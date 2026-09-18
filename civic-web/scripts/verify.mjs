// The guard. Starts the mock and the server, runs an extraction and a determination, then reads
// the request bodies the server ACTUALLY SENT to the API and fails if they carry anything but the
// operator's configuration: the configured model, the configured reasoning effort, the prompts
// verbatim, web search. Any other key in a request body is a failure, whoever added it.
// It also runs the prompt leak guard: no committed file may contain a fragment of the prompts.
// Run before every deploy: `npm run verify`. A non-zero exit is a defect.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leakChecks } from './leak-check.mjs';
import { sourceBlock } from '../server/source.js';
import { Bucket, parseRefusal } from '../server/gate.js';
import { parseEntry } from '../server/verdict.js';
import { isConnectionDrop, connectionWait, describeError } from '../server/openai.js';
import { generateCode, normalise, ALPHABET } from '../server/access.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MOCK_PORT = 3999;
const PORT = 3007;
const record = path.join(os.tmpdir(), `civic-verify-${Date.now()}.jsonl`);
const KEY = 'sk-verify00000000000000000000';          // the operator's, set on the server below
const READER_KEY = 'sk-reader11111111111111111111';   // a stranger's, offered in a header and ignored


const promptDir = path.join(root, 'server', 'prompts');
function readPrompt(name) {
  const inline = process.env[`CIVIC_PROMPT_${name.toUpperCase()}`];
  if (inline) return inline.replace(/\r\n/g, '\n');
  const file = process.env[`CIVIC_PROMPT_${name.toUpperCase()}_FILE`] || path.join(promptDir, `${name}.txt`);
  if (!fs.existsSync(file)) { console.error(`verify: ${name} prompt not installed (${file})`); process.exit(2); }
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}
const extractPrompt = readPrompt('extract');
const evaluatePrompt = readPrompt('evaluate');

// A prompt whose last line is entirely in square brackets takes the source in that line's place
// and travels as the only message; any other prompt is the instructions, with the source as the
// only message. The guard expects whichever the installed prompt asks for.
const slot = (() => {
  const end = extractPrompt.replace(/\s+$/, '').length;
  const start = extractPrompt.lastIndexOf('\n', end - 1) + 1;
  return /^\[[^\[\]]+\]$/.test(extractPrompt.slice(start, end)) ? { start, end } : null;
})();

// The only keys a request may carry. Nothing else, ever.
const ALLOWED = {
  extract: slot ? ['model', 'input', 'reasoning', 'tools', 'stream', 'store'] : ['model', 'instructions', 'input', 'reasoning', 'tools', 'stream', 'store'],
  evaluate: ['model', 'input', 'reasoning', 'tools', 'stream', 'store'],
  reasoning: ['effort', 'summary'],
  webSearchTool: ['type'],
};

const children = [];
const start = (args, extraEnv) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`  [${path.basename(args[0])}] ${d}`));
  children.push(child);
  return child;
};
const stop = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch {} } };
process.on('exit', stop);

const wait = async (url, ms = 15000, { anyResponse = false } = {}) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (anyResponse || r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
};

async function stream(url, body) {
  const events = [];
  // Every request in this guard carries a stranger's key in the header. Nothing may ever use it.
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-key': READER_KEY }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) events.push(JSON.parse(line)); }
  }
  return events;
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };
const extraKeys = (obj, allowed) => Object.keys(obj || {}).filter((k) => !allowed.includes(k));

