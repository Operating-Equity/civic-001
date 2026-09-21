// The guard. Starts the mock and the server, runs an extraction and a determination, then reads
// the request bodies the server ACTUALLY SENT to the API and fails if they carry anything but the
// operator's configuration: the configured model, the configured reasoning effort, the prompts
// verbatim, web search. Any other key in a request body is a failure, whoever added it.
// It also runs the prompt leak guard: no committed file may contain a fragment of the prompts.
// Run before every deploy: `npm run verify`. A non-zero exit is a defect.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { leakChecks } from './leak-check.mjs';
import { sourceBlock } from '../server/source.js';
import { Bucket, parseRefusal } from '../server/gate.js';
import { parseEntry } from '../server/verdict.js';
import { isConnectionDrop, connectionWait, describeError } from '../server/openai.js';
import { generateCode, normalise, ALPHABET } from '../server/access.js';
import { validateStandIn } from '../server/tools/contract.js';
import { requestShape } from '../server/config.js';

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
  reasoning: ['effort', 'mode', 'summary'],
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
  check('no token figures reach the page: neither the extraction\'s nor the determination\'s done event carries usage (the ledger keeps it)',
    !('usage' in (ex.find((e) => e.t === 'done') || {})) && !('usage' in (doneEv || {})) && !ev.some((e) => JSON.stringify(e).includes('"usage"')) && !ex.some((e) => JSON.stringify(e).includes('"usage"')),
    JSON.stringify(Object.keys(doneEv || {})));
  check('the Conclusion section is read out of the entry for the closed row, and it names the verdict',
    Boolean(doneEv?.conclusion) && new RegExp(`^${doneEv?.verdict === 'unverified' ? '(uncertain|unverified)' : doneEv?.verdict}`, 'i').test(doneEv?.conclusion || ''),
    JSON.stringify(doneEv?.conclusion));
  check('extraction request captured', Boolean(exBody));
  check('determination request captured', Boolean(evBody));

  if (exBody) {
    check('extraction: model is the configured model', exBody.model === shape.extract.model, exBody.model);
    check('extraction: reasoning.effort is the configured effort', exBody.reasoning?.effort === shape.extract.effort, JSON.stringify(exBody.reasoning));
    check('extraction: reasoning.mode is the configured mode (pro), and the key is there only when a mode is set', (exBody.reasoning?.mode ?? null) === shape.extract.mode && ('mode' in (exBody.reasoning || {})) === Boolean(shape.extract.mode), JSON.stringify({ sent: exBody.reasoning, configured: shape.extract.mode }));
    check(`extraction: no keys beyond ${ALLOWED.extract.join(', ')}`, extraKeys(exBody, ALLOWED.extract).length === 0, extraKeys(exBody, ALLOWED.extract).join(', '));
    const exTools = exBody.tools || [];
    check('extraction: web search available (exactly one web_search, no options)', exTools.length === 1 && exTools[0].type === 'web_search' && extraKeys(exTools[0], ALLOWED.webSearchTool).length === 0, JSON.stringify(exTools));
    check('extraction: no reasoning keys beyond effort, mode, summary', extraKeys(exBody.reasoning, ALLOWED.reasoning).length === 0, extraKeys(exBody.reasoning, ALLOWED.reasoning).join(', '));
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
    check('determination: reasoning.mode is the configured mode (pro), and the key is there only when a mode is set', (evBody.reasoning?.mode ?? null) === shape.evaluate.mode && ('mode' in (evBody.reasoning || {})) === Boolean(shape.evaluate.mode), JSON.stringify({ sent: evBody.reasoning, configured: shape.evaluate.mode }));
    check('determination: no keys beyond model, input, reasoning, tools, stream, store', extraKeys(evBody, ALLOWED.evaluate).length === 0, extraKeys(evBody, ALLOWED.evaluate).join(', '));
    check('determination: no reasoning keys beyond effort, mode, summary', extraKeys(evBody.reasoning, ALLOWED.reasoning).length === 0, extraKeys(evBody.reasoning, ALLOWED.reasoning).join(', '));
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
// The mode is a setting: `standard` (or empty) sends today's reasoning object, with no mode key at all.
async function modeChecks() {
  const modeRecord = path.join(os.tmpdir(), `civic-verify-mode-${Date.now()}.jsonl`);
  const r = await gateRun(9, { MOCK_RECORD: modeRecord }, { extraction: true, claims: [SIX[0]], serverEnv: { CIVIC_REASONING_MODE: 'standard' } });
  const bodies = fs.existsSync(modeRecord) ? fs.readFileSync(modeRecord, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.path === '/v1/responses').map((x) => x.body) : [];
  check('with CIVIC_REASONING_MODE=standard no request carries a mode key: the reasoning object is effort and summary alone, the effort still the configured one',
    bodies.length >= 2 && bodies.every((b) => !('mode' in (b.reasoning || {})) && b.reasoning?.effort === requestShape().evaluate.effort) && !r.failure, JSON.stringify({ reasoning: bodies.map((b) => b.reasoning), failure: r.failure }));
}
await modeChecks();

async function gateChecks() {
  const reserve = 68147;
  const done = (r) => r.events.filter((e) => e.t === 'done').length;
  const starts = (r) => { const d = (r.stats?.timeline || []).filter((e) => e.kind === 'determination'); return d.map((e) => e.at - d[0].at); };
  const twenty = { CIVIC_EVAL_CONCURRENCY: '20' };   // the gate's pacing is proved with claims allowed to run together

  // 0. The rule that runs: four claims at a time, never more, and none refused at the door or in its stream.
  {
    const r = await gateRun(3, { MOCK_TPM: '5000000', MOCK_RESERVE: String(reserve), MOCK_CONTINUATION: '90000' }, { claims: SIX });
    check('claims run four at a time: four determinations run together and never a fifth, and none is refused at the door or in its stream',
      !r.failure && r.stats?.maxInFlight === 4 && r.stats?.refused === 0 && r.stats?.refusedInStream === 0 && done(r) === 6, `${r.failure} maxInFlight=${r.stats?.maxInFlight} refused=${r.stats?.refused} inStream=${r.stats?.refusedInStream} done=${done(r)}`);
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
  // Its own uses file: the run counted here must not accumulate across guard runs (the default file
  // under data/ did, and the sixth run of a day was refused as a code used up).
  const usesFile = path.join(os.tmpdir(), `civic-verify-access-uses-${Date.now()}.jsonl`);
  const env = { OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), CIVIC_SIGNIN_LOG: path.join(os.tmpdir(), 'civic-verify-signins.jsonl'), CIVIC_USES_FILE: usesFile };
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
  try { fs.unlinkSync(usesFile); } catch {}
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
      let ledger = [];
      for (let i = 0; i < 20 && !ledger.some((l) => l.kind === 'illustrate'); i++) { // the ledger line is appended after the reply is sent; wait for it
        if (i) await new Promise((r) => setTimeout(r, 100));
        ledger = fs.existsSync(ledger2) ? fs.readFileSync(ledger2, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      }
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

// A link the server cannot read tells the reader what to do, at once (18 September): no link is
// refused by its shape (a Google app link is tried like any other and read where it leads, a page that
// is only a meta refresh is followed like a redirect), an open Google redirect is unwrapped, an unreachable address gets
// plain words with the cause recorded for the operator, and a read the page abandons is no failure.
/** The model writes a formula as mathematics. Markdown reads a line holding only "=" or only "-" as an
 *  underline for the line above: it deletes the operator and makes a heading of the term. The page parks
 *  each formula under a name Markdown cannot touch, and this proves nothing is lost on the way. */
async function formulaChecks() {
  const { splitMath } = await import(new URL('../public/js/render.js', import.meta.url));
  const entry = [
    '4. **Stock-flow accounting:**',
    '   \\[',
    '   \\text{Future inventory}',
    '   =',
    '   \\text{current unsold inventory}',
    '   +',
    '   \\text{completions}',
    '   -',
    '   \\text{net absorption}.',
    '   \\]',
    '',
    'An entry plan costs $5 a month and $54 a year, and \\(x\\) is inline.',
    '',
    '```',
    'a code block with \\[ not a formula \\]',
    '```',
  ].join('\n');
  const out = splitMath(entry);
  check('a formula the model wrote survives the text formatter whole: its equals sign and its minus sign are still there',
    out.spans.length === 2 && out.spans[0].display === true && /=/.test(out.spans[0].tex) && /-/.test(out.spans[0].tex) && /Future inventory/.test(out.spans[0].tex), JSON.stringify(out.spans));
  check('an inline formula is marked inline, and sums of money are never mistaken for mathematics',
    out.spans[1]?.display === false && out.spans[1]?.tex === 'x' && /\$5 a month and \$54 a year/.test(out.text), JSON.stringify({ second: out.spans[1], text: out.text.slice(-120) }));
  check('a formula shown inside a code block is left exactly as it was written',
    /a code block with \\\[ not a formula \\\]/.test(out.text), JSON.stringify(out.text.slice(-80)));
  check('nothing but the formulas is moved: the heading line and the list number are untouched',
    /^4\. \*\*Stock-flow accounting:\*\*$/m.test(out.text), JSON.stringify(out.text.slice(0, 60)));
}
await formulaChecks();

/** The guard's stand-in site: pages that answer every way a site can, and a stand-in YouTube and
 * transcript service; what the stand-in YouTube and the service were asked lands in `calls`. Shared by
 * the link checks and the tool checks. */
function standInSite(SITE, { ytCalls, capCalls, transcriptCalls, jobCalls }) {
  return (req, res) => {
    if (req.url.startsWith('/page')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><title>A page of facts</title></head><body><article><p>${'The Eiffel Tower stands about 330 metres tall. '.repeat(8)}</p></article></body></html>`); return; }
    if (req.url.startsWith('/goto')) { res.writeHead(302, { location: '/page' }); res.end(); return; }
    if (req.url.startsWith('/meta-loop')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><meta http-equiv="refresh" content="0;url=/meta-loop"><title>Loop</title></head><body><a href="/meta-loop">Continue</a></body></html>'); return; }
    if (req.url.startsWith('/meta')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><meta http-equiv="refresh" content="0; URL=\'/page\'"><title>Go</title></head><body><a href="/page">Continue</a></body></html>'); return; }
    if (req.url.startsWith('/slow')) { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><title>Slow</title></head><body><p>${'Water boils at 100 degrees Celsius at sea level. '.repeat(8)}</p></body></html>`); }, 2500); return; }
    // A site that keeps its text: a refusal at the door, a paywall marked the way Google News reads it
    // (with a teaser, or with the whole text), a wall said in prose, and a shell built by scripts.
    const marker = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Behind the wall","isAccessibleForFree":"False","hasPart":{"@type":"WebPageElement","isAccessibleForFree":"False","cssSelector":".paywall"}}</script>';
    const head = (title) => `<head><title>${title}</title><meta property="og:site_name" content="The Daily Stand-in">`;
    const prose = (n) => `<p>${'Water boils at 100 degrees Celsius at sea level, and the Eiffel Tower stands about 330 metres tall. '.repeat(n)}</p>`;
    if (req.url.startsWith('/refuse')) { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html><body>Forbidden</body></html>'); return; }
    if (req.url.startsWith('/paywalled-teaser')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html>${head('Behind the wall')}${marker}</head><body><article>${prose(1)}<div class="paywall"><p>Subscribe to continue reading.</p></div></article></body></html>`); return; }
    if (req.url.startsWith('/paywalled-full')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html>${head('Behind the wall')}${marker}</head><body><article>${prose(3)}${prose(3)}${prose(3)}</article></body></html>`); return; }
    if (req.url.startsWith('/paywalled')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html>${head('Behind the wall')}${marker}</head><body><article>${prose(3)}<div class="paywall"><p>Subscribe to continue reading.</p></div></article></body></html>`); return; } // a paragraph of prose (three sentences, past the 200-character line) before the wall
    if (req.url.startsWith('/cues')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html>${head('At the wall')}</head><body><article>${prose(3)}<p>To continue reading, subscribe today.</p></article></body></html>`); return; }
    if (req.url.startsWith('/shell')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html>${head('A shell')}</head><body><nav><a href="/">Home</a></nav><div><span>Menu</span> <span>Search</span> <span>Sign in</span></div></body></html>`); return; }
    // YouTube, stood in for: the watch page with its own key, the player API (the Android client's
    // answer, recorded), the caption file in json3, and thumbnails.
    if (req.url.startsWith('/watch')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>A talk on water - YouTube</title><meta name="title" content="A talk on water"></head><body><script>ytcfg.set({"INNERTUBE_API_KEY":"standin-key","VISITOR_DATA":"standin-visitor"});</script><script>var ytInitialPlayerResponse = {"author":"The Stand-in Channel","publishDate":"2026-09-01"};</script></body></html>'); return; }
    if (req.url.startsWith('/youtubei/v1/player')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch {}
        const id = body.videoId;
        const client = body.context?.client?.clientName;
        ytCalls.push({ videoId: id, key: new URL(req.url, 'http://x').searchParams.get('key'), client: body.context?.client, ua: req.headers['user-agent'], visitorHeader: req.headers['x-goog-visitor-id'] });
        const track = (v, kind) => ({ baseUrl: `http://localhost:${SITE}/api/timedtext?v=${v}&lang=en${kind ? `&kind=${kind}` : ''}&fmt=srv3`, languageCode: 'en', ...(kind ? { kind } : {}) });
        const details = (v) => ({ videoId: v, title: 'A talk on water', author: 'The Stand-in Channel', lengthSeconds: '61', thumbnail: { thumbnails: [{ url: `http://localhost:${SITE}/thumb-mq.png`, width: 320, height: 180 }, { url: `http://localhost:${SITE}/thumb-hq.png`, width: 480, height: 360 }] } });
        const shut = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you\u2019re not a bot' } };
        const open = (v, extra = {}) => ({ playabilityStatus: { status: 'OK', playableInEmbed: true, ...extra }, videoDetails: details(v), captions: { playerCaptionsTracklistRenderer: { captionTracks: [track(v)] } } });
        // The doors answer unevenly, as YouTube's do: vid2 is shut to the Android app and open to the TV app;
        // vid5 is shut at every door; vid6 opens everywhere on a video with no captions.
        const answers = {
          vid1: { playabilityStatus: { status: 'OK', playableInEmbed: true }, videoDetails: details('vid1'), captions: { playerCaptionsTracklistRenderer: { captionTracks: [track('vid1', 'asr'), track('vid1')] } } },
          vid2: client === 'ANDROID' ? shut : open('vid2'),
          vid3: open('vid3'),
          vid4: open('vid4', { playableInEmbed: false }),
          vid5: shut,
          vid6: { playabilityStatus: { status: 'OK', playableInEmbed: true }, videoDetails: details('vid6') },
        };
        if (!answers[id]) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answers[id]));
      });
      return;
    }
    if (req.url.startsWith('/api/timedtext')) {
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      capCalls.push(q);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (q.v === 'vid3') { res.end(''); return; }
      res.end(JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'Water boils at 100 degrees Celsius at sea level.' }] }, { tStartMs: 4000, segs: [{ utf8: 'The Eiffel Tower stands about' }, { utf8: ' 330 metres tall.' }] }] }));
      return;
    }
    // A hosted transcript service, stood in for, answering the shapes a real one does: the words, a
    // job it is still making, or a reason it has none.
    if (req.url.startsWith('/transcript-job/')) {
      const jobId = req.url.split('/transcript-job/')[1].split('?')[0];
      jobCalls.push(jobId);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobId === 'job-bad') { res.end(JSON.stringify({ status: 'failed', error: { error: 'transcript-unavailable', message: 'No captions for this video' } })); return; }
      const seen = jobCalls.filter((j) => j === jobId).length;
      if (seen < 2) { res.end(JSON.stringify({ status: 'active' })); return; }
      res.end(JSON.stringify({ status: 'completed', content: 'The Nile is about 6,650 kilometres long.', lang: 'en', availableLangs: ['en'] }));
      return;
    }
    if (req.url.startsWith('/transcript')) {
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      transcriptCalls.push({ video: q.video, auth: req.headers['x-api-key'] || req.headers['x-civic-transcript'] || req.headers.authorization || '' });
      if (q.video === 'vid5') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: 'The Nile is about 6,650 kilometres long.\nWater boils at 100 degrees Celsius at sea level.', lang: 'en', availableLangs: ['en'] }));
        return;
      }
      if (q.video === 'vid8' || q.video === 'vid9') {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jobId: q.video === 'vid8' ? 'job-good' : 'job-bad' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'transcript-unavailable', message: 'No transcript available', details: 'The video has no captions' }));
      return;
    }
    if (req.url.startsWith('/thumb-')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')); return; }
    res.writeHead(404); res.end();
  };
}

