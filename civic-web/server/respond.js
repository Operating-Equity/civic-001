// One streamed reply from OpenAI, read event by event, and what follows a go that failed: shared by the fact-check
// (server/evaluate.js), which forwards everything the model writes as it writes it, and the conversation
// (server/chat.js), which forwards only what the model is doing (thinking, searching, reading, writing) and keeps its
// words until they have been screened (server/screen.js).
import { usageOf, isRetryable, isRateLimit, isConnectionDrop, connectionWait, rateLimitWaitMs, sleep, streamFailure } from './openai.js';
import { noteFailure } from './reach.js';
import { gateFor, parseRefusal } from './gate.js';
import { toolStep, searchCount } from './tools/request.js';

/**
 * A fresh account of one reply: its words, its reasoning summary, its message items as OpenAI listed them (each with
 * its phase: OpenAI asks for the phase to be sent back with the message whenever the conversation goes on), every web
 * action it took, every source it cited, its usage, and whether it ended early.
 */
export function newReply() {
  return { text: '', reasoning: '', items: [], trail: [], sources: [], seen: new Set(), usage: null, incomplete: null, phase: null };
}

/**
 * Reads a streamed reply into `acc`. With `forward`, the page receives the model's words, its reasoning summary, its
 * searches and its sources as they come (the fact-check: nothing the model returns is withheld). Without, it receives
 * only what the model is doing (the conversation: its words wait for the screen). A reply that fails inside its
 * stream throws, as one refused at the door does.
 */
export async function readReply(stream, { acc, send, i, signal, forward = true, failure = 'the reply failed' }) {
  const doing = (phase) => { if (acc.phase !== phase) { acc.phase = phase; send({ t: 'phase', i, phase }); } };
  for await (const event of stream) {
    if (signal.aborted) return;
    switch (event.type) {
      case 'response.output_text.delta':
        acc.text += event.delta;
        if (forward) send({ t: 'delta', i, text: event.delta });
        else doing('writing');
        break;

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        acc.reasoning += event.delta || '';
        if (forward) send({ t: 'reasoning', i, text: event.delta || '' });
        else if (acc.phase !== 'writing') doing('reasoning');
        break;
      case 'response.reasoning_summary_part.done':
        acc.reasoning += '\n\n';
        break;

      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
        acc.phase = 'searching';
        send({ t: 'phase', i, phase: 'searching', searches: searchCount(acc.trail) + 1 });
        break;

      case 'response.mcp_call.in_progress':
        acc.phase = 'reading';
        send({ t: 'phase', i, phase: 'reading' }); // the model is reaching for one of FactEngine's tools
        break;

      case 'response.output_item.done': {
        const item = event.item;
        if (item?.type === 'web_search_call') {
          const a = item.action || {};
          const step = { kind: a.type || 'search', query: a.query || null, url: a.url || null, pattern: a.pattern || null, status: item.status };
          acc.trail.push(step);
          if (forward) send({ t: 'trail', i, step, searches: searchCount(acc.trail) });
        } else if (item?.type === 'mcp_call') {
          // One of FactEngine's tools, called and answered inside the response; its answer is the model's to use.
          const step = toolStep(item);
          acc.trail.push(step);
          if (forward) send({ t: 'trail', i, step, searches: searchCount(acc.trail) });
        } else if (item?.type === 'message' && (item.role || 'assistant') === 'assistant') {
          // The answer as OpenAI lists it, message by message, each with its phase, for a conversation to send back.
          const text = (item.content || []).filter((c) => c?.type === 'output_text').map((c) => c.text || '').join('');
          acc.items.push({ phase: typeof item.phase === 'string' ? item.phase : null, text });
        }
        break;
      }

      case 'response.output_text.annotation.added': {
        const a = event.annotation;
        if (a && a.type === 'url_citation' && a.url && !acc.seen.has(a.url)) {
          acc.seen.add(a.url);
          const source = { url: a.url, title: a.title || a.url };
          acc.sources.push(source);
          if (forward) send({ t: 'source', i, source });
        }
        break;
      }

      case 'response.completed':
        acc.usage = usageOf(event.response);
        break;
      case 'response.incomplete':
        acc.usage = usageOf(event.response);
        acc.incomplete = event.response?.incomplete_details?.reason || 'incomplete';
        send({ t: 'phase', i, phase: 'incomplete', reason: acc.incomplete });
        break;
      case 'response.failed':
      case 'error':
        throw streamFailure(event, failure);
      default:
        break;
    }
  }
}

/**
 * After a go that failed: waits whatever the failure asks and says to go again (true), or says it is a real failure
 * (false), for the caller to report.
 *
 * A refusal inside a streamed reply: the response's own later call (after a web search, say) found the minute short,
 * and OpenAI ended the response with its figures instead of turning the request back at the door. The figures go to
 * the gate as any refusal's do; the reply waits exactly what OpenAI asked and goes again, whole. Never a failure.
 *
 * The connection could not be made, or was cut: the operating system's report, never OpenAI's. Nothing was decided,
 * and a request that never left this computer spent nothing. It is a wait for the connection, as a refusal is a wait
 * for the minute: the reply goes again a second after this go began, however long the route is missing, and is never
 * counted out. The row says why, in the system's words; the outage is on record for /check.
 *
 * A 5xx from OpenAI cost nothing and is tried again, on the operator's count (`retries`). The attempt rejoins the line
 * at the gate, and its place in the line is its wait; when OpenAI names a wait of its own (retry-after), that comes
 * first. No back-off of ours. A refusal at the door never arrives here: the gate handles it.
 */
export async function goAgain(err, { tries, attemptAt, kind, model, send, i, retries }) {
  if (isRateLimit(err)) {
    const refusal = parseRefusal(err);
    gateFor(model).refusedInStream(kind, refusal);
    send({ t: 'retry', i, attempt: tries + 1, status: 429, reason: 'rate_limit', waitMs: refusal.waitMs || 0 });
    if (refusal.waitMs) await sleep(refusal.waitMs);
    return true;
  }
  if (isConnectionDrop(err)) {
    const { code, why, waitMs } = connectionWait(err, attemptAt);
    const { since } = noteFailure({ code, why });
    send({ t: 'retry', i, attempt: tries + 1, status: null, reason: 'connection', code, why, since, waitMs, at: Date.now() });
    if (waitMs > 0) await sleep(waitMs);
    return true;
  }
  if (tries < retries && isRetryable(err)) {
    const waitMs = rateLimitWaitMs(err) || 0;
    send({ t: 'retry', i, attempt: tries + 1, status: err?.status ?? null, reason: 'error', waitMs });
    if (waitMs > 0) await sleep(waitMs);
    return true;
  }
  return false;
}