try {
  fs.writeFileSync(record, '');
  // The mock refuses the second request with a rate limit at the door (the determination, which
  // follows the extraction; its bucket is drained first, as another user of the key would drain
  // it), cuts the connection of the third a few chunks in, and ends the fourth inside its stream
  // with a rate limit (the response's own later call finding the minute short, as OpenAI does):
  // the gate must wait what OpenAI asked and send the claim again first; after the cut the claim
  // must go again; after the refusal in the stream it must wait what OpenAI asked and go again,
  // whole; and the fifth request completes.
  // The stand-in tells a determination from an extraction by how the installed evaluation prompt
  // begins (the text before the claim's placeholder, or after it when the placeholder comes first).
  const [before, after] = evaluatePrompt.split('{{CLAIM}}');
  const evalMark = (before.trim() || after.trim()).slice(0, 60);
  process.env.MOCK_EVAL_MARK_FOR_GATE = evalMark;
  start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK_PORT), MOCK_RECORD: record, MOCK_SPEED: '0.2', MOCK_RATE_LIMIT_REQUESTS: '2', MOCK_DROP_REQUESTS: '3', MOCK_STREAM_RATE_LIMIT_REQUESTS: '4', MOCK_STREAM_REQUESTED: '90000', MOCK_EVAL_MARK: evalMark });
  await wait(`http://localhost:${MOCK_PORT}/v1/responses`, 15000, { anyResponse: true });
  start([path.join(root, 'server', 'index.js')], { PORT: String(PORT), OPENAI_BASE_URL: `http://localhost:${MOCK_PORT}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl') });
  await wait(`http://localhost:${PORT}/api/health`);

  const health = await (await fetch(`http://localhost:${PORT}/api/health`)).json();
  const shape = health.request;
  check('no fallback list on either step', shape.extract.fallback === false && shape.evaluate.fallback === false);

  const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
  const claim = 'The Eiffel Tower stands about 330 metres tall.';
  const ex = await stream(`http://localhost:${PORT}/api/extract`, { text: source });
  // The page tests each claim's whole entry, with the source it came from, as the page does.
  const entry = ex.find((e) => e.t === 'done')?.claims?.[0]?.entry || claim;
  const ev = await stream(`http://localhost:${PORT}/api/evaluate`, { claims: [entry], text: source, source: { kind: 'text' } });

  const sent = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.path === '/v1/responses');
  // The extraction is sent and completed before the determination is sent, so arrival order is
  // identity. (Telling them apart by an instructions field stopped working once a prompt could
  // travel as the message itself.)
  check('five requests were sent: the extraction, a determination refused at the door, its retry that was cut, the retry refused inside its stream, and the one that completed', sent.length === 5, `${sent.length} requests`);
  const exBody = sent[0]?.body;
  const evBody = sent[sent.length - 1]?.body;
  const retries = ev.filter((e) => e.t === 'retry');
  const held = ev.filter((e) => e.t === 'phase' && e.phase === 'queued');
  check('a refusal at the door is handled in the gate (the claim waits what OpenAI asked, 0.7 s here, and goes again first); a cut connection is retried; a refusal inside the stream is waited out the same way and the claim goes again whole; the claim completes; never an error',
    held.some((e) => e.waitMs >= 650 && e.waitMs <= 1300 && e.position === 1)
      && retries.length === 2 && retries[0].reason === 'connection' && retries[1].reason === 'rate_limit' && retries[1].waitMs >= 650 && retries[1].waitMs <= 1300
      && ev.some((e) => e.t === 'done') && !ev.some((e) => e.t === 'error'),
    JSON.stringify(held.concat(retries, ev.filter((e) => e.t === 'error'))));
  const doneEv = ev.find((e) => e.t === 'done');
  check('the Conclusion section is read out of the entry for the closed row, and it names the verdict',
    Boolean(doneEv?.conclusion) && new RegExp(`^${doneEv?.verdict === 'unverified' ? '(uncertain|unverified)' : doneEv?.verdict}`, 'i').test(doneEv?.conclusion || ''),
    JSON.stringify(doneEv?.conclusion));
  check('extraction request captured', Boolean(exBody));
  check('determination request captured', Boolean(evBody));

  if (exBody) {
    check('extraction: model is the configured model', exBody.model === shape.extract.model, exBody.model);
    check('extraction: reasoning.effort is the configured effort', exBody.reasoning?.effort === shape.extract.effort, JSON.stringify(exBody.reasoning));
    check(`extraction: no keys beyond ${ALLOWED.extract.join(', ')}`, extraKeys(exBody, ALLOWED.extract).length === 0, extraKeys(exBody, ALLOWED.extract).join(', '));
    const exTools = exBody.tools || [];
    check('extraction: web search available (exactly one web_search, no options)', exTools.length === 1 && exTools[0].type === 'web_search' && extraKeys(exTools[0], ALLOWED.webSearchTool).length === 0, JSON.stringify(exTools));
    check('extraction: no reasoning keys beyond effort, summary', extraKeys(exBody.reasoning, ALLOWED.reasoning).length === 0, extraKeys(exBody.reasoning, ALLOWED.reasoning).join(', '));
    const exText = exBody.input?.[0]?.content?.[0]?.text;
    if (slot) {
      check('extraction: no instructions field (the prompt is the message)', exBody.instructions === undefined);
      // The slot takes the source with its attribution lines: for pasted text, the day it was pasted.
      const expected = extractPrompt.slice(0, slot.start) + sourceBlock(source, { kind: 'text' }) + extractPrompt.slice(slot.end);
      check('extraction: the prompt sent verbatim with the source and its attribution lines in place of its final bracketed line, as the only message',
        exBody.input?.length === 1 && exText === expected, `${exText?.length} vs ${expected.length} chars`);
    } else {
      check('extraction: prompt sent verbatim as instructions', exBody.instructions === extractPrompt, `${exBody.instructions?.length} vs ${extractPrompt.length} chars`);
      check('extraction: the document sent whole, as the only message', exBody.input?.length === 1 && exText === source);
    }
    const first = ex.find((e) => e.t === 'done')?.claims?.[0];
    check('extraction: each entry\'s claim is its Claim line, the further lines kept beside it verbatim',
      Boolean(first) && !/^claim:/i.test(first.text) && first.text.length > 0 && /^Attribution:/.test(first.more) && first.entry.startsWith(`Claim: ${first.text}`),
      JSON.stringify(first));
    check('extraction: store = false', exBody.store === false);
  }
  if (evBody) {
    const userText = evBody.input?.[evBody.input.length - 1]?.content?.[0]?.text;
    const ahead = evBody.input?.length === 2 ? evBody.input[0]?.content?.[0]?.text : null;
    check('determination: model is the configured model', evBody.model === shape.evaluate.model, evBody.model);
    check('determination: reasoning.effort is the configured effort', evBody.reasoning?.effort === shape.evaluate.effort, JSON.stringify(evBody.reasoning));
    check('determination: no keys beyond model, input, reasoning, tools, stream, store', extraKeys(evBody, ALLOWED.evaluate).length === 0, extraKeys(evBody, ALLOWED.evaluate).join(', '));
    check('determination: no reasoning keys beyond effort, summary', extraKeys(evBody.reasoning, ALLOWED.reasoning).length === 0, extraKeys(evBody.reasoning, ALLOWED.reasoning).join(', '));
    check('determination: no instructions field (nothing added around the prompt)', evBody.instructions === undefined);
    check('determination: the prompt sent verbatim with the claim\'s whole entry (Claim, Attribution, what is unspecified) in place of {{CLAIM}}', userText === evaluatePrompt.split('{{CLAIM}}').join(entry) && /^Claim:/.test(entry) && /\nAttribution:/.test(entry), `${userText?.length} chars; entry: ${JSON.stringify(entry).slice(0, 120)}`);
    check('determination: exactly two messages, the source ahead of the prompt exactly as the extractor received it, then the prompt', Array.isArray(evBody.input) && evBody.input.length === 2 && ahead === sourceBlock(source, { kind: 'text' }), `${evBody.input?.length} messages`);
    const tools = evBody.tools || [];
    check('determination: web search available (exactly one web_search, no options)', tools.length === 1 && tools[0].type === 'web_search' && extraKeys(tools[0], ALLOWED.webSearchTool).length === 0, JSON.stringify(tools));
    check('determination: store = false', evBody.store === false);
  }
  // The first requirement of the product: a prompt is never run on anyone else's key, because that
  // hands them the prompt. Both requests above offered one; neither may have used it.
  const authHeaders = [...new Set(sent.map((r) => r.auth || ''))];
  check('every request to OpenAI used the operator\'s key',
    authHeaders.length === 1 && authHeaders[0] === `Bearer ${KEY}`, authHeaders.join(' | ').replace(READER_KEY, 'A READER KEY WAS USED'));
  check('no request used the key offered by the browser',
    !sent.some((r) => (r.auth || '').includes(READER_KEY)), 'a reader key reached OpenAI');

  check('no fallback or truncation warnings in either stream', ![...ex, ...ev].some((e) => e.t === 'warning'), JSON.stringify([...ex, ...ev].filter((e) => e.t === 'warning')));
  const done = ev.find((e) => e.t === 'done');
  // The entry is what streamed after the last start: a retried determination begins again.
  const lastStart = ev.map((e, k) => (e.t === 'start' && e.i === 0 ? k : -1)).reduce((a, b) => Math.max(a, b), -1);
  const streamed = ev.filter((e, k) => k > lastStart && e.t === 'delta' && e.i === 0).map((e) => e.text).join('');
  check('determination: final text equals every streamed character (nothing stripped)', Boolean(done?.text) && done.text === streamed, `${done?.text?.length} vs ${streamed.length} chars`);
  check('determination: verdict read from the Conclusion, or Unverified when the Conclusion states neither True nor False (never guessed)', done?.verdictSource === 'conclusion' || (done?.verdict === 'unverified' && done?.verdictSource === 'unread'), `source=${done?.verdictSource} verdict=${done?.verdict}`);

  // What the gate learned, in OpenAI's own figure: the refusal said "Requested 68147".
  const pacing = (await (await fetch(`http://localhost:${PORT}/api/selftest`)).json()).pacing || [];
  const g = pacing.find((x) => x.model === shape.evaluate.model);
  check('the gate learned what OpenAI counts for a determination from OpenAI\'s own figures, exactly, the larger one from the refusal inside the stream, and reports both refusals on /check',
    g?.costs?.determination === 90000 && g?.refusals === 2 && g?.tokens?.limit === 5000000, JSON.stringify({ costs: g?.costs, refusals: g?.refusals, limit: g?.tokens?.limit }));
} catch (err) {
  check('run completed', false, err.message);
} finally {
  stop();
  try { fs.unlinkSync(record); } catch {}
}

