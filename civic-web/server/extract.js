// Step 1 — empirical claim extraction, streamed. Claims are parsed out of the numbered
// list as it arrives so the browser can show them one by one.
import { config } from './config.js';
import { extractionInstructions } from './prompts.js';
import { clientFor, withModelFallback, usageOf, isRetryable, sleep } from './openai.js';
import { estimateTextCost } from './pricing.js';
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

export async function runExtraction({ apiKey, text, send, signal, sourceWarning }) {
  const client = clientFor(apiKey);
  const instructions = extractionInstructions();
  let full = '';
  let emitted = 0;
  const started = Date.now();

  let wantSummary = Boolean(config.extractSummary);
  let reasoning = '';
  const trail = []; // every web action the model took during extraction, if any
  const attempt = (model) => {
    // The operator's configuration and nothing else. `npm run verify` fails if any other key appears.
    const r = { effort: config.extractEffort };
    if (wantSummary) r.summary = config.extractSummary;
    const body = {
      model,
      instructions, // the extraction prompt, verbatim
      input: [{ role: 'user', content: [{ type: 'input_text', text }] }], // the document, whole
      reasoning: r,
      tools: [{ type: 'web_search' }], // available, as in the UI the prompt was tested in
      stream: true,
      store: false,
    };
    return client.responses.create(body, { signal });
  };

  let usage = null;
  let modelUsed = null;
  let incomplete = null;
  let fellBack = null;
  if (sourceWarning) send({ t: 'warning', ...sourceWarning });
  for (let tries = 0; ; tries++) {
    try {
      full = '';
      emitted = 0;
      await withModelFallback('extract', config.extractModels, async (model) => {
        const stream = await attempt(model);
        modelUsed = model;
        send({ t: 'start', model, requested: config.extractModels[0], at: started });
        for await (const event of stream) {
          if (signal.aborted) return;
          if (event.type === 'response.output_text.delta') {
            full += event.delta;
            const items = parseNumberedList(full);
            // Emit each claim once it is closed by the next number.
            while (emitted < items.length - 1) {
              const c = items[emitted];
              send({ t: 'claim', n: emitted + 1, text: c.text });
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
            send({ t: 'trail', step, searches: trail.length });
          } else if (event.type === 'response.completed') {
            usage = usageOf(event.response);
          } else if (event.type === 'response.incomplete') {
            usage = usageOf(event.response);
            incomplete = event.response?.incomplete_details?.reason || 'incomplete';
            send({ t: 'phase', phase: 'incomplete', reason: incomplete });
          } else if (event.type === 'response.failed' || event.type === 'error') {
            const e = new Error(event.response?.error?.message || event.message || 'extraction failed');
            e.status = 502;
            throw e;
          }
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
      if (tries < config.evalRetries && isRetryable(err)) {
        send({ t: 'retry', attempt: tries + 1 });
        await sleep(1500 * 2 ** tries);
        continue;
      }
      throw err;
    }
  }

  if (signal.aborted) return null;
  const items = parseNumberedList(full).filter((c) => c.text.length > 0);
  while (emitted < items.length) {
    send({ t: 'claim', n: emitted + 1, text: items[emitted].text });
    emitted++;
  }
  const claims = items.map((c, i) => ({ n: i + 1, text: c.text }));
  const ms = Date.now() - started;
  const cost = estimateTextCost({ model: modelUsed, usage });
  record({ kind: 'extract', model: modelUsed, effort: config.extractEffort, chars: text.length, claims: claims.length, usage, ms, usd: cost.usd, priced: cost.priced });
  // `raw` is the model's complete extraction output, exactly as returned, so it can be inspected.
  const result = { t: 'done', total: claims.length, limit: config.maxClaims, claims, raw: full, reasoning: reasoning.trim() || null, trail, model: modelUsed, requested: config.extractModels[0], fellBack, effort: config.extractEffort, usage, ms, cost, incomplete };
  send(result);
  return result;
}
