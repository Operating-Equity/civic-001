// Step 2 — each claim is tested by the protected evaluation prompt, sent verbatim.
// Four claims at a time (config.evalConcurrency). What is tested is the claim's whole entry as the
// extractor wrote it (Claim, Attribution, what the source leaves unspecified), and the source goes
// ahead of the prompt as its own message, as the conversation carried it in the workflow the
// prompts were tested in. A claim tested bare, with "the speech" and no speaker or date, was
// being tested without the context the extraction prompt had written for it.
//
// Nothing the model returns is edited, trimmed or withheld. The card receives the complete
// output text, the reasoning summary, every web search the model performed, and every source
// it cited. The verdict is read out of the model's own Conclusion, in whatever form the model
// wrote it (server/verdict.js); an entry that states no verdict at all is Unverified, by the
// operator's ruling, and its closing words are recorded for /check.
import { config } from './config.js';
import { evaluationPrompt } from './prompts.js';
import { clientFor, withModelFallback, usageOf, isRetryable, isRateLimit, isConnectionDrop, connectionWait, rateLimitWaitMs, sleep, describeError, throughGate, streamFailure } from './openai.js';
import { noteFailure } from './reach.js';
import { gateFor, parseRefusal } from './gate.js';
import { record as recordFailure } from './diagnostics.js';
import { estimateTextCost } from './pricing.js';
import { record, claimHash } from './ledger.js';
import { parseEntry, conclusionExcerpt } from './verdict.js';
import { requestTools, toolStep, searchCount } from './tools/request.js';
export { parseEntry, VERDICTS } from './verdict.js';