for (const r of leakChecks()) results.push(r); // no line of the prompts may sit in a committed file

// The verdict reader, against the forms the model writes its Conclusion in. Each must read as
// the model meant; an entry that states no verdict at all is Unverified by the operator's ruling.
const FORMS = [
  ['6. **Conclusion**: True — the record states it.\n7. **Confidence**: 90%', 'true', 'conclusion'],
  ['**6. Conclusion**\nFalse. The record contradicts it.\n\n**7. Confidence**: 80%', 'false', 'conclusion'],
  ['### 6. Conclusion\n\n**Uncertain** — no primary record.\n\n### 7. Confidence\n40%', 'unverified', 'conclusion'],
  ['6. Conclusion — TRUE\n7. Confidence: 95%', 'true', 'conclusion'],
  ['6) Conclusion (False): the count was 17.\n7) Confidence: 85%', 'false', 'conclusion'],
  ['**Conclusion:** The evidence shows the claim is **True**.\n**Confidence:** 88%', 'true', 'conclusion'],
  ['6. **Conclusion**: It is not true that the figure was 19; the record shows 17. **False**.\n7. **Confidence**: 90%', 'false', 'conclusion'],
  ['Conclusion: Uncertain.\nConfidence: 50%', 'unverified', 'conclusion'],
  ['5. The record settles it.\nFinal verdict: **False** (confidence 80%)', 'false', 'tag'],
  ['6. **Conclusion**: Two records were compared, and both give the same count. Neither was contradicted. The statement is therefore true as worded.\n7. Confidence: 82%', 'true', 'conclusion'],
  ['6. Conclusion: Although the narrative is widely repeated as true, the primary record shows the figure was 17, not 19. False.\n7. Confidence: 90%', 'false', 'conclusion'],
  ['An entry with no conclusion and no verdict word at all.', 'unverified', 'unread'],
  // The operator's own entry of 17 September: section 6 states the verdict under a sub-heading,
  // and the Logic Audit after it names the conclusion at the start of a numbered line.
  [['## 6. Conclusion', '', '### False as written', '', 'During the fourteen House sitting weeks ending June 18, 2026, **22 pieces of legislation in total** received Royal Assent—not 19.', '',
    'This finding does **not** establish intentional deception.', '', '## 7. Confidence and Logic Audit', '', '**Confidence: 98%**', '',
    '1. **Documentary count:** approximately 99% confidence.', '3. **Conclusion–evidence match:** the verdict follows from the statutory tally; no step relies on narrative.'].join('\n'), 'false', 'conclusion'],
  [['4. **Analysis**', 'Provisional conclusion: True, pending the record.', 'The record was then read.', '', '6. **Conclusion**: False. The record shows 17.', '7. **Confidence**: 90%'].join('\n'), 'false', 'conclusion'],
];
for (const [text, want, from] of FORMS) {
  const got = parseEntry(text);
  check(`the reader takes the model's own verdict from: ${JSON.stringify(text.slice(0, 44))}… → ${want}`, got.verdict === want && got.verdictSource === from, `read ${got.verdict} from ${got.verdictSource}`);
}

// OpenAI's own arithmetic, from five refusals in one real run (16 September 2026): the wait it
// names is exactly what refills the difference at the limit per minute. The gate must reproduce it.
const ROWS = [
  { used: 500000, requested: 83734, said: 10048 }, { used: 453260, requested: 58013, said: 1352 },
  { used: 428810, requested: 83800, said: 1513 }, { used: 500000, requested: 82413, said: 9889 },
  { used: 463491, requested: 55926, said: 2330 },
];
for (const row of ROWS) {
  const b = new Bucket('tokens');
  b.observe({ limit: 500000, remaining: 500000 - row.used }, 0);
  const wait = b.waitFor(row.requested, 0);
  check(`the gate's wait is OpenAI's: Limit 500000, Used ${row.used}, Requested ${row.requested} → ${row.said} ms`, wait >= row.said && wait <= row.said + 3, `${wait} ms`);
}
const refusal = parseRefusal({ status: 429, error: { message: 'Rate limit reached for gpt-5.6-sol in organization org-x on tokens per min (TPM): Limit 500000, Used 500000, Requested 83734. Please try again in 10.048s. Visit https://platform.openai.com/account/rate-limits to learn more.', code: 'rate_limit_exceeded' } });
check('a refusal is read as OpenAI wrote it: the bucket, the limit, what was used, what this request costs, and the wait',
  refusal.bucket === 'tokens' && refusal.limit === 500000 && refusal.used === 500000 && refusal.requested === 83734 && refusal.waitMs === 10048 && !refusal.perDay, JSON.stringify(refusal));
const rpm = parseRefusal({ status: 429, error: { message: 'Rate limit reached for gpt-5.6-sol in organization org-x on requests per min (RPM): Limit 500, Used 500, Requested 1. Please try again in 120ms. Visit https://platform.openai.com/account/rate-limits to learn more.' } });
check('a requests-per-minute refusal is told from a tokens one', rpm.bucket === 'requests' && rpm.limit === 500 && rpm.requested === 1 && rpm.waitMs === 120, JSON.stringify(rpm));