async function linkChecks() {
  const MOCK2 = MOCK_PORT + 20, PORT2 = PORT + 20, SITE = PORT + 21;
  const ytCalls = [], capCalls = [], transcriptCalls = [], jobCalls = []; // what the stand-in YouTube and transcript service were asked
  const site = http.createServer(standInSite(SITE, { ytCalls, capCalls, transcriptCalls, jobCalls }));
  await new Promise((r) => site.listen(SITE, r));
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2' });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT2), OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), CIVIC_ALLOW_PRIVATE_URLS: 'true', CIVIC_YOUTUBE_BASE: `http://localhost:${SITE}`, CIVIC_ERROR_LOG: path.join(os.tmpdir(), `civic-verify-link-errors-${Date.now()}.log`) });
  await wait(`http://localhost:${PORT2}/api/health`);
  const base = `http://localhost:${PORT2}`;
  const read = async (url, { signal } = {}) => { const t0 = Date.now(); const r = await fetch(`${base}/api/read-url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }), signal }); return { status: r.status, ms: Date.now() - t0, body: await r.json().catch(() => null) }; };
  const failures = async () => ((await (await fetch(`${base}/api/selftest`)).json()).recentFailures || []);
  try {
    const goto = await read(`http://localhost:${SITE}/goto?url=CAESvAEB6zswFZzRCvZZdw1C9iLOirg91vHQMHMiOh9q0dnQB9zlU50TGLQx6N8kjZtVpXTd3wGLsANsreI85`);
    check('a link shaped like a Google app link is refused by nothing: it is tried like any other and read where it leads',
      goto.status === 200 && goto.body?.title === 'A page of facts' && goto.body?.chars > 100, JSON.stringify(goto).slice(0, 200));
    const meta = await read(`http://localhost:${SITE}/meta`);
    check('a page that only sends the browser elsewhere (a meta refresh) is followed like a redirect',
      meta.status === 200 && meta.body?.title === 'A page of facts' && meta.body?.chars > 100, JSON.stringify(meta).slice(0, 200));
    const loop = await read(`http://localhost:${SITE}/meta-loop`);
    check('a meta refresh that goes round in circles ends at the same limit as redirects', loop.status === 400 && loop.body?.error?.code === 'url_redirects', JSON.stringify(loop.body));
    const open = await read(`https://www.google.com/url?q=http://localhost:${SITE}/page&sa=t`);
    check('an open Google redirect is unwrapped and its destination read', open.status === 200 && open.body?.title === 'A page of facts' && open.body?.chars > 100, JSON.stringify(open).slice(0, 200));
    const dead = await read(`http://localhost:${PORT + 30}/`); // nothing listens there (port 1 is refused by the client itself as a bad port)
    const rec = (await failures()).find((f) => f.where === 'server:POST /api/read-url');
    check('an unreachable address answers in plain words, and the failure record carries the cause for the operator',
      dead.status === 400 && dead.body?.error?.code === 'url_unreachable' && dead.body?.error?.message === 'That address could not be reached.' && Boolean(rec) && /ECONNREFUSED|ETIMEDOUT|UND_ERR/.test(rec?.detail || ''), JSON.stringify({ dead, rec }));
    // A site that keeps its text is named, with what to do.
    const refused = await read(`http://localhost:${SITE}/refuse`);
    check('a site that refuses the request is named, with what to do, and nothing of the status reaches the reader',
      refused.status === 400 && refused.body?.error?.code === 'url_refused' && refused.body?.error?.site === 'localhost' && /^localhost does not let CIVIC read its pages from here\./.test(refused.body?.error?.message || '') && !/40[13]/.test(refused.body?.error?.message || ''), JSON.stringify(refused.body));
    const teaser = await read(`http://localhost:${SITE}/paywalled-teaser`);
    check('a page marked as not free (the flag Google News reads) that sent no paragraph of prose is a paywall: the site is named by its own name, nothing is tested',
      teaser.status === 400 && teaser.body?.error?.code === 'url_paywall' && teaser.body?.error?.site === 'The Daily Stand-in' && /^The Daily Stand-in keeps this article behind its paywall/.test(teaser.body?.error?.message || ''), JSON.stringify(teaser.body));
    const walledFull = await read(`http://localhost:${SITE}/paywalled-full`);
    check('a marked page that sent its prose comes back marked, for the reader to decide (the operator\'s rule of 19 September)',
      walledFull.status === 200 && walledFull.body?.wall === true && walledFull.body?.title === 'Behind the wall' && walledFull.body?.site === 'The Daily Stand-in' && walledFull.body?.chars > 100, JSON.stringify(walledFull.body).slice(0, 200));
    const walled = await read(`http://localhost:${SITE}/paywalled`);
    check('the same for a marked page with a paragraph of prose before its wall', walled.status === 200 && walled.body?.wall === true && walled.body?.chars > 100, JSON.stringify(walled.body).slice(0, 200));
    const cues = await read(`http://localhost:${SITE}/cues`);
    check('a wall said in the prose ("to continue reading") marks the page the same way without any marker', cues.status === 200 && cues.body?.wall === true, JSON.stringify(cues.body).slice(0, 200));
    const plain = await read(`http://localhost:${SITE}/page`);
    check('a page without a wall is not marked', plain.status === 200 && plain.body?.wall === false, JSON.stringify(plain.body).slice(0, 120));
    // A YouTube video: the transcript through the player API, asked as the Android app asks (the web
    // player's caption addresses answer empty to a server since 2026), and the video for the page's box.
    const yt = await read('https://www.youtube.com/watch?v=vid1');
    const playerCall = ytCalls.find((c) => c.videoId === 'vid1');
    const capCall = capCalls.find((c) => c.v === 'vid1');
    check('a YouTube link reads its transcript through the player API, asked as the Android app asks with the page\'s own key, the manual English track in json3',
      yt.status === 200 && yt.body?.kind === 'youtube' && yt.body?.title === 'A talk on water' && yt.body?.author === 'The Stand-in Channel' && /Water boils at 100 degrees Celsius at sea level\.\nThe Eiffel Tower stands about 330 metres tall\./.test(yt.body?.text || '') && playerCall?.client?.clientName === 'ANDROID' && playerCall?.key === 'standin-key' && /android/i.test(playerCall?.ua || '') && capCall?.fmt === 'json3' && capCall?.kind === undefined, JSON.stringify({ body: yt.body, playerCall, capCall }).slice(0, 500));
    check('the answer carries the video for the page\'s box: embeddable, its length and its thumbnails',
      yt.body?.video?.id === 'vid1' && yt.body?.video?.embeddable === true && yt.body?.video?.lengthSeconds === 61 && yt.body?.video?.thumbnails?.length === 2 && yt.body?.video?.thumbnails[0]?.width === 320, JSON.stringify(yt.body?.video));
    const second = await read('https://youtu.be/vid2');
    const doors2 = ytCalls.filter((c) => c.videoId === 'vid2').map((c) => c.client?.clientName);
    check('a door YouTube keeps shut to the Android app is not the end: the next door is asked, with the page\'s visitor id, and the transcript is read',
      second.status === 200 && second.body?.kind === 'youtube' && JSON.stringify(doors2) === JSON.stringify(['ANDROID', 'TVHTML5']) && ytCalls.filter((c) => c.videoId === 'vid2').every((c) => c.client?.visitorData === 'standin-visitor' && c.visitorHeader === 'standin-visitor'), JSON.stringify({ status: second.status, doors2, body: second.body }).slice(0, 300));
    const shutVideo = await read('https://www.youtube.com/watch?v=vid5');
    const shutRec = (await failures()).find((f) => f.code === 'url_video_wall');
    const doors5 = ytCalls.filter((c) => c.videoId === 'vid5').map((c) => c.client?.clientName);
    check('a video shut at every door gets the wall sentence that points to YouTube\'s own transcript panel, and the record names each door\'s answer',
      shutVideo.status === 400 && shutVideo.body?.error?.code === 'url_video_wall' && /^YouTube would not show this video\'s captions to CIVIC\'s server without a sign-in/.test(shutVideo.body?.error?.message || '') && JSON.stringify(doors5) === JSON.stringify(['ANDROID', 'TVHTML5', 'WEB_EMBEDDED_PLAYER', 'ANDROID_VR', 'IOS']) && /ANDROID LOGIN_REQUIRED: Sign in.*IOS LOGIN_REQUIRED/.test(shutRec?.detail || ''), JSON.stringify({ body: shutVideo.body, doors5, detail: shutRec?.detail }));
    const none = await read('https://www.youtube.com/watch?v=vid6');
    check('a video with no captions at an open door gets the no-captions sentence, not the wall', none.status === 400 && none.body?.error?.code === 'url_no_transcript' && /has no caption track/.test(none.body?.error?.message || ''), JSON.stringify(none.body));
    const empty = await read('https://www.youtube.com/watch?v=vid3');
    check('an empty caption file gets the wall sentence', empty.status === 400 && empty.body?.error?.code === 'url_video_wall', JSON.stringify(empty.body));
    check('with no transcript service set, none is asked: the wall sentence stands on its own',
      transcriptCalls.length === 0, JSON.stringify(transcriptCalls));

    // The last door: a hosted transcript service the operator has set. A second server, because the
    // setting is the whole difference; the same stand-in YouTube and the same stand-in service.
    const PORT3 = PORT + 24;
    const withService = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT3), OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), CIVIC_ALLOW_PRIVATE_URLS: 'true', CIVIC_YOUTUBE_BASE: `http://localhost:${SITE}`, CIVIC_ERROR_LOG: path.join(os.tmpdir(), `civic-verify-service-errors-${Date.now()}.log`), CIVIC_TRANSCRIPT_URL: `http://localhost:${SITE}/transcript?video={id}&text=true`, CIVIC_TRANSCRIPT_KEY: 'standin-transcript-key', CIVIC_TRANSCRIPT_HEADER: 'x-api-key', CIVIC_TRANSCRIPT_JOB_URL: `http://localhost:${SITE}/transcript-job/{jobId}` });
    try {
      await wait(`http://localhost:${PORT3}/api/health`);
      const readVia = async (url) => { const r = await fetch(`http://localhost:${PORT3}/api/read-url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
      const bought = await readVia('https://www.youtube.com/watch?v=vid5');
      const call = transcriptCalls.find((c) => c.video === 'vid5');
      check('a video shut at every door of YouTube is read through the transcript service the operator set, with the key carried raw in the header they named',
        bought.status === 200 && bought.body?.kind === 'youtube' && /The Nile is about 6,650 kilometres long\./.test(bought.body?.text || '') && /Water boils/.test(bought.body?.text || '') && call?.auth === 'standin-transcript-key', JSON.stringify({ status: bought.status, text: (bought.body?.text || '').slice(0, 60), auth: call?.auth === 'standin-transcript-key' ? 'the key alone' : call?.auth }));
      const made = await readVia('https://www.youtube.com/watch?v=vid8');
      check('when the service answers with a job because it is still making the transcript, the job is followed to its end and the words arrive',
        made.status === 200 && made.body?.kind === 'youtube' && /The Nile is about 6,650 kilometres long\./.test(made.body?.text || '') && jobCalls.filter((j) => j === 'job-good').length >= 2, JSON.stringify({ status: made.status, text: (made.body?.text || '').slice(0, 60), polls: jobCalls.filter((j) => j === 'job-good').length }));
      const failed = await readVia('https://www.youtube.com/watch?v=vid9');
      const failedRec = ((await (await fetch(`http://localhost:${PORT3}/api/selftest`)).json()).recentFailures || []).find((f) => /could not make the transcript/.test(f.detail || ''));
      check('a job the service gives up on ends in the wall sentence, and the record says why without naming the key',
        failed.status === 400 && failed.body?.error?.code === 'url_video_wall' && /No captions for this video/.test(failedRec?.detail || '') && !/standin-transcript-key/.test(JSON.stringify(failed.body) + (failedRec?.detail || '')), JSON.stringify({ code: failed.body?.error?.code, detail: failedRec?.detail }));
      const nothing = await readVia('https://www.youtube.com/watch?v=vid7');
      const serviceFail = ((await (await fetch(`http://localhost:${PORT3}/api/selftest`)).json()).recentFailures || []).find((f) => /the transcript service answered 404/.test(f.detail || ''));
      check('when the service has nothing either, the wall sentence stands and the record carries the reason it gave, never the key',
        nothing.status === 400 && nothing.body?.error?.code === 'url_video_wall' && /transcript-unavailable/.test(serviceFail?.detail || '') && !/standin-transcript-key/.test(JSON.stringify(nothing.body) + (serviceFail?.detail || '')), JSON.stringify({ body: nothing.body?.error?.code, detail: serviceFail?.detail }));
    } finally {
      try { withService.kill('SIGTERM'); } catch {}
    }

    const policy = (await fetch(`${base}/`)).headers.get('content-security-policy') || '';
    check('the page\'s security policy admits the player and the thumbnails', /frame-src https:\/\/www\.youtube-nocookie\.com/.test(policy) && /img-src[^;]*https:\/\/\*\.ytimg\.com/.test(policy), policy);
    const shell = await read(`http://localhost:${SITE}/shell`);
    check('a page with no paragraph of prose is a shell: named, with what to do',
      shell.status === 400 && shell.body?.error?.code === 'url_shell' && /builds this page in the browser/.test(shell.body?.error?.message || ''), JSON.stringify(shell.body));
    const page = await read(`http://localhost:${SITE}/page`);
    check('an ordinary page with prose and no wall still reads', page.status === 200 && page.body?.chars > 100, JSON.stringify(page.body?.chars));

    // A silent site, first face: a listener whose queue is full and whose process is blocked never
    // completes the handshake, so the connection attempt gets no answer at all. Found in about ten
    // seconds (the connector's own timeout, made effective), remembered, and answered at once the
    // second time.
    const SILENT = PORT + 22;
    const holder = spawn(process.execPath, ['-e', `const net = require('node:net'); const s = net.createServer(); s.listen(${SILENT}, '127.0.0.1', 1, () => { process.send('up'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000); });`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise((r) => holder.on('message', r));
    const fillers = Array.from({ length: 6 }, () => { const c = net.connect(SILENT, '127.0.0.1'); c.on('error', () => {}); return c; });
    await new Promise((r) => setTimeout(r, 800));
    const firstAc = new AbortController();
    const firstTimer = setTimeout(() => firstAc.abort(), 40000);
    const silent1 = await read(`http://127.0.0.1:${SILENT}/`, { signal: firstAc.signal }).catch((e) => ({ status: 'aborted', ms: 40000, body: { error: { message: e.message } } }));
    clearTimeout(firstTimer);
    check('a site that never answers the connection is found in about ten seconds, not the operating system\'s minute, and named with what to do',
      silent1.status === 400 && silent1.body?.error?.code === 'url_silent' && silent1.ms < 30000 && /does not let CIVIC read its pages from here/.test(silent1.body?.error?.message || ''), JSON.stringify({ status: silent1.status, ms: silent1.ms, body: silent1.body }));
    const silent2 = await read(`http://127.0.0.1:${SILENT}/`);
    const listed = ((await (await fetch(`${base}/api/selftest`)).json()).silentSites || []).map((x) => x.host);
    check('the silent site is remembered: the next read answers at once, and /check lists the site',
      silent2.status === 400 && silent2.body?.error?.code === 'url_silent' && silent2.ms < 1500 && listed.includes('127.0.0.1'), JSON.stringify({ ms: silent2.ms, code: silent2.body?.error?.code, listed }));
    for (const c of fillers) { try { c.destroy(); } catch {} }
    try { holder.kill('SIGKILL'); } catch {}

    // Second face, the Washington Post's for a cloud address: the connection and the request go
    // through and nothing ever comes back. Found in the same ten seconds (the headers timeout set
    // to the platform's figure), not the operating system's minute; remembered the same way.
    const MUTE = PORT + 23;
    const mute = net.createServer(() => {}); // takes every connection and never writes a byte (its own host, so the first face's memory of 127.0.0.1 does not answer for it)
    await new Promise((r) => mute.listen(MUTE, '127.0.0.2', r));
    const muteAc = new AbortController();
    const muteTimer = setTimeout(() => muteAc.abort(), 40000);
    const mute1 = await read(`http://127.0.0.2:${MUTE}/`, { signal: muteAc.signal }).catch((e) => ({ status: 'aborted', ms: 40000, body: { error: { message: e.message } } }));
    clearTimeout(muteTimer);
    const muteRec = (await failures()).find((f) => f.where === 'server:POST /api/read-url' && /HEADERS_TIMEOUT/.test(f.detail || ''));
    check('a site that takes the request and never answers it is found in about ten seconds too, named with what to do, and the record says which silence',
      mute1.status === 400 && mute1.body?.error?.code === 'url_silent' && mute1.ms >= 9000 && mute1.ms < 30000 && /does not let CIVIC read its pages from here/.test(mute1.body?.error?.message || '') && Boolean(muteRec), JSON.stringify({ status: mute1.status, ms: mute1.ms, body: mute1.body, detail: muteRec?.detail }));
    const mute2 = await read(`http://127.0.0.2:${MUTE}/`);
    check('that site is remembered as well: the next read answers at once', mute2.status === 400 && mute2.body?.error?.code === 'url_silent' && mute2.ms < 1500, JSON.stringify({ ms: mute2.ms, code: mute2.body?.error?.code }));
    mute.close();

    const before = (await failures()).length;
    const ac = new AbortController();
    const gone = read(`http://localhost:${SITE}/slow`, { signal: ac.signal }).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await gone;
    await new Promise((r) => setTimeout(r, 3000)); // the slow page answers after the request is gone
    const after = (await failures()).length;
    check('a read the page abandons (the reader reloaded) leaves no failure record', after === before, `${before} → ${after}`);
  } finally {
    try { server.kill('SIGTERM'); } catch {}
    try { mock.kill('SIGTERM'); } catch {}
    site.close();
  }
}
await linkChecks();

// Sources as tools (server/tools): the gateway answers only the pass; the tool table is the verbs the
// sources on can answer; every adapter is driven through the gateway against its own stand-in; a
// determination's request names the gateway beside web search and nothing else new; the stand-in
// OpenAI calls the gateway as OpenAI's servers do and the page's stream shows each call; each call is
// a ledger line; the pass appears nowhere.
async function toolChecks() {
  const MOCK4 = MOCK_PORT + 22, PORT4 = PORT + 25, SITE2 = PORT + 26;
  const calls = { ytCalls: [], capCalls: [], transcriptCalls: [], jobCalls: [] };
  const dir = path.join(root, 'server', 'tools', 'adapters');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const adapters = files.filter((f) => !f.endsWith('.standin.js')).sort();
  const missing = adapters.filter((f) => !files.includes(f.replace(/\.js$/, '.standin.js')));
  check('every adapter in server/tools/adapters has a stand-in beside it (the contract the guard enforces on every source)', adapters.length > 0 && missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${adapters.length} adapter(s)`);
  // The stand-ins, mounted on one site with the guard's own stand-in YouTube behind them.
  const app = express();
  const standIns = [];
  for (const f of adapters) {
    const standInFile = f.replace(/\.js$/, '.standin.js');
    if (!files.includes(standInFile)) continue;
    const s = (await import(pathToFileURL(path.join(dir, standInFile)).href)).default;
    const problems = validateStandIn(s);
    check(`the stand-in beside ${f} meets the contract`, problems.length === 0, problems.join('; '));
    if (!problems.length) { s.mount(app); standIns.push({ file: f, standIn: s }); }
  }
  app.use(standInSite(SITE2, calls));
  const site = http.createServer(app);
  await new Promise((r) => site.listen(SITE2, r));
  const siteBase = `http://localhost:${SITE2}`;
  const env = Object.assign({}, ...standIns.map(({ standIn }) => standIn.settings(siteBase)));
  const stamp = Date.now();
  const mockRecord = path.join(os.tmpdir(), `civic-verify-tools-${stamp}.jsonl`);
  const ledgerFile = path.join(os.tmpdir(), `civic-verify-tools-ledger-${stamp}.jsonl`);
  const errorLog = path.join(os.tmpdir(), `civic-verify-tools-errors-${stamp}.log`);
  const PASS = 'standin-pass-3f9c1e';
  const toolCalls = [{ name: 'read_page', arguments: { url: `${siteBase}/tool-page` } }, { name: 'read_page', arguments: { url: `${siteBase}/refuse` } }];
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK4), MOCK_SPEED: '0.2', MOCK_RECORD: mockRecord, MOCK_TOOL_CALLS: JSON.stringify(toolCalls), MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCK4}/v1/mock/stats`, 15000, { anyResponse: true });
  const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT4), OPENAI_BASE_URL: `http://localhost:${MOCK4}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: ledgerFile, CIVIC_ERROR_LOG: errorLog, CIVIC_ALLOW_PRIVATE_URLS: 'true', CIVIC_TOOLS_URL: `http://localhost:${PORT4}/mcp`, CIVIC_TOOLS_PASS: PASS, ...env });
  await wait(`http://localhost:${PORT4}/api/health`);
  const base = `http://localhost:${PORT4}`;
  const readIf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const rpc = async (method, params, id, pass = PASS) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(pass ? { authorization: `Bearer ${pass}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  try {
    const shut = await rpc('tools/list', {}, 1, null);
    const wrong = await rpc('tools/list', {}, 1, 'not-the-pass');
    check('the gateway answers no one without the pass', shut.status === 401 && wrong.status === 401 && !shut.json?.result && !wrong.json?.result, JSON.stringify({ shut: shut.status, wrong: wrong.status }));
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'guard', version: '1' } }, 2);
    check('with the pass, the gateway speaks the standard: initialize answers with its name and that it has tools', init.status === 200 && init.json?.result?.serverInfo?.name === 'civic' && Boolean(init.json?.result?.capabilities?.tools), JSON.stringify(init.json).slice(0, 200));
    const list = await rpc('tools/list', {}, 3);
    const tools = list.json?.result?.tools || [];
    check('the tool table lists the verbs the sources on can answer, read_page and get_transcript, nothing else, and with one source no source parameter', JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(['read_page', 'get_transcript']) && tools.every((t) => !t.inputSchema.properties.source && t.inputSchema.required.includes('url') && t.description.length > 40), JSON.stringify(tools).slice(0, 300));
    // Every adapter's probes, through the gateway, against its stand-in.
    let n = 10;
    for (const { file, standIn } of standIns) {
      for (const probe of standIn.probes(siteBase)) {
        const r = await rpc('tools/call', { name: probe.verb, arguments: probe.args }, n++);
        const result = r.json?.result;
        const text = (result?.content || []).map((x) => x.text || '').join('');
        let ok = false, detail = '';
        if (probe.refused) { ok = result?.isError === true && probe.expect(text); detail = text.slice(0, 200); }
        else { let out = null; try { out = JSON.parse(text); } catch {} ok = r.status === 200 && !result?.isError && Boolean(out) && probe.expect(out); detail = JSON.stringify(out).slice(0, 300); }
        check(`${file.replace(/\.js$/, '')} answers ${probe.verb} ${JSON.stringify(probe.args)} ${probe.refused ? 'with the source\'s own answer, as information for the model' : 'in the one shape every source shares'}`, ok, detail);
      }
    }
    // A determination: the request names the gateway beside web search and nothing else new; the
    // stand-in OpenAI calls the gateway as OpenAI's servers do; the page's stream shows each call.
    const source = 'The Nile is about 6,650 kilometres long. Water boils at 100 degrees Celsius at sea level.';
    const ex = await stream(`${base}/api/extract`, { text: source });
    const entry = ex.find((e) => e.t === 'done')?.claims?.[0]?.entry || 'Claim: The Nile is about 6,650 kilometres long.';
    const ev = await stream(`${base}/api/evaluate`, { claims: [entry], text: source, source: { kind: 'text' } });
    await new Promise((r) => setTimeout(r, 500)); // the ledger is appended after the stream ends
    const sent = readIf(mockRecord).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const bodies = sent.filter((r) => r.path === '/v1/responses').map((r) => r.body);
    const mcpEntry = (b) => (b.tools || []).find((t) => t.type === 'mcp');
    const expectedMcp = { type: 'mcp', server_label: 'civic', server_url: `${base}/mcp`, headers: { authorization: `Bearer ${PASS}` }, require_approval: 'never' };
    check('both requests carry web search and the gateway entry with exactly these keys (type, server_label, server_url, headers, require_approval) and no key beyond the six', bodies.length >= 2 && bodies.every((b) => b.tools.length === 2 && b.tools[0].type === 'web_search' && JSON.stringify(mcpEntry(b)) === JSON.stringify(expectedMcp) && extraKeys(b, ['model', 'instructions', 'input', 'reasoning', 'tools', 'stream', 'store']).length === 0), JSON.stringify(bodies.map((b) => b.tools)).slice(0, 400));
    const client = sent.filter((r) => r.path === '/mcp-client');
    const listed = client.find((r) => r.step === 'list');
    const made = client.filter((r) => r.step === 'call');
    check('the stand-in OpenAI, as a client of the gateway, listed the tools and made its calls: the page\'s text came back whole, the refused page as the site\'s answer', listed?.status === 200 && JSON.stringify(listed?.names) === JSON.stringify(['read_page', 'get_transcript']) && made.length === 2 && made[0].failed === false && /The Nile is about 6,650 kilometres long/.test(made[0].output) && made[1].failed === true && /does not let CIVIC read its pages from here/.test(made[1].output), JSON.stringify({ listed: listed?.names, made: made.map((m) => [m.status, m.failed, String(m.output).slice(0, 80)]) }));
    const steps = ev.filter((e) => e.t === 'trail').map((e) => e.step);
    const toolSteps = steps.filter((s) => s.kind === 'tool');
    const done = ev.find((e) => e.t === 'done');
    check('the page\'s stream shows each tool call as a step of the trail, by its verb and what it was asked, with the source\'s answer when it kept the page', toolSteps.length === 2 && toolSteps[0].name === 'read_page' && toolSteps[0].url === `${siteBase}/tool-page` && toolSteps[0].status === 'completed' && !toolSteps[0].error && toolSteps[1].status === 'failed' && /does not let CIVIC read its pages from here/.test(toolSteps[1].error || ''), JSON.stringify(toolSteps));
    const webSteps = steps.filter((s) => s.kind !== 'tool').length;
    check('the searches counted for the cost are the web searches alone; the tool calls sit in the trail and on their own ledger lines; the row said it was reading', Boolean(done) && done.searches === webSteps && done.trail.length === webSteps + 2 && ev.some((e) => e.t === 'phase' && e.phase === 'reading'), JSON.stringify({ searches: done?.searches, webSteps, trail: done?.trail?.length }));
    const ledger = readIf(ledgerFile).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const toolLines = ledger.filter((l) => l.kind === 'tool');
    check('each call is one ledger line: the source, the verb, the time, the operator\'s price (zero for CIVIC\'s own reader), and how it ended', toolLines.length >= 2 && toolLines.every((l) => l.source === 'web' && ['read_page', 'get_transcript'].includes(l.verb) && l.usd === 0 && l.priced === true && typeof l.ms === 'number') && toolLines.some((l) => l.ok === true && l.chars > 100) && toolLines.some((l) => l.ok === false && l.code === 'url_refused'), JSON.stringify(toolLines.slice(-2)));
    const st = await (await fetch(`${base}/api/selftest`)).json();
    check('/check lists the sources the model can reach for, by name and verb, and that the requests name the gateway', st.tools?.reachable === true && st.tools?.on === true && st.tools?.sources?.[0]?.id === 'web' && JSON.stringify(st.tools.sources[0].verbs) === JSON.stringify(['read_page', 'get_transcript']), JSON.stringify(st.tools));
    const everywhere = readIf(ledgerFile) + readIf(errorLog) + JSON.stringify(st) + JSON.stringify(ev) + JSON.stringify(ex) + await (await fetch(`${base}/`)).text() + await (await fetch(`${base}/api/health`)).text();
    check('the pass appears in no record, no stream, no page and no health line', !everywhere.includes(PASS), '');
  } finally {
    try { server.kill('SIGTERM'); } catch {}
    try { mock.kill('SIGTERM'); } catch {}
    site.close();
  }
}
await toolChecks();

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
