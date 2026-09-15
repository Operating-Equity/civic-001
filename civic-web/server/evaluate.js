// Step 2 — each claim is tested by the protected evaluation prompt, sent verbatim.
// All claims run in parallel (bounded by config.evalConcurrency).
//
// Nothing the model returns is edited, trimmed or withheld. The card receives the complete
// output text, the reasoning summary, every web search the model performed, and every source
// it cited. The verdict is read out of the model's own Conclusion section; when it cannot be
// read, the verdict is null and the card says so rather than guessing.
import { config } from './config.js';
import { evaluationPrompt } from './prompts.js';
import { clientFor, withModelFallback, usageOf, isRetryable, sleep, describeError } from './openai.js';
import { estimateTextCost } from './pricing.js';
import { record, claimHash } from './ledger.js';

export const VERDICTS = ['true', 'false', 'unverified'];

// The author's output format asks for True / False / Uncertain. The page shows Unverified in
// place of Uncertain, as specified. Nothing else is mapped.
const VERDICT_WORDS = {
  true: 'true',
  false: 'false',
  uncertain: 'unverified',
  unverified: 'unverified',
  unverifiable: 'unverified',
  indeterminate: 'unverified',
  inconclusive: 'unverified',
};
const WORD_RE = /\b(true|false|uncertain|unverified|unverifiable|indeterminate|inconclusive)\b/i;

/**
 * Reads the verdict out of the finished entry without changing it.
 * Returns verdict: null when the Conclusion cannot be read — never a silent default.
 */
export function parseEntry(raw) {
  const text = String(raw || '');
  let verdict = null;
  let source = 'none';

  // 1. The author's own output format: section 6, "Conclusion".
  const headings = [...text.matchAll(/(?:^|\n)[^\n]{0,12}\**\s*Conclusion\**\s*[:\-–]/gi)];
  if (headings.length) {
    const at = headings[headings.length - 1].index;
    const window = text.slice(at, at + 400);
    const m = window.match(WORD_RE);
    if (m) { verdict = VERDICT_WORDS[m[1].toLowerCase()]; source = 'conclusion'; }
  }

  // 2. An explicit tag, if the author ever adds one to the prompt.
  if (!verdict) {
    const tag = text.match(/\bVERDICT\s*[:\-–]\s*\**\s*(True|False|Unverified|Uncertain)\b/i);
    if (tag) { verdict = VERDICT_WORDS[tag[1].toLowerCase()]; source = 'tag'; }
  }

  // There is no third step. Scanning the closing lines for any verdict word would be a guess,
  // and a guess is exactly what this file must never make. No Conclusion, no verdict: the card
  // says so and the claim is counted in no column.

  const conf = text.match(/Confidence\**\s*[:\-–]?\s*\**\s*(\d{1,3})\s*%/i);
  const confidence = conf ? Math.min(100, Number(conf[1])) : null;

  const name = text.match(/\*\*Name\*\*\s*[:\-–]?\s*\**\s*([^\n*]+)/i) || text.match(/^\s*0\.\s*\**Name\**\s*[:\-–]?\s*([^\n]+)/im);
  const inspector = name ? name[1].replace(/[\[\]]/g, '').trim().slice(0, 160) : null;

  // text is returned untouched.
  return { verdict, verdictSource: source, confidence, inspector, text };
}

export async function runEvaluation({ apiKey, claims, send, signal }) {
  const client = clientFor(apiKey);
  const total = claims.length;
  let completed = 0;
  const started = Date.now();
  send({ t: 'batch-start', total, at: started, model: config.evalModels[0], effort: config.evalEffort });

  const tools = [{ type: 'web_search' }]; // always; the prompts were tested with search available

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
      if (wantSummary) reasoning.summary = config.evalReasoningSummary;
      const body = {
        model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], // the prompt, verbatim, alone
        reasoning,
        tools,
        stream: true,
        store: false, // the key belongs to the reader; the prompt must not appear in their dashboard
      };
      return client.responses.create(body, { signal });
    };

    for (let tries = 0; ; tries++) {
      try {
        text = '';
        reasoning = '';
        await withModelFallback('evaluate', config.evalModels, async (model) => {
          const stream = await request(model);
          modelUsed = model;
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
                send({ t: 'phase', i, phase: 'searching', searches: trail.length + 1 });
                break;

              case 'response.output_item.done': {
                const item = event.item;
                if (item?.type === 'web_search_call') {
                  const a = item.action || {};
                  const step = { kind: a.type || 'search', query: a.query || null, url: a.url || null, pattern: a.pattern || null, status: item.status };
                  trail.push(step);
                  send({ t: 'trail', i, step, searches: trail.length });
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
              case 'error': {
                const e = new Error(event.response?.error?.message || event.message || 'evaluation failed');
                e.status = 502;
                throw e;
              }
              default:
                break;
            }
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
        if (tries < config.evalRetries && isRetryable(err)) {
          const waitMs = 2000 * 2 ** tries + Math.random() * 500;
          // The status is passed on: a 429 means this key's rate limit is throttling the run, which
          // is the difference between twenty claims running at once and twenty claims queueing.
          send({ t: 'retry', i, attempt: tries + 1, status: err?.status ?? null, waitMs: Math.round(waitMs) });
          await sleep(waitMs);
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
    const ms = Date.now() - startedAt;
    const cost = estimateTextCost({ model: modelUsed, usage, searches: trail.length });
    record({
      kind: 'evaluate', ok: true, model: modelUsed, effort: config.evalEffort, webSearch: true,
      claim: claimHash(claim), chars: claim.length, fellBack: fellBack?.used || null, verdict: parsed.verdict, verdictSource: parsed.verdictSource,
      confidence: parsed.confidence, usage, searches: trail.length, sources: sources.length, incomplete, ms,
      usd: cost.usd, priced: cost.priced,
    });
    completed++;
    send({
      t: 'done', i,
      verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence, inspector: parsed.inspector,
      text: parsed.text,            // complete, unmodified
      reasoning: reasoning.trim() || null,
      trail, sources,
      usage, model: modelUsed, requested: config.evalModels[0], fellBack, effort: config.evalEffort,
      searches: trail.length, ms, cost, incomplete,
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
