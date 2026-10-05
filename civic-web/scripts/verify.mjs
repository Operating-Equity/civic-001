// The guard. Starts the mock and the server, runs an extraction and a determination, then reads
// the request bodies the server ACTUALLY SENT to the API and fails if they carry anything but the
// operator's configuration: the configured model, the configured reasoning effort, the prompts
// verbatim, web search. Any other key in a request body is a failure, whoever added it.
// It also runs the prompt leak guard: no committed file may contain a fragment of the prompts.
// Run before every deploy: `npm run verify`. A non-zero exit is a defect.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { leakChecks } from './leak-check.mjs';
import { sourceBlock, attributionLines } from '../server/source.js';
import { linkWords, publisherOf } from '../server/copies.js';
import { Bucket, RateGate, parseRefusal } from '../server/gate.js';
import { parseEntry } from '../server/verdict.js';
import { isConnectionDrop, connectionWait, describeError } from '../server/openai.js';
import { generateCode, normalise, ALPHABET } from '../server/access.js';
import { validateStandIn } from '../server/tools/contract.js';
import { config, requestShape } from '../server/config.js';
import { tierAt, windowStartAt, freeFor, priceFromAverage } from '../server/economics.js';
import pg from 'pg';

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
// Every child starts with the listing on OpenAI, and DeepSeek and Fireworks out of reach (an address on a closed port,
// no key), unless a check says otherwise: a developer's shell can never send the guard's prompts to the real DeepSeek or
// Fireworks. No public address of Render's either, so the tool server's address is only ever one a check gives.
const DEEPSEEK_OFF = { CIVIC_EXTRACT_PROVIDER: '', DEEPSEEK_API_KEY: '', CIVIC_DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/deepseek' };
const FIREWORKS_OFF = { FIREWORKS_API_KEY: '', CIVIC_FIREWORKS_BASE_URL: 'http://127.0.0.1:9/fireworks', RENDER_EXTERNAL_URL: '' };
const start = (args, extraEnv) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...DEEPSEEK_OFF, ...FIREWORKS_OFF, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    check('extraction: reasoning.mode is the configured mode (standard since 5 October: no key), and the key is there only when a mode is set', (exBody.reasoning?.mode ?? null) === shape.extract.mode && ('mode' in (exBody.reasoning || {})) === Boolean(shape.extract.mode), JSON.stringify({ sent: exBody.reasoning, configured: shape.extract.mode }));
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
    check('determination: reasoning.mode is the configured mode (standard since 5 October: no key), and the key is there only when a mode is set', (evBody.reasoning?.mode ?? null) === shape.evaluate.mode && ('mode' in (evBody.reasoning || {})) === Boolean(shape.evaluate.mode), JSON.stringify({ sent: evBody.reasoning, configured: shape.evaluate.mode }));
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
async function gateRun(n, env, { extraction = false, claims = SIX, serverEnv = {}, during = null } = {}) {
  const MOCK2 = MOCK_PORT + 10 + n, PORT2 = PORT + 10 + n;
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_HOLD_MS: '400', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '', ...env });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT2), OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), ...serverEnv });
  await wait(`http://localhost:${PORT2}/api/health`);
  const out = { events: [], ex: [], failure: '', stats: null, pacing: null };
  const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
  // As in a real run, an extraction goes first. The first request a FactEngine ever sends teaches the
  // gate the key's limit and nothing else (what the bucket held before it is not known); the first
  // determination is then sent into a full minute and teaches its cost exactly, and so is the
  // extraction that follows the claims.
  if (extraction) { try { await stream(`http://localhost:${PORT2}/api/extract`, { text }); } catch (err) { out.failure += ` first extraction: ${err.message}`; } }
  try {
    const run = stream(`http://localhost:${PORT2}/api/evaluate`, { claims });
    if (during) { try { out.during = await during(`http://localhost:${PORT2}`); } catch (err) { out.failure += ` during: ${err.message}`; } }   // something else arrives while the claims run
    out.events = await run;
  } catch (err) { out.failure = err.message; }
  if (extraction) {
    try { out.ex = await stream(`http://localhost:${PORT2}/api/extract`, { text }); }
    catch (err) { out.failure += ` extraction: ${err.message}`; }
  }
  try { out.stats = await (await fetch(`http://localhost:${MOCK2}/v1/mock/stats`, { headers: { authorization: `Bearer ${KEY}` } })).json(); } catch (err) { out.failure += ` stats: ${err.message}`; }
  try { out.pacing = ((await (await fetch(`http://localhost:${PORT2}/api/selftest`)).json()).pacing || [])[0] || null; } catch {}
  try { out.health = await (await fetch(`http://localhost:${PORT2}/api/health`)).json(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  try { mock.kill('SIGTERM'); } catch {}
  return out;
}
// The mode and the effort are settings: standard (or empty) sends no mode key at all, the default since 5 October; set
// back to the power of 21 September (effort max in pro mode), both steps carry exactly that, and nothing else changes.
async function modeChecks() {
  const modeRecord = path.join(os.tmpdir(), `civic-verify-mode-${Date.now()}.jsonl`);
  const r = await gateRun(9, { MOCK_RECORD: modeRecord }, { extraction: true, claims: [SIX[0]], serverEnv: { CIVIC_REASONING_MODE: 'pro', CIVIC_EFFORT: 'max' } });
  const bodies = fs.existsSync(modeRecord) ? fs.readFileSync(modeRecord, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.path === '/v1/responses').map((x) => x.body) : [];
  check('with CIVIC_REASONING_MODE=pro and CIVIC_EFFORT=max both requests carry exactly that (effort max, mode pro, the summary), as from 21 September to 5 October',
    bodies.length >= 2 && bodies.every((b) => b.reasoning?.mode === 'pro' && b.reasoning?.effort === 'max' && JSON.stringify(Object.keys(b.reasoning).sort()) === JSON.stringify(['effort', 'mode', 'summary'])) && !r.failure, JSON.stringify({ reasoning: bodies.map((b) => b.reasoning), failure: r.failure }));
  // The defaults as the code holds them: judged only where no shell sets these (CI sets none).
  const set = ['CIVIC_EFFORT', 'CIVIC_EVAL_EFFORT', 'CIVIC_EXTRACT_EFFORT', 'CIVIC_REASONING_MODE', 'CIVIC_EVAL_REASONING_MODE', 'CIVIC_EXTRACT_REASONING_MODE'].filter((n) => process.env[n]);
  const shape = requestShape();
  check('by default (standard since 5 October) no request carries a mode key, and both steps\' effort is xhigh',
    set.length > 0 || (shape.extract.mode === null && shape.evaluate.mode === null && shape.evaluate.effort === 'xhigh' && (shape.extract.provider !== 'openai' || shape.extract.effort === 'xhigh')), JSON.stringify({ set, extract: shape.extract, evaluate: shape.evaluate }));
}
await modeChecks();

async function gateChecks() {
  const reserve = 68147;
  const done = (r) => r.events.filter((e) => e.t === 'done').length;
  const starts = (r) => { const d = (r.stats?.timeline || []).filter((e) => e.kind === 'determination'); return d.map((e) => e.at - d[0].at); };
  const twenty = { CIVIC_EVAL_CONCURRENCY: '20' };   // the gate's pacing is proved with claims allowed to run together

  // 0. The rule that runs: ten claims at a time, never more, and none refused at the door or in its stream.
  {
    const TWELVE = [...SIX, ...SIX.map((c) => c.replace('for the gate', 'for the gate again'))];
    const r = await gateRun(3, { MOCK_TPM: '5000000', MOCK_RESERVE: String(reserve), MOCK_CONTINUATION: '90000' }, { claims: TWELVE, serverEnv: { CIVIC_MAX_CLAIMS: '12' } });
    check('claims run ten at a time: ten determinations run together and never an eleventh, and none is refused at the door or in its stream',
      !r.failure && r.stats?.maxInFlight === 10 && r.stats?.refused === 0 && r.stats?.refusedInStream === 0 && done(r) === 12, `${r.failure} maxInFlight=${r.stats?.maxInFlight} refused=${r.stats?.refused} inStream=${r.stats?.refusedInStream} done=${done(r)}`);
    check('the database pool is a setting with its wait: ten connections and a thirty-second wait unless set (CIVIC_DATABASE_POOL, CIVIC_DATABASE_WAIT_MS)', config.databasePool === 10 && config.databaseWaitMs === 30000, `${config.databasePool} ${config.databaseWaitMs}`);
  check('the page is told the same figure it is paced by: /api/health carries inFlight equal to the configured concurrency',
      r.health?.inFlight === config.evalConcurrency && r.health?.inFlight === r.stats?.maxInFlight, `inFlight=${r.health?.inFlight} configured=${config.evalConcurrency} maxInFlight=${r.stats?.maxInFlight}`);
  }

  // 0b. The pace is a setting, not a release: one value moves both the number the page reads and the
  // claims that actually run together, so the operator changes it in Render and nothing is rebuilt.
  {
    const r = await gateRun(4, { MOCK_TPM: '5000000', MOCK_RESERVE: String(reserve), MOCK_CONTINUATION: '90000' }, { claims: SIX, serverEnv: { CIVIC_EVAL_CONCURRENCY: '2' } });
    check('the pace follows the setting: with CIVIC_EVAL_CONCURRENCY=2 the page is told 2 and exactly two determinations run together, never a third, and all six finish',
      !r.failure && r.health?.inFlight === 2 && r.stats?.maxInFlight === 2 && done(r) === 6, `${r.failure} inFlight=${r.health?.inFlight} maxInFlight=${r.stats?.maxInFlight} done=${done(r)}`);
  }

  // 0c. What runs without a press is a setting too (CIVIC_AUTO_TEST_FIRST): the page is told the figure
  // on /api/health, ten unless set, and a determination the reader asks for runs whatever it is.
  {
    const r = await gateRun(5, { MOCK_TPM: '5000000', MOCK_RESERVE: String(reserve), MOCK_CONTINUATION: '90000' }, { claims: [SIX[0]], serverEnv: { CIVIC_AUTO_TEST_FIRST: '0' } });
    check('what runs without a press is a setting: /api/health carries autoTestFirst (10 unless set; 0 with CIVIC_AUTO_TEST_FIRST=0), and a determination the reader asks for still runs',
      config.autoTestFirst === 10 && r.health?.autoTestFirst === 0 && !r.failure && done(r) === 1, `${r.failure} default=${config.autoTestFirst} set=${r.health?.autoTestFirst} done=${done(r)}`);
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
    const r = await gateRun(1, { MOCK_TPM: String(reserve * 2), MOCK_RESERVE_SERIES: `${reserve},${reserve},${bigger}`, MOCK_WINDOW_MS: '3000' }, { serverEnv: twenty });   // a budget of two: the third goes alone on what is left and meets its larger cost
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

  // Readers at once (3 October). Requests leave together, bounded by the bucket less what the sends whose
  // headers have not arrived reserve; listings before determinations; the readers take turns.
  const dets = (r) => (r.stats?.timeline || []).filter((e) => e.kind === 'determination');
  const overlapping = (d) => d.filter((b) => d.some((a) => a !== b && a.at <= b.at && a.headersAt && b.at < a.headersAt)).length;
  const startAt = (events, i, nth = 0) => events.filter((e) => e.t === 'start' && e.i === i)[nth]?.at;
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // 4. The line's order, in process: the listing first, the owners in turn, a refused ticket back at the front of its class.
  {
    const g = new RateGate('order');
    g.tokens.observe({ limit: 100, remaining: 100 }); g.learn('determination', 100); g.learn('extraction', 100);
    const headers = { 'x-ratelimit-limit-tokens': '100', 'x-ratelimit-remaining-tokens': '100' };
    const order = []; const tickets = {};
    const ask = (name, kind, owner, opts = {}) => g.admit({ kind, owner, ...opts }).then((t) => { order.push(name); tickets[name] = t; });
    const pump = async (count) => { for (let k = 0; k < 200 && order.length < count; k++) await settle(2); };
    ask('A1', 'determination', 'A'); ask('A2', 'determination', 'A'); ask('A3', 'determination', 'A');
    ask('B1', 'determination', 'B'); ask('B2', 'determination', 'B');
    ask('X', 'extraction', 'A');
    await pump(1);
    const st = g.state();
    check('the gate\'s line: one sent with its reservation, five waiting (one listing, four determinations, two readers), and the pacing figures say so',
      order[0] === 'A1' && st.pending === 1 && st.reserved === 100 && st.waiting === 5 && st.waitingByKind.extraction === 1 && st.waitingByKind.determination === 4 && st.owners === 2, JSON.stringify({ order, st }));
    // A1 went at once (nothing was in line): the turns begin with what waits. The listing goes next, then
    // A's turn, then B's. A2 is turned back at the door: it goes again first, ahead of B's next.
    g.replied(tickets.A1, headers); await pump(2);
    g.replied(tickets.X, headers); await pump(3);
    g.refused(tickets.A2, parseRefusal({ status: 429, error: { message: 'Rate limit reached' } }));
    g.admit({ kind: 'determination', owner: 'A', first: true, notBefore: 0 }).then((t) => { order.push('A2r'); tickets.A2r = t; });
    await pump(4);
    g.replied(tickets.A2r, headers); await pump(5);
    g.replied(tickets.B1, headers); await pump(6);
    g.replied(tickets.A3, headers); await pump(7);
    g.replied(tickets.B2, headers);
    check('the order served: the listing before every waiting determination, the two readers in turn, and the refused ticket back at the front of its class',
      JSON.stringify(order) === JSON.stringify(['A1', 'X', 'A2', 'A2r', 'B1', 'A3', 'B2']) && g.state().waiting === 0 && g.state().pending === 0, JSON.stringify(order));
  }
  // 5. Parallel sends: the first of a kind alone (it teaches), then the rest together before any headers arrive.
  {
    const r = await gateRun(6, { MOCK_TPM: '5000000', MOCK_RESERVE: String(reserve), MOCK_HEADERS_DELAY_MS: '2500' }, { extraction: true, serverEnv: twenty });
    const d = dets(r);
    check('the first determination goes alone and teaches its cost; the next five leave together before its successor\'s headers arrive (no refusal, all six done)',
      !r.failure && d.length === 6 && d[1].at >= d[0].headersAt && overlapping(d) >= 4 && r.stats?.refused === 0 && done(r) === 6 && r.pacing?.costs?.determination === reserve,
      `${r.failure} n=${d.length} overlapping=${overlapping(d)} refused=${r.stats?.refused} done=${done(r)} costs=${JSON.stringify(r.pacing?.costs)}`);
  }
  // 6. The reservation prevents overshoot: a budget of two, headers slow, nothing is sent that the bucket less the reservations cannot hold.
  {
    const r = await gateRun(7, { MOCK_TPM: String(reserve * 2), MOCK_RESERVE: String(reserve), MOCK_WINDOW_MS: '3000', MOCK_HEADERS_DELAY_MS: '2500' }, { serverEnv: twenty });
    const d = dets(r);
    check('with a budget of two and slow headers the gate never sends what the bucket less the reservations cannot hold: no refusal, no two in the air together, all six done',
      !r.failure && r.stats?.refused === 0 && done(r) === 6 && overlapping(d) === 0, `${r.failure} refused=${r.stats?.refused} done=${done(r)} overlapping=${overlapping(d)}`);
  }
  // 7. A listing arriving while determinations wait goes first.
  {
    const r = await gateRun(8, { MOCK_TPM: String(reserve * 3), MOCK_RESERVE: String(reserve), MOCK_WINDOW_MS: '3000' }, { serverEnv: twenty, during: async (base) => { await settle(400); return stream(`${base}/api/extract`, { text: 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.' }); } });
    const d = dets(r);
    const ex = (r.stats?.timeline || []).find((e) => e.kind === 'extraction');
    check('a listing that arrives while determinations wait their turn goes before them, and both complete',
      !r.failure && ex && d.length === 6 && ex.at < d[1].at && (r.during || []).some((e) => e.t === 'done') && done(r) === 6 && r.stats?.refused === 0,
      `${r.failure} ex=${ex?.at} d1=${d[1]?.at} exDone=${(r.during || []).some((e) => e.t === 'done')} done=${done(r)} refused=${r.stats?.refused}`);
  }
  // 8. Two readers take turns: a second reader's three claims are not kept behind the first reader's six.
  {
    const THREE = [1, 2, 3].map((n) => `A second reader's claim number ${n}: the bridge is ${100 + n} metres long.`);
    const r = await gateRun(10, { MOCK_TPM: String(reserve * 3), MOCK_RESERVE: String(reserve), MOCK_WINDOW_MS: '3000' }, { serverEnv: twenty, during: async (base) => { await settle(400); return stream(`${base}/api/evaluate`, { claims: THREE }); } });
    const second = r.during || [];
    check('two readers take turns at the gate: the second reader\'s third claim starts before the first reader\'s fifth, and all nine finish',
      !r.failure && dets(r).length === 9 && done(r) === 6 && second.filter((e) => e.t === 'done').length === 3 && startAt(second, 2) < startAt(r.events, 4) && r.stats?.refused === 0,
      `${r.failure} n=${dets(r).length} done=${done(r)} secondDone=${second.filter((e) => e.t === 'done').length} B3=${startAt(second, 2)} A5=${startAt(r.events, 4)}`);
  }
  // 9. A refusal at the door keeps the front: two sent together meet the drained bucket, both go again first, before the fifth.
  {
    const r = await gateRun(11, { MOCK_TPM: String(reserve * 3), MOCK_RESERVE: String(reserve), MOCK_WINDOW_MS: '3000', MOCK_RATE_LIMIT_REQUESTS: '3' }, { serverEnv: twenty });
    const ev = r.events;
    const held = ev.filter((e) => e.t === 'phase' && e.phase === 'queued');
    check('two requests refused at the door together go again first, in their order, with OpenAI\'s own wait on the row, before the fifth starts',
      !r.failure && r.stats?.refused === 2 && done(r) === 6 && held.some((e) => e.position === 1 && e.waitMs >= 500) && Math.max(startAt(ev, 2), startAt(ev, 3)) < startAt(ev, 4),
      `${r.failure} refused=${r.stats?.refused} done=${done(r)} held=${JSON.stringify(held.slice(0, 4))} starts=${[2, 3, 4].map((i) => startAt(ev, i))}`);
  }
  // 10. A refusal inside a stream rejoins at the back of its class, and its Requested figure is learned.
  {
    const r = await gateRun(12, { MOCK_TPM: String(reserve * 3), MOCK_RESERVE: String(reserve), MOCK_WINDOW_MS: '3000', MOCK_STREAM_RATE_LIMIT_REQUESTS: '3', MOCK_STREAM_REQUESTED: '90000' }, { serverEnv: twenty });
    const ev = r.events;
    const retry = ev.find((e) => e.t === 'retry' && e.reason === 'rate_limit');
    check('a claim refused inside its stream waits OpenAI\'s figure, rejoins behind its reader\'s other claims (its second start after the sixth claim\'s), finishes, and the gate learns the later call\'s charge',
      !r.failure && r.stats?.refusedInStream === 1 && retry && retry.i === 2 && startAt(ev, 2, 1) > startAt(ev, 5) && done(r) === 6 && r.pacing?.costs?.determination === 90000,
      `${r.failure} inStream=${r.stats?.refusedInStream} retry=${JSON.stringify(retry)} second=${startAt(ev, 2, 1)} sixth=${startAt(ev, 5)} done=${done(r)} costs=${JSON.stringify(r.pacing?.costs)}`);
  }
  // 11. The pacing row mid-run: sent and awaiting headers, reserved tokens, waiting by kind and by reader; nothing of it on /api/health.
  {
    const r = await gateRun(13, { MOCK_TPM: String(reserve * 3), MOCK_RESERVE: String(reserve), MOCK_WINDOW_MS: '3000', MOCK_HEADERS_DELAY_MS: '5000' }, { serverEnv: twenty, during: async (base) => { await settle(3500); return ((await (await fetch(`${base}/api/selftest`)).json()).pacing || [])[0] || null; } });
    const g = r.during;
    check('the pacing row says what is in the air and what waits: two sent awaiting their headers with two reservations, two waiting (determinations, one reader); the health line carries none of it',
      !r.failure && g && g.pending === 2 && g.reserved === 2 * reserve && g.waiting === 2 && g.waitingByKind?.determination === 2 && g.owners === 1 && g.inFlight >= 2 && done(r) === 6 && !('pacing' in (r.health || {})),
      `${r.failure} row=${JSON.stringify(g && { pending: g.pending, reserved: g.reserved, waiting: g.waiting, byKind: g.waitingByKind, owners: g.owners, inFlight: g.inFlight })} done=${done(r)}`);
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
    check('taking a code off the list signs out exactly its holders: on a FactEngine without ABCD234 the cookie issued under it proves nothing, and one issued under EFGH567 is honoured',
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

// The door's locks of 30 September (server/access.js, server/jobs.js, server/index.js). Routes
// match their case exactly and the gate sits on /api itself, so /API/extract is nobody's route;
// a job belongs to the sign-in that started it; an id of up to 128 characters is kept as given
// and a longer one is replaced by the server's, which the first event names; the cookie's secret
// is the operator's own when set; the sign-in list is the operator's to see; a request the
// browser marks as another site's is refused.
async function securityChecks() {
  const MOCK2 = MOCK_PORT + 31, PORT2 = PORT + 31, PORT3 = PORT + 32, PORT4 = PORT + 33;
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const stamp = Date.now();
  const files = (tag) => ({ CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), CIVIC_SIGNIN_LOG: path.join(os.tmpdir(), `civic-verify-sec-signins-${tag}-${stamp}.jsonl`), CIVIC_USES_FILE: path.join(os.tmpdir(), `civic-verify-sec-uses-${tag}-${stamp}.jsonl`) });
  const env = { OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, CIVIC_IMAGE_ENABLED: 'false', CIVIC_ACCESS_CODES: 'ABCD234,EFGH567', CIVIC_OPERATOR_CODES: 'ABCD234' };
  const SECRET = 'verify-session-secret-of-thirty-two-bytes';
  const a = start([path.join(root, 'server', 'index.js')], { ...env, ...files('a'), PORT: String(PORT2), OPENAI_API_KEY: KEY, CIVIC_SESSION_SECRET: SECRET });
  const b = start([path.join(root, 'server', 'index.js')], { ...env, ...files('b'), PORT: String(PORT3), OPENAI_API_KEY: `${KEY}-other`, CIVIC_SESSION_SECRET: SECRET });   // another key, the same secret
  const c = start([path.join(root, 'server', 'index.js')], { ...env, ...files('c'), PORT: String(PORT4), OPENAI_API_KEY: `${KEY}-other` });                                 // another key, no secret
  await wait(`http://localhost:${PORT2}/api/health`);
  await wait(`http://localhost:${PORT3}/api/health`);
  await wait(`http://localhost:${PORT4}/api/health`);
  const base = `http://localhost:${PORT2}`;
  const json = async (url, init) => { const r = await fetch(url, init); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
  const post = (url, body, headers = {}) => json(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const streamWith = async (url, body, headers = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!res.ok) return { status: res.status, body: await res.json().catch(() => null), events: [] };
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { status: res.status, events };
  };
  const att = (r) => r.events.find((e) => e.t === 'attached');
  const done = (r) => r.events.some((e) => e.t === 'done');
  const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level.';
  const signin = async (port, code, email) => (await post(`http://localhost:${port}/api/signin`, { email, code })).cookie;
  try {
    const op = await signin(PORT2, 'ABCD234', 'op@example.com');
    const rd = await signin(PORT2, 'EFGH567', 'reader@example.com');

    const upper = await post(`${base}/API/extract`, { text });
    const mixed = await post(`${base}/Api/Extract`, { text });
    const upperWith = await post(`${base}/API/extract`, { text }, { cookie: op });
    const selfUpper = await json(`${base}/API/selftest`);
    check('/API/extract, /Api/Extract and /API/selftest are nobody\'s route: none answers 200, with a cookie or without (routes match their case, and the gate sits on /api itself)',
      upper.status !== 200 && mixed.status !== 200 && upperWith.status !== 200 && selfUpper.status !== 200, JSON.stringify({ upper: upper.status, mixed: mixed.status, upperWith: upperWith.status, selfUpper: selfUpper.status }));

    const cross = await post(`${base}/api/extract`, { text }, { cookie: op, 'sec-fetch-site': 'cross-site' });
    const same = await streamWith(`${base}/api/extract`, { text, jobId: 'verify-sec-same-origin-1' }, { cookie: op, 'sec-fetch-site': 'same-origin' });
    check('a request the browser marks as another site\'s is refused (403 cross_site) whatever cookie it carries, and one marked same-origin runs to its end',
      cross.status === 403 && cross.body?.error?.code === 'cross_site' && same.status === 200 && done(same), JSON.stringify({ cross: { status: cross.status, code: cross.body?.error?.code }, same: same.status }));

    const own = await streamWith(`${base}/api/extract`, { text, jobId: 'verify-sec-owner-1' }, { cookie: op });
    const foreign = await post(`${base}/api/extract`, { jobId: 'verify-sec-owner-1', cursor: 0 }, { cookie: rd });
    const foreignCancel = await post(`${base}/api/cancel`, { jobIds: ['verify-sec-owner-1'] }, { cookie: rd });
    const foreignRelease = await post(`${base}/api/release`, { jobIds: ['verify-sec-owner-1'] }, { cookie: rd });
    const ownRelease = await post(`${base}/api/release`, { jobIds: ['verify-sec-owner-1'] }, { cookie: op });
    check('a job belongs to the sign-in that started it: another code\'s cookie cannot attach to it (403 not_your_job), its cancel and release count nothing, and the owner\'s release lets it go',
      own.status === 200 && done(own) && foreign.status === 403 && foreign.body?.error?.code === 'not_your_job' && foreignCancel.body?.cancelled === 0 && foreignRelease.body?.released === 0 && ownRelease.body?.released === 1,
      JSON.stringify({ own: own.status, foreign: foreign.status, code: foreign.body?.error?.code, foreignCancel: foreignCancel.body, foreignRelease: foreignRelease.body, ownRelease: ownRelease.body }));

    const id81 = `run-${'a'.repeat(36)}-c10-${'b'.repeat(36)}`;   // the page's shape for the eleventh claim: 81 characters
    const first = await streamWith(`${base}/api/extract`, { text, jobId: id81 }, { cookie: op });
    const again = await streamWith(`${base}/api/extract`, { jobId: id81, cursor: 0 }, { cookie: op });
    check('an 81-character id (a claim beyond the tenth) is kept as given, and the job is found again under it after its end',
      id81.length === 81 && first.status === 200 && att(first)?.job === id81 && again.status === 200 && att(again)?.job === id81 && att(again)?.finished === true, JSON.stringify({ length: id81.length, first: att(first)?.job, again: att(again) }));
    const id200 = `x-${'z'.repeat(198)}`;
    const long = await streamWith(`${base}/api/extract`, { text, jobId: id200 }, { cookie: op });
    const kept = att(long)?.job;
    const back = kept ? await streamWith(`${base}/api/extract`, { jobId: kept, cursor: 0 }, { cookie: op }) : { status: 0, events: [] };
    check('a 200-character id is replaced by the server\'s own, named in the first event, and that id finds the job again',
      long.status === 200 && Boolean(kept) && kept !== id200 && /^j-/.test(kept) && back.status === 200 && att(back)?.job === kept && att(back)?.finished === true, JSON.stringify({ kept, back: att(back) }));

    const onB = await json(`http://localhost:${PORT3}/api/health`, { headers: { cookie: op } });
    const onC = await json(`http://localhost:${PORT4}/api/health`, { headers: { cookie: op } });
    check('with CIVIC_SESSION_SECRET set the cookie is the secret\'s and not the key\'s: a FactEngine on another OpenAI key and the same secret honours it; one on another key without the secret does not',
      onB.body?.access?.session?.email === 'op@example.com' && onC.body?.access?.session === null, JSON.stringify({ onB: onB.body?.access, onC: onC.body?.access }));

    const opHealth = await json(`${base}/api/health`, { headers: { cookie: op } });
    const rdHealth = await json(`${base}/api/health`, { headers: { cookie: rd } });
    const opSelf = await json(`${base}/api/selftest`, { headers: { cookie: op } });
    const rdSelf = await json(`${base}/api/selftest`, { headers: { cookie: rd } });
    check('with CIVIC_OPERATOR_CODES set, the sign-in list and the runs per code go to the operator\'s codes alone: the health line says who the operator is, and a reader\'s check page has neither',
      opHealth.body?.access?.session?.operator === true && rdHealth.body?.access?.session?.operator === false
        && opSelf.status === 200 && (opSelf.body?.signins || []).length >= 2 && (opSelf.body?.codes || []).length === 2 && opSelf.body?.access?.operator === true
        && rdSelf.status === 200 && (rdSelf.body?.signins || []).length === 0 && (rdSelf.body?.codes || []).length === 0 && rdSelf.body?.access?.operator === false,
      JSON.stringify({ op: opHealth.body?.access, rd: rdHealth.body?.access, opSelf: { signins: opSelf.body?.signins?.length, codes: opSelf.body?.codes?.length }, rdSelf: { signins: rdSelf.body?.signins?.length, codes: rdSelf.body?.codes?.length } }));

    const cCookie = await signin(PORT4, 'ABCD234', 'op@example.com');
    const cSelf = await json(`http://localhost:${PORT4}/api/selftest`, { headers: { cookie: cCookie } });
    const warned = (cSelf.body?.checks || []).some((x) => x.state === 'warn' && /CIVIC_SESSION_SECRET/.test(x.fix || ''));
    const quiet = !(opSelf.body?.checks || []).some((x) => /CIVIC_SESSION_SECRET|CIVIC_OPERATOR_CODES/.test(x.fix || ''));
    check('/check warns while codes are set and the secret is not, and says nothing once the secret is set and the operator named', warned && quiet, JSON.stringify({ warned, quiet }));
  } catch (err) {
    check('the security checks completed', false, err.message);
  }
  for (const s of [a, b, c, mock]) { try { s.kill('SIGTERM'); } catch {} }
  for (const tag of ['a', 'b', 'c']) for (const k of ['CIVIC_SIGNIN_LOG', 'CIVIC_USES_FILE']) { try { fs.unlinkSync(files(tag)[k]); } catch {} }
}
await securityChecks();

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

// The visual echo is an edit of the FactEngine photograph, sent with every request as the style
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
      refused.status === 400 && refused.body?.error?.code === 'url_refused' && refused.body?.error?.site === 'localhost' && /^localhost turns FactEngine's server away, though people can often read it in a browser\./.test(refused.body?.error?.message || '') && !/40[13]/.test(refused.body?.error?.message || ''), JSON.stringify(refused.body));
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
      shutVideo.status === 400 && shutVideo.body?.error?.code === 'url_video_wall' && /^YouTube would not show this video\'s captions to FactEngine\'s server without a sign-in/.test(shutVideo.body?.error?.message || '') && JSON.stringify(doors5) === JSON.stringify(['ANDROID', 'TVHTML5', 'WEB_EMBEDDED_PLAYER', 'ANDROID_VR', 'IOS']) && /ANDROID LOGIN_REQUIRED: Sign in.*IOS LOGIN_REQUIRED/.test(shutRec?.detail || ''), JSON.stringify({ body: shutVideo.body, doors5, detail: shutRec?.detail }));
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
      silent1.status === 400 && silent1.body?.error?.code === 'url_silent' && silent1.ms < 30000 && /turns FactEngine's server away/.test(silent1.body?.error?.message || ''), JSON.stringify({ status: silent1.status, ms: silent1.ms, body: silent1.body }));
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
      mute1.status === 400 && mute1.body?.error?.code === 'url_silent' && mute1.ms >= 9000 && mute1.ms < 30000 && /turns FactEngine's server away/.test(mute1.body?.error?.message || '') && Boolean(muteRec), JSON.stringify({ status: mute1.status, ms: mute1.ms, body: mute1.body, detail: muteRec?.detail }));
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

// A link a site refused, found elsewhere (server/copies.js): the search service is asked with only the
// words of the link and its date, and the paper's name; copies that say they are the paper's article come
// first; a copy dated far from the link, the refused site's own pages and repeats are left out; the key
// travels in its header and nowhere else; each search's cost is the service's own figure on the ledger;
// a rate limit is a wait; any other refusal is a note on /check and no copies; without the service set,
// nothing is asked and the page is told so.
async function copiesChecks() {
  const MOCK5 = MOCK_PORT + 40, PORT5 = PORT + 40, PORT6 = PORT + 41, SITE3 = PORT + 42;
  const SEARCH_KEY = 'search-key-standin-7f3a9c';
  const REFUSED = `http://127.0.0.1:${SITE3}/2026/09/30/us/hegseth-troops-address.html`;
  const searchCalls = [];
  const forced = [];   // answers the stand-in gives before its ordinary ones: '429' or '402'
  const prose = (n) => `<p>${'Defense Secretary Pete Hegseth spoke to 600 junior officers and enlisted leaders at Quantico on Sept. 30. '.repeat(n)}</p>`;
  const plain = (n) => 'Defense Secretary Pete Hegseth spoke to 600 junior officers and enlisted leaders at Quantico on Sept. 30. '.repeat(n);
  const site = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/search')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch {}
        searchCalls.push({ key: req.headers['x-api-key'] || '', auth: req.headers.authorization || '', body, at: Date.now() });
        const f = forced.shift();
        if (f === '429') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }); res.end(JSON.stringify({ error: 'Too many requests' })); return; }
        if (f === '402') { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `Insufficient credits for ${SEARCH_KEY}` })); return; }
        const republished = /originally appeared in/i.test(String(body.query || ''));
        const results = republished ? [
          { url: `http://localhost:${SITE3}/copy-a`, title: 'Hegseth lays out his military vision', publishedDate: '2026-10-01T00:05:00.000Z', author: '', text: `${plain(4)}\n\nThis article originally appeared in 127.0.0.1.` },
          { url: `http://localhost:${SITE3}/copy-old`, title: 'An older article from the same paper', publishedDate: '2025-09-30T00:00:00.000Z', text: `${plain(4)}\n\nThis article originally appeared in 127.0.0.1.` },
          { url: `http://localhost:${SITE3}/copy-blocked`, title: 'The same article, on a site that turns FactEngine away', publishedDate: '2026-09-30T12:00:00.000Z', author: '127.0.0.1', text: plain(5) },
        ] : [
          { url: `http://localhost:${SITE3}/report-d`, title: 'Another outlet reports the speech', publishedDate: '2026-09-30T21:51:00.000Z', text: plain(3) },
          { url: REFUSED, title: 'The refused page itself', publishedDate: '2026-09-30T00:00:00.000Z', text: plain(2) },
          { url: `http://localhost:${SITE3}/copy-a/`, title: 'Hegseth lays out his military vision', publishedDate: '2026-10-01T00:05:00.000Z', text: plain(4) },
          { url: `http://localhost:${SITE3}/undated`, title: 'An undated report', text: plain(3) },
        ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ requestId: 'standin', results, costDollars: { total: 0.007 } }));
      });
      return;
    }
    if (req.url.startsWith('/2026/') || req.url.startsWith('/copy-blocked')) { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html><body>Forbidden</body></html>'); return; }
    if (req.url.startsWith('/copy-a')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><title>Hegseth lays out his military vision</title><meta property="og:site_name" content="The Stand-in Times"></head><body><article>${prose(4)}<p>This article originally appeared in 127.0.0.1.</p></article></body></html>`); return; }
    if (req.url.startsWith('/report-d')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><title>Another outlet reports the speech</title></head><body><article>${prose(3)}</article></body></html>`); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => site.listen(SITE3, r));
  const ledgerFile = path.join(os.tmpdir(), `civic-verify-copies-ledger-${Date.now()}.jsonl`);
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK5), MOCK_SPEED: '0.2' });
  await wait(`http://localhost:${MOCK5}/v1/mock/stats`, 15000, { anyResponse: true });
  const common = { OPENAI_BASE_URL: `http://localhost:${MOCK5}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_ALLOW_PRIVATE_URLS: 'true', CIVIC_LEDGER_FILE: ledgerFile, CIVIC_ERROR_LOG: path.join(os.tmpdir(), `civic-verify-copies-errors-${Date.now()}.log`) };
  const on = start([path.join(root, 'server', 'index.js')], { ...common, PORT: String(PORT5), CIVIC_SEARCH_URL: `http://localhost:${SITE3}/search`, CIVIC_SEARCH_KEY: SEARCH_KEY });
  const off = start([path.join(root, 'server', 'index.js')], { ...common, PORT: String(PORT6) });
  await wait(`http://localhost:${PORT5}/api/health`);
  await wait(`http://localhost:${PORT6}/api/health`);
  const find = async (base, url) => { const t0 = Date.now(); const r = await fetch(`${base}/api/find-copies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {} return { status: r.status, ms: Date.now() - t0, body, text }; };
  const read = async (base, url) => { const r = await fetch(`${base}/api/read-url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const baseOn = `http://localhost:${PORT5}`, baseOff = `http://localhost:${PORT6}`;
  try {
    // What a link says, read the same way for every paper: its words and its date, nothing guessed.
    const w = [
      linkWords('https://www.nytimes.com/2026/09/30/us/hegseth-troops-address.html'),
      linkWords('https://www.npr.org/2026/09/30/nx-s1-5986304/hegseth-troops-address'),
      linkWords('https://www.usatoday.com/story/news/politics/2026/09/30/pete-hegseth-state-of-force-transgender-troops-dei/92024167007/'),
      linkWords('https://thehill.com/policy/defense/6121765-pete-hegseth-takeaways-command-warfare-base/'),
      linkWords('https://www.inquirer.com/news/nation-world/hegseth-navy-promotions-list-pentagon-20260601.html'),
    ];
    check('a link\'s own words and date are read from its address, ids and section names left out, and nothing is guessed when it carries no date',
      w[0].words === 'hegseth troops address' && w[0].date === 'September 30 2026' && w[1].words === 'hegseth troops address' && w[2].words === 'pete hegseth state of force transgender troops dei'
      && w[3].words === 'pete hegseth takeaways command warfare base' && w[3].date === '' && w[4].date === 'June 1 2026'
      && publisherOf('www.nytimes.com') === 'The New York Times' && publisherOf('example.org') === 'example.org', JSON.stringify(w.map((x) => [x.words, x.date])));
    const lines = attributionLines({ kind: 'link', title: 'T', url: 'https://example.org/a', via: 'search' }, new Date('2026-10-01T12:00:00Z'));
    const direct = attributionLines({ kind: 'link', title: 'T', url: 'https://example.org/a' }, new Date('2026-10-01T12:00:00Z'));
    check('when a copy\'s text came from the search service, the source\'s attribution says so; otherwise it is as before',
      lines.at(-1) === 'Read by FactEngine on 2026-10-01 through a search service\'s copy of that address.' && direct.at(-1) === 'Read by FactEngine from that address on 2026-10-01.', JSON.stringify([lines.at(-1), direct.at(-1)]));

    // Without the service set: the page is told so, and nothing is asked.
    const hOff = await (await fetch(`${baseOff}/api/health`)).json();
    const fOff = await find(baseOff, REFUSED);
    check('without a search service set, /api/health says so and a request to look elsewhere is refused without asking anyone',
      hOff.findCopies === false && fOff.status === 409 && fOff.body?.error?.code === 'search_off' && searchCalls.length === 0, JSON.stringify({ findCopies: hOff.findCopies, status: fOff.status, calls: searchCalls.length }));

    // With it set: the two searches, the copies in order, the key only in its header.
    const hOn = await (await fetch(`${baseOn}/api/health`)).json();
    const got = await find(baseOn, REFUSED);
    const urls = (got.body?.copies || []).map((c) => c.url.replace(`http://localhost:${SITE3}`, ''));
    check('a refused link is looked for elsewhere: copies that say they are the paper\'s article first, then other reports, each with its headline, site, date and text',
      hOn.findCopies === true && got.status === 200 && JSON.stringify(urls) === JSON.stringify(['/copy-a', '/copy-blocked', '/report-d', '/undated'])
      && JSON.stringify(got.body.copies.map((c) => c.credited)) === JSON.stringify([true, true, false, false]) && got.body.publisher === '127.0.0.1'
      && got.body.copies[0].title === 'Hegseth lays out his military vision' && got.body.copies[0].site === 'localhost' && got.body.copies[0].published === '2026-10-01' && got.body.copies.every((c) => c.text.length > 100), JSON.stringify({ status: got.status, urls, credited: got.body?.copies?.map((c) => c.credited) }));
    check('left out: a copy dated a year from the link, the refused site\'s own page, and a repeat of a copy already listed', !urls.includes('/copy-old') && !urls.some((u) => u.includes('/2026/')) && urls.filter((u) => u.startsWith('/copy-a')).length === 1, JSON.stringify(urls));
    const qs = searchCalls.map((c) => String(c.body?.query || ''));
    check('the search is asked twice, with only the link\'s words, its date and the paper\'s name: once for the line republishers print, once for reports, never on the refused site',
      searchCalls.length === 2 && qs.some((q) => q === 'hegseth troops address September 30 2026 "This article originally appeared in 127.0.0.1"') && qs.some((q) => q === 'hegseth troops address September 30 2026 127.0.0.1')
      && searchCalls.every((c) => JSON.stringify(c.body.excludeDomains) === '["127.0.0.1"]' && c.body.contents?.text === true && c.body.numResults === 10), JSON.stringify(searchCalls.map((c) => c.body)));
    check('the key travels in the service\'s own header and nowhere else: not in the answer, the health line, the check page or the ledger',
      searchCalls.every((c) => c.key === SEARCH_KEY && c.auth === '') && !got.text.includes(SEARCH_KEY) && !JSON.stringify(hOn).includes(SEARCH_KEY), JSON.stringify(searchCalls.map((c) => c.key === SEARCH_KEY)));
    const st = await (await fetch(`${baseOn}/api/selftest`)).json();
    check('/check says a refused link is looked for elsewhere, naming the service by its address and never its key',
      (st.checks || []).some((c) => c.state === 'ok' && c.title === 'A link a site refuses is looked for elsewhere' && /localhost/.test(c.detail)) && !JSON.stringify(st).includes(SEARCH_KEY), JSON.stringify((st.checks || []).map((c) => c.title)));

    // FactEngine's own reader reads the copy it can, and is turned away by the one whose site refuses it, which
    // is when the page uses the search service's text of that page (proved in the browser check).
    const a = await read(baseOn, `http://localhost:${SITE3}/copy-a`);
    const b = await read(baseOn, `http://localhost:${SITE3}/copy-blocked`);
    check('a picked copy is read by FactEngine\'s own reader like any link; a copy whose site turns FactEngine away answers the refusal, and the page then has the search\'s text of it',
      a.status === 200 && /originally appeared in 127\.0\.0\.1/.test(a.body?.text || '') && b.status === 400 && b.body?.error?.code === 'url_refused' && got.body.copies[1].text.length > 100, JSON.stringify({ a: a.status, b: b.body?.error?.code }));

    // A rate limit is a wait: the service's own Retry-After, then the same search again.
    forced.push('429');
    const before = searchCalls.length;
    const slow = await find(baseOn, REFUSED);
    check('a rate limit from the search service is a wait of the time it asks, then the same search again, never a failure',
      slow.status === 200 && slow.body?.copies?.length === 4 && slow.ms >= 1000 && searchCalls.length - before === 3, JSON.stringify({ status: slow.status, n: slow.body?.copies?.length, ms: slow.ms, calls: searchCalls.length - before }));

    // Any other refusal: no copies, and a note for the operator in the service's own words, without the key.
    forced.push('402', '402');
    const broke = await find(baseOn, REFUSED);
    const recs = ((await (await fetch(`${baseOn}/api/selftest`)).json()).recentFailures || []).filter((f) => f.where === 'server:find-copies');
    check('a refusal from the search service gives no copies and a note on /check in its own words, the key struck out',
      broke.status === 200 && broke.body?.copies?.length === 0 && recs.length >= 1 && recs.every((f) => /answered 402 \(Insufficient credits for <key>\)/.test(f.detail || '') && !JSON.stringify(f).includes(SEARCH_KEY)), JSON.stringify(recs).slice(0, 400));

    // Each search is one ledger line with the service's own cost.
    await new Promise((r) => setTimeout(r, 300)); // the ledger is appended asynchronously
    const ledger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const searches = ledger.filter((l) => l.kind === 'search');
    check('each search is a ledger line with the service\'s own cost for it, and the key is in no line',
      searches.length === 4 && searches.every((l) => l.step === 'find-copies' && l.usd === 0.007 && Number.isFinite(l.ms)) && !JSON.stringify(ledger).includes(SEARCH_KEY), JSON.stringify(searches).slice(0, 300));
  } finally {
    for (const p of [on, off, mock]) { try { p.kill('SIGTERM'); } catch {} }
    site.close();
  }
}
await copiesChecks();

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
    check('the tool table lists the verbs the sources on can answer, read_page, get_transcript and search_web (the search service is set), nothing else, and with one source each no source parameter', JSON.stringify(tools.map((t) => t.name)) === JSON.stringify(['read_page', 'get_transcript', 'search_web']) && tools.every((t) => !t.inputSchema.properties.source && t.inputSchema.required.includes(t.name === 'search_web' ? 'query' : 'url') && t.description.length > 40), JSON.stringify(tools).slice(0, 300));
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
    check('the stand-in OpenAI, as a client of the gateway, listed the tools and made its calls: the page\'s text came back whole, the refused page as the site\'s answer', listed?.status === 200 && JSON.stringify(listed?.names) === JSON.stringify(['read_page', 'get_transcript', 'search_web']) && made.length === 2 && made[0].failed === false && /The Nile is about 6,650 kilometres long/.test(made[0].output) && made[1].failed === true && /turns FactEngine's server away/.test(made[1].output), JSON.stringify({ listed: listed?.names, made: made.map((m) => [m.status, m.failed, String(m.output).slice(0, 80)]) }));
    const steps = ev.filter((e) => e.t === 'trail').map((e) => e.step);
    const toolSteps = steps.filter((s) => s.kind === 'tool');
    const done = ev.find((e) => e.t === 'done');
    check('the page\'s stream shows each tool call as a step of the trail, by its verb and what it was asked, with the source\'s answer when it kept the page', toolSteps.length === 2 && toolSteps[0].name === 'read_page' && toolSteps[0].url === `${siteBase}/tool-page` && toolSteps[0].status === 'completed' && !toolSteps[0].error && toolSteps[1].status === 'failed' && /turns FactEngine's server away/.test(toolSteps[1].error || ''), JSON.stringify(toolSteps));
    const webSteps = steps.filter((s) => s.kind !== 'tool').length;
    check('the searches counted for the cost are the web searches alone; the tool calls sit in the trail and on their own ledger lines; the row said it was reading', Boolean(done) && done.searches === webSteps && done.trail.length === webSteps + 2 && ev.some((e) => e.t === 'phase' && e.phase === 'reading'), JSON.stringify({ searches: done?.searches, webSteps, trail: done?.trail?.length }));
    const ledger = readIf(ledgerFile).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const toolLines = ledger.filter((l) => l.kind === 'tool' && l.source === 'web');
    check('each call is one ledger line: the source, the verb, the time, the operator\'s price (zero for FactEngine\'s own reader), and how it ended', toolLines.length >= 2 && toolLines.every((l) => l.source === 'web' && ['read_page', 'get_transcript'].includes(l.verb) && l.usd === 0 && l.priced === true && typeof l.ms === 'number') && toolLines.some((l) => l.ok === true && l.chars > 100) && toolLines.some((l) => l.ok === false && l.code === 'url_refused'), JSON.stringify(toolLines.slice(-2)));
    const searchLines = ledger.filter((l) => l.kind === 'tool' && l.source === 'search');
    check('a search through the tool server is one ledger line priced at the search service\'s own figure for it, and no line of the copies search beside it', searchLines.length === 1 && searchLines[0].verb === 'search_web' && searchLines[0].usd === 0.005 && searchLines[0].ok === true && searchLines[0].items === 1 && !ledger.some((l) => l.kind === 'search'), JSON.stringify({ search: searchLines, copies: ledger.filter((l) => l.kind === 'search').length }));
    const st = await (await fetch(`${base}/api/selftest`)).json();
    const bySource = (id) => (st.tools?.sources || []).find((x) => x.id === id);
    check('/check lists the sources the model can reach for, by name and verb, and that the requests name the gateway', st.tools?.reachable === true && st.tools?.on === true && st.tools?.requests?.determinations === true && JSON.stringify(bySource('web')?.verbs) === JSON.stringify(['read_page', 'get_transcript']) && JSON.stringify(bySource('search')?.verbs) === JSON.stringify(['search_web']), JSON.stringify(st.tools));
    const everywhere = readIf(ledgerFile) + readIf(errorLog) + JSON.stringify(st) + JSON.stringify(ev) + JSON.stringify(ex) + await (await fetch(`${base}/`)).text() + await (await fetch(`${base}/api/health`)).text();
    check('the pass appears in no record, no stream, no page and no health line', !everywhere.includes(PASS), '');
  } finally {
    try { server.kill('SIGTERM'); } catch {}
    try { mock.kill('SIGTERM'); } catch {}
    site.close();
  }
}
await toolChecks();

// Facts have a price, and every user is measured (server/economics.js, server/db.js; the operator's
// program of 2 October). Proved on a real Postgres: the guard makes its own cluster here (initdb in a
// temporary directory; as root, handed to the postgres user) or uses CIVIC_VERIFY_DATABASE_URL, as in
// CI's service container; with CIVIC_VERIFY_REQUIRE_DATABASE=1 a missing database is a failure, so
// nothing passes by skipping. The file mode (no DATABASE_URL) runs the same flow at the end.
async function provisionPostgres() {
  if (process.env.CIVIC_VERIFY_DATABASE_URL) return { url: process.env.CIVIC_VERIFY_DATABASE_URL, stop: async () => {} };
  const onPath = (() => { const r = spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf8' }); return r.status === 0 ? path.dirname(r.stdout.trim()) : null; })();
  const bins = ['/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin', '/usr/local/pgsql/bin', '/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', onPath].filter(Boolean);
  const bin = bins.find((b) => fs.existsSync(path.join(b, 'initdb')) && fs.existsSync(path.join(b, 'pg_ctl')));
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civic-verify-pg-'));
  const port = PORT + 90;   // its own port, clear of every server and stand-in the guard starts
  const asPostgres = typeof process.getuid === 'function' && process.getuid() === 0;   // initdb will not run as root: the cluster is the postgres user's
  const run = (cmd, args) => (asPostgres ? spawnSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { encoding: 'utf8' }) : spawnSync(cmd, args, { encoding: 'utf8' }));
  if (asPostgres) spawnSync('chown', ['-R', 'postgres', dir]);
  const init = run(path.join(bin, 'initdb'), ['-D', path.join(dir, 'data'), '-U', 'postgres', '-A', 'trust', '--no-sync', '-E', 'UTF8']);
  if (init.status !== 0) { console.error(`  (economics: initdb failed: ${(init.stderr || init.stdout || '').trim().slice(0, 200)})`); return null; }
  const up = run(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-w', '-l', path.join(dir, 'pg.log'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -F`, 'start']);
  if (up.status !== 0) { let log = ''; try { log = fs.readFileSync(path.join(dir, 'pg.log'), 'utf8').trim().split('\n').slice(-3).join(' | '); } catch {} console.error(`  (economics: pg_ctl start failed: ${(up.stderr || up.stdout || '').trim().slice(0, 200)} ${log})`); return null; }
  return { url: `postgres://postgres@127.0.0.1:${port}/postgres`, stop: async () => { run(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

async function economicsChecks() {
  const required = /^(1|true|yes)$/i.test(process.env.CIVIC_VERIFY_REQUIRE_DATABASE || '');
  const provision = await provisionPostgres().catch((err) => { console.error(`  (economics: no database: ${err.message})`); return null; });
  if (!provision) {
    if (required) check('a Postgres is available for the economics checks (CIVIC_VERIFY_REQUIRE_DATABASE=1)', false, 'no CIVIC_VERIFY_DATABASE_URL, and initdb is not on this machine');
    else console.log('  (economics: no Postgres here, so the database checks are skipped; CI runs them against a service container)');
  }
  const MOCK2 = MOCK_PORT + 50;
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_HOLD_MS: '900', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
  const usesFile = path.join(os.tmpdir(), `civic-verify-economics-uses-${Date.now()}.jsonl`);
  const common = { OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), CIVIC_SIGNIN_LOG: path.join(os.tmpdir(), 'civic-verify-signins.jsonl'), CIVIC_USES_FILE: usesFile, CIVIC_ACCESS_CODES: 'ABCD234,EFGH567', CIVIC_OPERATOR_CODES: 'ABCD234', CIVIC_CODE_USES: '100' };
  const servers = [];
  const boot = async (port, env) => { const s = start([path.join(root, 'server', 'index.js')], { ...common, PORT: String(port), ...env }); servers.push(s); await wait(`http://localhost:${port}/api/health`, 20000); return s; };
  const base = (port) => `http://localhost:${port}`;
  const signin = async (port, code) => { const r = await fetch(`${base(port)}/api/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${code.toLowerCase()}@verify`, code }) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
  const streamAs = async (url, body, cookie) => { const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }); if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${await res.text()}`); return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)); };
  const json = async (url, cookie) => (await fetch(url, { headers: { cookie } })).json();
  const runOn = async (port, cookie, jobId) => streamAs(`${base(port)}/api/extract`, { text, jobId }, cookie);
  const detOn = async (port, cookie, { jobId, runId, n = 1, entry }) => streamAs(`${base(port)}/api/evaluate`, { jobId, claims: [entry], text, source: { kind: 'text' }, runId, n }, cookie);
  const quoteOf = (events) => { const q = events.find((e) => e.t === 'quote'); return q ? { free: q.free, priceCents: q.priceCents } : null; };
  const pricingOf = (events) => { const p = events.find((e) => e.t === 'pricing'); return p ? { tier: p.tier, freeFacts: p.freeFacts, priceCents: p.priceCents, currency: p.currency, note: p.note } : null; };
  const HOUR = 3600e3, DAY = 86400e3;
  const opts = { hours: 6, order: [1, 2, 3, 4], shift: 1, fixed: null };
  // An instant in the first half of a day whose tier is 3, so the next window is tier 4 on the same day.
  let T0 = Date.parse('2026-10-05T00:00:00Z');
  while (!(tierAt(T0, opts) === 3 && [0, 6].includes(new Date(T0).getUTCHours()))) T0 += 6 * HOUR;
  const T1 = T0 + 6 * HOUR;
  const at = (ms) => new Date(ms).toISOString();

  // 1. The clock, as arithmetic: every six hours, the daily shift, a fixed clock, a fixed tier.
  try {
    const base0 = Date.parse('2026-10-04T00:00:00Z');
    const slots = {};   // hour of day → the tiers seen over four days
    let changes = 0, prev = null, boundaries = true;
    for (let k = 0; k < 16; k++) {
      const t = base0 + k * 6 * HOUR;
      const tier = tierAt(t, opts);
      const mid = tierAt(t + 3 * HOUR, opts);
      const before = tierAt(t - 1, opts);
      if (mid !== tier) boundaries = false;
      if (prev !== null && before !== prev) boundaries = false;
      if (prev !== null && tier !== prev) changes++;
      prev = tier;
      const h = new Date(t).getUTCHours();
      slots[h] = [...(slots[h] || []), tier];
    }
    const everyTierEveryHour = Object.values(slots).every((list) => JSON.stringify([...list].sort()) === '[1,2,3,4]');
    const fixedClock = [0, 1, 2, 3].every((d) => tierAt(base0 + d * DAY, { ...opts, shift: 0 }) === tierAt(base0, { ...opts, shift: 0 }));
    check('the tier changes every six hours and only at the boundary, over four days every tier meets every time of day (the daily shift), a shift of 0 is a fixed clock, and CIVIC_TIER_FIXED holds one tier',
      boundaries && changes === 15 && everyTierEveryHour && fixedClock && tierAt(base0, { ...opts, fixed: 2 }) === 2 && tierAt(base0 + 5 * DAY, { ...opts, fixed: 2 }) === 2 && freeFor(1) === 0 && freeFor(4) === 3 && priceFromAverage(0.36, 25) === 45 && priceFromAverage(0.0081, 25) === 2,
      JSON.stringify({ boundaries, changes, slots, fixedClock }));
  } catch (err) { check('the tier clock arithmetic', false, err.message); }

  let admin = null;
  const dbUrl = (name) => { const u = new URL(provision.url); u.pathname = `/${name}`; return u.toString(); };
  const makeDb = async (name) => { await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.query(`CREATE DATABASE ${name}`); return dbUrl(name); };
  const dbQuery = async (url, sql, params = []) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); } };
  if (provision) {
    try {
      admin = new pg.Client({ connectionString: provision.url });
      await admin.connect();
      const DB1 = await makeDb('civic_verify_econ1');
      // 2. A run under tier 3 at the start price: the page is told first; the document's first two chosen claims are free, the third priced; a second document gets two free again.
      const P1 = PORT + 50;
      await boot(P1, { DATABASE_URL: DB1, CIVIC_CLOCK: at(T0), CIVIC_PRICE_START_CENTS: '45' });
      const a = await signin(P1, 'ABCD234');
      const health = await json(`${base(P1)}/api/health`, a);
      check('with a database, the health line carries the prices as the page shows them: the tier, the free count, the price and the note, and nothing else, never a cost',
        JSON.stringify(Object.keys(health.pricing || {}).sort()) === JSON.stringify(['currency', 'freeFacts', 'note', 'priceCents', 'tier']) && health.pricing.tier === 3 && health.pricing.freeFacts === 2 && health.pricing.priceCents === 45 && health.pricing.currency === 'USD' && !/cost|usd|margin|revenue|token/i.test(Object.keys(health.pricing).join(',')),
        JSON.stringify(health.pricing));
      const r1 = await runOn(P1, a, 'verify-econ-r1');
      const claims = r1.find((e) => e.t === 'done')?.claims || [];
      const entry = (i) => claims[i % Math.max(1, claims.length)]?.entry || text;
      check('the extraction\'s first event after attaching tells the page this run\'s tier, free count and price, fixed for the document',
        r1[0]?.t === 'attached' && JSON.stringify(pricingOf(r1)) === JSON.stringify({ tier: 3, freeFacts: 2, priceCents: 45, currency: 'USD', note: null }) && claims.length >= 3, JSON.stringify(r1.slice(0, 2)));
      const d1 = await detOn(P1, a, { jobId: 'verify-econ-r1-c1', runId: 'verify-econ-r1', n: 1, entry: entry(0) });
      const d2 = await detOn(P1, a, { jobId: 'verify-econ-r1-c2', runId: 'verify-econ-r1', n: 2, entry: entry(1) });
      const d3 = await detOn(P1, a, { jobId: 'verify-econ-r1-c3', runId: 'verify-econ-r1', n: 3, entry: entry(2) });
      const r2 = await runOn(P1, a, 'verify-econ-r2');
      const d4 = await detOn(P1, a, { jobId: 'verify-econ-r2-c1', runId: 'verify-econ-r2', n: 1, entry: entry(0) });
      check('under tier 3 the first two determinations the reader chooses on a document are free and the third is priced at 45 cents, each told to the page before the model is asked; a second document gets its two free again',
        JSON.stringify([quoteOf(d1), quoteOf(d2), quoteOf(d3), quoteOf(d4)]) === JSON.stringify([{ free: true, priceCents: 0 }, { free: true, priceCents: 0 }, { free: false, priceCents: 45 }, { free: true, priceCents: 0 }]) && [d1, d2, d3, d4].every((d) => d.findIndex((e) => e.t === 'quote') < d.findIndex((e) => e.t === 'start')) && [d1, d2, d3, d4].every((d) => d.some((e) => e.t === 'done')),
        JSON.stringify([quoteOf(d1), quoteOf(d2), quoteOf(d3), quoteOf(d4)]));
      await new Promise((r) => setTimeout(r, 500));
      const runs = (await dbQuery(DB1, 'SELECT id, owner, email, code_fp, tier, free_allowed, price_cents, status, claims_total, extract_usd::float AS extract_usd, chars FROM runs ORDER BY started_at')).rows;
      const dets = (await dbQuery(DB1, 'SELECT id, run_id, n, status, free, price_cents, cost_usd::float AS cost_usd, priced, searches, verdict, model, collected, failure FROM determinations ORDER BY started_at')).rows;
      const lines = (await dbQuery(DB1, 'SELECT kind, run_id, determination_id, owner, usd::float AS usd FROM cost_lines ORDER BY id')).rows;
      check('the rows: each run carries its owner (the code\'s fingerprint and the email), its tier, its free count and its price, its claims and its own listing cost; each determination its run, its number, free or the price, its cost from its ledger line, its searches, its verdict and collected=false; every ledger line carries the ids',
        runs.length === 2 && runs.every((r) => /^[0-9a-f]{16}:abcd234@verify$/.test(r.owner) && r.email === 'abcd234@verify' && r.code_fp.length === 16 && r.tier === 3 && r.free_allowed === 2 && r.price_cents === 45 && r.status === 'done' && r.claims_total === claims.length && r.extract_usd > 0 && r.chars === text.length)
          && dets.length === 4 && dets.every((d) => d.status === 'done' && d.cost_usd > 0 && d.priced === true && d.collected === false && d.verdict && d.model && d.failure === null)
          && JSON.stringify(dets.map((d) => [d.run_id, d.n, d.free, d.price_cents])) === JSON.stringify([['verify-econ-r1', 1, true, 0], ['verify-econ-r1', 2, true, 0], ['verify-econ-r1', 3, false, 45], ['verify-econ-r2', 1, true, 0]])
          && lines.length === 6 && lines.filter((l) => l.kind === 'evaluate').every((l) => l.determination_id && l.run_id && l.owner) && lines.filter((l) => l.kind === 'extract').every((l) => l.run_id && !l.determination_id),
        JSON.stringify({ runs, dets: dets.map((d) => [d.id, d.status, d.free, d.price_cents, d.cost_usd]), lines: lines.length }));
      // 3. A determination stopped by the page fails, books nothing, keeps its cost line's figure, and never uses up a free one.
      const resD5 = fetch(`${base(P1)}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: a }, body: JSON.stringify({ jobId: 'verify-econ-r2-c2', claims: [entry(1)], text, source: { kind: 'text' }, runId: 'verify-econ-r2', n: 2 }) });
      await new Promise((r) => setTimeout(r, 400));
      await fetch(`${base(P1)}/api/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: a }, body: JSON.stringify({ jobIds: ['verify-econ-r2-c2'] }) });
      await (await resD5).text().catch(() => '');
      await new Promise((r) => setTimeout(r, 400));
      const d6 = await detOn(P1, a, { jobId: 'verify-econ-r2-c3', runId: 'verify-econ-r2', n: 3, entry: entry(2) });
      const d5row = (await dbQuery(DB1, 'SELECT status, failure, free, price_cents FROM determinations WHERE id = $1', ['verify-econ-r2-c2'])).rows[0];
      check('a determination the page stops is failed as cancelled with nothing booked, and it never uses up a free one: the document\'s next determination is free again',
        d5row?.status === 'failed' && d5row?.failure === 'cancelled' && d5row?.price_cents === 0 && JSON.stringify(quoteOf(d6)) === JSON.stringify({ free: true, priceCents: 0 }), JSON.stringify({ d5row, d6: quoteOf(d6) }));
      // 4. The next window on the same database: the schema is applied once, a run keeps its tier, a new run takes the new one.
      const P2 = PORT + 51;
      await boot(P2, { DATABASE_URL: DB1, CIVIC_CLOCK: at(T1), CIVIC_PRICE_START_CENTS: '45' });
      const a2 = await signin(P2, 'ABCD234');
      const migrations = (await dbQuery(DB1, 'SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
      const d7 = await detOn(P2, a2, { jobId: 'verify-econ-r1-c4', runId: 'verify-econ-r1', n: 4, entry: entry(0) });
      const r3 = await runOn(P2, a2, 'verify-econ-r3');
      const health2 = await json(`${base(P2)}/api/health`, a2);
      check('a second FactEngine on the same database six hours on boots with the schema applied once; a determination of the first document, now from this one, is priced by that document\'s tier and count (two free already taken) whatever the clock says; a new document takes the new window\'s tier (4: three free)',
        migrations === 1 && JSON.stringify(quoteOf(d7)) === JSON.stringify({ free: false, priceCents: 45 }) && JSON.stringify(pricingOf(r3)) === JSON.stringify({ tier: 4, freeFacts: 3, priceCents: 45, currency: 'USD', note: null }) && health2.pricing?.tier === 4,
        JSON.stringify({ migrations, d7: quoteOf(d7), r3: pricingOf(r3), tier: health2.pricing?.tier }));
      // 5. The measurement, for the operator alone.
      const st = await json(`${base(P2)}/api/selftest`, a2);
      const b2 = await signin(P2, 'EFGH567');
      const stB = await json(`${base(P2)}/api/selftest`, b2);
      const e = st.economics;
      const t3 = e?.byTier?.find((x) => x.tier === 3), t4 = e?.byTier?.find((x) => x.tier === 4);
      const user = e?.byUser?.find((x) => x.email === 'abcd234@verify');
      check('the operator\'s check page carries the measurement: per tier (users, runs, determinations, free given, cost, listing cost, revenue at list, margin, margin per user, coverage), per user by email, per window, the price with its basis and the measured average so far, the tier clock, the guard off, revenue at list and nothing collected; a code that is not the operator\'s gets none of it',
        Boolean(e) && e.store === 'postgres' && t3 && t3.users === 1 && t3.runs === 2 && t3.determinations === 6 && t3.failed === 1 && t3.freeGiven === 4 && t3.revenueUsd === 0.9 && t3.costUsd > 0 && Math.abs(t3.marginUsd - (t3.revenueUsd - t3.costUsd)) < 0.0011 && t3.extractUsd > 0 && typeof t3.coverage === 'number'
          && t4 && t4.runs === 1 && t4.determinations === 0 && user && user.runs === 3 && user.determinations === 6 && user.freeGiven === 4 && e.byWindow.length === 2
          && e.price.cents === 45 && e.price.basis === 'start' && e.price.measuredSample === 6 && e.price.measuredAvgUsd > 0 && e.price.minSample === 20 && e.price.markupPercent === 25
          && e.tier.now === 4 && e.tier.freeFacts === 3 && e.tier.hours === 6 && e.guard.configured === false && /list price/.test(e.note) && stB.economics === null,
        JSON.stringify({ t3, t4, user, price: e?.price, tier: e?.tier, guard: e?.guard, other: stB.economics }));
      check('the report carries how long determinations and listings take over the window, with the searches per determination',
        e?.durations && e.durations.determinations.n >= 6 && e.durations.determinations.meanMs > 0 && e.durations.determinations.p75Ms >= e.durations.determinations.meanMs * 0.5 && typeof e.durations.determinations.meanSearches === 'number' && e.durations.extractions.n >= 2 && e.durations.extractions.meanMs > 0,
        JSON.stringify(e?.durations));
      // 6. A deploy with a determination in flight: the row is failed as deploy, nothing booked.
      const P3 = PORT + 52;
      const s3 = await boot(P3, { DATABASE_URL: DB1, CIVIC_CLOCK: at(T1), CIVIC_PRICE_START_CENTS: '45' });
      const a3 = await signin(P3, 'ABCD234');
      const inflight = fetch(`${base(P3)}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: a3 }, body: JSON.stringify({ jobId: 'verify-econ-r3-c1', claims: [entry(0)], text, source: { kind: 'text' }, runId: 'verify-econ-r3', n: 1 }) });
      await new Promise((r) => setTimeout(r, 400));
      s3.kill('SIGTERM');
      await (await inflight).text().catch(() => '');
      await new Promise((r) => setTimeout(r, 800));
      const deployRow = (await dbQuery(DB1, 'SELECT status, failure, price_cents, free FROM determinations WHERE id = $1', ['verify-econ-r3-c1'])).rows[0];
      check('a FactEngine told to stop with a determination in flight fails that row as deploy, nothing booked, before it goes', deployRow?.status === 'failed' && deployRow?.failure === 'deploy' && deployRow?.price_cents === 0, JSON.stringify(deployRow));
      // 7. The price from the measured average: fixed at a window's start, start figure until the sample, the sample's own figure after.
      const DB2 = await makeDb('civic_verify_econ2');
      const T2 = T0 + 12 * HOUR, T3 = T2 + 6 * HOUR;
      const seed = async (url, { runId, tier, from, n, cost, price, free, email = 'seed@verify' }) => {
        await dbQuery(url, 'INSERT INTO runs (id, owner, email, started_at, tier, window_start, price_cents, free_allowed, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING', [runId, `seed:${email}`, email, new Date(from), tier, new Date(windowStartAt(from, 6)), price, freeFor(tier), 'done']);
        for (let i = 0; i < n; i++) await dbQuery(url, "INSERT INTO determinations (id, run_id, n, started_at, ended_at, status, free, price_cents, cost_usd, priced) VALUES ($1, $2, $3, $4, $4, 'done', $5, $6, $7, true)", [`${runId}-d${i + 1}`, runId, i + 1, new Date(from + i * 1000), free, free ? 0 : price, cost]);
      };
      // nineteen determinations at 36 cents two days before: one short of the sample
      const P4 = PORT + 53;
      await boot(P4, { DATABASE_URL: DB2, CIVIC_CLOCK: at(T0) });   // the schema, for the seed
      await seed(DB2, { runId: 'seed-a', tier: 3, from: T2 - 2 * DAY, n: 19, cost: 0.36, price: 45, free: false });
      const P5 = PORT + 54;
      await boot(P5, { DATABASE_URL: DB2, CIVIC_CLOCK: at(T2) });
      const a5 = await signin(P5, 'ABCD234');
      const h5 = await json(`${base(P5)}/api/health`, a5);
      const st5 = await json(`${base(P5)}/api/selftest`, a5);
      await seed(DB2, { runId: 'seed-b', tier: 3, from: T2 - DAY, n: 1, cost: 0.36, price: 45, free: false });
      await new Promise((r) => setTimeout(r, 5500));   // the health line's prices are cached for five seconds
      const h5again = await json(`${base(P5)}/api/health`, a5);
      const P6 = PORT + 55;
      await boot(P6, { DATABASE_URL: DB2, CIVIC_CLOCK: at(T3) });
      const a6 = await signin(P6, 'ABCD234');
      const h6 = await json(`${base(P6)}/api/health`, a6);
      const st6 = await json(`${base(P6)}/api/selftest`, a6);
      const r6 = await runOn(P6, a6, 'verify-econ-r6');
      const windows = (await dbQuery(DB2, 'SELECT window_start, price_cents, sample, basis, avg_cost_usd::float AS avg FROM windows WHERE window_start >= $1 ORDER BY window_start', [new Date(T2)])).rows;
      check('with no start figure and nineteen of the twenty determinations the average needs, nothing is priced (the health line says no price, the check page says 19 of 20 measured at 36 cents); the twentieth, dated before the window, prices it the next time it is asked, since a window without a price is not fixed: the measured average × 1.25, rounded up, 45 cents; the next window prices the same, and a run in it is told so',
        h5.pricing?.priceCents === null && st5.economics?.price?.cents === null && st5.economics?.price?.measuredSample === 19 && Math.abs(st5.economics.price.measuredAvgUsd - 0.36) < 1e-9
          && h5again.pricing?.priceCents === 45 && h6.pricing?.priceCents === 45 && st6.economics?.price?.basis === 'measured' && st6.economics?.price?.windowSample === 20 && pricingOf(r6)?.priceCents === 45
          && windows.length === 2 && windows.every((w) => w.price_cents === 45 && w.basis === 'measured' && w.sample === 20 && Math.abs(w.avg - 0.36) < 1e-9),
        JSON.stringify({ h5: h5.pricing, st5: st5.economics?.price, h5again: h5again.pricing, h6: h6.pricing, st6: st6.economics?.price, windows }));
      // 7b. The operator sets the start figure during a window that began without one (2 October, 49 cents): the next instance prices at once.
      const DB4 = await makeDb('civic_verify_econ4');
      const P8 = PORT + 59;
      const s8 = await boot(P8, { DATABASE_URL: DB4, CIVIC_CLOCK: at(T0) });
      const a8 = await signin(P8, 'ABCD234');
      const h8 = await json(`${base(P8)}/api/health`, a8);
      const row8 = (await dbQuery(DB4, 'SELECT price_cents, basis FROM windows')).rows;
      s8.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      const P9 = PORT + 61;
      await boot(P9, { DATABASE_URL: DB4, CIVIC_CLOCK: at(T0 + 10 * 60e3), CIVIC_PRICE_START_CENTS: '49' });
      const a9 = await signin(P9, 'ABCD234');
      const h9b = await json(`${base(P9)}/api/health`, a9);
      const r9b = await runOn(P9, a9, 'verify-econ-r9b');
      const row9 = (await dbQuery(DB4, 'SELECT price_cents, basis FROM windows')).rows;
      check('a window that began with no price (the row says none) takes the start figure the moment the operator sets it: the next instance on the same database, ten minutes into the same window, prices at 49 cents, tells a run so, and the window\'s row now says start',
        h8.pricing?.priceCents === null && row8.length === 1 && row8[0].price_cents === null && row8[0].basis === 'none'
          && h9b.pricing?.priceCents === 49 && pricingOf(r9b)?.priceCents === 49 && row9.length === 1 && row9[0].price_cents === 49 && row9[0].basis === 'start',
        JSON.stringify({ h8: h8.pricing, row8, h9b: h9b.pricing, r9b: pricingOf(r9b), row9 }));
      // 8. The loss guard: a window that lost more than the guard sends every new run to tier 1, until the margin earned since covers the loss.
      const DB3 = await makeDb('civic_verify_econ3');
      const P7 = PORT + 56;
      await boot(P7, { DATABASE_URL: DB3, CIVIC_CLOCK: at(T0 + 30 * 60e3), CIVIC_PRICE_START_CENTS: '45', CIVIC_TIER_LOSS_GUARD_USD: '0.5' });
      const a7 = await signin(P7, 'ABCD234');
      const h7 = await json(`${base(P7)}/api/health`, a7);
      // three free determinations at 50 cents each earlier in this window: the window's margin is −1.50, below −0.50
      await seed(DB3, { runId: 'seed-loss', tier: 3, from: T0 + 60e3, n: 3, cost: 0.5, price: 45, free: true });
      const r7 = await runOn(P7, a7, 'verify-econ-r7');
      const st7 = await json(`${base(P7)}/api/selftest`, a7);
      const events1 = (await dbQuery(DB3, 'SELECT engaged, loss_usd::float AS loss, earned_usd::float AS earned FROM guard_events ORDER BY id')).rows;
      // four priced determinations at 50 cents with no cost, after the switch: 2.00 earned back against 1.50 lost
      await seed(DB3, { runId: 'seed-earn', tier: 1, from: T0 + 40 * 60e3, n: 4, cost: 0, price: 50, free: false });
      const r8 = await runOn(P7, a7, 'verify-econ-r8');
      const events2 = (await dbQuery(DB3, 'SELECT engaged, loss_usd::float AS loss, earned_usd::float AS earned FROM guard_events ORDER BY id')).rows;
      const st8 = await json(`${base(P7)}/api/selftest`, a7);
      check('the loss guard (0.50 here): before any loss the rotation holds (tier 3); a window that has lost 1.50 sends the next run to tier 1 with nothing free, with the switch on record and on the check page; once 2.00 has been earned back since, the next run has the rotation again and the release is on record',
        h7.pricing?.tier === 3 && pricingOf(r7)?.tier === 1 && pricingOf(r7)?.freeFacts === 0 && st7.economics?.guard?.engaged === true && Math.abs(st7.economics.guard.lossUsd - 1.5) < 1e-6 && st7.economics?.tier?.underGuard === true
          && events1.length === 1 && events1[0].engaged === true && Math.abs(events1[0].loss - 1.5) < 1e-6
          && pricingOf(r8)?.tier === 3 && pricingOf(r8)?.freeFacts === 2 && events2.length === 2 && events2[1].engaged === false && Math.abs(events2[1].earned - 2) < 1e-6 && st8.economics?.guard?.engaged === false,
        JSON.stringify({ h7: h7.pricing?.tier, r7: pricingOf(r7), st7: st7.economics?.guard, events1, r8: pricingOf(r8), events2, st8: st8.economics?.guard }));
    } catch (err) {
      check('the economics checks on Postgres ran to the end', false, err.stack || err.message);
    }
    try { await admin?.end(); } catch {}
  }
  // 9. The file mode: no DATABASE_URL, the same flow, the rows in memory.
  try {
    const P9 = PORT + 57;
    await boot(P9, { CIVIC_CLOCK: at(T0), CIVIC_PRICE_START_CENTS: '45', CIVIC_PRICING_NOTE: 'The beta is not charged.' });
    const a9 = await signin(P9, 'ABCD234');
    const h9 = await json(`${base(P9)}/api/health`, a9);
    const r9 = await runOn(P9, a9, 'verify-econ-r9');
    const claims9 = r9.find((e) => e.t === 'done')?.claims || [];
    const e9 = (i) => claims9[i % Math.max(1, claims9.length)]?.entry || text;
    const q = [];
    for (let i = 0; i < 3; i++) q.push(quoteOf(await detOn(P9, a9, { jobId: `verify-econ-r9-c${i + 1}`, runId: 'verify-econ-r9', n: i + 1, entry: e9(i) })));
    const st9 = await json(`${base(P9)}/api/selftest`, a9);
    const t9 = st9.economics?.byTier?.find((x) => x.tier === 3);
    check('without a database the same flow runs from memory: the health line and the extraction carry the prices with the operator\'s note, two free then one priced, and the operator\'s measurement counts them (and says the rows reset with the instance)',
      h9.pricing?.note === 'The beta is not charged.' && JSON.stringify(pricingOf(r9)) === JSON.stringify({ tier: 3, freeFacts: 2, priceCents: 45, currency: 'USD', note: 'The beta is not charged.' })
        && JSON.stringify(q) === JSON.stringify([{ free: true, priceCents: 0 }, { free: true, priceCents: 0 }, { free: false, priceCents: 45 }]) && st9.economics?.store === 'memory' && t9?.determinations === 3 && t9?.freeGiven === 2 && t9?.revenueUsd === 0.45,
      JSON.stringify({ h9: h9.pricing, r9: pricingOf(r9), q, t9, store: st9.economics?.store }));
    check('in file mode the report carries the durations too, from the ledger lines this instance wrote',
      st9.economics?.durations?.determinations?.n === 3 && st9.economics.durations.determinations.meanMs > 0 && st9.economics.durations.extractions.n === 1, JSON.stringify(st9.economics?.durations));
    // 10. Pricing off: the rollback. The page is as before: no pricing on the health line, no pricing or quote event, nothing measured.
    const P10 = PORT + 58;
    await boot(P10, { CIVIC_PRICING_ENABLED: 'false', CIVIC_PRICE_START_CENTS: '45' });
    const a10 = await signin(P10, 'ABCD234');
    const h10 = await json(`${base(P10)}/api/health`, a10);
    const r10 = await runOn(P10, a10, 'verify-econ-r10');
    const d10 = await detOn(P10, a10, { jobId: 'verify-econ-r10-c1', runId: 'verify-econ-r10', n: 1, entry: e9(0) });
    const st10 = await json(`${base(P10)}/api/selftest`, a10);
    check('CIVIC_PRICING_ENABLED=false is the rollback: the health line says nothing of prices, no pricing or quote event reaches the page, the check page has no measurement, and the determination completes as before',
      h10.pricing === null && !r10.some((e) => e.t === 'pricing') && !d10.some((e) => e.t === 'quote') && d10.some((e) => e.t === 'done') && st10.economics === null, JSON.stringify({ pricing: h10.pricing, kinds: d10.map((e) => e.t) }));
  } catch (err) {
    check('the economics checks in file mode ran to the end', false, err.stack || err.message);
  }
  for (const s of servers) { try { s.kill('SIGTERM'); } catch {} }
  try { mock.kill('SIGTERM'); } catch {}
  try { fs.unlinkSync(usesFile); } catch {}
  if (provision) await provision.stop();
}
await economicsChecks();