// The connection, as the operating system reports it. The shape of 17 September: the SDK's
// "Connection error." over fetch's "fetch failed" over Node's report of trying every address of
// the name and being refused a route for each (an AggregateError with an empty message, its code
// the first address's). Each must be known as a connection failure, read in the system's words,
// and followed by the next go a second after the failed one began; an error OpenAI answered is
// none of that.
const addr = (code, address) => Object.assign(new Error(`connect ${code} ${address}:443`), { code, syscall: 'connect', address, port: 443 });
const everyAddress = (code) => Object.assign(new AggregateError([addr(code, '2606:4700::6810:1'), addr(code, '104.18.0.1')], ''), { code });
const viaSdk = (cause) => Object.assign(new Error('Connection error.'), { name: 'APIConnectionError', cause: new TypeError('fetch failed', { cause }) });
const NET = [
  [viaSdk(everyAddress('EHOSTUNREACH')), 'EHOSTUNREACH', 'no route to host'],
  [viaSdk(everyAddress('ENETUNREACH')), 'ENETUNREACH', 'the network is unreachable'],
  [viaSdk(addr('ECONNREFUSED', '127.0.0.1')), 'ECONNREFUSED', 'the connection was refused'],
  [viaSdk(Object.assign(new Error('getaddrinfo ENOTFOUND api.openai.com'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' })), 'ENOTFOUND', 'the name api.openai.com could not be resolved'],
  [Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }), 'UND_ERR_SOCKET', 'the connection was cut during the reply'],
  [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }), 'ECONNRESET', 'the connection was reset'],
];
for (const [err, code, why] of NET) {
  const w = connectionWait(err, 0, 400);
  check(`a connection failure is known as one and read in the system's words: ${code} → "${why}"; the next go a second after the failed one began (600 ms more here)`,
    isConnectionDrop(err) && w.code === code && w.why === why && w.waitMs === 600, JSON.stringify({ drop: isConnectionDrop(err), ...w }));
}
check('a failure that itself took longer than the interval is followed at once', connectionWait(NET[0][0], 0, 1400).waitMs === 0);
const described = describeError(viaSdk(everyAddress('EHOSTUNREACH'))).message;
check('the record of a connection failure names every address that was tried', /2606:4700::6810:1/.test(described) && /104\.18\.0\.1/.test(described) && /EHOSTUNREACH/.test(described), described);
const parameter = Object.assign(new Error('Unsupported value: reasoning.effort'), { status: 400, error: { message: 'Unsupported value: reasoning.effort' } });
check('an error OpenAI answered with a status is not a connection failure', !isConnectionDrop(parameter));

// The gate, proved against a stand-in that keeps OpenAI's rule: a bucket refilled continuously
// over the stand-in's minute (three seconds here), a cost per kind of request, a refusal with the
// exact figures when the bucket cannot hold a request.
const SIX = [1, 2, 3, 4, 5, 6].map((n) => `Claim number ${n} for the gate: the tower is ${300 + n} metres tall.`);
async function gateRun(n, env, { extraction = false, claims = SIX, serverEnv = {} } = {}) {
  const MOCK2 = MOCK_PORT + 10 + n, PORT2 = PORT + 10 + n;
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_HOLD_MS: '400', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '', ...env });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT2), OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), ...serverEnv });
  await wait(`http://localhost:${PORT2}/api/health`);
  const out = { events: [], ex: [], failure: '', stats: null, pacing: null };
  const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
  // As in a real run, an extraction goes first. The first request a CIVIC ever sends teaches the
  // gate the key's limit and nothing else (what the bucket held before it is not known); the first
  // determination is then sent into a full minute and teaches its cost exactly, and so is the
  // extraction that follows the claims.
  if (extraction) { try { await stream(`http://localhost:${PORT2}/api/extract`, { text }); } catch (err) { out.failure += ` first extraction: ${err.message}`; } }
  try { out.events = await stream(`http://localhost:${PORT2}/api/evaluate`, { claims }); } catch (err) { out.failure = err.message; }
  if (extraction) {
    try { out.ex = await stream(`http://localhost:${PORT2}/api/extract`, { text }); }
    catch (err) { out.failure += ` extraction: ${err.message}`; }
  }
  try { out.stats = await (await fetch(`http://localhost:${MOCK2}/v1/mock/stats`, { headers: { authorization: `Bearer ${KEY}` } })).json(); } catch (err) { out.failure += ` stats: ${err.message}`; }
  try { out.pacing = ((await (await fetch(`http://localhost:${PORT2}/api/selftest`)).json()).pacing || [])[0] || null; } catch {}
  try { server.kill('SIGTERM'); } catch {}
  try { mock.kill('SIGTERM'); } catch {}
  return out;
}
async function gateChecks() {
  const reserve = 68147;
  const done = (r) => r.events.filter((e) => e.t === 'done').length;
  const starts = (r) => { const d = (r.stats?.timeline || []).filter((e) => e.kind === 'determination'); return d.map((e) => e.at - d[0].at); };
  const twenty = { CIVIC_EVAL_CONCURRENCY: '20' };   // the gate's pacing is proved with claims allowed to run together

  // 0. The rule that runs: two claims at a time, never more, and none refused at the door or in its stream.
  {
    const r = await gateRun(3, { MOCK_TPM: '5000000', MOCK_RESERVE: String(reserve), MOCK_CONTINUATION: '90000' }, { claims: SIX.slice(0, 4) });
    check('claims run two at a time: two determinations run together and never a third, and none is refused at the door or in its stream',
      !r.failure && r.stats?.maxInFlight === 2 && r.stats?.refused === 0 && r.stats?.refusedInStream === 0 && done(r) === 4, `${r.failure} maxInFlight=${r.stats?.maxInFlight} refused=${r.stats?.refused} inStream=${r.stats?.refusedInStream} done=${done(r)}`);
  }

  // 1. Steady costs. The budget holds three; one more fits each second as the bucket refills.
  {
    const r = await gateRun(0, { MOCK_TPM: String(reserve * 3), MOCK_RESERVE: String(reserve), MOCK_WINDOW_MS: '3000' }, { extraction: true, serverEnv: twenty });
    const t = starts(r);
    check('the gate sends nothing the minute cannot hold: six claims, a budget of three, no refusal, all six finish',
      !r.failure && r.stats?.refused === 0 && done(r) === 6, `${r.failure} refused=${r.stats?.refused} admitted=${r.stats?.admitted} done=${done(r)}`);
    check('the fourth, fifth and sixth start as the bucket refills (one more each second here), not before and not long after',
      t.length === 6 && t[2] < 1000 && [3, 4, 5].every((k) => t[k] >= (k - 2) * 1000 - 50 && t[k] <= (k - 2) * 1000 + 1500), JSON.stringify(t));
    const held = r.events.filter((e) => e.t === 'phase' && e.phase === 'queued');
    check('the held claims said they were waiting, with the wait and their place in the line in figures', held.some((e) => e.waitMs > 0 && e.position >= 1), JSON.stringify(held.slice(0, 3)));
    check('each kind of request learns its own cost, exactly, from a request sent into a full minute: the determination, then the extraction',
      r.pacing?.costs?.determination === reserve && r.pacing?.costs?.extraction === reserve && r.ex.some((e) => e.t === 'done'), JSON.stringify(r.pacing?.costs));
  }
  // 2. A cost larger than any seen (OpenAI's estimate varies): refused once, learned from the refusal, never refused again.
  {
    const bigger = Math.round(reserve * 1.3);
    const r = await gateRun(1, { MOCK_TPM: String(reserve * 3), MOCK_RESERVE_SERIES: `${reserve},${reserve},${bigger}`, MOCK_WINDOW_MS: '3000' }, { serverEnv: twenty });
    check('a determination that costs more than any seen is refused once, the figure is learned from the refusal, and nothing is refused after it',
      !r.failure && r.stats?.refused === 1 && done(r) === 6 && r.pacing?.costs?.determination === bigger && !r.events.some((e) => e.t === 'error'),
      `${r.failure} refused=${r.stats?.refused} done=${done(r)} costs=${JSON.stringify(r.pacing?.costs)}`);
  }
  // 3. Requests per minute pace the same way: two per three seconds here, so one more every 1.5 s.
  {
    const r = await gateRun(2, { MOCK_TPM: '5000000', MOCK_RESERVE: String(reserve), MOCK_RPM: '2', MOCK_WINDOW_MS: '3000' }, { serverEnv: twenty });
    const t = starts(r);
    check('the requests-per-minute bucket paces the same way: two at once, then one every 1.5 s, no refusal',
      !r.failure && r.stats?.refused === 0 && done(r) === 6 && t.length === 6 && t[1] < 1000 && t[5] >= 4 * 1500 - 50 && t[5] <= 4 * 1500 + 2000, `${r.failure} refused=${r.stats?.refused} starts=${JSON.stringify(t)}`);
  }
}
await gateChecks();