export async function runEvaluation({ apiKey, claims, document = '', send, signal }) {
  const client = clientFor(apiKey);
  const total = claims.length;
  let completed = 0;
  const started = Date.now();
  send({ t: 'batch-start', total, at: started, model: config.evalModels[0], effort: config.evalEffort, mode: config.evalReasoningMode || null });

  const tools = requestTools(); // web search always (the prompts were tested with it); CIVIC's own tools when the gateway is set

  // The key's minute figures, once the gate has them from OpenAI: the page is told the limit, what
  // OpenAI counts for one determination, how many start at once and how often one more can. All
  // of it is OpenAI's own arithmetic; it is sent whenever the figures change.
  let announced = '';
  const announceGate = (model) => {
    const g = gateFor(model).state();
    if (!g.determination) return;
    const key = `${g.tokens.limit}:${g.costs.determination}:${g.determination.everyMs}`;
    if (key === announced) return;
    announced = key;
    send({ t: 'gate', model, limit: g.tokens.limit, cost: g.costs.determination, ...g.determination });
  };

  const evaluateOne = async (claim, i) => {
    const prompt = evaluationPrompt(claim);
    const startedAt = Date.now();
    let text = '';
    let reasoning = '';
    let usage = null;
    let modelUsed = null;
    let incomplete = null;
    let wantSummary = Boolean(config.evalReasoningSummary);
    let fellBack = null;
    const trail = [];   // every web action the model took
    const sources = []; // every URL it cited
    const seen = new Set();

    const request = (model) => {
      // The operator's tested configuration and nothing else. No cap, no mode, no verbosity,
      // no context size. `npm run verify` fails if any other key ever appears here.
      const reasoning = { effort: config.evalEffort };
      if (config.evalReasoningMode) reasoning.mode = config.evalReasoningMode; // pro: more model work per answer, at the same rates
      if (wantSummary) reasoning.summary = config.evalReasoningSummary;
      const body = {
        model,
        // The source ahead, as its own message, then the prompt verbatim with the entry in its slot.
        input: [
          ...(document ? [{ role: 'user', content: [{ type: 'input_text', text: document }] }] : []),
          { role: 'user', content: [{ type: 'input_text', text: prompt }] },
        ],
        reasoning,
        tools,
        stream: true,
        store: false, // the key belongs to the reader; the prompt must not appear in their dashboard
      };
      // Through the gate: sent only when the key's minute holds it. A held claim's row says so, in figures.
      return throughGate(client, body, { kind: 'determination', signal, onHold: (h) => send({ t: 'phase', i, phase: 'queued', ...h }) });
    };

    for (let tries = 0; ; tries++) {
      const attemptAt = Date.now();
      try {
        text = '';
        reasoning = '';
        await withModelFallback('evaluate', config.evalModels, async (model) => {
          const { data: stream, release } = await request(model);
          modelUsed = model;
          announceGate(model);
          try {
          send({ t: 'start', i, model, requested: config.evalModels[0], at: Date.now() });
          for await (const event of stream) {
            if (signal.aborted) return;
            switch (event.type) {
              case 'response.output_text.delta':
                text += event.delta;
                send({ t: 'delta', i, text: event.delta });
                break;

              case 'response.reasoning_summary_text.delta':
              case 'response.reasoning_text.delta':
                reasoning += event.delta || '';
                send({ t: 'reasoning', i, text: event.delta || '' });
                break;
              case 'response.reasoning_summary_part.done':
                reasoning += '\n\n';
                break;

              case 'response.web_search_call.in_progress':
              case 'response.web_search_call.searching':
                send({ t: 'phase', i, phase: 'searching', searches: searchCount(trail) + 1 });
                break;

              case 'response.mcp_call.in_progress':
                send({ t: 'phase', i, phase: 'reading' }); // the model is reaching for one of CIVIC's tools
                break;

              case 'response.output_item.done': {
                const item = event.item;
                if (item?.type === 'web_search_call') {
                  const a = item.action || {};
                  const step = { kind: a.type || 'search', query: a.query || null, url: a.url || null, pattern: a.pattern || null, status: item.status };
                  trail.push(step);
                  send({ t: 'trail', i, step, searches: searchCount(trail) });
                } else if (item?.type === 'mcp_call') {
                  // One of CIVIC's tools, called and answered inside the response; its answer is the model's to use.
                  const step = toolStep(item);
                  trail.push(step);
                  send({ t: 'trail', i, step, searches: searchCount(trail) });
                }
                break;
              }

              case 'response.output_text.annotation.added': {
                const a = event.annotation;
                if (a && a.type === 'url_citation' && a.url && !seen.has(a.url)) {
                  seen.add(a.url);
                  const source = { url: a.url, title: a.title || a.url };
                  sources.push(source);
                  send({ t: 'source', i, source });
                }
                break;
              }

              case 'response.completed':
                usage = usageOf(event.response);
                break;
              case 'response.incomplete':
                usage = usageOf(event.response);
                incomplete = event.response?.incomplete_details?.reason || 'incomplete';
                send({ t: 'phase', i, phase: 'incomplete', reason: incomplete });
                break;
              case 'response.failed':
              case 'error':
                throw streamFailure(event, 'evaluation failed');
              default:
                break;
            }
          }
          } finally {
            release();   // the gate learns the request is over, whatever ended it
          }
        }, (f) => { fellBack = f; send({ t: 'warning', i, code: 'model_fallback', ...f }); });
        break;
      } catch (err) {
        if (signal.aborted) return;
        // Reasoning summaries need a verified organisation on some accounts. Drop them and keep going.
        if (wantSummary && err?.status === 400 && /summar/i.test(String(err?.error?.message || err?.message || ''))) {
          wantSummary = false;
          send({ t: 'note', i, code: 'no_reasoning_summary' });
          continue;
        }
        if (isRateLimit(err)) {
          // A refusal inside a streamed reply: the response's own later call (after a web search,
          // say) found the minute short, and OpenAI ended the response with its figures instead of
          // turning the request back at the door. The figures go to the gate as any refusal's do;
          // the claim waits exactly what OpenAI asked and goes again, whole. Never a failure.
          const refusal = parseRefusal(err);
          gateFor(modelUsed || config.evalModels[0]).refusedInStream('determination', refusal);
          send({ t: 'retry', i, attempt: tries + 1, status: 429, reason: 'rate_limit', waitMs: refusal.waitMs || 0 });
          if (refusal.waitMs) await sleep(refusal.waitMs);
          continue;
        }
        if (isConnectionDrop(err)) {
          // The connection could not be made, or was cut: the operating system's report, never
          // OpenAI's. Nothing was decided, and a request that never left this computer spent
          // nothing. It is a wait for the connection, as a refusal is a wait for the minute: the
          // claim goes again a second after this go began, however long the route is missing,
          // and is never counted out. The row says why, in the system's words; the outage is on
          // record for /check, with its start, its cause and its length.
          const { code, why, waitMs } = connectionWait(err, attemptAt);
          const { since } = noteFailure({ code, why });
          send({ t: 'retry', i, attempt: tries + 1, status: null, reason: 'connection', code, why, since, waitMs, at: Date.now() });
          if (waitMs > 0) await sleep(waitMs);
          continue;
        }
        if (tries < config.evalRetries && isRetryable(err)) {
          // A 5xx from OpenAI cost nothing and is tried again, on the operator's count. The attempt
          // rejoins the line at the gate, and its place in the line is its wait; when OpenAI names
          // a wait of its own (retry-after), that comes first. No back-off of ours. A refusal at
          // the door never arrives here: the gate handles it.
          const waitMs = rateLimitWaitMs(err) || 0;
          send({ t: 'retry', i, attempt: tries + 1, status: err?.status ?? null, reason: 'error', waitMs });
          if (waitMs > 0) await sleep(waitMs);
          continue;
        }
        const safe = describeError(err);
        record({ kind: 'evaluate', ok: false, code: safe.code, model: modelUsed, effort: config.evalEffort, claim: claimHash(claim), ms: Date.now() - startedAt });
        send({ t: 'error', i, code: safe.code, message: safe.message });
        completed++;
        send({ t: 'batch-progress', completed, total });
        return;
      }
    }

    if (signal.aborted) return;
    const parsed = parseEntry(text);
    // An entry whose Conclusion could not be read counts as Unverified; what it said at its
    // Conclusion is kept for /check, so the reader can be corrected to the form the model wrote.
    if (parsed.verdictSource === 'unread') recordFailure({ where: 'server:verdict', code: 'verdict_unread', message: conclusionExcerpt(text) });
    const ms = Date.now() - startedAt;
    const cost = estimateTextCost({ model: modelUsed, usage, searches: searchCount(trail) });
    record({
      kind: 'evaluate', ok: true, model: modelUsed, effort: config.evalEffort, mode: config.evalReasoningMode || null, webSearch: true,
      claim: claimHash(claim), chars: claim.length, fellBack: fellBack?.used || null, verdict: parsed.verdict, verdictSource: parsed.verdictSource,
      confidence: parsed.confidence, usage, searches: searchCount(trail), sources: sources.length, incomplete, ms,
      usd: cost.usd, priced: cost.priced,
    });
    completed++;
    send({
      t: 'done', i,
      verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence, inspector: parsed.inspector,
      conclusion: parsed.conclusion, // the Conclusion section, for the closed row
      text: parsed.text,            // complete, unmodified
      reasoning: reasoning.trim() || null,
      trail, sources,
      model: modelUsed, requested: config.evalModels[0], fellBack, effort: config.evalEffort, mode: config.evalReasoningMode || null, // no token figures go to the page; the ledger keeps them
      searches: searchCount(trail), ms, cost, incomplete,
    });
    send({ t: 'batch-progress', completed, total });
  };

  const queue = claims.map((c, i) => [c, i]);
  const workers = Array.from({ length: Math.min(config.evalConcurrency, total) }, async () => {
    while (queue.length && !signal.aborted) {
      const [claim, i] = queue.shift();
      await evaluateOne(claim, i);
    }
  });
  await Promise.all(workers);
  if (!signal.aborted) send({ t: 'complete', total, completed, ms: Date.now() - started });
}
