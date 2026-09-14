// Step 1 — empirical claim extraction, streamed. Claims are parsed out of the numbered
// list as it arrives so the browser can show them one by one.
import { config } from './config.js';
import { extractionInstructions } from './prompts.js';
import { clientFor, withModelFallback, usageOf, isRetryable, sleep } from './openai.js';

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

function cleanClaim(s) {
  return String(s)
    .replace(/\s+/g, ' ')
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/^["“]\s*|\s*["”]$/g, '')
    .trim();
}

export async function runExtraction({ apiKey, text, send, signal }) {
  const client = clientFor(apiKey);
  const instructions = extractionInstructions();
  let full = '';
  let emitted = 0;
  const started = Date.now();

  const attempt = (model) => client.responses.create(
    {
      model,
      instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
      reasoning: { effort: config.extractEffort },
      max_output_tokens: config.extractMaxOutputTokens,
      stream: true,
      store: false,
    },
    { signal },
  );

  let usage = null;
  let modelUsed = null;
  for (let tries = 0; ; tries++) {
    try {
      full = '';
      emitted = 0;
      await withModelFallback('extract', config.extractModels, async (model) => {
        const stream = await attempt(model);
        modelUsed = model;
        send({ t: 'start', model, at: started });
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
          } else if (event.type === 'response.completed') {
            usage = usageOf(event.response);
          } else if (event.type === 'response.failed' || event.type === 'error') {
            const e = new Error(event.response?.error?.message || event.message || 'extraction failed');
            e.status = 502;
            throw e;
          }
        }
      });
      break;
    } catch (err) {
      if (signal.aborted) return null;
      if (tries < 2 && isRetryable(err)) {
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
  const result = {
    t: 'done',
    total: claims.length,
    limit: config.maxClaims,
    claims,
    model: modelUsed,
    usage,
    ms: Date.now() - started,
  };
  send(result);
  return result;
}
