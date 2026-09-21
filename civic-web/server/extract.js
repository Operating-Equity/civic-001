// Step 1 — empirical claim extraction, streamed. Claims are parsed out of the numbered
// list as it arrives so the browser can show them one by one.
import { config } from './config.js';
import { extractionRequest, extractionShape } from './prompts.js';
import { sourceBlock } from './source.js';
import { clientFor, withModelFallback, usageOf, isRetryable, isRateLimit, isConnectionDrop, connectionWait, rateLimitWaitMs, sleep, throughGate, streamFailure } from './openai.js';
import { noteFailure } from './reach.js';
import { gateFor, parseRefusal } from './gate.js';
import { estimateTextCost } from './pricing.js';
import { requestTools, toolStep, searchCount } from './tools/request.js';
import { record } from './ledger.js';

/** Parses "1. claim\n2. claim" incrementally. Returns the claims completed so far. */
export function parseNumberedList(text) {
  const items = [];
  const re = /(?:^|\n)\s*(\d{1,3})[.)\]:]\s+/g;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) {
    if (last) items.push({ n: last.n, text: text.slice(last.end, match.index) });
    last = { n: Number(match[1]), end: match.index + match[0].length };
  }
  if (last) items.push({ n: last.n, text: text.slice(last.end), open: true });
  return items.map((it) => ({ n: it.n, text: cleanClaim(it.text), open: !!it.open }));
}

// The claim is the model's wording. Only the surrounding whitespace is removed.
function cleanClaim(s) {
  return String(s).trim();
}

/**
 * An entry may be written as labelled lines: the claim under a "Claim:" label, then further
 * labelled lines, such as who said it and when, or what the source does not say. The claim is
 * what is tested; the further lines are kept beside it, verbatim, and shown with it. An entry
 * without the label is the claim, whole.
 */
export function splitEntry(entry) {
  const head = entry.match(/^[*_]*Claim[*_]*:[*_]*[ \t]*/i);
  if (!head) return { text: entry, more: '' };
  const rest = entry.slice(head[0].length);
  const next = rest.search(/\n[ \t]*[*_]*[A-Z][A-Za-z]*(?: [A-Za-z]+){0,3}[*_]*:[*_]*[ \t]/);
  if (next < 0) return { text: rest.trim(), more: '' };
  return { text: rest.slice(0, next).trim(), more: rest.slice(next).trim() };
}

