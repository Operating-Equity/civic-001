// Development-only stand-in for api.openai.com. Emulates just enough of the Responses API
// (streaming) and the Images API for the CIVIC page to be exercised end to end without a key.
//
//   npm run mock-openai            # listens on :3999
//   OPENAI_BASE_URL=http://localhost:3999/v1 npm start
//
// Keys starting with "sk-bad" are rejected with 401 so the invalid-key path can be tested.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT || 3999);
const SPEED = Number(process.env.MOCK_SPEED || 1); // >1 = slower, <1 = faster
const app = express();
app.use(express.json({ limit: '256mb' }));

// When MOCK_RECORD is set, every request body is appended there so a verifier can inspect what
// the server actually sent (scripts/verify-ceiling.mjs).
app.use((req, res, next) => {
  if (process.env.MOCK_RECORD && req.method === 'POST') {
    fs.appendFileSync(process.env.MOCK_RECORD, JSON.stringify({ ts: Date.now(), path: req.path, body: req.body }) + '\n');
  }
  next();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));

app.use((req, res, next) => {
  const auth = req.get('authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '');
  if (!key) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error', code: 'missing_key' } });
  if (key.startsWith('sk-bad')) return res.status(401).json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
  next();
});

const KNOWN_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-image-2.5-flare', 'gpt-image-1-mini']);
const modelError = (res, model) => res.status(404).json({ error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } });

// ---- Responses API -----------------------------------------------------------------------