// The connection that cannot be made. The server is started pointing at a port with nothing
// listening: the operating system refuses each connection before any request leaves, the same
// class of failure as the missing route of 17 September. Two claims are sent; the stand-in is
// started on that port three seconds later. The claims must wait, go again a second after each
// failed go began, and complete when the connection can be made: never an error, never a count.
async function outageChecks() {
  const MOCK2 = MOCK_PORT + 14, PORT2 = PORT + 14;
  const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT2), OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl') });
  await wait(`http://localhost:${PORT2}/api/health`);
  const run = stream(`http://localhost:${PORT2}/api/evaluate`, { claims: SIX.slice(0, 2) });
  await new Promise((r) => setTimeout(r, 3000));
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  let events = [];
  let failure = '';
  try { events = await run; } catch (err) { failure = err.message; }
  let failures = [];
  try { failures = (await (await fetch(`http://localhost:${PORT2}/api/selftest`)).json()).recentFailures || []; } catch (err) { failure += ` selftest: ${err.message}`; }
  try { server.kill('SIGTERM'); } catch {}
  try { mock.kill('SIGTERM'); } catch {}

  const retries = events.filter((e) => e.t === 'retry');
  const gaps = [0, 1].flatMap((i) => { const rs = retries.filter((e) => e.i === i); return rs.slice(1).map((e, k) => e.at - rs[k].at); });
  check('a connection that cannot be made is waited for, never counted: two claims, no route for three seconds, both complete with verdicts, never an error',
    !failure && events.filter((e) => e.t === 'done' && e.verdict).length === 2 && !events.some((e) => e.t === 'error'),
    `${failure} done=${events.filter((e) => e.t === 'done').length} errors=${JSON.stringify(events.filter((e) => e.t === 'error'))}`);
  check('every wait says why, in the system\'s words, and when it began',
    retries.length >= 4 && retries.every((e) => e.reason === 'connection' && e.code === 'ECONNREFUSED' && e.why === 'the connection was refused' && e.since > 0 && e.at >= e.since), JSON.stringify(retries.slice(0, 2)));
  check('the claim goes again a second after each failed go began, not sooner and not much later', gaps.length >= 2 && gaps.every((g) => g >= 900 && g <= 2500), JSON.stringify(gaps));
  const outage = failures.filter((f) => f.where === 'server:connection');
  check('/check records the outage once, with its cause and the machine\'s addresses, and once more when the connection is made again, with its length and the goes it took',
    outage.length === 2 && outage[1].code === 'ECONNREFUSED' && /addresses: /.test(outage[1].message) && outage[0].code === 'reachable' && /reachable again after \d+\.\d s and \d+ goes/.test(outage[0].message), JSON.stringify(outage));
}
await outageChecks();