export async function runExtraction({ apiKey, text, meta, send, signal, sourceWarning }) {
  const client = clientFor(apiKey);
  // A prompt with a slot for the source asked for what is known of its origin too, so the source
  // goes in with what CIVIC knows of that. A prompt without a slot gets the text alone.
  const request = extractionRequest(extractionShape() === 'inserted' ? sourceBlock(text, meta) : text);
  let full = '';
  let emitted = 0;
  const started = Date.now();

  let wantSummary = Boolean(config.extractSummary);
  let reasoning = '';
  const trail = []; // every web action the model took during extraction, if any
  const attempt = (model) => {
    // The operator's configuration and nothing else. `npm run verify` fails if any other key appears.
    const r = { effort: config.extractEffort };
    if (config.extractReasoningMode) r.mode = config.extractReasoningMode; // pro: more model work per answer, at the same rates
    if (wantSummary) r.summary = config.extractSummary;
    const body = {
      model,
      // The prompt verbatim: as the only message with the source in its place, or as the
      // instructions with the source as the only message. The prompt's own shape decides.
      ...(request.instructions ? { instructions: request.instructions } : {}),
      input: [{ role: 'user', content: [{ type: 'input_text', text: request.message }] }],
      reasoning: r,
      tools: requestTools(), // web search, as in the UI the prompt was tested in; CIVIC's own tools when the gateway is set
      stream: true,
      store: false,
    };
    return throughGate(client, body, { kind: 'extraction', signal, onHold: (h) => send({ t: 'phase', phase: 'queued', ...h }) });
  };

  let usage = null;
  let modelUsed = null;
  let incomplete = null;
  let fellBack = null;
  if (sourceWarning) send({ t: 'warning', ...sourceWarning });
  for (let tries = 0; ; tries++) {
    const attemptAt = Date.now();
    try {
      full = '';
      emitted = 0;
      await withModelFallback('extract', config.extractModels, async (model) => {
        const { data: stream, release } = await attempt(model);
        modelUsed = model;
        send({ t: 'start', model, requested: config.extractModels[0], at: started });
        try {
        for await (const event of stream) {
          if (signal.aborted) return;
          if (event.type === 'response.output_text.delta') {
            full += event.delta;
            const items = parseNumberedList(full);
            // Emit each claim once it is closed by the next number.
            while (emitted < items.length - 1) {
              const c = items[emitted];
              send({ t: 'claim', n: emitted + 1, ...splitEntry(c.text), entry: c.text });
              emitted++;
            }
            send({ t: 'progress', chars: full.length, found: Math.max(emitted, items.length) });
          } else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
            reasoning += event.delta || '';
            send({ t: 'reasoning', text: event.delta || '' });
          } else if (event.type === 'response.reasoning_summary_part.done') {
            reasoning += '\n\n';
          } else if (event.type === 'response.output_item.done' && event.item?.type === 'web_search_call') {
            const a = event.item.action || {};
            const step = { kind: a.type || 'search', query: a.query || null, url: a.url || null, pattern: a.pattern || null, status: event.item.status };
            trail.push(step);
            send({ t: 'trail', step, searches: searchCount(trail) });
          } else if (event.type === 'response.output_item.done' && event.item?.type === 'mcp_call') {
            const step = toolStep(event.item); // one of CIVIC's tools, called inside the response
            trail.push(step);
            send({ t: 'trail', step, searches: searchCount(trail) });
          } else if (event.type === 'response.completed') {
            usage = usageOf(event.response);
          } else if (event.type === 'response.incomplete') {
            usage = usageOf(event.response);
            incomplete = event.response?.incomplete_details?.reason || 'incomplete';
            send({ t: 'phase', phase: 'incomplete', reason: incomplete });
          } else if (event.type === 'response.failed' || event.type === 'error') {
            throw streamFailure(event, 'extraction failed');
          }
        }
        } finally {
          release();
        }
      }, (f) => { fellBack = f; send({ t: 'warning', code: 'model_fallback', ...f }); });
      break;
    } catch (err) {
      if (signal.aborted) return null;
      if (wantSummary && err?.status === 400 && /summar/i.test(String(err?.error?.message || err?.message || ''))) {
        wantSummary = false;
        send({ t: 'note', code: 'no_reasoning_summary' });
        continue;
      }
      if (isRateLimit(err)) {
        // A refusal inside the streamed reply, as in evaluate.js: OpenAI's figures go to the gate,
        // the extraction waits exactly what OpenAI asked, and goes again, whole.
        const refusal = parseRefusal(err);
        gateFor(modelUsed || config.extractModels[0]).refusedInStream('extraction', refusal);
        send({ t: 'retry', attempt: tries + 1, status: 429, reason: 'rate_limit', waitMs: refusal.waitMs || 0 });
        if (refusal.waitMs) await sleep(refusal.waitMs);
        continue;
      }
      if (isConnectionDrop(err)) {
        // As in evaluate.js: a connection that could not be made or was cut is the operating
        // system's report, not OpenAI's; the extraction waits for the connection, going again a
        // second after this go began, however long the route is missing, never counted out.
        const { code, why, waitMs } = connectionWait(err, attemptAt);
        const { since } = noteFailure({ code, why });
        send({ t: 'retry', attempt: tries + 1, status: null, reason: 'connection', code, why, since, waitMs, at: Date.now() });
        if (waitMs > 0) await sleep(waitMs);
        continue;
      }
      if (tries < config.evalRetries && isRetryable(err)) {
        // As in evaluate.js: a 5xx rejoins the line at the gate on the operator's count; OpenAI's
        // own retry-after, when given, is honoured first; no back-off of ours; a refusal at the
        // door never arrives here.
        const waitMs = rateLimitWaitMs(err) || 0;
        send({ t: 'retry', attempt: tries + 1, status: err?.status ?? null, reason: 'error', waitMs });
        if (waitMs > 0) await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  if (signal.aborted) return null;
  const items = parseNumberedList(full).filter((c) => c.text.length > 0);
  while (emitted < items.length) {
    send({ t: 'claim', n: emitted + 1, ...splitEntry(items[emitted].text), entry: items[emitted].text });
    emitted++;
  }
  const claims = items.map((c, i) => ({ n: i + 1, ...splitEntry(c.text), entry: c.text }));
  const ms = Date.now() - started;
  const cost = estimateTextCost({ model: modelUsed, usage });
  record({ kind: 'extract', model: modelUsed, effort: config.extractEffort, mode: config.extractReasoningMode || null, chars: text.length, claims: claims.length, usage, ms, usd: cost.usd, priced: cost.priced });
  // `raw` is the model's complete extraction output, exactly as returned, so it can be inspected.
  // No token figures go to the page (the operator's rule of 18 September); the ledger line above keeps them.
  const result = { t: 'done', total: claims.length, limit: config.maxClaims, claims, raw: full, reasoning: reasoning.trim() || null, trail, model: modelUsed, requested: config.extractModels[0], fellBack, effort: config.extractEffort, mode: config.extractReasoningMode || null, ms, cost, incomplete };
  send(result);
  return result;
}