// The port is FactEngine's. An older FactEngine still holding it is closed and the port taken over; anything
// else on it is left alone and named. Both are proved here with stand-in processes: one that runs
// from FactEngine's own directory, as an installed copy does, and one that does not.
async function takeoverChecks() {
  const holder = (cwd, port) => {
    const child = spawn(process.execPath, ['-e', `require('node:http').createServer().listen(${port}, () => process.send && process.send('up'))`],
      { cwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return new Promise((resolve) => child.on('message', () => resolve(child)));
  };
  const alive = (child) => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const env = { OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl') };

  // 1. An older FactEngine (a process running from FactEngine's directory) holds the port: it must be closed.
  const older = await holder(root, PORT + 1);
  const taker = start([path.join(root, 'server', 'index.js')], { ...env, PORT: String(PORT + 1) });
  let took = false;
  try { await wait(`http://localhost:${PORT + 1}/api/health`, 20000); took = true; } catch {}
  await settle(300);
  check('an older FactEngine holding the port is closed and the port taken over', took && !alive(older), took ? 'the older process is still alive' : 'the new FactEngine never answered');
  try { taker.kill('SIGTERM'); } catch {}
  try { older.kill('SIGKILL'); } catch {}

  // 2. Something that is not FactEngine holds the port: it must be left alone, and FactEngine must say so.
  const other = await holder(os.tmpdir(), PORT + 2);
  const refused = start([path.join(root, 'server', 'index.js')], { ...env, PORT: String(PORT + 2) });
  let stderr = '';
  refused.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => { refused.on('exit', resolve); setTimeout(() => resolve('timeout'), 20000); });
  check('a process that is not FactEngine on the port is left alone, and FactEngine says so',
    code === 1 && alive(other) && /STOPPED: port \d+ is already in use/.test(stderr) && /not FactEngine/.test(stderr),
    `exit ${code}, other alive=${alive(other)}, stderr: ${stderr.trim().slice(0, 160)}`);
  try { other.kill('SIGKILL'); } catch {}
}
await takeoverChecks();

// ---- The listing on DeepSeek (4 October) ------------------------------------------------------------------
// The operator: "I want use DeepSeek flash for the generating of empirical claims." The listing goes to DeepSeek's
// deepseek-flash at effort max; the determinations stay on OpenAI. A stand-in DeepSeek (the /deepseek routes of
// scripts/mock-openai.js) answers as DeepSeek's own pages describe it, refusals included. Proved here: the right key
// to the right provider and no OpenAI setting at DeepSeek; DeepSeek's body exactly; the prompt verbatim; the chain
// of thought on no page, replay, ledger line or failure record; every refusal a wait or the operator's sentence;
// /check's rows and the balance for the operator alone; the price by the hour; no key anywhere it could be read.
async function deepseekChecks() {
  const DMOCK = MOCK_PORT + 80;
  const DSKEY = 'sk-dsverify00000000000000000000000';
  const COT = 'DSCOT-7f3a';   // the stand-in's chain-of-thought marker
  const PASS = `verify-gateway-pass-${Date.now()}`;
  const stamp = Date.now();
  const rec = path.join(os.tmpdir(), `civic-verify-ds-${stamp}.jsonl`);
  const ledger = path.join(os.tmpdir(), `civic-verify-ds-ledger-${stamp}.jsonl`);
  const errlog = path.join(os.tmpdir(), `civic-verify-ds-errors-${stamp}.log`);
  fs.writeFileSync(rec, '');
  const records = () => fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const dsEntries = () => records().filter((r) => r.deepseek);
  const dsBodies = () => records().filter((r) => r.path === '/deepseek/responses' && r.body);
  const dsStats = async () => (await fetch(`http://localhost:${DMOCK}/deepseek/mock/stats`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  const procs = [];
  const output = [];
  const serve = (port, env) => {
    const child = start([path.join(root, 'server', 'index.js')], {
      PORT: String(port), OPENAI_BASE_URL: `http://localhost:${DMOCK}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false',
      CIVIC_LEDGER_FILE: ledger, CIVIC_ERROR_LOG: errlog, CIVIC_ACCESS_CODES: '', CIVIC_OPERATOR_CODES: '', DATABASE_URL: '',
      CIVIC_EXTRACT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: DSKEY, CIVIC_DEEPSEEK_BASE_URL: `http://localhost:${DMOCK}/deepseek`, ...env,
    });
    child.stdout.on('data', (d) => output.push(String(d)));
    child.stderr.on('data', (d) => output.push(String(d)));
    procs.push(child);
    return `http://localhost:${port}`;
  };
  // Request ordinals at the stand-in DeepSeek: 1 clean; 2 a 429 with no wait, 3 clean; 4 a 503, 5 clean; 6 an error
  // event mid-stream, 7 clean; 8 a stream closed with no event, 9 clean; 10 a 402. Every stream opens with keep-alives.
  start([path.join(root, 'scripts', 'mock-openai.js')], {
    MOCK_PORT: String(DMOCK), MOCK_RECORD: rec, MOCK_SPEED: '0.2', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '',
    MOCK_DS_429: '2', MOCK_DS_503: '4', MOCK_DS_ERROR_EVENT: '6', MOCK_DS_CLOSE: '8', MOCK_DS_402: '10', MOCK_DS_KEEPALIVE_MS: '400',
  });
  try {
    await wait(`http://localhost:${DMOCK}/v1/responses`, 15000, { anyResponse: true });
    // OpenAI's own settings in this server's environment, which none may carry to DeepSeek; the gateway's
    // address and pass too, which must never go to DeepSeek.
    const base = serve(PORT + 80, { OPENAI_ORG_ID: 'org-verify-ds', OPENAI_PROJECT_ID: 'proj-verify-ds', OPENAI_CUSTOM_HEADERS: 'X-Verify-Leak: yes', CIVIC_TOOLS_URL: `http://localhost:${PORT + 80}/mcp`, CIVIC_TOOLS_PASS: PASS });
    await wait(`${base}/api/health`);
    const health = await (await fetch(`${base}/api/health`)).json();
    const sx = health.request?.extract || {};
    const wantKeys = [...(slot ? ['model', 'input'] : ['model', 'instructions', 'input']), 'reasoning', 'tools', 'stream'];
    check('DeepSeek: the health line says the listing goes to DeepSeek\'s deepseek-flash at effort max with no mode and no summary, and lists its keys (no store); the determinations stay on OpenAI',
      sx.provider === 'deepseek' && sx.model === 'deepseek-flash' && sx.effort === 'max' && sx.mode === null && sx.summary === null && JSON.stringify(health.request?.keys?.extract) === JSON.stringify(wantKeys) && health.request?.evaluate?.model === config.evalModels[0],
      JSON.stringify({ extract: sx, keys: health.request?.keys?.extract }));

    const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
    const jobA = `ds-a-${stamp}`;
    const a = await stream(`${base}/api/extract`, { text: source, jobId: jobA });
    const doneA = a.find((e) => e.t === 'done');
    const bodyA = dsBodies()[0]?.body;
    check('DeepSeek: a listing completes with its claims, on deepseek-flash at effort max, no mode, its web search on the trail',
      Boolean(doneA) && doneA.total >= 3 && doneA.model === 'deepseek-flash' && doneA.effort === 'max' && doneA.mode === null && (doneA.trail || []).some((t) => t.kind === 'search') && !a.some((e) => e.t === 'error'),
      JSON.stringify(doneA && { total: doneA.total, model: doneA.model, effort: doneA.effort, mode: doneA.mode, trail: doneA.trail }));
    check('DeepSeek: the listing\'s body carries exactly the model, the prompt, reasoning {effort: max}, web search and stream; no store, mode or summary, and not CIVIC\'s own tools though the gateway is set',
      Boolean(bodyA) && JSON.stringify(Object.keys(bodyA).sort()) === JSON.stringify([...wantKeys].sort()) && JSON.stringify(bodyA.reasoning) === JSON.stringify({ effort: 'max' })
        && JSON.stringify(bodyA.tools) === JSON.stringify([{ type: 'web_search' }]) && bodyA.stream === true && bodyA.model === 'deepseek-flash' && !JSON.stringify(bodyA).includes(PASS),
      JSON.stringify(bodyA && { keys: Object.keys(bodyA), reasoning: bodyA.reasoning, tools: bodyA.tools }));
    const textA = bodyA?.input?.[0]?.content?.[0]?.text;
    if (slot) {
      const expected = extractPrompt.slice(0, slot.start) + sourceBlock(source, { kind: 'text' }) + extractPrompt.slice(slot.end);
      check('DeepSeek: the prompt sent verbatim with the source in place of its final bracketed line, as the only message', bodyA?.instructions === undefined && bodyA?.input?.length === 1 && textA === expected, `${textA?.length} vs ${expected.length} chars`);
    } else {
      check('DeepSeek: the prompt sent verbatim as the instructions, the document whole as the only message', bodyA?.instructions === extractPrompt && bodyA?.input?.length === 1 && textA === source, `${bodyA?.instructions?.length} vs ${extractPrompt.length} chars`);
    }
    const replay = await stream(`${base}/api/extract`, { text: source, jobId: jobA, cursor: 0 });
    check('DeepSeek: the chain of thought reaches no page: no reasoning event on the stream or in its replay from the start, nothing of it in done',
      a.length > 0 && replay.length > 0 && ![...a, ...replay].some((e) => e.t === 'reasoning') && ![...a, ...replay].some((e) => JSON.stringify(e).includes(COT)) && doneA?.reasoning === null,
      JSON.stringify([...a, ...replay].filter((e) => e.t === 'reasoning').slice(0, 2)));

    // A determination of the first claim: OpenAI, with OpenAI's key.
    const entry = doneA?.claims?.[0]?.entry || 'The Eiffel Tower stands about 330 metres tall.';
    const ev = await stream(`${base}/api/evaluate`, { claims: [entry], text: source, source: { kind: 'text' } });
    check('DeepSeek: the determination still runs on OpenAI and completes', ev.some((e) => e.t === 'done') && !ev.some((e) => e.t === 'error'), JSON.stringify(ev.filter((e) => e.t === 'error')));
    const openaiRecs = records().filter((r) => r.path === '/v1/responses');
    const dsRecs = dsEntries();
    check('DeepSeek: the listing went to DeepSeek with DeepSeek\'s key and never OpenAI\'s; the determination went to OpenAI with OpenAI\'s key and never DeepSeek\'s',
      dsRecs.length >= 1 && dsRecs.every((r) => r.auth === `Bearer ${DSKEY}`) && openaiRecs.length === 1 && openaiRecs.every((r) => r.auth === `Bearer ${KEY}`) && !records().some((r) => (r.auth || '').includes(READER_KEY)),
      JSON.stringify({ deepseek: [...new Set(dsRecs.map((r) => r.auth))].map((x) => x.replace(DSKEY, 'DSKEY').replace(KEY, 'OPENAI KEY')), openai: openaiRecs.length }));
    check('DeepSeek: none of OpenAI\'s settings travelled to DeepSeek (no organisation, project or custom header)',
      dsRecs.length >= 1 && dsRecs.every((r) => !r.headers.includes('openai-organization') && !r.headers.includes('openai-project') && !r.headers.includes('x-verify-leak')),
      JSON.stringify([...new Set(dsRecs.flatMap((r) => r.headers))]));

    // The refusals, one listing each, in the order the stand-in was told.
    const run = async (label) => { const before = (await dsStats()).requests; const evs = await stream(`${base}/api/extract`, { text: source, jobId: `ds-${label}-${stamp}` }); return { evs, sends: (await dsStats()).requests - before }; };
    const b = await run('429');
    const r429 = b.evs.find((e) => e.t === 'retry');
    check('DeepSeek: a 429 that names no wait is a wait of about a second, then the listing completes (two sends, no loop)',
      r429?.reason === 'rate_limit' && r429.waitMs >= 600 && r429.waitMs <= 1000 && b.sends === 2 && b.evs.some((e) => e.t === 'done'), JSON.stringify({ retry: r429, sends: b.sends }));
    const c = await run('503');
    check('DeepSeek: an overloaded answer (503) goes again a second later and the listing completes',
      c.evs.some((e) => e.t === 'retry' && e.reason === 'error' && e.waitMs >= 600) && c.sends === 2 && c.evs.some((e) => e.t === 'done'), JSON.stringify({ retries: c.evs.filter((e) => e.t === 'retry'), sends: c.sends }));
    const d = await run('error-event');
    check('DeepSeek: an error event in the middle of a stream is read as the stream\'s failure and goes again; the listing completes',
      d.evs.some((e) => e.t === 'retry') && d.sends === 2 && d.evs.some((e) => e.t === 'done') && !d.evs.some((e) => e.t === 'error'), JSON.stringify({ retries: d.evs.filter((e) => e.t === 'retry'), sends: d.sends }));
    const e = await run('closed');
    const doneE = e.evs.find((x) => x.t === 'done');
    check('DeepSeek: a stream closed with no event is a cut connection and goes again; never a listing of no claims',
      e.evs.some((x) => x.t === 'retry' && x.reason === 'connection') && e.sends === 2 && doneE?.total >= 3, JSON.stringify({ retries: e.evs.filter((x) => x.t === 'retry'), sends: e.sends, total: doneE?.total }));
    const f = await run('402');
    const errF = f.evs.find((x) => x.t === 'error');
    const failures = (await (await fetch(`${base}/api/selftest`)).json()).recentFailures || [];
    const rec402 = failures.find((x) => x.where === 'server:listing' && x.code === 'balance_exhausted');
    check('DeepSeek: a balance used up (402) reaches the page as its status and code with no words of the provider\'s, and /check records DeepSeek\'s own',
      errF?.status === 402 && errF.code === 'balance_exhausted' && errF.message === '' && /DeepSeek answered 402 \(Insufficient Balance\)/.test(rec402?.detail || ''),
      JSON.stringify({ error: errF, record: rec402 }));

    // Every go had a door of its own, and every door is shut now: the refused sends (429, 503, 402), the stream that
    // failed, the one that closed early and the ones that completed alike.
    const doors = fwBodies().map((r) => doorOf(r.body));
    const knocks = await Promise.all(doors.filter(Boolean).map((d) => knock(`${base}/mcp/t/${d}`)));
    const stDoors = await (await fetch(`${base}/api/selftest`)).json();
    check('Fireworks: each request to Fireworks named a door of its own, and once the listings ended every door is shut, whether its send was refused, its stream failed or closed early, or it completed; /check counts none open',
      doors.length >= 12 && doors.every(Boolean) && new Set(doors).size === doors.length && knocks.every((x) => x === 401) && stDoors.tools?.doors === 0,
      JSON.stringify({ sends: doors.length, named: doors.filter(Boolean).length, distinct: new Set(doors).size, open: knocks.filter((x) => x !== 401).length, counted: stDoors.tools?.doors }));

    const st = await (await fetch(`${base}/api/selftest`)).json();
    const row = (re) => (st.checks || []).find((x) => re.test(x.title));
    check('DeepSeek: /check accepts the listing\'s key and model without spending a token, shows the balance to the operator, and is ready',
      st.ready === true && row(/^A DeepSeek key is configured/)?.state === 'ok' && row(/^DeepSeek accepts this key for deepseek-flash/)?.state === 'ok'
        && /Balance 12\.34 USD/.test(row(/DeepSeek account can pay/)?.detail || '') && row(/^OpenAI accepts this key for/)?.title === `OpenAI accepts this key for ${config.evalModels[0]}`
        && st.settings?.listingProvider === 'DeepSeek' && st.settings?.listingModel === 'deepseek-flash' && st.settings?.listingEffort === 'max',
      JSON.stringify((st.checks || []).filter((x) => /DeepSeek|OpenAI/.test(x.title)).map((x) => `${x.state}:${x.title}`)));
    check('DeepSeek: the listing\'s price is DeepSeek\'s at the hour it went, its ledger line says DeepSeek, and the chain of thought is in no ledger line and no failure record',
      (() => {
        const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.kind === 'extract');
        const errText = fs.existsSync(errlog) ? fs.readFileSync(errlog, 'utf8') : '';
        return lines.length >= 5 && lines.every((l) => l.provider === 'deepseek' && l.model === 'deepseek-flash' && l.priced === true && l.usd > 0) && !fs.readFileSync(ledger, 'utf8').includes(COT) && !errText.includes(COT);
      })(), '');

    // The price by the hour, in process, from DeepSeek's page: peak Monday to Friday 01-04 and 06-10 UTC, half otherwise.
    delete process.env.CIVIC_PRICING_JSON;
    const { estimateTextCost } = await import(`${pathToFileURL(path.join(root, 'server', 'pricing.js')).href}?ds=${stamp}`);
    const u = { input: 1_000_000, cached: 0, output: 1_000_000 };
    const at = (iso) => estimateTextCost({ model: 'deepseek-flash', usage: u, at: Date.parse(iso) }).usd;
    check('DeepSeek: a million tokens in and out cost $1.50 at a peak hour (Monday 02:00 UTC) and $0.75 off-peak (Monday 05:00, Monday 10:00, Sunday 02:00); cached input at its own price',
      at('2026-10-05T02:00:00Z') === 1.5 && at('2026-10-05T05:00:00Z') === 0.75 && at('2026-10-05T10:00:00Z') === 0.75 && at('2026-10-04T02:00:00Z') === 0.75
        && estimateTextCost({ model: 'deepseek-flash', usage: { input: 1_000_000, cached: 1_000_000, output: 0 }, at: Date.parse('2026-10-05T02:00:00Z') }).usd === 0.006,
      JSON.stringify({ peak: at('2026-10-05T02:00:00Z'), off: at('2026-10-05T05:00:00Z') }));

    // The operator's figures stay the operator's: a reader's /check says whether the account can pay, never how much.
    const readerCode = generateCode();
    const operatorCode = generateCode();
    const base2 = serve(PORT + 81, { CIVIC_ACCESS_CODES: `${readerCode},${operatorCode}`, CIVIC_OPERATOR_CODES: operatorCode, CIVIC_SESSION_SECRET: 'b'.repeat(64) });
    await wait(`${base2}/api/health`);
    const signIn = async (code) => { const r = await fetch(`${base2}/api/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'guard@example.com', code }) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
    const balanceRow = async (cookie) => ((await (await fetch(`${base2}/api/selftest`, { headers: { cookie } })).json()).checks || []).find((x) => /DeepSeek account can pay/.test(x.title));
    const asReader = await balanceRow(await signIn(readerCode));
    const asOperator = await balanceRow(await signIn(operatorCode));
    check('DeepSeek: a reader\'s /check says the listing\'s account can pay, with no figure; the operator\'s shows the balance',
      asReader?.state === 'ok' && !/\d/.test(asReader.detail || '') && /Balance 12\.34 USD/.test(asOperator?.detail || ''), JSON.stringify({ reader: asReader, operator: asOperator }));

    // No key, no request: provider DeepSeek with DEEPSEEK_API_KEY unset refuses the listing before anything is sent.
    const before = dsEntries().length;
    const base3 = serve(PORT + 82, { DEEPSEEK_API_KEY: '' });
    await wait(`${base3}/api/health`);
    const noKey = await fetch(`${base3}/api/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: source, jobId: `ds-nokey-${stamp}` }) });
    const noKeyBody = await noKey.json().catch(() => ({}));
    const st3 = await (await fetch(`${base3}/api/selftest`)).json();
    check('DeepSeek: with no DeepSeek key the listing is refused before any request (the page\'s own sentence, no words of ours), /check says which setting is missing and is not ready, and nothing reaches DeepSeek',
      noKey.status === 503 && noKeyBody?.error?.code === 'no_operator_key' && noKeyBody.error.message === '' && st3.ready === false
        && (st3.checks || []).some((x) => x.state === 'bad' && x.title === 'No DeepSeek key for the listing' && /DEEPSEEK_API_KEY/.test(x.detail)) && dsEntries().length === before,
      JSON.stringify({ status: noKey.status, body: noKeyBody, sent: dsEntries().length - before }));

    // The key, nowhere it could be read.
    const health2 = await (await fetch(`${base}/api/health`)).text();
    const check2 = await (await fetch(`${base}/api/selftest`)).text();
    const pageHtml = await (await fetch(`${base}/`)).text();
    const ledgerText = fs.readFileSync(ledger, 'utf8');
    const errText = fs.existsSync(errlog) ? fs.readFileSync(errlog, 'utf8') : '';
    const said = output.join('');
    check('DeepSeek: neither key appears in the health line, the check data, the page, the ledger, the failure records or the server\'s own output',
      ![health2, check2, pageHtml, ledgerText, errText, said].some((t) => t.includes(DSKEY) || t.includes(KEY)) && said.includes('extraction requests go to localhost (DeepSeek) and carry: model deepseek-flash'),
      [['health', health2], ['check', check2], ['page', pageHtml], ['ledger', ledgerText], ['errors', errText], ['output', said]].filter(([, t]) => t.includes(DSKEY) || t.includes(KEY)).map(([n]) => n).join(', '));
  } catch (err) {
    check('DeepSeek checks completed', false, err.message);
  } finally {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  }
}
await deepseekChecks();

// ---- the listing on Fireworks: DeepSeek V4.1 Flash from a US company, FactEngine's own search, the chain of thought cut off ----
// The operator's choice of 5 October. Against a stand-in that speaks Fireworks' dialect (scripts/mock-openai.js): the
// model's reasoning inside the answer's text ahead of `</think>` (with no opening tag, with one, or sent apart), carrying a
// marker and numbered lines of its own; the input echoed among the output; usage as prompt_tokens and completion_tokens;
// no web search, and FactEngine's tool server called by the stand-in itself during the response, as Fireworks calls one.
async function fireworksChecks() {
  const FMOCK = MOCK_PORT + 85, SITE = PORT + 88;
  const FWKEY = 'fw_verify0000000000000000000000';
  const SKEY = 'search-key-fw-verify-5d2a';
  const SECRET = 'd'.repeat(64);
  const COT = 'FWCOT-2c9d', ECHO = 'FWUSER-8b1e';   // the stand-in's reasoning and input-echo markers
  const MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';
  const stamp = Date.now();
  const rec = path.join(os.tmpdir(), `civic-verify-fw-${stamp}.jsonl`);
  const ledger = path.join(os.tmpdir(), `civic-verify-fw-ledger-${stamp}.jsonl`);
  const errlog = path.join(os.tmpdir(), `civic-verify-fw-errors-${stamp}.log`);
  fs.writeFileSync(rec, '');
  const records = () => fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const fwEntries = () => records().filter((r) => r.fireworks);
  const fwBodies = () => records().filter((r) => r.path === '/fireworks/responses' && r.body);
  const fwStats = async () => (await fetch(`http://localhost:${FMOCK}/fireworks/mock/stats`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  // The search service the tool server asks, in Exa's shape; every call recorded.
  const searchCalls = [];
  const site = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/search')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch {}
        searchCalls.push({ key: req.headers['x-api-key'] || '', auth: req.headers.authorization || '', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ requestId: 'standin', results: [{ url: `http://localhost:${SITE}/tower`, title: 'The tower, measured', publishedDate: '2026-01-02T00:00:00.000Z', text: `${body.query}: the Eiffel Tower is about 330 metres tall.` }], costDollars: { total: 0.005 } }));
      });
      return;
    }
    if (req.url.startsWith('/tower')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><title>The tower, measured</title></head><body><article><p>${'The Eiffel Tower is about 330 metres tall and stands on the Champ de Mars in Paris. '.repeat(6)}</p></article></body></html>`); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => site.listen(SITE, r));
  const procs = [];
  const output = [];
  const serve = (port, env) => {
    const child = start([path.join(root, 'server', 'index.js')], {
      PORT: String(port), OPENAI_BASE_URL: `http://localhost:${FMOCK}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false',
      CIVIC_LEDGER_FILE: ledger, CIVIC_ERROR_LOG: errlog, CIVIC_ACCESS_CODES: '', CIVIC_OPERATOR_CODES: '', DATABASE_URL: '',
      CIVIC_EXTRACT_PROVIDER: 'fireworks', FIREWORKS_API_KEY: FWKEY, CIVIC_FIREWORKS_BASE_URL: `http://localhost:${FMOCK}/fireworks`,
      RENDER_EXTERNAL_URL: `http://localhost:${port}`, CIVIC_SESSION_SECRET: SECRET, CIVIC_TOOLS_URL: '', CIVIC_TOOLS_PASS: '',
      CIVIC_SEARCH_URL: `http://localhost:${SITE}/search`, CIVIC_SEARCH_KEY: SKEY, CIVIC_ALLOW_PRIVATE_URLS: 'true', ...env,
    });
    child.stdout.on('data', (d) => output.push(String(d)));
    child.stderr.on('data', (d) => output.push(String(d)));
    procs.push(child);
    return `http://localhost:${port}`;
  };
  // Request ordinals at the stand-in Fireworks: 1 the reasoning inline with no opening tag; 2 opened with <think>; 3 sent
  // apart; 4 a 429 with no wait, 5 clean; 6 a 503, 7 clean; 8 an error event mid-stream, 9 clean; 10 a stream closed with
  // no event, 11 clean; 12 a 402 (out of credits). Every stream calls the tool server twice: a search and a page.
  const toolCalls = [{ name: 'search_web', arguments: { query: 'height of the Eiffel Tower' } }, { name: 'read_page', arguments: { url: `http://localhost:${SITE}/tower` } }];
  start([path.join(root, 'scripts', 'mock-openai.js')], {
    MOCK_PORT: String(FMOCK), MOCK_RECORD: rec, MOCK_SPEED: '0.2', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '', MOCK_FW_TOOL_CALLS: JSON.stringify(toolCalls),
    MOCK_FW_TAGGED: '2', MOCK_FW_APART: '3', MOCK_FW_429: '4', MOCK_FW_503: '6', MOCK_FW_ERROR_EVENT: '8', MOCK_FW_CLOSE: '10', MOCK_FW_402: '12',
  });
  try {
    await wait(`http://localhost:${FMOCK}/v1/responses`, 15000, { anyResponse: true });
    // OpenAI's own settings in this server's environment, none of which may travel to Fireworks.
    const base = serve(PORT + 85, { OPENAI_ORG_ID: 'org-verify-fw', OPENAI_PROJECT_ID: 'proj-verify-fw', OPENAI_CUSTOM_HEADERS: 'X-Verify-Leak: yes' });
    await wait(`${base}/api/health`);
    const health = await (await fetch(`${base}/api/health`)).json();
    const sx = health.request?.extract || {};
    const wantKeys = [...(slot ? ['model', 'input'] : ['model', 'instructions', 'input']), 'reasoning', 'tools', 'stream', 'store'];
    check('Fireworks: the health line says the listing goes to Fireworks\' DeepSeek V4.1 Flash at effort max with no mode and no summary, can search, and lists its keys (store among them); the determinations stay on OpenAI',
      sx.provider === 'fireworks' && sx.model === MODEL && sx.effort === 'max' && sx.mode === null && sx.summary === null && sx.webSearch === true && JSON.stringify(health.request?.keys?.extract) === JSON.stringify(wantKeys) && health.request?.evaluate?.model === config.evalModels[0],
      JSON.stringify({ extract: sx, keys: health.request?.keys?.extract }));

    const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
    const sentences = ['The Eiffel Tower stands about 330 metres tall.', 'Water boils at 100 degrees Celsius at sea level.', 'Mount Everest is 8,849 metres above sea level.'];
    const listing = async (label, cursor) => stream(`${base}/api/extract`, { text: source, jobId: `fw-${label}-${stamp}`, ...(cursor === undefined ? {} : { cursor }) });
    const a = await listing('a');
    const doneA = a.find((e) => e.t === 'done');
    const bodyA = fwBodies()[0]?.body;
    const toolStepsA = (doneA?.trail || []).filter((t) => t.kind === 'tool');
    check('Fireworks: a listing completes with exactly the document\'s three claims, on DeepSeek V4.1 Flash at effort max, no mode, its search and its page read on the trail',
      Boolean(doneA) && doneA.total === 3 && JSON.stringify(doneA.claims.map((c) => c.text)) === JSON.stringify(sentences) && doneA.model === MODEL && doneA.effort === 'max' && doneA.mode === null
        && toolStepsA.length === 2 && toolStepsA[0].name === 'search_web' && toolStepsA[0].query === 'height of the Eiffel Tower' && toolStepsA[0].status === 'completed' && toolStepsA[1].name === 'read_page' && toolStepsA[1].url === `http://localhost:${SITE}/tower` && !a.some((e) => e.t === 'error'),
      JSON.stringify(doneA && { total: doneA.total, claims: doneA.claims.map((c) => c.text), model: doneA.model, trail: doneA.trail }));
    // The tool server is named at a door of the listing's own, in the address: Fireworks forwards no header of the entry's.
    const doorOf = (b) => new RegExp(`^${base.replace(/[.]/g, '\\.')}/mcp/t/([0-9a-f]{48})$`).exec(String(b?.tools?.[0]?.server_url || ''))?.[1] || null;
    const entryA = bodyA?.tools?.[0];
    const doorA = doorOf(bodyA);
    check('Fireworks: the listing\'s body carries exactly the model, the prompt, reasoning {effort: max}, the one entry naming FactEngine\'s tool server at the service\'s own address through a door of the listing\'s own and with no header (no pass goes to Fireworks), stream, and store: false; no web search, mode or summary',
      Boolean(bodyA) && JSON.stringify(Object.keys(bodyA).sort()) === JSON.stringify([...wantKeys].sort()) && JSON.stringify(bodyA.reasoning) === JSON.stringify({ effort: 'max' })
        && bodyA.tools.length === 1 && JSON.stringify(Object.keys(entryA)) === JSON.stringify(['type', 'server_label', 'server_url', 'require_approval'])
        && entryA.type === 'mcp' && entryA.server_label === 'civic' && entryA.require_approval === 'never' && Boolean(doorA)
        && bodyA.store === false && bodyA.stream === true && bodyA.model === MODEL,
      JSON.stringify(bodyA && { keys: Object.keys(bodyA), reasoning: bodyA.reasoning, store: bodyA.store, tools: (bodyA.tools || []).map((t) => ({ ...t, server_url: String(t.server_url || '').replace(/[0-9a-f]{48}$/, '<door>') })) }));
    // As Fireworks' servers do, the stand-in called that address with no header at all; once the listing ended, the door is shut.
    const knock = async (url) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).status;
    const callsA = records().filter((r) => r.path === '/mcp-client' && r.style === 'fireworks').slice(0, 3);
    const afterA = { door: await knock(entryA?.server_url || `${base}/mcp/t/none`), never: await knock(`${base}/mcp/t/${'0'.repeat(48)}`), bare: await knock(`${base}/mcp`) };
    check('Fireworks: the stand-in Fireworks reached the tool server through the listing\'s door with no header at all and was answered; once the listing ended that door is refused (401), as are a door never opened and /mcp itself (no pass is set)',
      callsA.length === 3 && callsA.every((r) => r.url === entryA?.server_url && r.headers?.length === 0 && r.status === 200) && callsA[0].initialize === 200
        && afterA.door === 401 && afterA.never === 401 && afterA.bare === 401,
      JSON.stringify({ calls: callsA.map((r) => ({ status: r.status, headers: r.headers, sameDoor: r.url === entryA?.server_url })), afterA }));
    const textA = bodyA?.input?.[0]?.content?.[0]?.text;
    if (slot) {
      const expected = extractPrompt.slice(0, slot.start) + sourceBlock(source, { kind: 'text' }) + extractPrompt.slice(slot.end);
      check('Fireworks: the prompt sent verbatim with the source in place of its final bracketed line, as the only message', bodyA?.instructions === undefined && bodyA?.input?.length === 1 && textA === expected, `${textA?.length} vs ${expected.length} chars`);
    } else {
      check('Fireworks: the prompt sent verbatim as the instructions, the document whole as the only message', bodyA?.instructions === extractPrompt && bodyA?.input?.length === 1 && textA === source, `${bodyA?.instructions?.length} vs ${extractPrompt.length} chars`);
    }
    const replay = await listing('a', 0);
    const marked = (evs) => JSON.stringify(evs).includes(COT) || JSON.stringify(evs).includes(ECHO) || JSON.stringify(evs).includes('</think>') || JSON.stringify(evs).includes('<think>');
    check('Fireworks: the chain of thought, and its own numbered lines, reach nothing: not a claim, not an event of the stream or of its replay from the start, not the raw listing, not done; nor does the input Fireworks lists among its output',
      a.length > 0 && replay.length > 0 && !marked(a) && !marked(replay) && ![...a, ...replay].some((e) => e.t === 'reasoning') && doneA?.reasoning === null && String(doneA?.raw || '').trim().startsWith('1. Claim: The Eiffel Tower'),
      JSON.stringify({ raw: String(doneA?.raw || '').slice(0, 120), reasoningEvents: [...a, ...replay].filter((e) => e.t === 'reasoning').length }));
    const b = await listing('tagged');
    const c = await listing('apart');
    const doneB = b.find((e) => e.t === 'done'), doneC = c.find((e) => e.t === 'done');
    check('Fireworks: with the reasoning opened by <think>, or sent apart as reasoning events, the listing is the same three claims and nothing of the reasoning appears',
      [doneB, doneC].every((d) => d && JSON.stringify(d.claims.map((x) => x.text)) === JSON.stringify(sentences)) && !marked(b) && !marked(c),
      JSON.stringify({ tagged: doneB?.claims?.map((x) => x.text), apart: doneC?.claims?.map((x) => x.text) }));

    // The search: through the tool server, with the search service's key, the model's words as the query.
    const mcpCalls = records().filter((r) => r.path === '/mcp-client' && r.step === 'call' && r.style === 'fireworks');
    const firstSearch = mcpCalls.find((r) => r.call?.name === 'search_web');
    const firstRead = mcpCalls.find((r) => r.call?.name === 'read_page');
    check('Fireworks: the model\'s search reached the search service through FactEngine\'s tool server, in the model\'s own words, with the service\'s key and no site left out; its pages came back to the model, and the page it read came back whole',
      searchCalls.length >= 1 && searchCalls.every((x) => x.key === SKEY && x.auth === '' && x.body.query === 'height of the Eiffel Tower' && x.body.excludeDomains === undefined && x.body.contents?.text === true)
        && firstSearch?.status === 200 && firstSearch.failed === false && /height of the Eiffel Tower: the Eiffel Tower is about 330 metres tall/.test(firstSearch.output) && firstRead?.failed === false && /Champ de Mars/.test(firstRead.output),
      JSON.stringify({ searches: searchCalls.map((x) => x.body), search: firstSearch && [firstSearch.status, String(firstSearch.output).slice(0, 120)] }));
    const lines = () => fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await new Promise((r) => setTimeout(r, 300));   // the ledger is appended after the stream ends
    const searchLines = lines().filter((l) => l.kind === 'tool' && l.source === 'search');
    check('Fireworks: each search is one ledger line at the search service\'s own figure, beside the listing\'s own line',
      searchLines.length === searchCalls.length && searchLines.every((l) => l.verb === 'search_web' && l.usd === 0.005 && l.ok === true) && !lines().some((l) => l.kind === 'search'),
      JSON.stringify({ lines: searchLines.length, calls: searchCalls.length }));

    // A determination of the first claim: OpenAI, with OpenAI's key, and the gateway not in its request.
    const entry = doneA?.claims?.[0]?.entry || 'Claim: The Eiffel Tower stands about 330 metres tall.';
    const ev = await stream(`${base}/api/evaluate`, { claims: [entry], text: source, source: { kind: 'text' } });
    const openaiRecs = records().filter((r) => r.path === '/v1/responses');
    check('Fireworks: the determination still runs on OpenAI and completes, and its request carries web search alone though the tool server is mounted with a pass',
      ev.some((e) => e.t === 'done') && !ev.some((e) => e.t === 'error') && openaiRecs.length === 1 && JSON.stringify(openaiRecs[0].body?.tools) === JSON.stringify([{ type: 'web_search' }]),
      JSON.stringify({ errors: ev.filter((e) => e.t === 'error'), tools: openaiRecs.map((r) => r.body?.tools) }));
    const fw = fwEntries();
    check('Fireworks: the listing went to Fireworks with Fireworks\' key and never OpenAI\'s; the determination went to OpenAI with OpenAI\'s key and never Fireworks\'',
      fw.length >= 3 && fw.every((r) => r.auth === `Bearer ${FWKEY}`) && openaiRecs.every((r) => r.auth === `Bearer ${KEY}`) && !records().some((r) => (r.auth || '').includes(READER_KEY)),
      JSON.stringify({ fireworks: [...new Set(fw.map((r) => r.auth))].map((x) => x.replace(FWKEY, 'FWKEY').replace(KEY, 'OPENAI KEY')), openai: openaiRecs.length }));
    check('Fireworks: none of OpenAI\'s settings travelled to Fireworks (no organisation, project or custom header)',
      fw.length >= 1 && fw.every((r) => !r.headers.includes('openai-organization') && !r.headers.includes('openai-project') && !r.headers.includes('x-verify-leak')),
      JSON.stringify([...new Set(fw.flatMap((r) => r.headers))]));

    // The refusals, one listing each, in the order the stand-in was told.
    const run = async (label) => { const before = (await fwStats()).requests; const evs = await listing(label); return { evs, sends: (await fwStats()).requests - before }; };
    const d429 = await run('429');
    const r429 = d429.evs.find((e) => e.t === 'retry');
    check('Fireworks: a 429 that names no wait is a wait of about a second, then the listing completes (two sends, no loop)',
      r429?.reason === 'rate_limit' && r429.waitMs >= 600 && r429.waitMs <= 1000 && d429.sends === 2 && d429.evs.some((e) => e.t === 'done'), JSON.stringify({ retry: r429, sends: d429.sends }));
    const d503 = await run('503');
    check('Fireworks: an unavailable answer (503) goes again a second later and the listing completes',
      d503.evs.some((e) => e.t === 'retry' && e.reason === 'error' && e.waitMs >= 600) && d503.sends === 2 && d503.evs.some((e) => e.t === 'done'), JSON.stringify({ retries: d503.evs.filter((e) => e.t === 'retry'), sends: d503.sends }));
    const dErr = await run('error-event');
    check('Fireworks: an error event in the middle of a stream is read as the stream\'s failure and goes again; the listing completes',
      dErr.evs.some((e) => e.t === 'retry') && dErr.sends === 2 && dErr.evs.some((e) => e.t === 'done') && !dErr.evs.some((e) => e.t === 'error'), JSON.stringify({ retries: dErr.evs.filter((e) => e.t === 'retry'), sends: dErr.sends }));
    const dClose = await run('closed');
    const doneClose = dClose.evs.find((x) => x.t === 'done');
    check('Fireworks: a stream closed with no event is a cut connection and goes again; never a listing of no claims',
      dClose.evs.some((x) => x.t === 'retry' && x.reason === 'connection') && dClose.sends === 2 && doneClose?.total === 3, JSON.stringify({ retries: dClose.evs.filter((x) => x.t === 'retry'), sends: dClose.sends, total: doneClose?.total }));
    const d402 = await run('402');
    const err402 = d402.evs.find((x) => x.t === 'error');
    const failures = (await (await fetch(`${base}/api/selftest`)).json()).recentFailures || [];
    const rec402 = failures.find((x) => x.where === 'server:listing' && x.code === 'balance_exhausted');
    check('Fireworks: an account out of credits (402) reaches the page as its status and code with no words of the provider\'s, and /check records Fireworks\' own',
      err402?.status === 402 && err402.code === 'balance_exhausted' && err402.message === '' && /Fireworks answered 402 \(Your account is out of credits/.test(rec402?.detail || ''),
      JSON.stringify({ error: err402, record: rec402 }));

    // Every go had a door of its own, and every door is shut now: the refused sends (429, 503, 402), the stream that
    // failed, the one that closed early and the ones that completed alike.
    const doors = fwBodies().map((r) => doorOf(r.body));
    const knocks = await Promise.all(doors.filter(Boolean).map((d) => knock(`${base}/mcp/t/${d}`)));
    const stDoors = await (await fetch(`${base}/api/selftest`)).json();
    check('Fireworks: each request to Fireworks named a door of its own, and once the listings ended every door is shut, whether its send was refused, its stream failed or closed early, or it completed; /check counts none open',
      doors.length >= 12 && doors.every(Boolean) && new Set(doors).size === doors.length && knocks.every((x) => x === 401) && stDoors.tools?.doors === 0,
      JSON.stringify({ sends: doors.length, named: doors.filter(Boolean).length, distinct: new Set(doors).size, open: knocks.filter((x) => x !== 401).length, counted: stDoors.tools?.doors }));

    const st = await (await fetch(`${base}/api/selftest`)).json();
    const row = (re) => (st.checks || []).find((x) => re.test(x.title));
    check('Fireworks: /check accepts the listing\'s key and model without spending a token, finds the tool server answering at its public address, checks OpenAI for the determinations\' model alone, shows Fireworks\' own echo of the effort it took, and is ready',
      st.ready === true && row(/^A Fireworks key is configured/)?.state === 'ok' && row(new RegExp(`^Fireworks accepts this key for ${MODEL.replace(/[.]/g, '\\.')}`))?.state === 'ok'
        && row(/^FactEngine's tool server answers at localhost/)?.state === 'ok' && row(/^OpenAI accepts this key for/)?.title === `OpenAI accepts this key for ${config.evalModels[0]}` && !(st.checks || []).some((x) => x.title === `OpenAI accepts this key for ${MODEL}`)
        && row(/^Fireworks took the listing's effort as max$/)?.state === 'ok'
        && st.settings?.listingProvider === 'Fireworks' && st.settings?.listingModel === MODEL && st.settings?.listingEffort === 'max' && st.tools?.requests?.listing === true && st.tools?.requests?.determinations === false,
      JSON.stringify((st.checks || []).filter((x) => /Fireworks|OpenAI|tool server/.test(x.title)).map((x) => `${x.state}:${x.title}`)));
    check('Fireworks: the listing\'s ledger lines say Fireworks, are priced at its rates from its own token counts (cached apart), and keep Fireworks\' echo of the effort it was asked for; the chain of thought is in no ledger line and no failure record',
      (() => {
        const ex = lines().filter((l) => l.kind === 'extract');
        const errText = fs.existsSync(errlog) ? fs.readFileSync(errlog, 'utf8') : '';
        const all = fs.readFileSync(ledger, 'utf8');
        return ex.length >= 7 && ex.every((l) => l.provider === 'fireworks' && l.model === MODEL && l.priced === true && l.usd > 0 && l.usage?.input > 0 && l.usage?.cached === 7 && l.usage?.output > 0 && JSON.stringify(l.reasoningEcho) === JSON.stringify({ effort: 'max' }))
          && !all.includes(COT) && !all.includes(ECHO) && !errText.includes(COT);
      })(), JSON.stringify(lines().filter((l) => l.kind === 'extract').slice(0, 1)));

    // The price, in process, from Fireworks' page of 5 October: one price at every hour.
    delete process.env.CIVIC_PRICING_JSON;
    const { estimateTextCost } = await import(`${pathToFileURL(path.join(root, 'server', 'pricing.js')).href}?fw=${stamp}`);
    const priced = (usage, iso) => estimateTextCost({ model: MODEL, usage, at: Date.parse(iso) }).usd;
    check('Fireworks: a million tokens in and out cost $0.88 at any hour; a million cached $0.007',
      priced({ input: 1_000_000, cached: 0, output: 1_000_000 }, '2026-10-05T02:00:00Z') === 0.88 && priced({ input: 1_000_000, cached: 0, output: 1_000_000 }, '2026-10-04T14:00:00Z') === 0.88 && priced({ input: 1_000_000, cached: 1_000_000, output: 0 }, '2026-10-05T02:00:00Z') === 0.007,
      JSON.stringify({ any: priced({ input: 1_000_000, cached: 0, output: 1_000_000 }, '2026-10-05T02:00:00Z') }));

    // No key, no request: provider Fireworks with FIREWORKS_API_KEY unset refuses the listing before anything is sent.
    const before = fwEntries().length;
    const base2 = serve(PORT + 86, { FIREWORKS_API_KEY: '' });
    await wait(`${base2}/api/health`);
    const noKey = await fetch(`${base2}/api/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: source, jobId: `fw-nokey-${stamp}` }) });
    const noKeyBody = await noKey.json().catch(() => ({}));
    const st2 = await (await fetch(`${base2}/api/selftest`)).json();
    check('Fireworks: with no Fireworks key the listing is refused before any request (the page\'s own sentence, no words of ours), /check says which setting is missing and is not ready, and nothing reaches Fireworks',
      noKey.status === 503 && noKeyBody?.error?.code === 'no_operator_key' && noKeyBody.error.message === '' && st2.ready === false
        && (st2.checks || []).some((x) => x.state === 'bad' && x.title === 'No Fireworks key for the listing' && /FIREWORKS_API_KEY/.test(x.detail)) && fwEntries().length === before,
      JSON.stringify({ status: noKey.status, body: noKeyBody, sent: fwEntries().length - before }));

    // No public address for the tool server (not on Render, no CIVIC_TOOLS_URL): the listing goes without tools, and /check says so.
    const before3 = fwBodies().length;
    const base3 = serve(PORT + 87, { RENDER_EXTERNAL_URL: '' });
    await wait(`${base3}/api/health`);
    const h3 = await (await fetch(`${base3}/api/health`)).json();
    const l3 = await stream(`${base3}/api/extract`, { text: source, jobId: `fw-notools-${stamp}` });
    const body3 = fwBodies()[before3]?.body;
    const st3 = await (await fetch(`${base3}/api/selftest`)).json();
    check('Fireworks: with no public address for the tool server, the listing goes with an empty tools list and completes, the health line says it cannot search, and /check says why',
      h3.request?.extract?.webSearch === false && JSON.stringify(body3?.tools) === '[]' && JSON.stringify(Object.keys(body3 || {}).sort()) === JSON.stringify([...wantKeys].sort()) && l3.some((e) => e.t === 'done')
        && (st3.checks || []).some((x) => x.state === 'warn' && x.title === 'The listing on Fireworks cannot search or read pages'),
      JSON.stringify({ webSearch: h3.request?.extract?.webSearch, tools: body3?.tools, warn: (st3.checks || []).filter((x) => x.state === 'warn').map((x) => x.title) }));

    // The keys and the pass, nowhere they could be read.
    const health2 = await (await fetch(`${base}/api/health`)).text();
    const check2 = await (await fetch(`${base}/api/selftest`)).text();
    const pageHtml = await (await fetch(`${base}/`)).text();
    const ledgerText = fs.readFileSync(ledger, 'utf8');
    const errText = fs.existsSync(errlog) ? fs.readFileSync(errlog, 'utf8') : '';
    const said = output.join('');
    const secretIn = (t) => t.includes(FWKEY) || t.includes(KEY) || fwBodies().map((r) => doorOf(r.body)).filter(Boolean).some((d) => t.includes(d));
    check('Fireworks: neither key nor any listing\'s door appears in the health line, the check data, the page, the ledger, the failure records or the server\'s own output; the startup line says where the listing goes and what it carries',
      ![health2, check2, pageHtml, ledgerText, errText, said].some(secretIn)
        && said.includes(`extraction requests go to localhost (Fireworks) and carry: model ${MODEL} · reasoning.effort max · FactEngine's tool server (search_web, read_page, get_transcript) through a door opened for that listing alone · store false`),
      [['health', health2], ['check', check2], ['page', pageHtml], ['ledger', ledgerText], ['errors', errText], ['output', said]].filter(([, t]) => secretIn(t)).map(([n]) => n).join(', ') || said.split('\n').find((l) => l.startsWith('extraction requests')));
  } catch (err) {
    check('Fireworks checks completed', false, err.message);
  } finally {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
    site.close();
  }
}
await fireworksChecks();

// ---- the pages a commercial service owes: the texts are served, whole, English, with no script but the field ----
// Terms, Privacy, Refunds and Contact are static files (public/*.html) served at /terms, /privacy, /refunds and
// /contact by the extensionless rule; each carries its heading, the support address and the text in .prose, names no
// vendor (categories only: the operator's rule of 3 October) and loads nothing but the field. The footer of the page
// links the four in a new tab (leaving the page cancels a run), and the four locales carry the footer and AI-line words.
async function pagesChecks() {
  const MOCK8 = MOCK_PORT + 70, PORT8 = PORT + 70;
  start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK8), MOCK_SPEED: '0.2' });
  await wait(`http://localhost:${MOCK8}/v1/mock/stats`, 15000, { anyResponse: true });   // the stats route answers 401 without the key: any answer means up
  const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORT8), OPENAI_BASE_URL: `http://localhost:${MOCK8}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl') });
  try {
    await wait(`http://localhost:${PORT8}/api/health`);
    const base = `http://localhost:${PORT8}`;
    const page = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; };
    const PAGES = [
      ['/terms', 'Terms of Service', /15\. Dispute resolution/],
      ['/privacy', 'Privacy Policy', /8\. Children/],
      ['/refunds', 'Refund and Dispute Policy', /A test that fails is never charged\./],
      ['/contact', 'Contact', /Arbitration opt-out/],
    ];
    const vendors = /\b(OpenAI|DeepSeek|Fireworks|Exa|Supadata|YouTube|Render|Stripe|Google|Resend|Cloudflare)\b/;
    for (const [p, heading, mark] of PAGES) {
      const r = await page(p);
      const scripts = r.text.match(/<script[^>]*>/g) || [];
      check(`${p}: served as its own page with the heading "${heading}", the text in .prose, the support address as a link, and the field held still`,
        r.status === 200 && /text\/html/.test(r.type) && r.text.includes(`<h1 class="plain-head">${heading}</h1>`) && r.text.includes('class="prose"') && r.text.includes('href="mailto:support@operatingequity.ai"') && mark.test(r.text) && r.text.includes('data-still="golden"'),
        `status ${r.status} type ${r.type} heading ${r.text.includes(heading)} mark ${mark.test(r.text)}`);
      check(`${p}: loads no script but the field, names no vendor and no key or token`,
        scripts.length === 1 && /src="js\/field\.js"/.test(scripts[0]) && !vendors.test(r.text) && !/\b(api key|token|tokens)\b/i.test(r.text) && !/sk-[A-Za-z0-9]/.test(r.text),
        `scripts ${JSON.stringify(scripts)} vendor ${(r.text.match(vendors) || [])[0] || 'none'}`);
      check(`${p}: links the other three pages and marks itself`,
        r.text.includes('class="plain-nav"') && ['terms', 'privacy', 'refunds', 'contact'].every((q) => r.text.includes(`href="${q}"`)) && r.text.includes(`href="${p.slice(1)}" aria-current="page"`), '');
    }
    // The listing's provider (5 October): a US company serving the model from the United States, Europe and Japan, which
    // keeps nothing and trains on nothing; it may search through our search provider. True before the switch (the
    // listing on OpenAI) and after it (on Fireworks); no country named that is not one, and no vendor.
    const privacy = await page('/privacy');
    const terms = await page('/terms');
    check('/privacy and /terms: the listing\'s provider lists claims under terms that do not permit training, searching itself or through our search provider; the search provider may receive the model\'s searches; data may be processed in the United States, Europe and Japan; China is named nowhere',
      privacy.text.includes('A model provider that lists the claims in what you submit: it processes the documents you submit, and may search the web while doing so, itself or through our search provider, under terms that do not permit your inputs to be used to train its models.')
        && privacy.text.includes('A model provider that produces the determinations') && privacy.text.includes('A search provider, which may receive the searches a model makes while listing claims, and the words of a link&#39;s own address and date')
        && privacy.text.includes('the model providers we use may process data in the United States, Europe and Japan; by using the Service you understand your information is transferred to those places')
        && terms.text.includes('search the web while doing so, themselves or through our search provider; a search provider performs the searches a model asks for and may be asked to find a licensed copy')
        && !/China/.test(privacy.text + terms.text),
      '');
    const home = await page('/');
    const footer = (home.text.match(/<footer class="footer">[\s\S]*?<\/footer>/) || [''])[0];
    check('the page\'s footer links Terms, Privacy, Refunds and Contact in a new tab and names Fact Engine LLC, an Operating Equity company',
      ['terms', 'privacy', 'refunds', 'contact'].every((q) => new RegExp(`<a href="${q}" target="_blank" rel="noopener" data-i18n="footer\\.${q}">`).test(footer)) && /class="footer-company">Fact Engine LLC,</.test(footer) && /data-i18n="footer\.parent">an Operating Equity company</.test(footer) && /aria-label="Terms, privacy, refunds and contact"/.test(footer),
      footer.slice(0, 300));
    check('the page carries the AI disclosure line under the results, translated by key',
      /<p class="score-note" data-i18n="score\.aiLine">Determinations are made by an AI model from the sources it cites and can be wrong; check the sources before relying on one\.<\/p>/.test(home.text), '');
    const words = { en: ['Refunds', 'an Operating Equity company', 'Determinations are made by an AI model'], es: ['Reembolsos', 'una empresa de Operating Equity', 'Las determinaciones las hace un modelo de IA'], fr: ['Remboursements', "une société d'Operating Equity", "Les déterminations sont faites par un modèle d'IA"], de: ['Erstattungen', 'ein Unternehmen von Operating Equity', 'Die Feststellungen trifft ein KI-Modell'] };
    for (const [code, [refunds, parent, ai]] of Object.entries(words)) {
      const l = await page(`/locales/${code}.js`);
      const raw = l.text.replace(/\\'/g, "'");   // the source escapes an apostrophe inside its single-quoted strings (fr: d'IA)
      check(`${code}: the locale carries the footer's refunds and parent words and the AI line`, l.status === 200 && raw.includes(`refunds: '${refunds}'`) && raw.includes(parent) && raw.includes(ai), `status ${l.status} refunds ${raw.includes(`refunds: '${refunds}'`)} parent ${raw.includes(parent)} ai ${raw.includes(ai)}`);
    }
  } catch (err) {
    check('pages checks completed', false, err.message);
  } finally {
    try { server.kill('SIGTERM'); } catch {}
  }
}
await pagesChecks();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   ← ${r.detail}`}`);
console.log(failed.length
  ? `\n${failed.length} FAILED. A request carries something the operator did not configure.`
  : `\nAll ${results.length} checks passed. Requests carry the configured model and effort, the prompts verbatim, web search on both steps, and nothing else.`);
process.exit(failed.length ? 1 : 0);
