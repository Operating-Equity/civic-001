// Step 2 — each claim is tested by the protected evaluation prompt. All claims run in parallel
// (bounded by config.evalConcurrency). Every event is tagged with the claim index.
import { config } from './config.js';
import { evaluationPrompt, VERDICT_TAG_INSTRUCTION } from './prompts.js';
import { clientFor, withModelFallback, usageOf, isRetryable, sleep, describeError } from './openai.js';

export const VERDICTS = ['true', 'false', 'unverified'];

const VERDICT_WORDS = {
  true: 'true',
  false: 'false',
  uncertain: 'unverified',
  unverified: 'unverified',
  unverifiable: 'unverified',
  unknown: 'unknown',
  indeterminate: 'unverified',
  inconclusive: 'unverified',
};

/** Finds the verdict, confidence and inspector name in the finished entry. */
export function parseEntry(raw) {
  const text = String(raw || '');
  let verdict = null;

  const tag = text.match(/VERDICT:\s*\**\s*(True|False|Unverified|Uncertain)\b/i);
  if (tag) verdict = VERDICT_WORDS[tag[1].toLowerCase()] || 'unverified';

  if (!verdict) {
    const idx = text.toLowerCase().lastIndexOf('conclusion');
    const window = idx >= 0 ? text.slice(idx, idx + 400) : text.slice(-1200);
    const m = window.match(/\b(true|false|uncertain|unverified|unverifiable|unknown|indeterminate|inconclusive)\b/i);
    if (m) verdict = VERDICT_WORDS[m[1].toLowerCase()];
    if (verdict === 'unknown') verdict = 'unverified';
  }
  if (!verdict) verdict = 'unverified';

  const conf = text.match(/Confidence\**\s*[:\-–]?\s*\**\s*(\d{1,3})\s*%/i);
  const confidence = conf ? Math.min(100, Number(conf[1])) : null;

  const name = text.match(/\*\*Name\*\*\s*[:\-–]?\s*\**\s*([^\n*]+)/i) || text.match(/^\s*0\.\s*\**Name\**\s*[:\-–]?\s*([^\n]+)/im);
  const inspector = name ? name[1].replace(/[\[\]]/g, '').trim().slice(0, 120) : null;

  const display = text.replace(/\n?\s*\**VERDICT:\s*\**\s*(True|False|Unverified|Uncertain)\**\s*$/i, '').trimEnd();
  return { verdict, confidence, inspector, text: display };
}

export async function runEvaluation({ apiKey, claims, send, signal }) {
  const client = clientFor(apiKey);
  const total = claims.length;
  let completed = 0;
  const started = Date.now();
  send({ t: 'batch-start', total, at: started, model: config.evalModels[0], effort: config.evalEffort });

  const tools = config.evalWebSearch ? [{ type: 'web_search' }] : undefined;

  const evaluateOne = async (claim, i) => {
    const prompt = evaluationPrompt(claim);
    let text = '';
    let usage = null;
    let modelUsed = null;
    let searches = 0;

    const attempt = (model) => client.responses.create(
      {
        model,
        instructions: VERDICT_TAG_INSTRUCTION,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        reasoning: { effort: config.evalEffort },
        tools,
        max_output_tokens: config.evalMaxOutputTokens,
        stream: true,
        store: false,
      },
      { signal },
    );

    for (let tries = 0; ; tries++) {
      try {
        text = '';
        await withModelFallback('evaluate', config.evalModels, async (model) => {
          const stream = await attempt(model);
          modelUsed = model;
          send({ t: 'start', i, model, at: Date.now() });
          for await (const event of stream) {
            if (signal.aborted) return;
            switch (event.type) {
              case 'response.output_text.delta':
                text += event.delta;
                send({ t: 'delta', i, text: event.delta });
                break;
              case 'response.reasoning_summary_text.delta':
              case 'response.reasoning_text.delta':
                send({ t: 'phase', i, phase: 'reasoning' });
                break;
              case 'response.web_search_call.searching':
              case 'response.web_search_call.in_progress':
                searches++;
                send({ t: 'phase', i, phase: 'searching', searches });
                break;
              case 'response.completed':
                usage = usageOf(event.response);
                break;
              case 'response.incomplete':
                usage = usageOf(event.response);
                send({ t: 'phase', i, phase: 'incomplete', reason: event.response?.incomplete_details?.reason });
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
        });
        break;
      } catch (err) {
        if (signal.aborted) return;
        if (tries < config.evalRetries && isRetryable(err)) {
          send({ t: 'retry', i, attempt: tries + 1 });
          await sleep(2000 * 2 ** tries + Math.random() * 500);
          continue;
        }
        const safe = describeError(err);
        send({ t: 'error', i, code: safe.code, message: safe.message });
        completed++;
        send({ t: 'batch-progress', completed, total });
        return;
      }
    }

    if (signal.aborted) return;
    const parsed = parseEntry(text);
    completed++;
    send({ t: 'done', i, verdict: parsed.verdict, confidence: parsed.confidence, inspector: parsed.inspector, text: parsed.text, usage, model: modelUsed, searches });
    send({ t: 'batch-progress', completed, total });
  };

  // Bounded parallelism.
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