// The run belongs to the server. A connection cut in the middle of an extraction or a determination
// stops nothing: the job goes on, and a page that attaches again, saying how many events it already
// has, receives the rest; one model call, paid once. A job is stopped by the page's cancel and
// nothing else; a finished job is kept until the page says it has it. (18 September: a relay on the
// reader's side cut a four-minute extraction that the server had finished, and it was lost.)
async function continuationChecks() {
  const MOCK2 = MOCK_PORT + 17, PORT2 = PORT + 17;
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EXTRACT_THINK_MS: '2500', MOCK_EVAL_HOLD_MS: '1500', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT2), OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl') });
  await wait(`http://localhost:${PORT2}/api/health`);
  const base = `http://localhost:${PORT2}`;
  const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
  const stats = async () => (await (await fetch(`http://localhost:${MOCK2}/v1/mock/stats`, { headers: { authorization: `Bearer ${KEY}` } })).json());
  const health = async () => (await (await fetch(`${base}/api/health`)).json());
  const post = async (url, body) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());
  const calls = (st, kind) => (st.timeline || []).filter((e) => e.kind === kind).length;
  const counted = (events) => events.filter((e) => e.t !== 'ping' && e.t !== 'attached');
  // A page whose connection is cut: it reads `n` of the job's events and destroys its own socket.
  const cut = (url, body, n) => new Promise((resolve) => {
    const events = [];
    let buf = '';
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.t === 'ping') continue;
          events.push(ev);
          if (counted(events).length >= n) { req.destroy(); resolve({ events, status: res.statusCode }); return; }
        }
      });
      res.on('end', () => resolve({ events, status: res.statusCode, ended: true }));
      res.on('error', () => resolve({ events, status: res.statusCode }));
    });
    req.on('error', () => resolve({ events }));
    req.end(JSON.stringify(body));
  });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  let failure = '';
  try {
    // 1. An extraction cut three events in, attached again with the count: the rest arrives, once.
    const xid = `verify-extract-${Date.now()}`;
    const first = await cut(`${base}/api/extract`, { jobId: xid, text }, 3);
    const during = await health();
    const rest = await stream(`${base}/api/extract`, { jobId: xid, text: 'not read: the job is known by its id', cursor: counted(first.events).length });
    const joined = rest.find((e) => e.t === 'attached');
    const all = [...counted(first.events), ...counted(rest)];
    const done = all.find((e) => e.t === 'done');
    const claimNs = all.filter((e) => e.t === 'claim').map((e) => e.n);
    const s1 = await stats();
    check('an extraction whose connection is cut goes on at the server: the health line counts it in flight with nobody connected',
      first.events[0]?.t === 'attached' && first.events[0].from === 0 && counted(first.events).length === 3 && during.active === 1, `first=${JSON.stringify(first.events.map((e) => e.t))} active=${during.active}`);
    check('the page attaches again with the number of events it has and receives exactly the rest, through to the result',
      joined && joined.from === 3 && Boolean(done) && done.total === 3 && JSON.stringify(claimNs) === '[1,2,3]', `joined=${JSON.stringify(joined)} done=${done?.total} claims=${JSON.stringify(claimNs)}`);
    check('one model call for the whole extraction: nothing run twice, nothing paid twice', calls(s1, 'extraction') === 1, `extractions=${calls(s1, 'extraction')}`);
    // 2. A finished job is kept until the page lets go of it: attaching with everything replays nothing and runs nothing.
    const again = await stream(`${base}/api/extract`, { jobId: xid, text, cursor: all.length });
    const s2 = await stats();
    const released = await post(`${base}/api/release`, { jobIds: [xid] });
    check('a finished job is kept until the page says it has it: attaching again with everything replays nothing, starts nothing, and the release lets it go',
      again.length >= 1 && again[0].t === 'attached' && again[0].finished === true && again[0].from === all.length && counted(again).length === 0 && calls(s2, 'extraction') === 1 && released.released === 1 && (await health()).active === 0,
      `again=${JSON.stringify(again.map((e) => e.t))} extractions=${calls(s2, 'extraction')} released=${JSON.stringify(released)}`);
    // 3. A determination, cut and attached again the same way: the verdict arrives, one model call.
    const cid = `verify-claim-${Date.now()}`;
    const c1 = await cut(`${base}/api/evaluate`, { jobId: cid, claims: [SIX[0]] }, 3);
    const c2 = await stream(`${base}/api/evaluate`, { jobId: cid, claims: [SIX[0]], cursor: counted(c1.events).length });
    const cAll = [...counted(c1.events), ...counted(c2)];
    const cDone = cAll.find((e) => e.t === 'done');
    const cJoined = c2.find((e) => e.t === 'attached');
    const s3 = await stats();
    await post(`${base}/api/release`, { jobIds: [cid] });
    check('a determination whose connection is cut is completed at the server and its verdict reaches the page that attaches again; one model call',
      cJoined?.from === 3 && Boolean(cDone?.verdict) && cAll.filter((e) => e.t === 'start').length === 1 && cAll.filter((e) => e.t === 'done').length === 1 && calls(s3, 'determination') === 1,
      `joined=${JSON.stringify(cJoined)} verdict=${cDone?.verdict} starts=${cAll.filter((e) => e.t === 'start').length} determinations=${calls(s3, 'determination')}`);
    // 4. Cancel is what stops a job: the model call is aborted and the run is no longer in flight.
    const kid = `verify-cancel-${Date.now()}`;
    await cut(`${base}/api/extract`, { jobId: kid, text }, 1);
    const before = await health();
    const cancelled = await post(`${base}/api/cancel`, { jobIds: [kid] });
    let inFlight = null;
    for (let k = 0; k < 20; k++) { inFlight = (await stats()).inFlight; if (inFlight === 0) break; await settle(100); }
    check('only the page\'s cancel stops a job: the extraction was in flight with its connection gone, and the cancel aborted the model call and cleared the run',
      before.active === 1 && cancelled.cancelled === 1 && (await health()).active === 0 && inFlight === 0, `before=${before.active} cancelled=${JSON.stringify(cancelled)} after=${(await health()).active} mockInFlight=${inFlight}`);
  } catch (err) {
    failure = err.message;
    check('continuation checks ran', false, failure);
  }
  try { server.kill('SIGTERM'); } catch {}
  try { mock.kill('SIGTERM'); } catch {}
}
await continuationChecks();

// The door. With codes set, the API needs the cookie a listed code earns; the page, the health line
// and the sign-in itself stay open. A cookie is bound to the code it was issued under: taking that
// code off the list signs out its holders and nobody else. The health line counts runs in flight.
const seen = new Set(Array.from({ length: 200 }, generateCode));
check('a generated code is seven characters from the alphabet without look-alikes, and two hundred of them are all different',
  seen.size === 200 && [...seen].every((c) => new RegExp(`^[${ALPHABET}]{7}$`).test(c)) && !/[01OIL]/.test(ALPHABET), [...seen].slice(0, 3).join(' '));
check('a code typed in lower case with spaces and dashes is read as the listed one', normalise(' ab cd-234 ') === 'ABCD234', normalise(' ab cd-234 '));
async function accessChecks() {
  const MOCK2 = MOCK_PORT + 15, PORT2 = PORT + 15, PORT3 = PORT + 16;
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const env = { OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), CIVIC_SIGNIN_LOG: path.join(os.tmpdir(), 'civic-verify-signins.jsonl') };
  const server = start([path.join(root, 'server', 'index.js')], { ...env, PORT: String(PORT2), CIVIC_ACCESS_CODES: 'ABCD234,EFGH567' });
  const other = start([path.join(root, 'server', 'index.js')], { ...env, PORT: String(PORT3), CIVIC_ACCESS_CODES: 'EFGH567' });
  await wait(`http://localhost:${PORT2}/api/health`);
  await wait(`http://localhost:${PORT3}/api/health`);
  const base = `http://localhost:${PORT2}`;
  const json = async (url, init) => { const r = await fetch(url, init); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
  const post = (url, body, headers = {}) => json(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level.';
  try {
    const health = await json(`${base}/api/health`);
    check('the health line stays open with codes set, says a sign-in is required, names no session, and counts no run in flight',
      health.status === 200 && health.body?.access?.required === true && health.body?.access?.session === null && health.body?.active === 0, JSON.stringify({ status: health.status, access: health.body?.access, active: health.body?.active }));
    const refused = await post(`${base}/api/extract`, { text });
    check('without a sign-in the API refuses with signin_required', refused.status === 401 && refused.body?.error?.code === 'signin_required', JSON.stringify(refused));
    const wrong = await post(`${base}/api/signin`, { email: 'x@example.com', code: 'ZZZZ999' });
    check('a code not on the list is refused in those words, and no cookie is set', wrong.status === 401 && wrong.body?.error?.code === 'code_not_listed' && !wrong.cookie, JSON.stringify(wrong));
    const ok = await post(`${base}/api/signin`, { email: 'reader@example.com', code: 'abcd-234' });
    check('a listed code, typed in lower case with a dash, signs in and sets the cookie', ok.status === 200 && ok.body?.session?.email === 'reader@example.com' && ok.cookie.startsWith('civic_access='), JSON.stringify(ok));
    const cookie = ok.cookie;
    const named = await json(`${base}/api/health`, { headers: { cookie } });
    check('the health line then names the session', named.body?.access?.session?.email === 'reader@example.com', JSON.stringify(named.body?.access));
    const res = await fetch(`${base}/api/extract`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text }) });
    const during = await json(`${base}/api/health`);
    const streamed = await res.text();
    const after = await json(`${base}/api/health`);
    check('with the cookie the extraction streams and completes; while it streams the health line counts one run in flight, and none after',
      res.status === 200 && /"t":"done"/.test(streamed) && during.body?.active === 1 && after.body?.active === 0, `status=${res.status} during=${during.body?.active} after=${after.body?.active}`);
    const selftestNo = await json(`${base}/api/selftest`);
    const selftest = await json(`${base}/api/selftest`, { headers: { cookie } });
    check('the check page\'s data needs the cookie, and then lists the sign-in with its email',
      selftestNo.status === 401 && selftest.status === 200 && selftest.body?.signins?.[0]?.email === 'reader@example.com' && selftest.body?.access?.required === true, JSON.stringify({ without: selftestNo.status, with: selftest.status, signins: selftest.body?.signins }));
    const revoked = await json(`http://localhost:${PORT3}/api/health`, { headers: { cookie } });
    const okB = await post(`${base}/api/signin`, { email: 'b@example.com', code: 'EFGH567' });
    const stillIn = await json(`http://localhost:${PORT3}/api/health`, { headers: { cookie: okB.cookie } });
    check('taking a code off the list signs out exactly its holders: on a CIVIC without ABCD234 the cookie issued under it proves nothing, and one issued under EFGH567 is honoured',
      revoked.body?.access?.session === null && stillIn.body?.access?.session?.email === 'b@example.com', JSON.stringify({ revoked: revoked.body?.access, stillIn: stillIn.body?.access }));
    const out = await post(`${base}/api/signout`, {}, { cookie });
    check('signing out clears the cookie', out.status === 200 && out.cookie === 'civic_access=', JSON.stringify(out));
  } catch (err) {
    check('the door\'s checks completed', false, err.message);
  }
  try { server.kill('SIGTERM'); } catch {}
  try { other.kill('SIGTERM'); } catch {}
  try { mock.kill('SIGTERM'); } catch {}
}
await accessChecks();