function sse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  return (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function inputText(body) {
  const input = body.input;
  if (typeof input === 'string') return input;
  return (input || []).flatMap((m) => (m.content || []).map((c) => c.text || '')).join('\n');
}

// Reading a model's description, which is what the self-check uses to prove a key may use a model.
// It costs no tokens, so the mock answers it the same way the real API does.
app.get('/v1/models/:id', (req, res) => {
  const id = req.params.id;
  if (!KNOWN_MODELS.has(id)) return modelError(res, id);
  res.json({ id, object: 'model', created: 1700000000, owned_by: 'mock' });
});

app.post('/v1/responses', async (req, res) => {
  const body = req.body || {};
  if (!KNOWN_MODELS.has(body.model)) return modelError(res, body.model);
  const text = inputText(body);
  const isEvaluation = /^\s*Prompt\s*=/.test(text);
  const isArtDirection = /art director/i.test(String(body.instructions || ''));

  // Exercise the case where a PARAMETER is unsupported: the server must surface this as an error,
  // never silently swap in a different, weaker model.
  if (process.env.MOCK_BAD_EFFORT && body.reasoning?.effort === process.env.MOCK_BAD_EFFORT) {
    return res.status(400).json({ error: { message: `Unsupported value: 'reasoning.effort' does not support '${body.reasoning.effort}' with this model.`, type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value' } });
  }

  // Exercise the server's fallback when an account cannot get reasoning summaries.
  if (process.env.MOCK_NO_SUMMARY && body.reasoning?.summary) {
    return res.status(400).json({ error: { message: 'Your organization must be verified to generate reasoning summaries.', type: 'invalid_request_error', code: 'unsupported_parameter' } });
  }

  // Non-streaming calls (the art-direction stage).
  if (body.stream === false) {
    await sleep(isArtDirection ? 900 : 400);
    const out = isArtDirection ? MOCK_BRIEF : 'ok';
    return res.json({
      id: 'resp_' + Math.random().toString(36).slice(2), status: 'completed', model: body.model, output_text: out,
      usage: { input_tokens: Math.round(text.length / 4), input_tokens_details: { cached_tokens: 0 }, output_tokens: Math.round(out.length / 4), output_tokens_details: { reasoning_tokens: 0 } },
    });
  }

  const send = sse(res);
  const id = 'resp_' + Math.random().toString(36).slice(2);
  send({ type: 'response.created', response: { id, status: 'in_progress' } });

  let output;
  if (isEvaluation) {
    const claim = text.split('\n')[0].replace(/^\s*Prompt\s*=\s*/, '').trim();

    if (body.reasoning?.summary) {
      for (const part of MOCK_REASONING) {
        await sleep(300 + Math.random() * 700);
        for (const chunk of part.match(/[\s\S]{1,30}/g) || []) {
          send({ type: 'response.reasoning_summary_text.delta', delta: chunk, summary_index: 0 });
          await sleep(12);
        }
        send({ type: 'response.reasoning_summary_part.done', summary_index: 0 });
      }
    } else {
      await sleep(800 + Math.random() * 2500);
    }

    if (body.tools?.some((t) => t.type === 'web_search')) {
      const queries = pickQueries(claim);
      for (let k = 0; k < queries.length; k++) {
        send({ type: 'response.web_search_call.in_progress', item_id: `ws_${k}` });
        send({ type: 'response.web_search_call.searching', item_id: `ws_${k}` });
        await sleep(400 + Math.random() * 900);
        send({ type: 'response.web_search_call.completed', item_id: `ws_${k}` });
        send({ type: 'response.output_item.done', output_index: k, item: { id: `ws_${k}`, type: 'web_search_call', status: 'completed', action: { type: 'search', query: queries[k] } } });
      }
    }
    output = mockEntry(claim);
  } else {
    // Extraction at a high reasoning effort is a long silence followed by a burst of text. The real
    // API behaves that way and the page has to stay alive through it, so the stand-in can too:
    // MOCK_EXTRACT_THINK_MS sets how long the model thinks before writing its first claim.
    const think = Number(process.env.MOCK_EXTRACT_THINK_MS || 500);
    if (body.reasoning?.summary && think > 1500) {
      const parts = ['Reading the document through once to see what kind of claims it carries.',
        'Separating the empirical propositions from the rhetoric around them.',
        'Carrying forward the speaker, the date and the units so each claim stands on its own.'];
      const per = Math.floor(think / parts.length);
      for (const part of parts) {
        for (const chunk of part.match(/[\s\S]{1,30}/g) || []) {
          send({ type: 'response.reasoning_summary_text.delta', delta: chunk, summary_index: 0 });
          await sleep(12);
        }
        send({ type: 'response.reasoning_summary_part.done', summary_index: 0 });
        await sleep(Math.max(0, per - part.length * 12));
      }
    } else {
      await sleep(think);
    }
    output = mockClaims(text);
  }

  const chunks = output.match(/[\s\S]{1,28}/g) || [];
  for (const delta of chunks) {
    if (res.writableEnded || res.destroyed) return;
    send({ type: 'response.output_text.delta', delta });
    await sleep(isEvaluation ? 18 : 25);
  }
  if (isEvaluation && body.tools?.some((t) => t.type === 'web_search')) {
    for (const src of MOCK_SOURCES) {
      send({ type: 'response.output_text.annotation.added', item_id: 'msg_1', output_index: 0, content_index: 0, annotation_index: 0, annotation: { type: 'url_citation', url: src.url, title: src.title, start_index: 0, end_index: 0 } });
    }
  }
  send({ type: 'response.output_text.done', text: output });
  send({
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      model: body.model,
      output_text: output,
      usage: {
        input_tokens: Math.round(text.length / 4),
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: Math.round(output.length / 4) + (isEvaluation ? 6000 : 0),
        output_tokens_details: { reasoning_tokens: isEvaluation ? 6000 : 0 },
        total_tokens: 0,
      },
    },
  });
  res.end();
});

// ---- Images API --------------------------------------------------------------------------

const imageB64 = fs.existsSync(path.join(here, 'mock-image.b64')) ? fs.readFileSync(path.join(here, 'mock-image.b64'), 'utf8').trim() : null;

app.post('/v1/images/generations', async (req, res) => {
  const body = req.body || {};
  if (!KNOWN_MODELS.has(body.model)) return modelError(res, body.model);
  await sleep(2500 + Math.random() * 2500);
  res.json({ created: Math.floor(Date.now() / 1000), model: body.model, output_format: 'jpeg', data: [{ b64_json: imageB64 }] });
});

app.use((req, res) => res.status(404).json({ error: { message: `mock: no route ${req.method} ${req.path}` } }));

app.listen(PORT, () => console.log(`mock OpenAI on http://localhost:${PORT}/v1  (speed x${SPEED})`));

// ---- Canned content ----------------------------------------------------------------------

const MOCK_BRIEF = `SUBJECT: a public reading-room table at the end of the day, a stack of bound newspaper volumes half open on it
SETTING: a municipal library annexe in early autumn, late afternoon, tall windows facing a street of plane trees
FOREGROUND: a brass reading lamp and a pencil lying across an index card, slightly out of focus
LIGHT: low side light through the windows, warm, long shadows across the table grain
PALETTE: oak brown, paper cream, brass, deep green, cool window blue
LENS: 35mm, eye level, half a step back from the table edge`;

const MOCK_REASONING = [
  'Restating the proposition in measurable terms and identifying which part is the empirical load.',
  'Looking for a primary artifact rather than repetition: an original record, a measurement, or a published table.',
  'Checking whether the candidate source actually addresses the exact proposition, then stopping once it is settled.',
];

const MOCK_SOURCES = [
  { url: 'https://example.gov/records/primary-source', title: 'Official record (mock source)' },
  { url: 'https://example.org/dataset/table-3', title: 'Published data table 3 (mock source)' },
];

function pickQueries(claim) {
  const words = claim.replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 4).slice(0, 4);
  return [words.join(' ') || claim.slice(0, 40), `${words.slice(0, 2).join(' ')} primary source`];
}

function mockClaims(source) {
  const sentences = source
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
  const picked = sentences.slice(0, 26);
  if (!picked.length) picked.push('The source contains no clearly empirical sentence.');
  return picked.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

const INSPECTORS = ['Karl Popper', 'Richard Feynman', 'Florence Nightingale', 'Ibn al-Haytham', 'Marie Curie', 'John Snow', 'Ronald Fisher', 'Galileo Galilei', 'Barbara McClintock', 'Charles Sanders Peirce'];

function mockEntry(claim) {
  const roll = Math.random();
  const verdict = roll < 0.45 ? 'True' : roll < 0.75 ? 'False' : 'Uncertain';
  const who = INSPECTORS[Math.floor(Math.random() * INSPECTORS.length)];
  const conf = verdict === 'Uncertain' ? 35 + Math.floor(Math.random() * 25) : 78 + Math.floor(Math.random() * 20);
  // Invented filler for development only. It deliberately does NOT follow the operator's output
  // format: no part of the real prompt, including its section names, exists in this repository.
  // Only the three labels the reader below keys on are present: Name, Conclusion, Confidence.
  return `**Name**: ${who}

(Development mock. Invented placeholder text, never a determination. The real entry follows the
operator's own output format, which is not reproduced anywhere in this repository.)

**Statement under inspection**: "${claim}"

**Method**: The proposition was reduced to its measurable parts, and each part was checked against a
primary artifact rather than against repetition of that artifact. Candidate sources were scored for
transparency (4), verifiability (4), independence (3), incentives (3), track record (4) and
specificity (${verdict === 'Uncertain' ? 2 : 5}), average ${verdict === 'Uncertain' ? '3.3' : '3.8'}.

**Findings**: What is directly supported was separated from what is inferred, and the evidence that
would change the answer was named rather than left implicit.

**Conclusion**: ${verdict}. ${verdict === 'True' ? 'The primary record states the proposition as claimed.' : verdict === 'False' ? 'The primary record contradicts the proposition as stated.' : 'No primary record was found that settles the proposition either way.'}

**Confidence**: ${conf}%. ${verdict === 'Uncertain' ? 'Confidence is limited by the absence of a primary source.' : 'Residual uncertainty reflects the possibility of an unpublished correction.'}`;
}