// Runs per code (server/uses.js). A use is a run started; a connection that joins a run already
// started is not one; a code's own entry may carry its allowance (ABCD234:2); the general
// allowance is CIVIC_CODE_USES; the count is a file, so a restart forgets nothing.
async function usesChecks() {
  const MOCK2 = MOCK_PORT + 18, PORT2 = PORT + 18;
  const usesFile = path.join(os.tmpdir(), `civic-verify-uses-${Date.now()}.jsonl`);
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const env = { OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), CIVIC_SIGNIN_LOG: path.join(os.tmpdir(), 'civic-verify-signins.jsonl'), CIVIC_USES_FILE: usesFile, CIVIC_ACCESS_CODES: 'ABCD234:2,EFGH567', CIVIC_CODE_USES: '1', PORT: String(PORT2) };
  let server = start([path.join(root, 'server', 'index.js')], env);
  await wait(`http://localhost:${PORT2}/api/health`);
  const base = `http://localhost:${PORT2}`;
  const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level.';
  const signin = async (code) => { const r = await fetch(`${base}/api/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${code.toLowerCase()}@verify`, code }) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
  const run = async (cookie, jobId) => {
    const res = await fetch(`${base}/api/extract`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text, jobId }) });
    if (!res.ok) return { status: res.status, body: await res.json().catch(() => null) };
    const body = await res.text();
    return { status: res.status, done: /"t":"done"/.test(body) };
  };
  const codesOn = async (cookie) => ((await (await fetch(`${base}/api/selftest`, { headers: { cookie } })).json()).codes || []);
  try {
    const a = await signin('ABCD234');
    const b = await signin('EFGH567');
    const r1 = await run(a, 'verify-uses-a1');
    const r1again = await run(a, 'verify-uses-a1');   // the same run joined again: not a use
    const r2 = await run(a, 'verify-uses-a2');
    const r3 = await run(a, 'verify-uses-a3');
    check('a code with its own allowance (ABCD234:2) starts two runs, joining a run already started counts nothing, and the third run is refused with the figures',
      r1.done && r1again.status === 200 && r2.done && r3.status === 403 && r3.body?.error?.code === 'code_used_up' && /used 2 times; it allows 2/.test(r3.body?.error?.message || ''), JSON.stringify({ r1: r1.status, again: r1again.status, r2: r2.status, r3 }));
    const s1 = await run(b, 'verify-uses-b1');
    const s2 = await run(b, 'verify-uses-b2');
    check('a code without its own figure has the general allowance (CIVIC_CODE_USES, 1 here): one run, then refused',
      s1.done && s2.status === 403 && s2.body?.error?.code === 'code_used_up', JSON.stringify({ s1: s1.status, s2 }));
    const figures = await codesOn(a);
    check('/check lists each code by its ending with the runs used and allowed',
      JSON.stringify(figures) === JSON.stringify([{ ending: '34', used: 2, allowed: 2 }, { ending: '67', used: 1, allowed: 1 }]), JSON.stringify(figures));
    // A restart in place (a deploy, with the file on the disk): the count is what it was.
    try { server.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    server = start([path.join(root, 'server', 'index.js')], env);
    await wait(`http://localhost:${PORT2}/api/health`);
    const r4 = await run(a, 'verify-uses-a4');
    const after = await codesOn(a);
    check('the count survives a restart: the file is read at start and the refusal stands',
      r4.status === 403 && JSON.stringify(after) === JSON.stringify(figures), JSON.stringify({ r4: r4.status, after }));
    const lines = fs.readFileSync(usesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('the record holds a fingerprint of the code, its last two characters, the email and the job, and never the code itself',
      lines.length === 3 && lines.every((l) => l.fp && l.fp.length === 16 && !/ABCD234|EFGH567/.test(JSON.stringify(l)) && /^[A-Z0-9]{2}$/.test(l.code) && l.email && l.job), JSON.stringify(lines[0]));
  } catch (err) {
    check('uses checks ran', false, err.message);
  }
  try { server.kill('SIGTERM'); } catch {}
  try { mock.kill('SIGTERM'); } catch {}
  try { fs.unlinkSync(usesFile); } catch {}
}
await usesChecks();

// The visual echo is an edit of the CIVIC photograph, sent with every request as the style
// reference (the operator's rule of 18 September): the picture takes its style and none of its
// content, and the request carries nothing beyond the knobs the operator tested with.
async function illustrateChecks() {
  const MOCK2 = MOCK_PORT + 19, PORT2 = PORT + 19;
  const record2 = path.join(os.tmpdir(), `civic-verify-illustrate-${Date.now()}.jsonl`);
  const ledger2 = path.join(os.tmpdir(), `civic-verify-illustrate-ledger-${Date.now()}.jsonl`);
  const reference = path.join(root, 'public', 'assets', 'civic-scene-1920.jpg');
  const referenceBytes = fs.statSync(reference).size;
  const source = fs.readFileSync(path.join(root, 'server', 'illustrate.js'), 'utf8');
  const style = (source.match(/export const STYLE_REFERENCE = `([^`]*)`;/) || [])[1] || '';
  const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level.';
  const session = async (mockEnv) => {
    fs.writeFileSync(record2, '');
    const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_RECORD: record2, MOCK_SPEED: '0.2', ...mockEnv });
    await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
    const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT2), OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_LEDGER_FILE: ledger2 });
    await wait(`http://localhost:${PORT2}/api/health`);
    try {
      const res = await fetch(`http://localhost:${PORT2}/api/illustrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      const reply = await res.json();
      const lines = fs.readFileSync(record2, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const ledger = fs.existsSync(ledger2) ? fs.readFileSync(ledger2, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      return { status: res.status, reply, edits: lines.filter((l) => l.path === '/v1/images/edits'), generations: lines.filter((l) => l.path === '/v1/images/generations'), ledger: ledger.filter((l) => l.kind === 'illustrate') };
    } finally {
      try { server.kill('SIGTERM'); } catch {}
      try { mock.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  const isReference = (part) => part && part.name === 'civic-scene-1920.jpg' && part.type === 'image/jpeg' && part.bytes === referenceBytes;
  try {
    const a = await session({});
    const body = a.edits[0]?.body || {};
    check('the echo is requested as an edit, never a generation, and the photograph itself goes with it (name, type and every byte)',
      a.status === 200 && a.edits.length === 1 && a.generations.length === 0 && isReference(body.image), JSON.stringify({ status: a.status, edits: a.edits.length, generations: a.generations.length, image: body.image }));
    const sent = String(body.prompt || '').split('\n\nSTYLE:\n')[1] || '';
    check('the prompt ends with the style instruction verbatim: style only, none of the picture\'s content, no text of any kind',
      style.length > 100 && sent === style && /no part of its\s+scene/.test(sent) && /Absolutely no text, letters, numbers/.test(sent) && !/\bpark\b|\bpeople\b|\bbuilding|\bCIVIC\b/i.test(sent), JSON.stringify({ styleChars: style.length, sentChars: sent.length, equal: sent === style }));
    const keys = Object.keys(body).sort();
    const allowed = ['image', 'model', 'n', 'output_compression', 'output_format', 'prompt', 'quality', 'size'];
    check('the edit carries only model, image, prompt, n, size, quality, output_format and output_compression, on the operator\'s key',
      keys.every((k) => allowed.includes(k)) && keys.includes('image') && keys.includes('prompt') && a.edits[0].auth === `Bearer ${KEY}`, JSON.stringify(keys));
    check('the page receives the picture as a data URL with its cost, no model name, and the ledger line records the reference and OpenAI\'s usage figures',
      typeof a.reply?.dataUrl === 'string' && a.reply.dataUrl.startsWith('data:image/jpeg;base64,') && a.reply.cost?.priced === true && !('model' in a.reply)
        && a.ledger.length === 1 && a.ledger[0].reference === 'civic-scene-1920.jpg' && a.ledger[0].usage?.input_tokens_details?.image_tokens > 0 && a.ledger[0].model === 'gpt-image-2.5-flare',
      JSON.stringify({ keys: Object.keys(a.reply || {}), ledger: a.ledger[0] }));
    const b = await session({ MOCK_IMAGE_REJECT_KNOBS: '1' });
    const second = b.edits[1]?.body || {};
    check('an image model that rejects the newer knobs gets one retry with the minimal set, the photograph streamed afresh, and the picture still arrives',
      b.status === 200 && b.edits.length === 2 && Object.keys(second).sort().join(',') === 'image,model,n,prompt,size' && isReference(second.image) && typeof b.reply?.dataUrl === 'string',
      JSON.stringify({ status: b.status, edits: b.edits.length, secondKeys: Object.keys(second).sort(), image: second.image }));
  } finally {
    try { fs.unlinkSync(record2); } catch {}
    try { fs.unlinkSync(ledger2); } catch {}
  }
}
await illustrateChecks();

// The port is CIVIC's. An older CIVIC still holding it is closed and the port taken over; anything
// else on it is left alone and named. Both are proved here with stand-in processes: one that runs
// from CIVIC's own directory, as an installed copy does, and one that does not.
async function takeoverChecks() {
  const holder = (cwd, port) => {
    const child = spawn(process.execPath, ['-e', `require('node:http').createServer().listen(${port}, () => process.send && process.send('up'))`],
      { cwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return new Promise((resolve) => child.on('message', () => resolve(child)));
  };
  const alive = (child) => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const env = { OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl') };

  // 1. An older CIVIC (a process running from CIVIC's directory) holds the port: it must be closed.
  const older = await holder(root, PORT + 1);
  const taker = start([path.join(root, 'server', 'index.js')], { ...env, PORT: String(PORT + 1) });
  let took = false;
  try { await wait(`http://localhost:${PORT + 1}/api/health`, 20000); took = true; } catch {}
  await settle(300);
  check('an older CIVIC holding the port is closed and the port taken over', took && !alive(older), took ? 'the older process is still alive' : 'the new CIVIC never answered');
  try { taker.kill('SIGTERM'); } catch {}
  try { older.kill('SIGKILL'); } catch {}

  // 2. Something that is not CIVIC holds the port: it must be left alone, and CIVIC must say so.
  const other = await holder(os.tmpdir(), PORT + 2);
  const refused = start([path.join(root, 'server', 'index.js')], { ...env, PORT: String(PORT + 2) });
  let stderr = '';
  refused.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => { refused.on('exit', resolve); setTimeout(() => resolve('timeout'), 20000); });
  check('a process that is not CIVIC on the port is left alone, and CIVIC says so',
    code === 1 && alive(other) && /STOPPED: port \d+ is already in use/.test(stderr) && /not CIVIC/.test(stderr),
    `exit ${code}, other alive=${alive(other)}, stderr: ${stderr.trim().slice(0, 160)}`);
  try { other.kill('SIGKILL'); } catch {}
}
await takeoverChecks();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   ← ${r.detail}`}`);
console.log(failed.length
  ? `\n${failed.length} FAILED. A request carries something the operator did not configure.`
  : `\nAll ${results.length} checks passed. Requests carry the configured model and effort, the prompts verbatim, web search on both steps, and nothing else.`);
process.exit(failed.length ? 1 : 0);
