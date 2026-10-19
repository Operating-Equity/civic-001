// The guard. Starts the mock and the server, runs an extraction and a determination, then reads
// the request bodies the server ACTUALLY SENT to the API and fails if they carry anything but the
// operator's configuration: the configured model, the configured reasoning effort, the prompts
// verbatim, web search. Any other key in a request body is a failure, whoever added it.
// It also runs the prompt leak guard: no committed file may contain a fragment of the prompts.
// Run before every deploy: `npm run verify`. A non-zero exit is a defect.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
import { validateStandIn } from '../server/tools/contract.js';
import { config, requestShape } from '../server/config.js';
import { tierAt, windowStartAt, freeFor } from '../server/economics.js';
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
// And with accounts off (the door open, as on a laptop of one's own) unless a check turns them on: since 5 October they are
// on wherever CIVIC_ACCOUNTS is not "off". No database from the shell either, and none of the access codes' retired settings.
const ACCOUNTS_OFF = { CIVIC_ACCOUNTS: 'off', DATABASE_URL: '', CIVIC_OPERATOR_EMAILS: '', CIVIC_OPERATOR_CLAIM: '', CIVIC_ACCESS_CODES: '', CIVIC_OPERATOR_CODES: '', CIVIC_CODE_USES: '', CIVIC_USES_FILE: '', CIVIC_SIGNIN_LOG: '', CIVIC_SESSION_SECRET: '' };
// And no price from the shell (since 6 October one list price, CIVIC_LIST_PRICE_CENTS, which a check sets when it needs one),
// none of the measured price's retired settings, and the tiers' default rotation.
const PRICES_OFF = { CIVIC_LIST_PRICE_CENTS: '', CIVIC_PRICE_START_CENTS: '', CIVIC_PRICE_MIN_SAMPLE: '', CIVIC_TIER_ORDER: '', CIVIC_TIER_FIXED: '' };
// And no ranking unless a check turns it on (the second pass of 16 October, server/rank.js): no ranking prompt from the
// shell or the vault's own file reaches an older check's listing, which makes one request to the model.
const RANK_OFF = { CIVIC_RANK: 'off', CIVIC_PROMPT_RANK: '', CIVIC_PROMPT_RANK_FILE: '', CIVIC_RANK_KEEP_PERCENT: '', CIVIC_RANK_EFFORT: '' };
// And Google's Gemini out of reach (the operator's trial of 18 October, server/gemini.js), as DeepSeek is, unless a check
// points it at the stand-in: no key from the shell, an address on a closed port.
const GEMINI_OFF = { GEMINI_API_KEY: '', CIVIC_GEMINI_BASE_URL: 'http://127.0.0.1:9/gemini' };
const start = (args, extraEnv) => {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...DEEPSEEK_OFF, ...FIREWORKS_OFF, ...ACCOUNTS_OFF, ...PRICES_OFF, ...RANK_OFF, ...GEMINI_OFF, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const dbQuery = async (url, sql, params = []) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); } };

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
    // The stand-in refuses its third request, whichever claim that carries: claims can reach the gate a moment out of
    // order, so the refused claim is the one the retry names.
    const ri = retry?.i;
    const others = [0, 1, 2, 3, 4, 5].filter((j) => j !== ri).map((j) => startAt(ev, j));
    check('a claim refused inside its stream waits OpenAI\'s figure, rejoins behind its reader\'s other claims (its second start after every other claim\'s first), finishes, and the gate learns the later call\'s charge',
      !r.failure && r.stats?.refusedInStream === 1 && Number.isInteger(ri) && others.every((t) => t !== undefined && startAt(ev, ri, 1) > t) && done(r) === 6 && r.pacing?.costs?.determination === 90000,
      `${r.failure} inStream=${r.stats?.refusedInStream} retry=${JSON.stringify(retry)} second=${startAt(ev, ri, 1)} others=${JSON.stringify(others)} done=${done(r)} costs=${JSON.stringify(r.pacing?.costs)}`);
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
    check('every stream says how often it is alive, every 5 s, in its first line and in the health line, so the page can count three silent ones as a dead connection (18 October: Safari sat on one for over a minute)',
      first.events[0]?.heartbeatMs === 5000 && during.heartbeatMs === 5000, JSON.stringify({ attached: first.events[0]?.heartbeatMs, health: during.heartbeatMs }));
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

// Accounts and credit (5 October). The operator: "Get rid of access codes … We need to establish a sign-up and sign-on
// process first, followed by payments … assume everyone who signs up gets $10 in their account." A reader signs up and
// signs in with an email and a password; the cookie carries a session's random token, the server keeps its hash; the
// door refuses every route that spends without a session; the operator's account is made through a one-time link and
// sees /check alone; a test's price is held from the reader's credit when it starts, charged when it is delivered and
// released when it is not. Proved on memory and, when a Postgres is to hand, on Postgres too.
const PASSWORD = 'correct horse battery';
const ACCT_TEXT = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level. The Pacific is the largest ocean on Earth. Light from the Sun takes about eight minutes to reach the Earth.';
const CLAIM_TOKEN = 'verify-operator-claim-token-0123456789abcdef';
const claimHash = () => crypto.createHash('sha256').update(CLAIM_TOKEN).digest('hex');

function accountClient(base) {
  const json = async (pathname, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const r = await fetch(base + pathname, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setCookies = r.headers.getSetCookie?.() || [];
    let parsed = null;
    try { parsed = await r.json(); } catch { /* none */ }
    return { status: r.status, body: parsed, cookie: (setCookies.find((c) => c.startsWith('fe_session=')) || '').split(';')[0], setCookies };
  };
  const stream = async (pathname, body, cookie, headers = {}) => {
    const r = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) });
    if (!r.ok) return { status: r.status, body: await r.json().catch(() => null), events: [] };
    return { status: r.status, events: (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
  };
  const signup = (email, password = PASSWORD, agree = true) => json('/api/account/signup', { method: 'POST', body: { email, password, agree } });
  const signin = (email, password = PASSWORD) => json('/api/account/signin', { method: 'POST', body: { email, password } });
  const balance = async (cookie) => (await json('/api/account', { cookie })).body?.account?.balanceCents;
  return { json, stream, signup, signin, balance };
}

/** A server with accounts on, its output kept (so the guard can say no password, hash or token ever reaches it). */
function accountServer(port, mockPort, env = {}) {
  const out = [];
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...DEEPSEEK_OFF, ...FIREWORKS_OFF, ...ACCOUNTS_OFF, ...PRICES_OFF, ...RANK_OFF, ...GEMINI_OFF, CIVIC_ACCOUNTS: 'on', PORT: String(port), OPENAI_BASE_URL: `http://localhost:${mockPort}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), `civic-verify-accounts-ledger-${port}.jsonl`), ...env },
  });
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  children.push(child);
  return { child, output: () => out.join('') };
}

async function accountChecks(label, dbUrl) {
  const MOCK2 = MOCK_PORT + (dbUrl ? 63 : 62), P = PORT + (dbUrl ? 66 : 62);
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const env = { DATABASE_URL: dbUrl || '', CIVIC_SIGNUP_GRANT_CENTS: '1000', CIVIC_SIGNIN_TRIES: '3', CIVIC_OPERATOR_EMAILS: 'op@example.com', CIVIC_OPERATOR_CLAIM: claimHash(), CIVIC_ACCESS_CODES: 'ABCD234' };
  let s1 = accountServer(P, MOCK2, env);
  const servers = [s1];
  await wait(`http://localhost:${P}/api/health`, 20000);
  const base = `http://localhost:${P}`;
  const c = accountClient(base);
  const reqs = async () => (await (await fetch(`http://localhost:${MOCK2}/v1/mock/stats`)).json()).admitted;
  try {
    const h0 = await c.json('/api/health');
    check(`accounts (${label}): the health line is open, says an account is needed, names no session and the credit a new account starts with`,
      h0.status === 200 && h0.body?.access?.required === true && h0.body.access.session === null && h0.body.access.grantCents === 1000 && h0.body.accounting === false, JSON.stringify(h0.body?.access));

    const before = await reqs();
    const refused = await Promise.all([
      c.json('/api/extract', { method: 'POST', body: { text: ACCT_TEXT } }), c.json('/api/evaluate', { method: 'POST', body: { claims: ['x'] } }),
      c.json('/api/read-url', { method: 'POST', body: { url: 'https://example.com/' } }), c.json('/api/find-copies', { method: 'POST', body: { url: 'https://example.com/' } }),
      c.json('/api/illustrate', { method: 'POST', body: { text: ACCT_TEXT } }), c.json('/api/parse', { method: 'POST', body: {} }),
      c.json('/api/selftest'), c.json('/api/account'), c.json('/api/operator/accounts'), c.json('/api/cancel', { method: 'POST', body: { jobIds: ['x'] } }),
    ]);
    check(`accounts (${label}): without a session every route that spends or shows anything is refused (401 signin_required), and nothing reaches the model`,
      refused.every((r) => r.status === 401 && r.body?.error?.code === 'signin_required') && (await reqs()) === before, JSON.stringify(refused.map((r) => r.status)));

    const up = await c.signup('Reader@Example.com');
    const flags = up.setCookies.find((x) => x.startsWith('fe_session=')) || '';
    check(`accounts (${label}): sign-up answers with a session cookie that is HttpOnly, SameSite=Lax, for the whole site and 400 days, clears the codes' old cookie, and the account starts with $10.00`,
      up.status === 200 && /HttpOnly/.test(flags) && /SameSite=Lax/.test(flags) && /Path=\//.test(flags) && /Max-Age=34560000/.test(flags) && up.setCookies.some((x) => /^civic_access=;.*Max-Age=0/.test(x)) && up.body?.session?.balanceCents === 1000,
      JSON.stringify({ status: up.status, flags, cookies: up.setCookies, session: up.body?.session }));
    const reader = up.cookie;
    const h1 = await c.json('/api/health', { cookie: reader });
    check(`accounts (${label}): the health line then names the reader, their balance and that they are not the operator, and shows a reader no costs`,
      h1.body?.access?.session?.email === 'Reader@Example.com' && h1.body.access.session.balanceCents === 1000 && h1.body.access.session.operator === false && h1.body.accounting === false, JSON.stringify(h1.body?.access));

    const taken = await c.signup('reader@EXAMPLE.com', 'another long one');
    const short = await c.signup('b@example.com', 'short');
    const noTick = await c.signup('b@example.com', PASSWORD, false);
    const bad = await c.signup('not an address', PASSWORD);
    check(`accounts (${label}): one account per address whatever its capitals (409 email_taken); a short password, no tick, or something that is not an address are refused in words (400)`,
      taken.status === 409 && taken.body?.error?.code === 'email_taken' && short.body?.error?.code === 'password_short' && noTick.body?.error?.code === 'terms_required' && bad.body?.error?.code === 'email_invalid',
      JSON.stringify([taken.body, short.body, noTick.body, bad.body]));

    const reserved = await c.signup('OP@example.com');
    check(`accounts (${label}): the operator's address cannot be taken through the open form; it answers as any taken address does`, reserved.status === 409 && reserved.body?.error?.code === 'email_taken', JSON.stringify(reserved.body));
    const wrongClaim = await c.json('/api/account/claim', { method: 'POST', body: { token: 'not-the-link', email: 'op@example.com', password: PASSWORD, agree: true } });
    const claim = await c.json('/api/account/claim', { method: 'POST', body: { token: CLAIM_TOKEN, email: 'op@example.com', password: PASSWORD, agree: true } });
    const again = await c.json('/api/account/claim', { method: 'POST', body: { token: CLAIM_TOKEN, email: 'op2@example.com', password: PASSWORD, agree: true } });
    const op = claim.cookie;
    check(`accounts (${label}): the operator's one-time link makes the operator's account once: a wrong link and a second use are refused (400 claim_invalid)`,
      wrongClaim.status === 400 && wrongClaim.body?.error?.code === 'claim_invalid' && claim.status === 200 && claim.body?.session?.operator === true && again.status === 400 && again.body?.error?.code === 'claim_invalid',
      JSON.stringify([wrongClaim.body, claim.body, again.body]));
    const opSelf = await c.json('/api/selftest', { cookie: op });
    const rdSelf = await c.json('/api/selftest', { cookie: reader });
    const opList = await c.json('/api/operator/accounts', { cookie: op });
    const rdList = await c.json('/api/operator/accounts', { cookie: reader });
    const opHealth = await c.json('/api/health', { cookie: op });
    check(`accounts (${label}): /check and the operator's tools are the operator's: 200 with the accounts for them, 403 operator_only for a reader; the costs are shown to the operator alone`,
      opSelf.status === 200 && Boolean(opSelf.body?.checks) && rdSelf.status === 403 && rdSelf.body?.error?.code === 'operator_only' && opList.status === 200 && opList.body?.accounts?.length === 2 && rdList.status === 403 && opHealth.body?.accounting === true,
      JSON.stringify({ opSelf: opSelf.status, rdSelf: rdSelf.status, opList: opList.body?.accounts?.length, rdList: rdList.status, acc: opHealth.body?.accounting }));

    const wrong = await c.signin('reader@example.com', 'not the password');
    const unknown = await c.signin('nobody@example.com', 'not the password');
    check(`accounts (${label}): a wrong password and an unknown email get the same answer (401 wrong_password, one sentence)`,
      wrong.status === 401 && unknown.status === 401 && wrong.body?.error?.code === 'wrong_password' && wrong.body.error.message === unknown.body?.error?.message, JSON.stringify([wrong.body, unknown.body]));
    await c.signin('reader@example.com', 'not the password two');
    await c.signin('reader@example.com', 'not the password three');
    const locked = await c.signin('reader@example.com');
    check(`accounts (${label}): past the wrong-password limit (CIVIC_SIGNIN_TRIES) an email waits, even with the right password (429 tries_wait, with the wait)`,
      locked.status === 429 && locked.body?.error?.code === 'tries_wait' && locked.body.error.waitSeconds > 0, JSON.stringify(locked.body));

    const second = await c.signup('second@example.com');
    const b = second.cookie;
    const own = await c.stream('/api/extract', { text: ACCT_TEXT, jobId: 'verify-acct-owner-1' }, reader);
    const foreign = await c.json('/api/extract', { method: 'POST', body: { jobId: 'verify-acct-owner-1', cursor: 0 }, cookie: b });
    const fCancel = await c.json('/api/cancel', { method: 'POST', body: { jobIds: ['verify-acct-owner-1'] }, cookie: b });
    const fRelease = await c.json('/api/release', { method: 'POST', body: { jobIds: ['verify-acct-owner-1'] }, cookie: b });
    const oRelease = await c.json('/api/release', { method: 'POST', body: { jobIds: ['verify-acct-owner-1'] }, cookie: reader });
    check(`accounts (${label}): a job is its account's: another account cannot attach to it (403 not_your_job), its cancel and release count nothing, and the owner's release lets it go`,
      own.status === 200 && own.events.some((e) => e.t === 'done') && foreign.status === 403 && foreign.body?.error?.code === 'not_your_job' && fCancel.body?.cancelled === 0 && fRelease.body?.released === 0 && oRelease.body?.released === 1,
      JSON.stringify({ own: own.status, foreign: foreign.body, fCancel: fCancel.body, fRelease: fRelease.body, oRelease: oRelease.body }));
    const stolenRun = await c.json('/api/extract', { method: 'POST', body: { text: ACCT_TEXT, jobId: 'verify-acct-owner-1' }, cookie: b });
    check(`accounts (${label}): a run's id belongs to its account even after its job is let go: another account asking for it is refused (403)`, stolenRun.status === 403, JSON.stringify(stolenRun.body));

    const upper = await c.json('/API/extract', { method: 'POST', body: { text: ACCT_TEXT }, cookie: reader });
    const upperSignup = await c.json('/API/account/signup', { method: 'POST', body: { email: 'z@example.com', password: PASSWORD, agree: true } });
    const oldSignin = await c.json('/api/signin', { method: 'POST', body: { email: 'x@example.com', code: 'ABCD234' } });
    check(`accounts (${label}): routes match their case (/API/… is nobody's), and the codes' sign-in is gone even with CIVIC_ACCESS_CODES still set`,
      upper.status === 404 && upperSignup.status === 404 && oldSignin.status !== 200 && !oldSignin.cookie, JSON.stringify([upper.status, upperSignup.status, oldSignin.status]));
    const cross = await c.json('/api/account/signin', { method: 'POST', body: { email: 'reader@example.com', password: PASSWORD }, headers: { 'sec-fetch-site': 'cross-site' } });
    const origin = await c.json('/api/extract', { method: 'POST', body: { text: ACCT_TEXT }, cookie: reader, headers: { origin: 'https://elsewhere.example' } });
    const form = await fetch(`${base}/api/account/signin`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=reader%40example.com&password=x' });
    check(`accounts (${label}): another site cannot act for this browser: cross-site (Sec-Fetch-Site) 403, another Origin 403, and the account's doors take JSON alone (415)`,
      cross.status === 403 && cross.body?.error?.code === 'cross_site' && origin.status === 403 && form.status === 415, JSON.stringify([cross.status, origin.status, form.status]));

    const id81 = `run-${'a'.repeat(36)}-c10-${'b'.repeat(36)}`;
    const first81 = await c.stream('/api/extract', { text: ACCT_TEXT, jobId: id81 }, reader);
    const id200 = `x-${'z'.repeat(198)}`;
    const long = await c.stream('/api/extract', { text: ACCT_TEXT, jobId: id200 }, reader);
    const kept = long.events.find((e) => e.t === 'attached')?.job;
    check(`accounts (${label}): an 81-character id is kept as given, a 200-character one is replaced by the server's own`,
      first81.events.find((e) => e.t === 'attached')?.job === id81 && Boolean(kept) && kept !== id200 && /^j-/.test(kept), JSON.stringify({ kept }));

    const out = await c.json('/api/account/signout', { method: 'POST', body: {}, cookie: b });
    const afterOut = await c.json('/api/account', { cookie: b });
    check(`accounts (${label}): sign-out ends the session: its cookie is refused afterwards (401)`, out.status === 200 && afterOut.status === 401, JSON.stringify([out.status, afterOut.status]));
    const inAgain = await c.signin('second@example.com');
    check(`accounts (${label}): sign-in makes a new session, never the old one (a fresh token each time)`, inAgain.status === 200 && Boolean(inAgain.cookie) && inAgain.cookie !== b, JSON.stringify({ status: inAgain.status }));
    const b2 = inAgain.cookie;

    const link = await c.json('/api/operator/reset-link', { method: 'POST', body: { userId: opList.body.accounts.find((a) => a.email === 'Reader@Example.com').id }, cookie: op });
    const rdLink = await c.json('/api/operator/reset-link', { method: 'POST', body: { userId: 1 }, cookie: reader });
    const token = (link.body?.link || '').split('#reset=')[1] || '';
    const used = await c.json('/api/account/reset', { method: 'POST', body: { token, password: 'a brand new password' } });
    const reused = await c.json('/api/account/reset', { method: 'POST', body: { token, password: 'yet another password' } });
    const oldSession = await c.json('/api/account', { cookie: reader });
    const withNew = await c.signin('reader@example.com', 'a brand new password');
    check(`accounts (${label}): the operator's reset link (its token after #) sets a new password once and signs the reader in; a second use is refused (400 reset_invalid); every earlier session ends; a reader cannot make one (403)`,
      link.status === 200 && /\/account#reset=[A-Za-z0-9_-]{40,}$/.test(link.body.link) && used.status === 200 && Boolean(used.cookie) && reused.status === 400 && reused.body?.error?.code === 'reset_invalid'
        && oldSession.status === 401 && (withNew.status === 200 || withNew.status === 429) && rdLink.status === 403,
      JSON.stringify({ link: link.status, used: used.status, reused: reused.body, oldSession: oldSession.status, withNew: withNew.status, rdLink: rdLink.status }));

    const list2 = (await c.json('/api/operator/accounts', { cookie: op })).body.accounts;
    const reader2 = () => used.cookie;
    const secondId = list2.find((a) => a.email === 'second@example.com').id;
    await c.json('/api/operator/block', { method: 'POST', body: { userId: secondId, blocked: true }, cookie: op });
    const blockedSession = await c.json('/api/account', { cookie: b2 });
    const blockedSignin = await c.signin('second@example.com');
    await c.json('/api/operator/block', { method: 'POST', body: { userId: secondId, blocked: false }, cookie: op });
    const reopened = await c.signin('second@example.com');
    const opBlock = await c.json('/api/operator/block', { method: 'POST', body: { userId: list2.find((a) => a.operator).id, blocked: true }, cookie: op });
    check(`accounts (${label}): the operator closes an account (its sessions end; its sign-in is refused, 403 account_closed) and opens it again; the operator's own cannot be closed (409)`,
      blockedSession.status === 401 && blockedSignin.status === 403 && blockedSignin.body?.error?.code === 'account_closed' && reopened.status === 200 && opBlock.status === 409,
      JSON.stringify([blockedSession.status, blockedSignin.body, reopened.status, opBlock.status]));

    const fourth = await c.signup('fourth@example.com');
    const fourthId = (await c.json('/api/operator/accounts', { cookie: op })).body.accounts.find((a) => a.email === 'fourth@example.com').id;
    const opDelete = await c.json('/api/operator/delete', { method: 'POST', body: { userId: fourthId }, cookie: op });
    const fourthSession = await c.json('/api/account', { cookie: fourth.cookie });
    const fourthSignin = await c.signin('fourth@example.com');
    const fourthRow = (await c.json('/api/operator/accounts', { cookie: op })).body.accounts.find((a) => a.id === fourthId);
    const opSelfDelete = await c.json('/api/operator/delete', { method: 'POST', body: { userId: list2.find((a) => a.operator).id }, cookie: op });
    const rdDelete = await c.json('/api/operator/delete', { method: 'POST', body: { userId: fourthId }, cookie: reader2() });
    check(`accounts (${label}): the operator deletes an account: its sessions end, its email and password sign in no more, the table keeps it as deleted with its amounts; the operator's own cannot be deleted (409), and a reader cannot delete one (403)`,
      opDelete.status === 200 && fourthSession.status === 401 && fourthSignin.status === 401 && fourthRow?.deleted === true && fourthRow.email === null && fourthRow.balanceCents === 1000 && opSelfDelete.status === 409 && rdDelete.status === 403,
      JSON.stringify([opDelete.status, fourthSession.status, fourthSignin.status, fourthRow, opSelfDelete.status, rdDelete.status]));

    const third = await c.signup('third@example.com');
    const selfDelete = await c.json('/api/account/delete', { method: 'POST', body: { password: PASSWORD }, cookie: third.cookie });
    const afterDelete = await c.json('/api/account', { cookie: third.cookie });
    const reuse = await c.signup('third@example.com');
    check(`accounts (${label}): a reader deletes their own account with their password: the session ends and the address is free again`,
      selfDelete.status === 200 && afterDelete.status === 401 && reuse.status === 200, JSON.stringify([selfDelete.status, afterDelete.status, reuse.status]));

    let lateToken = '';
    if (dbUrl) {
      const rows = (await dbQuery(dbUrl, 'SELECT email_key, password_hash FROM users')).rows;
      const sess = (await dbQuery(dbUrl, 'SELECT id FROM sessions')).rows;
      const cookieTokens = [reader, op, b, b2].map((x) => x.split('=')[1]).filter(Boolean);
      check(`accounts (${label}): the database keeps a scrypt hash, never a password, and a session's SHA-256, never its token`,
        rows.filter((r) => !r.email_key.startsWith('deleted:')).every((r) => /^scrypt\$16384\$8\$5\$/.test(r.password_hash) && !r.password_hash.includes(PASSWORD)) && sess.every((r) => /^[0-9a-f]{64}$/.test(r.id) && !cookieTokens.includes(r.id)),
        JSON.stringify(rows.map((r) => r.password_hash.slice(0, 20))));
      // A deploy: the same cookie on a new server over the same database.
      try { s1.child.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 800));
      s1 = accountServer(P, MOCK2, env);
      servers.push(s1);
      await wait(`http://localhost:${P}/api/health`, 20000);
      const survived = await c.json('/api/account', { cookie: used.cookie });
      check(`accounts (${label}): a session outlives a restart (a deploy): the same cookie is honoured by the next server`, survived.status === 200 && survived.body?.account?.email === 'Reader@Example.com', JSON.stringify({ status: survived.status }));
      const late = await c.json('/api/operator/reset-link', { method: 'POST', body: { userId: secondId }, cookie: op });
      lateToken = (late.body?.link || '').split('#reset=')[1] || '';
      try { s1.child.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 800));
      s1 = accountServer(P, MOCK2, { ...env, CIVIC_CLOCK: new Date(Date.now() + 25 * 3600e3).toISOString() });
      servers.push(s1);
      await wait(`http://localhost:${P}/api/health`, 20000);
      const expired = await c.json('/api/account/reset', { method: 'POST', body: { token: lateToken, password: 'too late a password' } });
      check(`accounts (${label}): a reset link past its hours (CIVIC_RESET_LINK_HOURS, 24) is refused (400 reset_invalid)`,
        late.status === 200 && Boolean(lateToken) && expired.status === 400 && expired.body?.error?.code === 'reset_invalid', JSON.stringify([late.status, expired.body]));
    }

    const ledgerFile = path.join(os.tmpdir(), `civic-verify-accounts-ledger-${P}.jsonl`);
    const all = servers.map((s) => s.output()).join('') + (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '');
    const secrets = [PASSWORD, 'a brand new password', 'too late a password', CLAIM_TOKEN, token, lateToken, ...[reader, op, b, b2, used.cookie].map((x) => (x || '').split('=')[1])].filter((x) => x && x.length > 8);
    const shown = JSON.stringify([h1.body, opSelf.body, opList.body, opHealth.body]);
    check(`accounts (${label}): no password, token or session appears in the health line, /check's data, the operator's table, the cost ledger or the server's own output`,
      secrets.every((x) => !all.includes(x) && !shown.includes(x)) && !/scrypt\$/.test(shown), secrets.filter((x) => all.includes(x) || shown.includes(x)).map((x) => x.slice(0, 6)).join(','));
  } catch (err) {
    check(`accounts (${label}): the checks completed`, false, err.stack);
  }
  for (const s of servers) { try { s.child.kill('SIGTERM'); } catch {} }
  try { mock.kill('SIGTERM'); } catch {}
}

async function creditChecks(label, dbUrl) {
  const MOCK2 = MOCK_PORT + (dbUrl ? 65 : 64), P = PORT + (dbUrl ? 68 : 64);
  const mock = start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK2), MOCK_SPEED: '0.2', MOCK_EVAL_HOLD_MS: '1200', MOCK_EVAL_FAIL_TEXT: 'Pacific', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCK2}/v1/mock/stats`, 15000, { anyResponse: true });
  const env = { DATABASE_URL: dbUrl || '', CIVIC_SIGNUP_GRANT_CENTS: '100', CIVIC_LIST_PRICE_CENTS: '45', CIVIC_TIER_FIXED: '2', CIVIC_OPERATOR_EMAILS: 'op@example.com', CIVIC_OPERATOR_CLAIM: claimHash() };
  let s1 = accountServer(P, MOCK2, env);
  const servers = [s1];
  await wait(`http://localhost:${P}/api/health`, 20000);
  const c = accountClient(`http://localhost:${P}`);
  const reqs = async () => (await (await fetch(`http://localhost:${MOCK2}/v1/mock/stats`)).json()).admitted;
  const listRun = async (cookie, jobId) => {
    const r = await c.stream('/api/extract', { text: ACCT_TEXT, jobId }, cookie);
    return { pricing: r.events.find((e) => e.t === 'pricing'), claims: r.events.find((e) => e.t === 'done')?.claims || [] };
  };
  const det = (cookie, runId, claims, n, jobId, extra = {}) => c.stream('/api/evaluate', { jobId, claims: [claims[n - 1].entry], text: ACCT_TEXT, source: { kind: 'text' }, runId, n, ...extra }, cookie);
  const quote = (r) => r.events.find((e) => e.t === 'quote');
  const done = (r) => r.events.some((e) => e.t === 'done');
  const idx = (claims, word) => claims.findIndex((x) => x.entry.includes(word)) + 1;
  try {
    const reader = (await c.signup('payer@example.com')).cookie;
    const run1 = await listRun(reader, 'verify-credit-run-1');
    check(`credit (${label}): the listing is free and priced for the document: 45 cents a claim, one free (tier 2)`, run1.pricing?.priceCents === 45 && run1.pricing.freeFacts === 1 && run1.claims.length >= 5 && (await c.balance(reader)) === 100, JSON.stringify(run1.pricing));
    const nEiffel = idx(run1.claims, 'Eiffel'), nWater = idx(run1.claims, 'Water'), nPacific = idx(run1.claims, 'Pacific'), nEverest = idx(run1.claims, 'Everest');
    const free = await det(reader, 'verify-credit-run-1', run1.claims, nEiffel, 'verify-credit-d1');
    check(`credit (${label}): the document's free claim holds nothing: free in its quote, the balance unchanged`, quote(free)?.free === true && done(free) && (await c.balance(reader)) === 100, JSON.stringify(quote(free)));
    // A priced claim, held while the stand-in thinks (MOCK_EVAL_HOLD_MS): the price is held at the start, charged at the end.
    const pending = det(reader, 'verify-credit-run-1', run1.claims, nWater, 'verify-credit-d2');
    await new Promise((r) => setTimeout(r, 500));
    const during = await c.balance(reader);
    const priced = await pending;
    await new Promise((r) => setTimeout(r, 300));
    const afterDone = await c.balance(reader);
    const act = (await c.json('/api/account/activity', { cookie: reader })).body?.lines || [];
    check(`credit (${label}): a priced claim's 45 cents are held when it starts (55 cents left while it runs), and charged when it is delivered (still 55; the activity says charged)`,
      quote(priced)?.priceCents === 45 && quote(priced).balanceCents === 55 && during === 55 && done(priced) && afterDone === 55 && act.some((l) => l.kind === 'test' && l.state === 'charged') && act.some((l) => l.state === 'free'),
      JSON.stringify({ q: quote(priced), during, afterDone, act }));
    const failed = await det(reader, 'verify-credit-run-1', run1.claims, nPacific, 'verify-credit-d3');
    await new Promise((r) => setTimeout(r, 300));
    check(`credit (${label}): a claim that fails is not charged: its hold is released and the balance is back to 55`,
      failed.events.some((e) => e.t === 'error') && (await c.balance(reader)) === 55, JSON.stringify({ events: failed.events.map((e) => e.t), balance: await c.balance(reader) }));
    // A stop: the page's cancel while the claim runs.
    const stopping = det(reader, 'verify-credit-run-1', run1.claims, nEverest, 'verify-credit-d4');
    await new Promise((r) => setTimeout(r, 400));
    const heldNow = await c.balance(reader);
    await c.json('/api/cancel', { method: 'POST', body: { jobIds: ['verify-credit-d4'] }, cookie: reader });
    await stopping;
    await new Promise((r) => setTimeout(r, 400));
    check(`credit (${label}): a claim the reader stops is not charged: held while it ran (10 cents left), released when stopped (55)`, heldNow === 10 && (await c.balance(reader)) === 55, JSON.stringify({ heldNow, after: await c.balance(reader) }));

    const run2 = await listRun(reader, 'verify-credit-run-2');
    await det(reader, 'verify-credit-run-2', run2.claims, idx(run2.claims, 'Eiffel'), 'verify-credit-e1');   // this document's free one
    const once = await det(reader, 'verify-credit-run-2', run2.claims, idx(run2.claims, 'Water'), 'verify-credit-e2');   // 45 of the 55
    const before = await reqs();
    const short = await det(reader, 'verify-credit-run-2', run2.claims, idx(run2.claims, 'Everest'), 'verify-credit-e3');
    check(`credit (${label}): a claim the balance cannot cover is refused before any model is asked (402 credit_short, with the balance and the price)`,
      done(once) && short.status === 402 && short.body?.error?.code === 'credit_short' && short.body.error.balanceCents === 10 && short.body.error.priceCents === 45 && (await reqs()) === before, JSON.stringify(short.body));

    const noRun = await c.stream('/api/evaluate', { jobId: 'verify-credit-norun', claims: ['Water boils at 100 degrees.'], text: ACCT_TEXT, source: { kind: 'text' } }, reader);
    const other = (await c.signup('other@example.com')).cookie;
    const theirs = await det(other, 'verify-credit-run-2', run2.claims, idx(run2.claims, 'Everest'), 'verify-credit-theirs');
    check(`credit (${label}): no test is free by leaving the run out, or by naming another account's run (400 run_required)`,
      noRun.status === 400 && noRun.body?.error?.code === 'run_required' && theirs.status === 400 && theirs.body?.error?.code === 'run_required', JSON.stringify([noRun.body, theirs.body]));

    // Two at once on a balance for one: the other account has $1.00: two priced claims at 45 fit, a third does not.
    const run3 = await listRun(other, 'verify-credit-run-3');
    await det(other, 'verify-credit-run-3', run3.claims, idx(run3.claims, 'Eiffel'), 'verify-credit-f0');
    await det(other, 'verify-credit-run-3', run3.claims, idx(run3.claims, 'Water'), 'verify-credit-f1');   // 55 left
    const [x, y] = await Promise.all([
      det(other, 'verify-credit-run-3', run3.claims, idx(run3.claims, 'Everest'), 'verify-credit-f2'),
      det(other, 'verify-credit-run-3', run3.claims, idx(run3.claims, 'Sun'), 'verify-credit-f3'),
    ]);
    check(`credit (${label}): two claims started together on a balance that covers one: exactly one runs, the other is refused (402), and the balance never goes below nothing`,
      [x, y].filter((r) => r.status === 200 && done(r)).length === 1 && [x, y].filter((r) => r.status === 402).length === 1 && (await c.balance(other)) === 10, JSON.stringify([x.status, y.status, await c.balance(other)]));

    // The monthly limit.
    const limiter = (await c.signup('limit@example.com')).cookie;
    await c.json('/api/account/limit', { method: 'POST', body: { cents: 50 }, cookie: limiter });
    const run4 = await listRun(limiter, 'verify-credit-run-4');
    await det(limiter, 'verify-credit-run-4', run4.claims, idx(run4.claims, 'Eiffel'), 'verify-credit-g0');
    const g1 = await det(limiter, 'verify-credit-run-4', run4.claims, idx(run4.claims, 'Water'), 'verify-credit-g1');
    const g2 = await det(limiter, 'verify-credit-run-4', run4.claims, idx(run4.claims, 'Everest'), 'verify-credit-g2');
    const acct = (await c.json('/api/account', { cookie: limiter })).body?.account;
    check(`credit (${label}): a monthly limit of 50 cents lets one 45-cent test through and refuses the next (402 month_limit with the figures); the account says this month's spend`,
      done(g1) && g2.status === 402 && g2.body?.error?.code === 'month_limit' && g2.body.error.limitCents === 50 && acct?.monthSpentCents === 45 && acct.monthlyLimitCents === 50, JSON.stringify({ g2: g2.body, acct }));

    // The operator adds credit.
    const op = (await c.json('/api/account/claim', { method: 'POST', body: { token: CLAIM_TOKEN, email: 'op@example.com', password: PASSWORD, agree: true } })).cookie;
    const accounts = (await c.json('/api/operator/accounts', { cookie: op })).body?.accounts || [];
    const payerId = accounts.find((a) => a.email === 'payer@example.com')?.id;
    const add = await c.json('/api/operator/credit', { method: 'POST', body: { userId: payerId, cents: 200, note: 'for the guard' }, cookie: op });
    const byReader = await c.json('/api/operator/credit', { method: 'POST', body: { userId: payerId, cents: 200 }, cookie: reader });
    const payerLines = (await c.json('/api/account/activity', { cookie: reader })).body?.lines || [];
    check(`credit (${label}): the operator adds credit to an account (it shows in the account's activity with the note); a reader cannot (403)`,
      add.status === 200 && add.body.balanceCents === 210 && (await c.balance(reader)) === 210 && byReader.status === 403 && payerLines.some((l) => l.kind === 'adjustment' && l.note === 'for the guard'),
      JSON.stringify({ add: add.body, byReader: byReader.status }));
    const totals = (await c.json('/api/operator/accounts', { cookie: op })).body?.totals;
    check(`credit (${label}): /check's line under the measurement adds up the credit given and spent, and nothing collected`,
      totals && totals.collectedCents === 0 && totals.spentCents === 45 * 5 && totals.grantedCents === 100 * 4 + 200, JSON.stringify(totals));

    if (dbUrl) {
      // A deploy while a claim is held: the old server releases it (deploy); the page's next request, on the new server,
      // opens the next attempt, holds it again, and is charged once.
      const run5 = await listRun(reader, 'verify-credit-run-5');
      await det(reader, 'verify-credit-run-5', run5.claims, idx(run5.claims, 'Eiffel'), 'verify-credit-h0');
      const balBefore = await c.balance(reader);
      const cut = det(reader, 'verify-credit-run-5', run5.claims, idx(run5.claims, 'Water'), 'verify-credit-h1');
      await new Promise((r) => setTimeout(r, 400));
      try { s1.child.kill('SIGTERM'); } catch {}
      await cut.catch(() => null);
      await new Promise((r) => setTimeout(r, 1200));
      s1 = accountServer(P, MOCK2, env);
      servers.push(s1);
      await wait(`http://localhost:${P}/api/health`, 20000);
      const released = await c.balance(reader);
      const redo = await det(reader, 'verify-credit-run-5', run5.claims, idx(run5.claims, 'Water'), 'verify-credit-h1');
      await new Promise((r) => setTimeout(r, 300));
      const ledger = (await dbQuery(dbUrl, "SELECT kind, count(*)::int AS n FROM credit WHERE determination_id = 'verify-credit-h1' GROUP BY kind")).rows;
      const kinds = Object.fromEntries(ledger.map((r) => [r.kind, r.n]));
      check(`credit (${label}): a deploy while a claim is held releases it; the same claim on the next server is held again and charged once (two holds, one release, one charge)`,
        released === balBefore && done(redo) && (await c.balance(reader)) === balBefore - 45 && kinds.hold === 2 && kinds.release === 1 && kinds.charge === 1, JSON.stringify({ balBefore, released, after: await c.balance(reader), kinds }));
      // The same claim asked for again with no job behind it: one more go, never charged; after that, 409.
      try { s1.child.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 800));
      s1 = accountServer(P, MOCK2, env);
      servers.push(s1);
      await wait(`http://localhost:${P}/api/health`, 20000);
      const balNow = await c.balance(reader);
      const rerun = await det(reader, 'verify-credit-run-5', run5.claims, idx(run5.claims, 'Water'), 'verify-credit-h1');
      await c.json('/api/release', { method: 'POST', body: { jobIds: ['verify-credit-h1'] }, cookie: reader });   // as the page does once it has the result
      const third = await det(reader, 'verify-credit-run-5', run5.claims, idx(run5.claims, 'Water'), 'verify-credit-h1');
      check(`credit (${label}): a delivered claim asked for again (its result lost on the way) runs once more, never charged; a third time is refused (409 already_tested)`,
        done(rerun) && (await c.balance(reader)) === balNow && third.status === 409 && third.body?.error?.code === 'already_tested', JSON.stringify({ rerun: rerun.status, third: { status: third.status, body: third.body }, bal: [balNow, await c.balance(reader)] }));
      // A crash: the server dies (SIGKILL) with a claim held; its row, older than the reaper's twelve hours by the
      // server's clock, is failed as lost at the next boot and its hold released.
      try { s1.child.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 800));
      s1 = accountServer(P, MOCK2, { ...env, CIVIC_CLOCK: new Date(Date.now() - 13 * 3600e3).toISOString() });
      servers.push(s1);
      await wait(`http://localhost:${P}/api/health`, 20000);
      const run6 = await listRun(reader, 'verify-credit-run-6');
      await det(reader, 'verify-credit-run-6', run6.claims, idx(run6.claims, 'Eiffel'), 'verify-credit-k0');
      const balK = await c.balance(reader);
      det(reader, 'verify-credit-run-6', run6.claims, idx(run6.claims, 'Water'), 'verify-credit-k1').catch(() => null);
      await new Promise((r) => setTimeout(r, 500));
      const heldK = await c.balance(reader);
      try { s1.child.kill('SIGKILL'); } catch {}
      await new Promise((r) => setTimeout(r, 800));
      s1 = accountServer(P, MOCK2, env);
      servers.push(s1);
      await wait(`http://localhost:${P}/api/health`, 20000);
      check(`credit (${label}): a crash with a claim held: at the next boot its row is lost and its hold released`,
        heldK === balK - 45 && (await c.balance(reader)) === balK, JSON.stringify({ balK, heldK, after: await c.balance(reader) }));
    }
  } catch (err) {
    check(`credit (${label}): the checks completed`, false, err.stack);
  }
  for (const s of servers) { try { s.child.kill('SIGTERM'); } catch {} }
  try { mock.kill('SIGTERM'); } catch {}
}

async function accountsAndCreditChecks() {
  await accountChecks('memory', null);
  await creditChecks('memory', null);
  const required = /^(1|true|yes)$/i.test(process.env.CIVIC_VERIFY_REQUIRE_DATABASE || '');
  const provision = await provisionPostgres().catch(() => null);
  if (!provision) {
    if (required) check('a Postgres is available for the accounts and credit checks (CIVIC_VERIFY_REQUIRE_DATABASE=1)', false, 'none');
    else console.log('  (accounts and credit: no Postgres here, so their database checks are skipped; CI runs them)');
    return;
  }
  const admin = new pg.Client({ connectionString: provision.url });
  try {
    await admin.connect();
    const url = (name) => { const u = new URL(provision.url); u.pathname = `/${name}`; return u.toString(); };
    for (const name of ['civic_verify_acct', 'civic_verify_credit']) { await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.query(`CREATE DATABASE ${name}`); }
    await accountChecks('Postgres', url('civic_verify_acct'));
    await creditChecks('Postgres', url('civic_verify_credit'));
  } catch (err) {
    check('the accounts and credit checks on Postgres completed', false, err.message);
  } finally {
    await admin.end().catch(() => {});
    await provision.stop();
  }
}
await accountsAndCreditChecks();

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
  const ECON_OP = 'op@verify.example';
  // The rotation's mechanics are proved on four tiers (CIVIC_TIER_ORDER 1,2,3,4, as it was until 6 October); the default of
  // three is proved on its own server below.
  const common = { OPENAI_BASE_URL: `http://localhost:${MOCK2}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl'), CIVIC_ACCOUNTS: 'on', CIVIC_OPERATOR_EMAILS: ECON_OP, CIVIC_OPERATOR_CLAIM: claimHash(), CIVIC_SIGNUP_GRANT_CENTS: '1000', CIVIC_TIER_ORDER: '1,2,3,4' };
  const servers = [];
  const outputs = new Map();   // port → what that server printed (its boot lines among it)
  const boot = async (port, env) => {
    const s = start([path.join(root, 'server', 'index.js')], { ...common, PORT: String(port), ...env });
    const out = [];
    s.stdout.on('data', (d) => out.push(String(d)));
    s.stderr.on('data', (d) => out.push(String(d)));
    outputs.set(port, out);
    servers.push(s);
    await wait(`http://localhost:${port}/api/health`, 20000);
    return s;
  };
  const printed = (port) => (outputs.get(port) || []).join('');
  const base = (port) => `http://localhost:${port}`;
  // The operator's account on each server: made through the one-time link the first time a database (or a server in memory)
  // sees it, and signed into after that; a reader's likewise, through the open form.
  const ECON_PEOPLE = { op: ECON_OP, reader: 'reader@verify.example' };
  const signin = async (port, who) => {
    const email = ECON_PEOPLE[who];
    const post = (p, body) => fetch(`${base(port)}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let r = who === 'op' ? await post('/api/account/claim', { token: CLAIM_TOKEN, email, password: PASSWORD, agree: true }) : await post('/api/account/signup', { email, password: PASSWORD, agree: true });
    if (r.status !== 200) r = await post('/api/account/signin', { email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`${who} could not sign in on ${port}: ${r.status} ${await r.text()}`);
    return ((r.headers.getSetCookie?.() || []).find((c) => c.startsWith('fe_session=')) || '').split(';')[0];
  };
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
      boundaries && changes === 15 && everyTierEveryHour && fixedClock && tierAt(base0, { ...opts, fixed: 2 }) === 2 && tierAt(base0 + 5 * DAY, { ...opts, fixed: 2 }) === 2 && freeFor(1) === 0 && freeFor(4) === 3,
      JSON.stringify({ boundaries, changes, slots, fixedClock }));
    // The operator, 6 October: "0, 1, or 2 answers, not 3". The rotation of three (and the fallback when the order holds
    // nothing) never gives three free, and over three days still meets every time of day.
    const three = { hours: 6, order: [1, 2, 3], shift: 1, fixed: null };
    const slots3 = {};
    let only3 = true;
    for (let k = 0; k < 12; k++) {
      const t = base0 + k * 6 * HOUR;
      const tier = tierAt(t, three);
      if (tier !== tierAt(t, { ...three, order: [] })) only3 = false;
      if (freeFor(tier) > 2) only3 = false;
      const h = new Date(t).getUTCHours();
      slots3[h] = [...(slots3[h] || []), tier];
    }
    check('the default rotation of three (1, 2, 3, and the fallback of an empty order) gives 0, 1 or 2 free and never 3, and over three days every tier meets every time of day',
      only3 && Object.values(slots3).every((list) => JSON.stringify([...list].sort()) === '[1,2,3]') && freeFor(3) === 2, JSON.stringify({ only3, slots3 }));
  } catch (err) { check('the tier clock arithmetic', false, err.message); }

  let admin = null;
  const dbUrl = (name) => { const u = new URL(provision.url); u.pathname = `/${name}`; return u.toString(); };
  const makeDb = async (name) => { await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.query(`CREATE DATABASE ${name}`); return dbUrl(name); };
  if (provision) {
    try {
      admin = new pg.Client({ connectionString: provision.url });
      await admin.connect();
      const DB1 = await makeDb('civic_verify_econ1');
      // 2. A run under tier 3 at the start price: the page is told first; the document's first two chosen claims are free, the third priced; a second document gets two free again.
      const P1 = PORT + 50;
      await boot(P1, { DATABASE_URL: DB1, CIVIC_CLOCK: at(T0), CIVIC_LIST_PRICE_CENTS: '45' });
      const a = await signin(P1, 'op');
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
      const runs = (await dbQuery(DB1, 'SELECT id, owner, email, user_id, code_fp, tier, free_allowed, price_cents, status, claims_total, extract_usd::float AS extract_usd, chars FROM runs ORDER BY started_at')).rows;
      const opId = Number((await dbQuery(DB1, 'SELECT id FROM users WHERE email_key = $1', [ECON_OP])).rows[0]?.id);
      const dets = (await dbQuery(DB1, 'SELECT id, run_id, n, status, free, price_cents, cost_usd::float AS cost_usd, priced, searches, verdict, model, collected, failure FROM determinations ORDER BY started_at')).rows;
      const lines = (await dbQuery(DB1, 'SELECT kind, run_id, determination_id, owner, usd::float AS usd FROM cost_lines ORDER BY id')).rows;
      check('the rows: each run carries its owner (the account: u:<id>, with the account\'s id and email, and no code), its tier, its free count and its price, its claims and its own listing cost; each determination its run, its number, free or the price, its cost from its ledger line, its searches, its verdict and collected=false; every ledger line carries the ids',
        runs.length === 2 && runs.every((r) => r.owner === `u:${opId}` && Number(r.user_id) === opId && r.email === ECON_OP && r.code_fp === null && r.tier === 3 && r.free_allowed === 2 && r.price_cents === 45 && r.status === 'done' && r.claims_total === claims.length && r.extract_usd > 0 && r.chars === text.length)
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
      await boot(P2, { DATABASE_URL: DB1, CIVIC_CLOCK: at(T1), CIVIC_LIST_PRICE_CENTS: '45' });
      const a2 = await signin(P2, 'op');
      const migrations = (await dbQuery(DB1, 'SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
      const d7 = await detOn(P2, a2, { jobId: 'verify-econ-r1-c4', runId: 'verify-econ-r1', n: 4, entry: entry(0) });
      const r3 = await runOn(P2, a2, 'verify-econ-r3');
      const health2 = await json(`${base(P2)}/api/health`, a2);
      check('a second FactEngine on the same database six hours on boots with each migration applied once; a determination of the first document, now from this one, is priced by that document\'s tier and count (two free already taken) whatever the clock says; a new document takes the new window\'s tier (4: three free)',
        migrations === fs.readdirSync(path.join(root, 'server', 'migrations')).filter((f) => f.endsWith('.sql')).length && JSON.stringify(quoteOf(d7)) === JSON.stringify({ free: false, priceCents: 45 }) && JSON.stringify(pricingOf(r3)) === JSON.stringify({ tier: 4, freeFacts: 3, priceCents: 45, currency: 'USD', note: null }) && health2.pricing?.tier === 4,
        JSON.stringify({ migrations, d7: quoteOf(d7), r3: pricingOf(r3), tier: health2.pricing?.tier }));
      // 4b. The boot lines, for the operator in the host's log: the list price and the rotation, and what one running
      // determination takes of the key's minute (the five determinations so far: their mean tokens over their mean minutes).
      // Nothing of a key, a password or a reader's address.
      const boot2 = printed(P2);
      const cap2 = (boot2.match(/\[capacity\] last 7 days: (\d+) fact-checks?, on average ([\d,]+) tokens over ([\d.]+) min \(([\d,]+) a minute each\)/) || []);
      const toInt = (v) => Number(String(v || '').replace(/,/g, ''));
      check('at boot the host\'s log says the list price and the rotation, and what one running fact-check takes of the key\'s minute: the fact-checks measured over the last seven days, their mean tokens over their mean minutes, and that rate; it carries no key, no password and no reader\'s address',
        /\[economics\] measuring in Postgres[^\n]* · the list price is 45 cents a fact-check · the rotation 1,2,3,4/.test(boot2) && cap2.length === 5 && toInt(cap2[1]) >= 5 && toInt(cap2[2]) > 6000 && Number(cap2[3]) > 0
          && Math.abs(toInt(cap2[4]) - toInt(cap2[2]) / Number(cap2[3])) <= Math.max(2, toInt(cap2[4]) * 0.06) && !boot2.includes(KEY) && !boot2.includes(PASSWORD) && !boot2.includes(ECON_OP),
        (boot2.match(/\[(economics|capacity)\][^\n]*/g) || []).join(' | '));
      // 5. The measurement, for the operator alone.
      const st = await json(`${base(P2)}/api/selftest`, a2);
      const b2 = await signin(P2, 'reader');
      const stB = await fetch(`${base(P2)}/api/selftest`, { headers: { cookie: b2 } });
      const e = st.economics;
      const t3 = e?.byTier?.find((x) => x.tier === 3), t4 = e?.byTier?.find((x) => x.tier === 4);
      const user = e?.byUser?.find((x) => x.email === ECON_OP);
      check('the operator\'s check page carries the measurement: per tier (users, runs, determinations, free given, cost, listing cost, revenue at list, margin, margin per user, coverage), per user by email, per window, the price with its basis and the measured average so far, the tier clock, the guard off, revenue at list and nothing collected; an account that is not the operator\'s cannot open the check page at all (403)',
        Boolean(e) && e.store === 'postgres' && t3 && t3.users === 1 && t3.runs === 2 && t3.determinations === 6 && t3.failed === 1 && t3.freeGiven === 4 && t3.revenueUsd === 0.9 && t3.costUsd > 0 && Math.abs(t3.marginUsd - (t3.revenueUsd - t3.costUsd)) < 0.0011 && t3.extractUsd > 0 && typeof t3.coverage === 'number'
          && t4 && t4.runs === 1 && t4.determinations === 0 && user && user.runs === 3 && user.determinations === 6 && user.freeGiven === 4 && e.byWindow.length === 2
          && e.price.cents === 45 && e.price.basis === 'list' && e.price.listCents === 45 && e.price.measuredSample === 6 && e.price.measuredAvgUsd > 0 && e.price.markupPercent === 25
          && Math.abs(e.price.coverage - Math.round((0.45 / (e.price.measuredAvgUsd * 1.25)) * 100) / 100) < 1e-9 && !('minSample' in e.price) && !('startCents' in e.price)
          && e.tier.now === 4 && e.tier.freeFacts === 3 && e.tier.hours === 6 && e.guard.configured === false && /list price/.test(e.note) && stB.status === 403,
        JSON.stringify({ t3, t4, user, price: e?.price, tier: e?.tier, guard: e?.guard, other: stB.status }));
      check('the report carries how long determinations and listings take over the window, with the searches per determination',
        e?.durations && e.durations.determinations.n >= 6 && e.durations.determinations.meanMs > 0 && e.durations.determinations.p75Ms >= e.durations.determinations.meanMs * 0.5 && typeof e.durations.determinations.meanSearches === 'number' && e.durations.extractions.n >= 2 && e.durations.extractions.meanMs > 0,
        JSON.stringify(e?.durations));
      // The tokens of a determination, as the stand-in reported them on each ledger line (read and written; the stand-in
      // writes 6,000 reasoning tokens into every determination): the report's mean is theirs, over the same lines.
      const evLines = (await dbQuery(DB1, "SELECT at, line FROM cost_lines WHERE kind = 'evaluate' AND ok IS NOT FALSE AND line->>'ms' IS NOT NULL")).rows
        .filter((r) => new Date(r.at).getTime() >= T1 - 7 * DAY).map((r) => (Number(r.line.usage?.input) || 0) + (Number(r.line.usage?.output) || 0)).filter((v) => v > 0);
      const meanTok = evLines.length ? Math.round(evLines.reduce((a, b) => a + b, 0) / evLines.length) : null;
      check('the report\'s durations carry the mean tokens of a determination (read and written, cached included): the mean of the stand-in\'s own figures on the ledger lines, its 6,000 reasoning tokens in each',
        e?.durations?.determinations?.meanTokens === meanTok && meanTok > 6000 && e.durations.determinations.tokensMeasured === evLines.length && evLines.length === e.durations.determinations.n,
        JSON.stringify({ report: e?.durations?.determinations, lines: evLines.length, meanTok }));
      // 6. A deploy with a determination in flight: the row is failed as deploy, nothing booked.
      const P3 = PORT + 52;
      const s3 = await boot(P3, { DATABASE_URL: DB1, CIVIC_CLOCK: at(T1), CIVIC_LIST_PRICE_CENTS: '45' });
      const a3 = await signin(P3, 'op');
      const inflight = fetch(`${base(P3)}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: a3 }, body: JSON.stringify({ jobId: 'verify-econ-r3-c1', claims: [entry(0)], text, source: { kind: 'text' }, runId: 'verify-econ-r3', n: 1 }) });
      await new Promise((r) => setTimeout(r, 400));
      s3.kill('SIGTERM');
      await (await inflight).text().catch(() => '');
      await new Promise((r) => setTimeout(r, 800));
      const deployRow = (await dbQuery(DB1, 'SELECT status, failure, price_cents, free FROM determinations WHERE id = $1', ['verify-econ-r3-c1'])).rows[0];
      check('a FactEngine told to stop with a determination in flight fails that row as deploy, nothing booked, before it goes', deployRow?.status === 'failed' && deployRow?.failure === 'deploy' && deployRow?.price_cents === 0, JSON.stringify(deployRow));
      // 7. One list price (the operator, 6 October): it prices every window, and the measured average never does.
      const DB2 = await makeDb('civic_verify_econ2');
      const T2 = T0 + 12 * HOUR, T3 = T2 + 6 * HOUR;
      const seed = async (url, { runId, tier, from, n, cost, price, free, email = 'seed@verify' }) => {
        await dbQuery(url, 'INSERT INTO runs (id, owner, email, started_at, tier, window_start, price_cents, free_allowed, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING', [runId, `seed:${email}`, email, new Date(from), tier, new Date(windowStartAt(from, 6)), price, freeFor(tier), 'done']);
        for (let i = 0; i < n; i++) await dbQuery(url, "INSERT INTO determinations (id, run_id, n, started_at, ended_at, status, free, price_cents, cost_usd, priced) VALUES ($1, $2, $3, $4, $4, 'done', $5, $6, $7, true)", [`${runId}-d${i + 1}`, runId, i + 1, new Date(from + i * 1000), free, free ? 0 : price, cost]);
      };
      // twenty determinations measured at 36 cents two days before: the sample the measured price once waited for (it would have priced at 45)
      const P4 = PORT + 53;
      await boot(P4, { DATABASE_URL: DB2, CIVIC_CLOCK: at(T0) });   // the schema, for the seed
      await seed(DB2, { runId: 'seed-a', tier: 3, from: T2 - 2 * DAY, n: 20, cost: 0.36, price: 45, free: false });
      const P5 = PORT + 54;
      await boot(P5, { DATABASE_URL: DB2, CIVIC_CLOCK: at(T2) });   // no list price
      const a5 = await signin(P5, 'op');
      const h5 = await json(`${base(P5)}/api/health`, a5);
      const st5 = await json(`${base(P5)}/api/selftest`, a5);
      const P6 = PORT + 55;
      await boot(P6, { DATABASE_URL: DB2, CIVIC_CLOCK: at(T3), CIVIC_LIST_PRICE_CENTS: '125', CIVIC_TIER_ORDER: '' });   // the list price, and the default rotation
      const a6 = await signin(P6, 'op');
      const h6 = await json(`${base(P6)}/api/health`, a6);
      const st6 = await json(`${base(P6)}/api/selftest`, a6);
      const r6 = await runOn(P6, a6, 'verify-econ-r6');
      const windows = (await dbQuery(DB2, 'SELECT window_start, price_cents, sample, basis, avg_cost_usd::float AS avg FROM windows WHERE window_start >= $1 ORDER BY window_start', [new Date(T2)])).rows;
      check('with no list price set nothing is priced, even with twenty determinations measured (the health line says no price, the check page says so and still measures 20 at 36 cents, and a warning names the missing setting); with CIVIC_LIST_PRICE_CENTS the window prices at the list price, never at the measured average (which would have priced at 45 cents), the check page says how many times the list price covers the measured cost and the markup, and a run in it is told so',
        h5.pricing?.priceCents === null && st5.economics?.price?.cents === null && st5.economics?.price?.basis === 'none' && st5.economics?.price?.measuredSample === 20 && Math.abs(st5.economics.price.measuredAvgUsd - 0.36) < 1e-9 && (st5.checks || []).some((x) => x.state === 'warn' && x.title === 'No list price is set')
          && h6.pricing?.priceCents === 125 && st6.economics?.price?.cents === 125 && st6.economics?.price?.basis === 'list' && st6.economics?.price?.listCents === 125 && st6.economics?.price?.measuredSample === 20 && st6.economics?.price?.coverage === Math.round((1.25 / (0.36 * 1.25)) * 100) / 100 && pricingOf(r6)?.priceCents === 125
          && !(st6.checks || []).some((x) => x.title === 'No list price is set')
          && windows.length === 2 && windows[0].price_cents === null && windows[0].basis === 'none' && windows[1].price_cents === 125 && windows[1].basis === 'list' && windows[1].sample === 20 && Math.abs(windows[1].avg - 0.36) < 1e-9,
        JSON.stringify({ h5: h5.pricing, st5: st5.economics?.price, h6: h6.pricing, st6: st6.economics?.price, r6: pricingOf(r6), windows }));
      check('a FactEngine with no CIVIC_TIER_ORDER rotates through tiers 1, 2 and 3 (0, 1 or 2 free on a document, never 3), and says so on the check page and in its boot line',
        JSON.stringify(st6.economics?.tier?.order) === '[1,2,3]' && [1, 2, 3].includes(h6.pricing?.tier) && h6.pricing.freeFacts === h6.pricing.tier - 1 && h6.pricing.freeFacts <= 2 && pricingOf(r6)?.freeFacts <= 2
          && /the list price is 125 cents a fact-check · the rotation 1,2,3\b/.test(printed(P6)) && /no list price is set \(CIVIC_LIST_PRICE_CENTS\), so nothing is priced/.test(printed(P5)),
        JSON.stringify({ order: st6.economics?.tier?.order, h6: h6.pricing, r6: pricingOf(r6) }));
      // 7b. The deploy of 6 October: the live window was fixed at 49 cents by the retired start figure. The list price rewrites
      // that window's row the first time it is asked, so a new document is told the list price at once; a document listed
      // before keeps the price it was told.
      const DB4 = await makeDb('civic_verify_econ4');
      const P8 = PORT + 59;
      const s8 = await boot(P8, { DATABASE_URL: DB4, CIVIC_CLOCK: at(T0), CIVIC_TIER_FIXED: '1', CIVIC_LIST_PRICE_CENTS: '49' });
      const a8 = await signin(P8, 'op');
      const r8b = await runOn(P8, a8, 'verify-econ-r8b');
      await dbQuery(DB4, "UPDATE windows SET basis = 'start'");   // the row exactly as the measured price left it live: 49 cents, from the start figure
      const row8 = (await dbQuery(DB4, 'SELECT price_cents, basis FROM windows')).rows;
      s8.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      const P9 = PORT + 61;
      await boot(P9, { DATABASE_URL: DB4, CIVIC_CLOCK: at(T0 + 10 * 60e3), CIVIC_TIER_FIXED: '1', CIVIC_LIST_PRICE_CENTS: '125', CIVIC_PRICE_START_CENTS: '49', CIVIC_PRICE_MIN_SAMPLE: '20' });
      const a9 = await signin(P9, 'op');
      const h9b = await json(`${base(P9)}/api/health`, a9);
      const row9 = (await dbQuery(DB4, 'SELECT price_cents, basis FROM windows')).rows;
      const r9b = await runOn(P9, a9, 'verify-econ-r9b');
      const c9 = (r) => r.find((e) => e.t === 'done')?.claims?.[0]?.entry || text;
      const dOld = await detOn(P9, a9, { jobId: 'verify-econ-r8b-c1', runId: 'verify-econ-r8b', n: 1, entry: c9(r8b) });
      const dNew = await detOn(P9, a9, { jobId: 'verify-econ-r9b-c1', runId: 'verify-econ-r9b', n: 1, entry: c9(r9b) });
      const st9b = await json(`${base(P9)}/api/selftest`, a9);
      check('a window fixed at another price (49 cents, from the retired start figure) takes the list price the first time it is asked: the next instance, ten minutes into the same window, says 125 cents at once, the row now says list, and a new document is told 125; a document listed before keeps its 49 cents, and each claim is held at its own document\'s price',
        pricingOf(r8b)?.priceCents === 49 && row8.length === 1 && row8[0].price_cents === 49 && row8[0].basis === 'start'
          && h9b.pricing?.priceCents === 125 && row9.length === 1 && row9[0].price_cents === 125 && row9[0].basis === 'list' && pricingOf(r9b)?.priceCents === 125
          && JSON.stringify([quoteOf(dOld), quoteOf(dNew)]) === JSON.stringify([{ free: false, priceCents: 49 }, { free: false, priceCents: 125 }]) && dOld.some((e) => e.t === 'done') && dNew.some((e) => e.t === 'done'),
        JSON.stringify({ r8b: pricingOf(r8b), row8, h9b: h9b.pricing, row9, r9b: pricingOf(r9b), dOld: quoteOf(dOld), dNew: quoteOf(dNew) }));
      check('the measured price\'s settings still on a service (CIVIC_PRICE_START_CENTS, CIVIC_PRICE_MIN_SAMPLE) are read by nothing, and named: in the boot line and as a warning on the check page',
        /no longer read: CIVIC_PRICE_START_CENTS, CIVIC_PRICE_MIN_SAMPLE/.test(printed(P9)) && (st9b.checks || []).some((x) => x.state === 'warn' && x.title === 'Settings of the measured price are still on the service' && /CIVIC_PRICE_START_CENTS, CIVIC_PRICE_MIN_SAMPLE/.test(x.detail))
          && JSON.stringify(st9b.economics?.price?.retired) === JSON.stringify(['CIVIC_PRICE_START_CENTS', 'CIVIC_PRICE_MIN_SAMPLE']) && st9b.economics?.price?.cents === 125,
        (printed(P9).match(/\[economics\][^\n]*/) || [''])[0]);
      // 8. The loss guard: a window that lost more than the guard sends every new run to tier 1, until the margin earned since covers the loss.
      const DB3 = await makeDb('civic_verify_econ3');
      const P7 = PORT + 56;
      await boot(P7, { DATABASE_URL: DB3, CIVIC_CLOCK: at(T0 + 30 * 60e3), CIVIC_LIST_PRICE_CENTS: '45', CIVIC_TIER_LOSS_GUARD_USD: '0.5' });
      const a7 = await signin(P7, 'op');
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
    await boot(P9, { CIVIC_CLOCK: at(T0), CIVIC_LIST_PRICE_CENTS: '45', CIVIC_PRICING_NOTE: 'The beta is not charged.' });
    const a9 = await signin(P9, 'op');
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
    check('in file mode the report carries the durations too, from the ledger lines this instance wrote, with the mean tokens of a determination (the stand-in\'s 6,000 reasoning tokens in each of the three) and the list price',
      st9.economics?.durations?.determinations?.n === 3 && st9.economics.durations.determinations.meanMs > 0 && st9.economics.durations.extractions.n === 1
        && st9.economics.durations.determinations.meanTokens > 6000 && st9.economics.durations.determinations.tokensMeasured === 3
        && st9.economics.price?.cents === 45 && st9.economics.price.basis === 'list' && st9.economics.price.listCents === 45,
      JSON.stringify({ durations: st9.economics?.durations, price: st9.economics?.price }));
    // 10. Pricing off: the rollback. The page is as before: no pricing on the health line, no pricing or quote event, nothing measured.
    const P10 = PORT + 58;
    await boot(P10, { CIVIC_PRICING_ENABLED: 'false', CIVIC_LIST_PRICE_CENTS: '45' });
    const a10 = await signin(P10, 'op');
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
// deepseek-flash at effort high; the determinations stay on OpenAI. A stand-in DeepSeek (the /deepseek routes of
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
      CIVIC_LEDGER_FILE: ledger, CIVIC_ERROR_LOG: errlog, DATABASE_URL: '',
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
    const wantKeys = [...(slot ? ['model', 'input'] : ['model', 'instructions', 'input']), 'reasoning', 'stream'];
    check('DeepSeek: the health line says the listing goes to DeepSeek\'s deepseek-flash at effort high with no mode, no summary and no search (DeepSeek ignores it), and lists its keys (no tools, no store); the readers\' determinations stay on OpenAI',
      sx.provider === 'deepseek' && sx.model === 'deepseek-flash' && sx.effort === 'high' && sx.mode === null && sx.summary === null && sx.webSearch === false && JSON.stringify(health.request?.keys?.extract) === JSON.stringify(wantKeys) && health.request?.evaluate?.model === config.evalModels[0],
      JSON.stringify({ extract: sx, keys: health.request?.keys?.extract }));

    const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
    const jobA = `ds-a-${stamp}`;
    const a = await stream(`${base}/api/extract`, { text: source, jobId: jobA });
    const doneA = a.find((e) => e.t === 'done');
    const bodyA = dsBodies()[0]?.body;
    check('DeepSeek: a listing completes with its claims, on deepseek-flash at effort high, no mode, and nothing searched',
      Boolean(doneA) && doneA.total >= 3 && doneA.model === 'deepseek-flash' && doneA.effort === 'high' && doneA.mode === null && (doneA.trail || []).length === 0 && !a.some((e) => e.t === 'error'),
      JSON.stringify(doneA && { total: doneA.total, model: doneA.model, effort: doneA.effort, mode: doneA.mode, trail: doneA.trail }));
    check('DeepSeek: the listing\'s body carries exactly the model, the prompt, reasoning {effort: high} and stream; no tools (DeepSeek ignores web search), no store, mode or summary, and not CIVIC\'s own tools though the gateway is set',
      Boolean(bodyA) && JSON.stringify(Object.keys(bodyA).sort()) === JSON.stringify([...wantKeys].sort()) && JSON.stringify(bodyA.reasoning) === JSON.stringify({ effort: 'high' })
        && bodyA.tools === undefined && bodyA.stream === true && bodyA.model === 'deepseek-flash' && !JSON.stringify(bodyA).includes(PASS),
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
    check('DeepSeek: a reader\'s determination still runs on OpenAI and completes', ev.some((e) => e.t === 'done') && !ev.some((e) => e.t === 'error'), JSON.stringify(ev.filter((e) => e.t === 'error')));
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

    const st = await (await fetch(`${base}/api/selftest`)).json();
    const row = (re) => (st.checks || []).find((x) => re.test(x.title));
    check('DeepSeek: /check accepts the listing\'s key and model without spending a token, shows the balance to the operator, and is ready',
      st.ready === true && row(/^A DeepSeek key is configured/)?.state === 'ok' && row(/^DeepSeek accepts this key for deepseek-flash/)?.state === 'ok'
        && /Balance 12\.34 USD/.test(row(/DeepSeek account can pay/)?.detail || '') && row(/^OpenAI accepts this key for/)?.title === `OpenAI accepts this key for ${config.evalModels[0]}`
        && st.settings?.listingProvider === 'DeepSeek' && st.settings?.listingModel === 'deepseek-flash' && st.settings?.listingEffort === 'high',
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

    // The operator's figures stay the operator's: /check is the operator's account's alone, and it shows the balance.
    const base2 = serve(PORT + 81, { CIVIC_ACCOUNTS: 'on', CIVIC_OPERATOR_EMAILS: 'op@example.com', CIVIC_OPERATOR_CLAIM: claimHash() });
    await wait(`${base2}/api/health`);
    const people = accountClient(base2);
    const readerCookie = (await people.signup('reader@example.com')).cookie;
    const operatorCookie = (await people.json('/api/account/claim', { method: 'POST', body: { token: CLAIM_TOKEN, email: 'op@example.com', password: PASSWORD, agree: true } })).cookie;
    const asReader = await people.json('/api/selftest', { cookie: readerCookie });
    const asOperator = ((await people.json('/api/selftest', { cookie: operatorCookie })).body?.checks || []).find((x) => /DeepSeek account can pay/.test(x.title));
    check('DeepSeek: a reader cannot open /check at all (403 operator_only); the operator\'s shows the balance',
      asReader.status === 403 && asReader.body?.error?.code === 'operator_only' && /Balance 12\.34 USD/.test(asOperator?.detail || ''), JSON.stringify({ reader: asReader.status, operator: asOperator }));

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

    // A key's name, whatever its capitals (5 October: the operator saved DeepSeek's key in Render as DEEPSEEK_API_Key).
    // Under another spelling it is still the listing's key, and /check names the spelling; the exact name wins; two
    // spellings that hold different keys are not guessed between, and nothing is sent.
    const sentBy = () => dsEntries().map((r) => r.auth);
    const KEY2 = 'sk-dsverify-other-spelling-000000000';
    const before4 = sentBy().length;
    const base4 = serve(PORT + 93, { DEEPSEEK_API_KEY: '', DEEPSEEK_API_Key: DSKEY });
    await wait(`${base4}/api/health`);
    const l4 = await stream(`${base4}/api/extract`, { text: source, jobId: `ds-case-${stamp}` });
    const st4 = await (await fetch(`${base4}/api/selftest`)).json();
    const row4 = (st4.checks || []).find((x) => x.title === 'A DeepSeek key is configured for the listing');
    check('DeepSeek: a key saved as DEEPSEEK_API_Key (other capitals) is the listing\'s key: the listing reaches DeepSeek with it and completes, and /check says under which name it was saved',
      l4.some((e) => e.t === 'done') && sentBy().slice(before4).length >= 1 && sentBy().slice(before4).every((a) => a === `Bearer ${DSKEY}`)
        && /saved in Render as DEEPSEEK_API_Key/.test(row4?.detail || '') && st4.ready === true,
      JSON.stringify({ done: l4.some((e) => e.t === 'done'), sent: sentBy().slice(before4).map((a) => (a === `Bearer ${DSKEY}` ? 'the key' : 'another')), row: row4?.detail }));
    const before5 = sentBy().length;
    const base5 = serve(PORT + 94, { DEEPSEEK_API_KEY: DSKEY, DEEPSEEK_API_Key: KEY2 });
    await wait(`${base5}/api/health`);
    const l5 = await stream(`${base5}/api/extract`, { text: source, jobId: `ds-exact-${stamp}` });
    check('DeepSeek: when the exact name and another spelling both hold a key, the exact name wins',
      l5.some((e) => e.t === 'done') && sentBy().slice(before5).length >= 1 && sentBy().slice(before5).every((a) => a === `Bearer ${DSKEY}`),
      JSON.stringify(sentBy().slice(before5).map((a) => (a === `Bearer ${DSKEY}` ? 'exact' : 'other'))));
    const before6 = sentBy().length;
    const base6 = serve(PORT + 95, { DEEPSEEK_API_KEY: '', DEEPSEEK_API_Key: DSKEY, Deepseek_Api_Key: KEY2 });
    await wait(`${base6}/api/health`);
    const r6 = await fetch(`${base6}/api/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: source, jobId: `ds-ambiguous-${stamp}` }) });
    const b6 = await r6.json().catch(() => ({}));
    const st6 = await (await fetch(`${base6}/api/selftest`)).json();
    check('DeepSeek: two spellings holding different keys are not guessed between: the listing is refused before any request, and /check names both and says to keep one',
      r6.status === 503 && b6?.error?.code === 'no_operator_key' && sentBy().length === before6 && st6.ready === false
        && (st6.checks || []).some((x) => x.state === 'bad' && x.title === 'Two settings hold the DeepSeek key, with different values' && /DEEPSEEK_API_Key and Deepseek_Api_Key/.test(x.detail) && /DEEPSEEK_API_KEY/.test(x.fix)),
      JSON.stringify({ status: r6.status, sent: sentBy().length - before6, rows: (st6.checks || []).filter((x) => x.state === 'bad').map((x) => x.title) }));
    const check4 = await (await fetch(`${base4}/api/selftest`)).text() + await (await fetch(`${base6}/api/selftest`)).text();
    check('DeepSeek: neither spelling\'s key appears in /check\'s data',
      !check4.includes(DSKEY) && !check4.includes(KEY2), '');

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

// ---- The operator's trial: their own determinations on DeepSeek (14 October) ---------------------------------------
// The operator: "I think the best experiment is to use the new DeepSeek deep reasoning model through the already
// connected API." Their own runs alone, chosen on the page. DeepSeek ignores web search, so the model is offered
// FactEngine's own tools as functions and FactEngine runs each call, round after round. Proved here: a reader's choice
// of model is ignored and their request is OpenAI's, unchanged; the trial's body exactly, its tools the registry's, the
// prompt as the readers' request carries it; three rounds, each sending back the model's reasoning and the calls'
// answers; the search and the page read through FactEngine; the chain of thought on no page, replay, ledger line or
// failure record; the cost DeepSeek's tokens plus the search's own; never charged, out of the readers' measurements, in
// /check's trial table; every refusal a wait; the trial unavailable without the search service; side by side, the
// readers' own request recorded as a trial; and the three fixes to OpenAI's loop.
async function trialChecks() {
  const TMOCK = MOCK_PORT + 90, TMOCK2 = MOCK_PORT + 91, SITE = PORT + 96;
  const DSKEY = 'sk-dstrial00000000000000000000000';
  const SKEY = 'search-key-trial-verify-7e1c';
  const COT = 'DSCOT-7f3a';   // the stand-in's chain-of-thought marker
  const stamp = Date.now();
  const rec = path.join(os.tmpdir(), `civic-verify-trial-${stamp}.jsonl`);
  const rec2 = path.join(os.tmpdir(), `civic-verify-trial2-${stamp}.jsonl`);
  const ledger = path.join(os.tmpdir(), `civic-verify-trial-ledger-${stamp}.jsonl`);
  const errlog = path.join(os.tmpdir(), `civic-verify-trial-errors-${stamp}.log`);
  fs.writeFileSync(rec, ''); fs.writeFileSync(rec2, '');
  const read = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const dsBodies = (f = rec) => read(f).filter((r) => r.path === '/deepseek/responses' && r.body);
  const dsHeads = (f = rec) => read(f).filter((r) => r.deepseek && r.path !== '/deepseek/mock/stats');   // the guard's own stats reads carry the stand-in's key
  const oaBodies = (f = rec) => read(f).filter((r) => r.path === '/v1/responses' && r.body);
  const dsStats = async (port = TMOCK) => (await fetch(`http://localhost:${port}/deepseek/mock/stats`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  const lines = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // The search service the tools ask, in Exa's shape, and the page it finds; every call recorded.
  const searchCalls = [];
  const pageReads = [];
  const site = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/search')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch {}
        searchCalls.push({ key: req.headers['x-api-key'] || '', auth: req.headers.authorization || '', query: body.query || '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ requestId: 'standin', results: [{ url: `http://localhost:${SITE}/tower`, title: 'The tower, measured', publishedDate: '2026-01-02T00:00:00.000Z', text: `${body.query}: the Eiffel Tower is about 330 metres tall.` }], costDollars: { total: 0.005 } }));
      });
      return;
    }
    if (req.url.startsWith('/tower')) { pageReads.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><title>The tower, measured</title></head><body><article><p>${'The Eiffel Tower is about 330 metres tall and stands on the Champ de Mars in Paris. '.repeat(6)}</p></article></body></html>`); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => site.listen(SITE, r));
  const procs = [];
  const output = [];
  const trialEnv = (mock) => ({
    OPENAI_BASE_URL: `http://localhost:${mock}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false',
    CIVIC_LEDGER_FILE: ledger, CIVIC_ERROR_LOG: errlog, DEEPSEEK_API_KEY: DSKEY, CIVIC_DEEPSEEK_BASE_URL: `http://localhost:${mock}/deepseek`,
    CIVIC_SEARCH_URL: `http://localhost:${SITE}/search`, CIVIC_SEARCH_KEY: SKEY, CIVIC_ALLOW_PRIVATE_URLS: 'true',
  });
  const serve = (port, env) => {
    const child = start([path.join(root, 'server', 'index.js')], { PORT: String(port), ...trialEnv(TMOCK), DATABASE_URL: '', ...env });
    child.stdout.on('data', (d) => output.push(String(d)));
    child.stderr.on('data', (d) => output.push(String(d)));
    procs.push(child);
    return `http://localhost:${port}`;
  };
  // Ordinals at the stand-in DeepSeek: 1-3 the first trial (search, page, entry); 4 a 429 with no wait, then 5-7; 8 a
  // 503, then 9-11; 12 an error event mid-stream, then 13-15; 16 a stream closed with no event, then 17-19; 20 a 402.
  // At the stand-in OpenAI: 1 a reader's determination; 2 the same claim side by side; 3 a reply that ends with no last
  // event, then 4; 5 an error event mid-stream, then 6; 7 cut after its searches, then 8.
  const evalMark = process.env.MOCK_EVAL_MARK_FOR_GATE || '';
  start([path.join(root, 'scripts', 'mock-openai.js')], {
    MOCK_PORT: String(TMOCK), MOCK_RECORD: rec, MOCK_SPEED: '0.2', MOCK_EVAL_MARK: evalMark, MOCK_DS_READ_URL: `http://localhost:${SITE}/tower`,
    MOCK_DS_429: '4', MOCK_DS_503: '8', MOCK_DS_ERROR_EVENT: '12', MOCK_DS_CLOSE: '16', MOCK_DS_402: '20',
    MOCK_END_EARLY_REQUESTS: '3', MOCK_ERROR_EVENT_REQUESTS: '5', MOCK_DROP_REQUESTS: '7',
  });
  start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(TMOCK2), MOCK_RECORD: rec2, MOCK_SPEED: '0.2', MOCK_EVAL_MARK: evalMark, MOCK_DS_READ_URL: `http://localhost:${SITE}/tower` });
  try {
    await wait(`http://localhost:${TMOCK}/v1/responses`, 15000, { anyResponse: true });
    await wait(`http://localhost:${TMOCK2}/v1/responses`, 15000, { anyResponse: true });
    // An open door (CIVIC_ACCOUNTS=off, a laptop of one's own) is the operator's: the trial is offered.
    const base = serve(PORT + 97, { OPENAI_ORG_ID: 'org-verify-trial', OPENAI_CUSTOM_HEADERS: 'X-Verify-Leak: yes' });
    await wait(`${base}/api/health`);
    const health = await (await fetch(`${base}/api/health`)).json();
    const tr = health.trial || {};
    // 18 October: "There is only 1 DeepSeek model for fact checking" (V4 Pro), and Gemini 4 Argon beside it, which this
    // server, with no Gemini key, offers as unable to run (geminiChecks below run it).
    const dsEntry = (tr.entries || []).find((e) => e.model === 'deepseek-v4-pro');
    check('Trial: the operator\'s page is offered DeepSeek V4 Pro alone of DeepSeek\'s models, its four efforts opening on high, beside the readers\' model, and ready; V4.1 Flash is not offered for fact-checking',
      JSON.stringify((tr.models || []).map((m) => m.id)) === JSON.stringify(['deepseek-v4-pro', 'gemini-4-argon']) && !(tr.entries || []).some((e) => e.model === 'deepseek-flash')
        && dsEntry?.fixed === false && JSON.stringify(dsEntry.efforts) === JSON.stringify(['none', 'low', 'high', 'max']) && dsEntry.effort === 'high' && dsEntry.ready === true
        && tr.readers?.id === config.evalModels[0] && tr.ready === true && JSON.stringify(health.request?.keys?.trial) === JSON.stringify(['model', 'input', 'reasoning', 'tools', 'stream']),
      JSON.stringify({ trial: tr, keys: health.request?.keys?.trial }));

    const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level.';
    const claim = 'The Eiffel Tower stands about 330 metres tall.';
    const evaluate = (extra = {}, label = 'x') => stream(`${base}/api/evaluate`, { claims: [claim], text: source, source: { kind: 'text' }, jobId: `tr-${label}-${stamp}`, ...extra });

    // A reader's determination first, for the request the trial must match.
    const r1 = await evaluate({}, 'reader');
    const readerBody = oaBodies()[0]?.body;
    check('Trial: a determination with no model chosen is the readers\' own, on OpenAI, delivered as always',
      r1.some((e) => e.t === 'done' && !e.trial && !e.provider) && oaBodies().length === 1 && dsBodies().length === 0, JSON.stringify(r1.filter((e) => e.t === 'error')));

    // The trial on DeepSeek V4 Pro at max: three rounds, a search and a page through FactEngine, then the entry.
    const jobT = `tr-t1-${stamp}`;
    const t1 = await stream(`${base}/api/evaluate`, { claims: [claim], text: source, source: { kind: 'text' }, jobId: jobT, model: 'deepseek-v4-pro', effort: 'max' });
    const done1 = t1.find((e) => e.t === 'done');
    const b = dsBodies().map((x) => x.body);
    const st1 = await dsStats();
    check('Trial: the operator\'s fact-check on DeepSeek V4 Pro at max is delivered, its verdict read, its trail a search and a page read through FactEngine, no reasoning box',
      done1?.provider === 'deepseek' && done1.trial === true && done1.model === 'deepseek-v4-pro' && done1.effort === 'max' && done1.verdictSource !== 'unread' && done1.reasoning === null
        && (done1.trail || []).length === 2 && done1.trail[0].name === 'search_web' && done1.trail[0].status === 'completed' && done1.trail[1].name === 'read_page' && done1.trail[1].url === `http://localhost:${SITE}/tower` && done1.trail[1].status === 'completed'
        && done1.searches === 1 && !t1.some((e) => e.t === 'error'),
      JSON.stringify(done1 && { provider: done1.provider, model: done1.model, effort: done1.effort, verdictSource: done1.verdictSource, trail: done1.trail, searches: done1.searches }));
    check('Trial: three rounds went to DeepSeek, each carrying exactly the model, the conversation, reasoning {effort: max}, FactEngine\'s tools as functions and stream (no store, mode, summary, web search or mcp)',
      b.length === 3 && b.every((x) => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(['input', 'model', 'reasoning', 'stream', 'tools']) && JSON.stringify(x.reasoning) === JSON.stringify({ effort: 'max' }) && x.stream === true && x.model === 'deepseek-v4-pro')
        && b.every((x) => x.tools.length >= 2 && x.tools.every((t) => t.type === 'function' && typeof t.name === 'string' && typeof t.description === 'string' && t.parameters?.type === 'object') && ['search_web', 'read_page'].every((n) => x.tools.some((t) => t.name === n))),
      JSON.stringify(b.map((x) => ({ keys: Object.keys(x), reasoning: x.reasoning, tools: (x.tools || []).map((t) => `${t.type}:${t.name}`) }))));
    check('Trial: the first round begins with exactly the two messages a reader\'s determination of the same claim carries (the source, then the prompt verbatim)',
      Boolean(readerBody) && b.length > 0 && JSON.stringify(b[0].input) === JSON.stringify(readerBody.input), `${JSON.stringify(b[0]?.input).length} vs ${JSON.stringify(readerBody?.input).length} chars`);
    check('Trial: each later round sends back the model\'s reasoning and its call, then the call\'s answer, and DeepSeek refused none',
      b.length === 3 && b[1].input.length === 5 && JSON.stringify(b[1].input.slice(2).map((x) => x.type)) === JSON.stringify(['reasoning', 'function_call', 'function_call_output'])
        && b[2].input.length === 8 && b[2].input[3].call_id === b[2].input[4].call_id && st1.refusedRounds === 0 && st1.rounds === 3,
      JSON.stringify({ round2: b[1]?.input?.map((x) => x.type || x.role), round3: b[2]?.input?.map((x) => x.type || x.role), stats: st1 }));
    check('Trial: the search went to FactEngine\'s search service with its key, in the model\'s words, and the page was read by FactEngine\'s reader',
      searchCalls.length === 1 && searchCalls[0].key === SKEY && /evidence for/.test(searchCalls[0].query) && pageReads.length === 1, JSON.stringify({ searches: searchCalls.map((x) => x.query), pages: pageReads }));
    const heads = dsHeads();
    check('Trial: DeepSeek got DeepSeek\'s key alone: never OpenAI\'s, nor any setting of OpenAI\'s (organisation, custom header)',
      heads.length >= 3 && heads.every((r) => r.auth === `Bearer ${DSKEY}` && !r.headers.includes('openai-organization') && !r.headers.includes('x-verify-leak')),
      JSON.stringify([...new Set(heads.map((r) => r.auth))].map((x) => x.replace(DSKEY, 'DSKEY').replace(KEY, 'OPENAI KEY'))));
    const replay = await stream(`${base}/api/evaluate`, { claims: [claim], text: source, jobId: jobT, cursor: 0, model: 'deepseek-v4-pro', effort: 'max' });
    check('Trial: DeepSeek\'s chain of thought reaches no page: no reasoning event in the stream or its replay from the start, nothing of it in done',
      replay.some((e) => e.t === 'done') && ![...t1, ...replay].some((e) => e.t === 'reasoning' || JSON.stringify(e).includes(COT)),
      JSON.stringify([...t1, ...replay].filter((e) => e.t === 'reasoning' || JSON.stringify(e).includes(COT)).slice(0, 2)));
    const tline = lines().find((l) => l.kind === 'trial' && l.provider === 'deepseek' && l.ok);
    const toolLine = lines().find((l) => l.kind === 'tool' && l.verb === 'search_web' && l.determination === jobT);
    check('Trial: its ledger line is a trial\'s (DeepSeek, V4 Pro at max, three rounds, one search, one page), its cost DeepSeek\'s tokens plus the search\'s own $0.005, which done carries too; the search\'s own line is filed under it',
      Boolean(tline) && tline.model === 'deepseek-v4-pro' && tline.effort === 'max' && tline.rounds === 3 && tline.searches === 1 && tline.reads === 1 && tline.toolUsd === 0.005 && tline.tokenUsd > 0
        && Math.abs(tline.usd - (tline.tokenUsd + tline.toolUsd)) < 0.0002 && done1?.cost?.usd === tline.usd && toolLine?.usd === 0.005,
      JSON.stringify({ line: tline && { rounds: tline.rounds, searches: tline.searches, reads: tline.reads, tokenUsd: tline.tokenUsd, toolUsd: tline.toolUsd, usd: tline.usd }, done: done1?.cost, tool: toolLine?.usd }));

    // Every refusal a wait: one trial each, in the order the stand-in was told.
    const trialRun = async (label) => { const before = (await dsStats()).requests; const evs = await evaluate({ model: 'deepseek-v4-pro', effort: 'max' }, label); return { evs, sends: (await dsStats()).requests - before }; };
    const w1 = await trialRun('429');
    const rr = w1.evs.find((e) => e.t === 'retry');
    check('Trial: a 429 from DeepSeek that names no wait is a wait of about a second, then the fact-check is delivered (four sends, no loop)',
      rr?.reason === 'rate_limit' && rr.waitMs >= 600 && rr.waitMs <= 1000 && w1.sends === 4 && w1.evs.filter((e) => e.t === 'done').length === 1, JSON.stringify({ retry: rr, sends: w1.sends }));
    const w2 = await trialRun('503');
    check('Trial: an overloaded DeepSeek (503) is tried again a second later, and the fact-check is delivered',
      w2.evs.some((e) => e.t === 'retry' && e.reason === 'error' && e.waitMs >= 600) && w2.sends === 4 && w2.evs.filter((e) => e.t === 'done').length === 1, JSON.stringify({ retries: w2.evs.filter((e) => e.t === 'retry'), sends: w2.sends }));
    const w3 = await trialRun('error-event');
    check('Trial: an error event in the middle of a round is read as that round\'s failure and the round goes again; delivered once',
      w3.evs.some((e) => e.t === 'retry') && w3.sends === 4 && w3.evs.filter((e) => e.t === 'done').length === 1 && !w3.evs.some((e) => e.t === 'error'), JSON.stringify({ retries: w3.evs.filter((e) => e.t === 'retry'), sends: w3.sends }));
    const w4 = await trialRun('closed');
    check('Trial: a round that stops before its last event is a cut connection and goes again; never an entry of nothing',
      w4.evs.some((e) => e.t === 'retry' && e.reason === 'connection') && w4.sends === 4 && w4.evs.filter((e) => e.t === 'done').length === 1 && (w4.evs.find((e) => e.t === 'done')?.text || '').length > 0,
      JSON.stringify({ retries: w4.evs.filter((e) => e.t === 'retry'), sends: w4.sends }));
    const w5 = await trialRun('402');
    const err5 = w5.evs.find((e) => e.t === 'error');
    const recent = (await (await fetch(`${base}/api/selftest`)).json()).recentFailures || [];
    const rec402 = recent.find((x) => x.where === 'trial:deepseek' && x.code === 'balance_exhausted');
    check('Trial: DeepSeek\'s balance used up (402) ends that fact-check with the code and no words of the provider\'s, and /check records DeepSeek\'s own',
      err5?.code === 'balance_exhausted' && err5.message === '' && /DeepSeek answered 402 \(Insufficient Balance\)/.test(rec402?.detail || '') && w5.sends === 1,
      JSON.stringify({ error: err5, record: rec402, sends: w5.sends }));

    // The effort the page opens on, when none is sent; and models outside the trial.
    const f1 = await evaluate({ model: 'deepseek-v4-pro' }, 'no-effort');
    const fb = dsBodies().slice(-1)[0]?.body;
    check('Trial: DeepSeek V4 Pro with no effort sent runs at high, the level the page opens on',
      f1.some((e) => e.t === 'done' && e.model === 'deepseek-v4-pro' && e.effort === 'high') && JSON.stringify(fb?.reasoning) === JSON.stringify({ effort: 'high' }) && fb?.model === 'deepseek-v4-pro',
      JSON.stringify({ done: f1.find((e) => e.t === 'done')?.effort, body: fb?.reasoning }));
    const beforeFlash = (await dsStats()).requests;
    const flash = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claims: [claim], text: source, jobId: `tr-flash-${stamp}`, model: 'deepseek-flash' }) });
    const flashBody = await flash.json().catch(() => ({}));
    check('Trial: DeepSeek V4.1 Flash is not a fact-checker (the operator\'s word of 18 October): asked for one, it is refused (400 trial_model) and nothing reaches DeepSeek',
      flash.status === 400 && flashBody?.error?.code === 'trial_model' && (await dsStats()).requests === beforeFlash, JSON.stringify({ status: flash.status, body: flashBody }));
    const beforeOdd = (await dsStats()).requests;
    const odd = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claims: [claim], text: source, jobId: `tr-odd-${stamp}`, model: 'deepseek-unknown' }) });
    const oddBody = await odd.json().catch(() => ({}));
    check('Trial: a model that is not one of the trial\'s is refused (400 trial_model) and nothing reaches DeepSeek',
      odd.status === 400 && oddBody?.error?.code === 'trial_model' && (await dsStats()).requests === beforeOdd, JSON.stringify({ status: odd.status, body: oddBody }));

    // Side by side: the readers' own model, asked for by the operator, is the readers' request, recorded as a trial.
    const s1 = await evaluate({ model: config.evalModels[0] }, 'twin');
    const twinBody = oaBodies()[1]?.body;
    check('Trial: side by side, the readers\' model runs the readers\' request exactly, and is delivered and recorded as a trial',
      s1.some((e) => e.t === 'done' && e.trial === true && e.provider === 'openai') && JSON.stringify(twinBody) === JSON.stringify(readerBody)
        && lines().some((l) => l.kind === 'trial' && l.provider === 'openai' && l.ok),
      JSON.stringify({ done: s1.find((e) => e.t === 'done')?.provider, same: JSON.stringify(twinBody) === JSON.stringify(readerBody) }));

    // The three fixes to OpenAI's loop, on the readers' own path.
    const e1 = await evaluate({}, 'openai-end-early');
    const d1 = e1.filter((e) => e.t === 'done');
    check('OpenAI: a reply that ends with no last event is a cut connection: the claim goes again and is delivered once, whole, never read as a finished entry',
      e1.some((e) => e.t === 'retry' && e.reason === 'connection') && d1.length === 1 && d1[0].verdictSource !== 'unread' && (d1[0].text || '').length > 200,
      JSON.stringify({ retries: e1.filter((e) => e.t === 'retry'), done: d1.map((d) => d.verdictSource) }));
    const e2 = await evaluate({}, 'openai-error-event');
    check('OpenAI: an error event in the middle of a reply (an overloaded server) is tried again, not a failed claim',
      e2.some((e) => e.t === 'retry' && e.reason === 'error') && e2.filter((e) => e.t === 'done').length === 1 && !e2.some((e) => e.t === 'error'),
      JSON.stringify({ retries: e2.filter((e) => e.t === 'retry'), errors: e2.filter((e) => e.t === 'error') }));
    const e3 = await evaluate({}, 'openai-cut-after-search');
    const d3 = e3.find((e) => e.t === 'done');
    const l3 = lines().filter((l) => l.kind === 'evaluate' && l.ok).slice(-1)[0];
    check('OpenAI: a claim taken up again after a cut keeps only the delivered go\'s searches and sources on its card, while the cost counts every search made',
      Boolean(d3) && d3.trail.length === 2 && d3.searches === 2 && d3.sources.length === new Set(d3.sources.map((x) => x.url)).size && l3?.searches === 4,
      JSON.stringify({ trail: d3?.trail?.length, searches: d3?.searches, line: l3?.searches }));

    // Out of the readers' figures, and in /check's trial table.
    const report = (await (await fetch(`${base}/api/selftest`)).json()).economics || {};
    const trow = (report.trial || []).find((x) => x.who === 'trial' && x.provider === 'deepseek' && x.model === 'deepseek-v4-pro' && x.effort === 'max');
    const rrow = (report.trial || []).find((x) => x.who === 'readers');
    check('Trial: the readers\' durations count the readers\' four determinations and none of the trial\'s; /check\'s trial table has V4 Pro at max (five delivered, one failed, one search and one page each) beside the readers\'',
      report.durations?.determinations?.n === 4 && trow?.n === 5 && trow.failed === 1 && trow.meanSearches === 1 && trow.meanReads === 1 && trow.meanUsd > 0 && rrow?.n === 4
        && (report.trial || []).some((x) => x.who === 'trial' && x.provider === 'openai') && (report.trial || []).some((x) => x.model === 'deepseek-v4-pro' && x.effort === 'high'),
      JSON.stringify({ durations: report.durations?.determinations?.n, trial: report.trial }));
    check('Trial: the chain of thought is in no ledger line and no failure record, and neither key is in the health line, the check data or the server\'s output',
      !fs.readFileSync(ledger, 'utf8').includes(COT) && !(fs.existsSync(errlog) ? fs.readFileSync(errlog, 'utf8') : '').includes(COT)
        && ![await (await fetch(`${base}/api/health`)).text(), await (await fetch(`${base}/api/selftest`)).text(), output.join('')].some((t) => t.includes(DSKEY) || t.includes(KEY) || t.includes(SKEY)), '');

    // Without the search service the trial cannot search, so it does not run.
    const baseC = serve(PORT + 98, { CIVIC_SEARCH_URL: '', CIVIC_SEARCH_KEY: '' });
    await wait(`${baseC}/api/health`);
    const hC = await (await fetch(`${baseC}/api/health`)).json();
    const beforeC = (await dsStats()).requests;
    const rC = await fetch(`${baseC}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claims: [claim], text: source, jobId: `tr-nosearch-${stamp}`, model: 'deepseek-v4-pro' }) });
    const bC = await rC.json().catch(() => ({}));
    const stC = await (await fetch(`${baseC}/api/selftest`)).json();
    check('Trial: without FactEngine\'s search service the trial is offered as unavailable with the reason, refused (503 trial_unavailable) and nothing reaches DeepSeek; /check warns, and is still ready for readers',
      hC.trial?.ready === false && /search service/.test(hC.trial?.why || '') && rC.status === 503 && bC?.error?.code === 'trial_unavailable' && (await dsStats()).requests === beforeC
        && stC.ready === true && (stC.checks || []).some((x) => x.state === 'warn' && x.title === 'Your trial on DeepSeek cannot run'),
      JSON.stringify({ trial: hC.trial, status: rC.status, body: bC, ready: stC.ready }));

    // With accounts on: the trial is the operator's alone, never charged; a reader's choice of model is ignored.
    const P = PORT + 99;
    const srv = accountServer(P, TMOCK2, { ...trialEnv(TMOCK2), CIVIC_OPERATOR_EMAILS: 'op@example.com', CIVIC_OPERATOR_CLAIM: claimHash(), CIVIC_LIST_PRICE_CENTS: '125', CIVIC_TIER_ORDER: '1' });
    procs.push(srv.child);
    await wait(`http://localhost:${P}/api/health`, 20000);
    const people = accountClient(`http://localhost:${P}`);
    const reader = (await people.signup('reader@example.com')).cookie;
    const op = (await people.json('/api/account/claim', { method: 'POST', body: { token: CLAIM_TOKEN, email: 'op@example.com', password: PASSWORD, agree: true } })).cookie;
    const hReader = (await people.json('/api/health', { cookie: reader })).body;
    const hOp = (await people.json('/api/health', { cookie: op })).body;
    check('Trial: a reader\'s health line offers no trial; the operator\'s does',
      hReader?.trial === null && hOp?.trial?.ready === true, JSON.stringify({ reader: hReader?.trial, operator: hOp?.trial?.ready }));
    const listAndTest = async (cookie, who, extra) => {
      const runId = `tr-${who}-run-${stamp}`;
      await people.stream('/api/extract', { jobId: runId, text: ACCT_TEXT }, cookie);
      return people.stream('/api/evaluate', { jobId: `tr-${who}-c1-${stamp}`, claims: ['The Eiffel Tower stands about 330 metres tall.'], text: ACCT_TEXT, runId, n: 1, ...extra }, cookie);
    };
    const rBal0 = await people.balance(reader);
    const dsBefore = (await dsStats(TMOCK2)).requests;
    const rt = await listAndTest(reader, 'reader', { model: 'deepseek-v4-pro', effort: 'max' });
    const rDone = rt.events.find((e) => e.t === 'done');
    const isDetermination = (x) => (x.body?.input || []).some((m) => (m.content || []).some((c) => evalMark ? String(c.text || '').includes(evalMark) : /^\s*Prompt\s*=/.test(String(c.text || ''))));
    const rBody = oaBodies(rec2).filter(isDetermination).slice(-1)[0]?.body;
    check('Trial: a reader who names DeepSeek gets the readers\' determination on OpenAI, unchanged and charged as always; nothing reaches DeepSeek',
      Boolean(rDone) && !rDone.trial && !rDone.provider && (await dsStats(TMOCK2)).requests === dsBefore && JSON.stringify(extraKeys(rBody, ALLOWED.evaluate)) === '[]' && rBody?.model === config.evalModels[0]
        && (await people.balance(reader)) === rBal0 - 125,
      JSON.stringify({ done: Boolean(rDone), trial: rDone?.trial, ds: (await dsStats(TMOCK2)).requests - dsBefore, balance: [rBal0, await people.balance(reader)] }));
    const oBal0 = await people.balance(op);
    const ot = await listAndTest(op, 'operator', { model: 'deepseek-v4-pro', effort: 'high' });
    const oDone = ot.events.find((e) => e.t === 'done');
    const quote = ot.events.find((e) => e.t === 'quote');
    check('Trial: the operator\'s own fact-check on DeepSeek is delivered and never charged (free of price, not one of the document\'s free ones, the balance as it was)',
      oDone?.provider === 'deepseek' && oDone.trial === true && quote?.free === false && quote?.priceCents === 0 && (await people.balance(op)) === oBal0,
      JSON.stringify({ done: oDone?.provider, quote, balance: [oBal0, await people.balance(op)] }));
  } catch (err) {
    check('Trial checks completed', false, err.stack || err.message);
  } finally {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
    site.close();
  }
}
await trialChecks();

// ---- the operator's trial on Gemini (18 October) ------------------------------------------------------------------
// "I want to test the new Gemini model using argon medium and argon high." Their answers: Google's own search and page
// reading; an entry per level; Gemini's summary of its thinking on its card. Proved against a stand-in Gemini (the
// /gemini routes of the stand-in, speaking Google's Interactions API): the offer, an entry per level; the request
// exactly (the model, the two messages a reader's determination carries, the level with the summary, Google's two tools,
// the stream, store: false) with the operator's Google key alone; the card's trail, sources and summary; the thought
// signature on no page or record; the books, Google's price for the day; every refusal a wait but the balance used up
// and a key refused; the two levels and no other; a reader's choice ignored and the operator's never charged; Gemini
// unable to run without its key while DeepSeek still runs; the key shown nowhere.
async function geminiChecks() {
  const GMOCK = MOCK_PORT + 100;
  const GMKEY = 'gm-verify-key-gemini-0000';   // made-up, and never in the shape of a real Google key
  const stamp = Date.now();
  const rec = path.join(os.tmpdir(), `civic-verify-gemini-${stamp}.jsonl`);
  const ledger = path.join(os.tmpdir(), `civic-verify-gemini-ledger-${stamp}.jsonl`);
  const errlog = path.join(os.tmpdir(), `civic-verify-gemini-errors-${stamp}.log`);
  fs.writeFileSync(rec, '');
  const read = () => fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const gmBodies = () => read().filter((r) => r.path === '/gemini/v1beta/interactions' && r.body);
  const oaBodies = () => read().filter((r) => r.path === '/v1/responses' && r.body);
  const gmStats = async () => (await fetch(`http://localhost:${GMOCK}/gemini/mock/stats`)).json();
  const lines = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const textOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const procs = [];
  const output = [];
  const gmEnv = {
    OPENAI_BASE_URL: `http://localhost:${GMOCK}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: ledger, CIVIC_ERROR_LOG: errlog,
    GEMINI_API_KEY: GMKEY, CIVIC_GEMINI_BASE_URL: `http://localhost:${GMOCK}/gemini`,
  };
  const serve = (port, env) => {
    const child = start([path.join(root, 'server', 'index.js')], { PORT: String(port), ...gmEnv, ...env });
    child.stdout.on('data', (d) => output.push(String(d)));
    child.stderr.on('data', (d) => output.push(String(d)));
    procs.push(child);
    return `http://localhost:${port}`;
  };
  // Ordinals at the stand-in Gemini: 1 the fact-check at high; 2 at medium; 3 a 429 naming a second, then 4; 5 a stream
  // closed with no event, then 6; 7 an error event mid-stream, then 8; 9 a 503, then 10; 11 a 402; 12 a 429 naming no
  // wait, at medium, then 13; 14 a 429 in the stream's own form, at medium, then 15; 16 a 429 at a limit of 0, at medium,
  // which ends that fact-check; 17 a refused key's; 18 the operator's own, with accounts on.
  const evalMark = process.env.MOCK_EVAL_MARK_FOR_GATE || '';
  start([path.join(root, 'scripts', 'mock-openai.js')], {
    MOCK_PORT: String(GMOCK), MOCK_RECORD: rec, MOCK_SPEED: '0.2', MOCK_EVAL_MARK: evalMark,
    MOCK_GM_429: '3', MOCK_GM_CLOSE: '5', MOCK_GM_ERROR_EVENT: '7', MOCK_GM_503: '9', MOCK_GM_402: '11', MOCK_GM_429_BARE: '12',
    MOCK_GM_429_SSE: '14', MOCK_GM_429_ZERO: '16',
  });
  try {
    await wait(`http://localhost:${GMOCK}/v1/responses`, 15000, { anyResponse: true });
    const base = serve(PORT + 100, { OPENAI_ORG_ID: 'org-verify-gemini', OPENAI_CUSTOM_HEADERS: 'X-Verify-Leak: yes', DEEPSEEK_API_KEY: 'sk-dsgemini000000000000000000000' });
    await wait(`${base}/api/health`);
    const health = await (await fetch(`${base}/api/health`)).json();
    const tr = health.trial || {};
    const gEntries = (tr.entries || []).filter((e) => e.model === 'gemini-4-argon');
    check('Gemini: the operator\'s page is offered Gemini 4 Argon twice, "· medium" and "· high", each level its own entry, ready on the operator\'s Google key; its request keys are the model, the input, generation_config, the tools, the stream and store, and store is false',
      JSON.stringify(gEntries.map((e) => [e.label, e.effort, e.fixed, e.ready])) === JSON.stringify([['Gemini 4 Argon · medium', 'medium', true, true], ['Gemini 4 Argon · high', 'high', true, true]])
        && JSON.stringify(health.request?.keys?.trialGemini) === JSON.stringify(['model', 'input', 'generation_config', 'tools', 'stream', 'store']) && health.request?.trialGemini?.store === false,
      JSON.stringify({ entries: tr.entries, keys: health.request?.keys?.trialGemini }));

    const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level.';
    const claim = 'The Eiffel Tower stands about 330 metres tall.';
    const evaluate = (extra = {}, label = 'x') => stream(`${base}/api/evaluate`, { claims: [claim], text: source, source: { kind: 'text' }, jobId: `gm-${label}-${stamp}`, ...extra });
    // A reader's determination first, for the two messages the trial must carry.
    await evaluate({}, 'reader');
    const readerBody = oaBodies()[0]?.body;

    const jobH = `gm-high-${stamp}`;
    const h1 = await stream(`${base}/api/evaluate`, { claims: [claim], text: source, source: { kind: 'text' }, jobId: jobH, model: 'gemini-4-argon', effort: 'high' });
    const d1 = h1.find((e) => e.t === 'done');
    const b1 = gmBodies()[0]?.body;
    check('Gemini: the operator\'s fact-check on Gemini 4 Argon at high is delivered, its verdict read, its trail two Google searches and a page read, its sources the cited pages once each, and Gemini\'s summary of its thinking on the card',
      d1?.provider === 'gemini' && d1.trial === true && d1.model === 'gemini-4-argon' && d1.effort === 'high' && d1.verdictSource !== 'unread'
        && JSON.stringify((d1.trail || []).map((s) => [s.kind, s.status])) === JSON.stringify([['search', 'completed'], ['search', 'completed'], ['open_page', 'completed']])
        && (d1.trail || []).slice(0, 2).every((s) => typeof s.query === 'string' && s.query.length > 0) && d1.trail[2].url === 'https://example.org/tower'
        && JSON.stringify((d1.sources || []).map((s) => s.url)) === JSON.stringify(['https://example.org/tower', 'https://example.org/second-source'])
        && /GMSUM-5b2e/.test(d1.reasoning || '') && d1.searches === 2 && !h1.some((e) => e.t === 'error'),
      JSON.stringify(d1 && { provider: d1.provider, effort: d1.effort, verdictSource: d1.verdictSource, trail: d1.trail, sources: d1.sources, reasoning: (d1.reasoning || '').slice(0, 40) }));
    check('Gemini: its request carries exactly the model, the input, generation_config {thinking_level: high, thinking_summaries: auto}, Google\'s search and URL context, stream and store: false (no output cap, sampling setting or system instruction)',
      Boolean(b1) && JSON.stringify(Object.keys(b1).sort()) === JSON.stringify(['generation_config', 'input', 'model', 'store', 'stream', 'tools']) && b1.model === 'gemini-4-argon'
        && JSON.stringify(b1.generation_config) === JSON.stringify({ thinking_level: 'high', thinking_summaries: 'auto' })
        && JSON.stringify(b1.tools) === JSON.stringify([{ type: 'google_search' }, { type: 'url_context' }]) && b1.stream === true && b1.store === false,
      JSON.stringify(b1 && { keys: Object.keys(b1), gen: b1.generation_config, tools: b1.tools, store: b1.store }));
    const saidIn = (steps) => (steps || []).map((s) => (s.content || []).map((c) => c.text).join(''));
    const readerSaid = saidIn(readerBody?.input);
    check('Gemini: its input is the two messages a reader\'s determination of the same claim carries, as Google\'s user_input steps: the source first, then the prompt verbatim',
      Boolean(b1) && readerSaid.length === 2 && (b1.input || []).every((s) => s.type === 'user_input' && (s.content || []).every((c) => c.type === 'text'))
        && JSON.stringify(saidIn(b1.input)) === JSON.stringify(readerSaid),
      `${JSON.stringify(saidIn(b1?.input)).length} vs ${JSON.stringify(readerSaid).length} chars`);
    const heads = read().filter((r) => r.gemini && r.method === 'POST');
    check('Gemini: Google got the operator\'s Gemini key alone, in x-goog-api-key: no Authorization header, and nothing of OpenAI\'s (organisation, custom header)',
      heads.length >= 1 && heads.every((r) => r.key === GMKEY && r.auth === '' && !r.headers.includes('openai-organization') && !r.headers.includes('x-verify-leak')),
      JSON.stringify([...new Set(heads.map((r) => `${r.key === GMKEY ? 'GMKEY' : r.key ? 'OTHER' : 'none'}|${r.auth ? 'auth' : ''}`))]));
    const replay = await stream(`${base}/api/evaluate`, { claims: [claim], text: source, jobId: jobH, cursor: 0, model: 'gemini-4-argon', effort: 'high' });
    check('Gemini: its thought signature reaches no page (not the stream, not its replay from the start, not done), while its summary does, as the readers\' model\'s',
      replay.some((e) => e.t === 'done') && ![...h1, ...replay].some((e) => JSON.stringify(e).includes('GMSIG')) && h1.some((e) => e.t === 'reasoning' && /GMSUM-5b2e/.test(e.text || '')),
      JSON.stringify([...h1, ...replay].filter((e) => JSON.stringify(e).includes('GMSIG')).slice(0, 2)));
    const l1 = lines().find((l) => l.kind === 'trial' && l.provider === 'gemini' && l.ok && l.effort === 'high');
    const [pin, pout] = Date.now() < Date.parse('2026-12-01T00:00:00Z') ? [2, 10] : [4, 20];
    check('Gemini: its ledger line is a trial\'s (Gemini 4 Argon at high, two searches, a page), its thinking counted as output and the page read as input, priced at Google\'s rate for the day plus $14 per 1,000 searches, which done carries too',
      Boolean(l1) && l1.model === 'gemini-4-argon' && l1.searches === 2 && l1.reads === 1 && l1.usage?.reasoning === 900 && l1.usage.output > 900 && l1.usage.input > 1200
        && l1.searchUsd === 0.028 && Math.abs(l1.tokenUsd - (l1.usage.input * pin + l1.usage.output * pout) / 1e6) < 0.0002 && Math.abs(l1.usd - (l1.tokenUsd + l1.searchUsd)) < 0.0002
        && l1.priced === true && d1?.cost?.usd === l1.usd,
      JSON.stringify(l1 && { usage: l1.usage, searches: l1.searches, reads: l1.reads, tokenUsd: l1.tokenUsd, searchUsd: l1.searchUsd, usd: l1.usd, done: d1?.cost }));

    const m1 = await evaluate({ model: 'gemini-4-argon', effort: 'medium' }, 'medium');
    const b2 = gmBodies().slice(-1)[0]?.body;
    check('Gemini: the medium entry sends thinking_level medium, and is delivered at medium',
      m1.some((e) => e.t === 'done' && e.provider === 'gemini' && e.effort === 'medium') && b2?.generation_config?.thinking_level === 'medium', JSON.stringify(b2?.generation_config));

    // Every refusal a wait, but the balance used up: one fact-check each, in the order the stand-in was told.
    const gmRun = async (label) => { const before = (await gmStats()).requests; const evs = await evaluate({ model: 'gemini-4-argon', effort: 'high' }, label); return { evs, sends: (await gmStats()).requests - before }; };
    const t429 = Date.now();
    const w1 = await gmRun('429');
    const t429end = Date.now();
    const rr = w1.evs.find((e) => e.t === 'retry');
    check('Gemini: a 429 is a wait for the second Google names (its RetryInfo), then the fact-check is delivered',
      rr?.reason === 'rate_limit' && rr.status === 429 && rr.waitMs === 1000 && w1.sends === 2 && w1.evs.filter((e) => e.t === 'done').length === 1, JSON.stringify({ retry: rr, sends: w1.sends }));
    check('Gemini: its wait says whose it is (Google), until when, and why, in Google\'s own words on one line of at most 300 characters, with the key taken out (the operator\'s answer of 18 October: "Say why and keep waiting")',
      rr?.who === 'Google' && /GMWAIT-7f3a/.test(rr.why || '') && /limit: 25, model: gemini-4-argon/.test(rr.why) && rr.why.includes('<key>') && !rr.why.includes(GMKEY) && rr.why.length <= 300 && !/\n/.test(rr.why)
        && Number.isFinite(rr.until) && rr.until >= t429 + rr.waitMs && rr.until <= t429end + rr.waitMs,
      JSON.stringify(rr));
    const recentWait = (await (await fetch(`${base}/api/selftest`)).json()).recentFailures || [];
    const recWait = recentWait.find((x) => x.where === 'trial:gemini' && x.code === 'rate_limited');
    const gemLog = output.join('').split('\n').filter((l) => l.startsWith('[gemini] '));
    check('Gemini: Google\'s words for a wait are kept on /check (rate_limited, the model, its level and the wait) and in the service\'s log as one line, with no key in either',
      recWait?.status === 429 && recWait.message === 'Google asked gemini-4-argon at high to wait 1 s (refusal 1 of this fact-check).' && /GMWAIT-7f3a/.test(recWait.detail || '') && !JSON.stringify(recWait).includes(GMKEY)
        && gemLog.length === 1 && /^\[gemini\] Google asked gemini-4-argon at high to wait 1 s \(refusal 1 of this fact-check\): "You exceeded your current quota.*GMWAIT-7f3a.*"$/.test(gemLog[0]) && !gemLog[0].includes(GMKEY),
      JSON.stringify({ record: recWait, log: gemLog }));
    const w2 = await gmRun('closed');
    check('Gemini: a reply that stops before its last event is a cut connection and goes again; delivered once, whole, with its own trail',
      w2.evs.some((e) => e.t === 'retry' && e.reason === 'connection') && w2.sends === 2 && w2.evs.filter((e) => e.t === 'done').length === 1 && (w2.evs.find((e) => e.t === 'done')?.trail || []).length === 3,
      JSON.stringify({ retries: w2.evs.filter((e) => e.t === 'retry'), sends: w2.sends }));
    const w3 = await gmRun('error-event');
    check('Gemini: an error event in the middle of a reply (the model overloaded) goes again, the card started again; delivered once',
      w3.evs.some((e) => e.t === 'retry' && e.reason === 'error' && e.status === 503) && w3.sends === 2 && w3.evs.filter((e) => e.t === 'done').length === 1
        && w3.evs.filter((e) => e.t === 'start').length === 2 && !w3.evs.some((e) => e.t === 'error'),
      JSON.stringify({ retries: w3.evs.filter((e) => e.t === 'retry'), sends: w3.sends }));
    const w4 = await gmRun('503');
    check('Gemini: an overloaded Gemini (503) is tried again, and the fact-check is delivered',
      w4.evs.some((e) => e.t === 'retry' && e.reason === 'error' && e.status === 503) && w4.sends === 2 && w4.evs.filter((e) => e.t === 'done').length === 1,
      JSON.stringify({ retries: w4.evs.filter((e) => e.t === 'retry'), sends: w4.sends }));
    const w5 = await gmRun('402');
    const err5 = w5.evs.find((e) => e.t === 'error');
    const recent = (await (await fetch(`${base}/api/selftest`)).json()).recentFailures || [];
    const rec402 = recent.find((x) => x.where === 'trial:gemini' && x.code === 'balance_exhausted');
    check('Gemini: the prepaid balance used up (402) ends that fact-check at once, with the code and no words of the provider\'s, and /check records Google\'s own with where to add credits',
      err5?.code === 'balance_exhausted' && err5.message === '' && /prepayment credits are depleted/.test(rec402?.detail || '') && /Google AI Studio, Billing/.test(rec402?.detail || '') && w5.sends === 1,
      JSON.stringify({ error: err5, record: rec402, sends: w5.sends }));

    // A 429 that names no wait at all (no RetryInfo, no Retry-After), at medium so the high row below keeps its count.
    const tBare = Date.now();
    const beforeBare = (await gmStats()).requests;
    const w6 = await evaluate({ model: 'gemini-4-argon', effort: 'medium' }, '429-bare');
    const sendsBare = (await gmStats()).requests - beforeBare;
    const rb = w6.find((e) => e.t === 'retry');
    const bareAt = read().filter((r) => r.gemini && r.method === 'POST' && r.path === '/gemini/v1beta/interactions' && r.ts >= tBare).map((r) => r.ts);
    const gap = bareAt.length >= 2 ? bareAt[1] - bareAt[0] : null;
    check('Gemini: a 429 that names no wait goes again a second after its go began, never at once (a missing Retry-After read as a wait of none, Number(null) being 0, would ask again and again inside the second); then the fact-check is delivered',
      rb?.reason === 'rate_limit' && rb.who === 'Google' && rb.waitMs >= 500 && rb.waitMs <= 1000 && sendsBare === 2 && gap >= 900 && w6.filter((e) => e.t === 'done').length === 1,
      JSON.stringify({ retry: rb, sends: sendsBare, gap }));

    // A 429 in the stream's own form, as Google sent one on 19 October ("event: error" then "data: {…}"), at medium.
    const beforeSse = (await gmStats()).requests;
    const w7 = await evaluate({ model: 'gemini-4-argon', effort: 'medium' }, '429-stream');
    const sendsSse = (await gmStats()).requests - beforeSse;
    const rs = w7.find((e) => e.t === 'retry');
    check('Gemini: a refusal sent in the stream\'s own form is read for its JSON: the card carries Google\'s sentence alone (no "event:", no "data:", no braces), the wait is the Retry-After header\'s, and the fact-check is delivered after it',
      rs?.reason === 'rate_limit' && rs.who === 'Google' && rs.why === 'Rate limit exceeded for model gemini-4-argon (limit: 25 input tokens per minute on Tier 1). GMSSE-3e1b'
        && rs.waitMs === 1000 && sendsSse === 2 && w7.filter((e) => e.t === 'done').length === 1,
      JSON.stringify({ retry: rs, sends: sendsSse }));

    // A 429 at a limit of 0 (the key's project on a tier without the model): no wait, at medium (the operator's answer of
    // 19 October: "Stop and say why").
    const beforeZero = (await gmStats()).requests;
    const w8 = await evaluate({ model: 'gemini-4-argon', effort: 'medium' }, '429-zero');
    const sendsZero = (await gmStats()).requests - beforeZero;
    const ez = w8.find((e) => e.t === 'error');
    check('Gemini: a 429 whose words give a limit of 0 ends the fact-check at once, without a wait: one request, no retry, the code tier_refused, and Google\'s sentence on the card as Google\'s, its key taken out',
      sendsZero === 1 && !w8.some((e) => e.t === 'retry') && !w8.some((e) => e.t === 'done') && ez?.code === 'tier_refused' && ez.who === 'Google'
        && /^Rate limit exceeded for model gemini-4-argon \(limit: 0 input tokens per minute on Free Tier\)\. Please upgrade your tier at https:\/\/ai\.dev\/rate-limit\. GMZERO-8d4c/.test(ez.message || '')
        && ez.message.includes('<key>') && !ez.message.includes(GMKEY) && !/event:|data:|[{}]/.test(ez.message),
      JSON.stringify({ error: ez, sends: sendsZero, retries: w8.filter((e) => e.t === 'retry').length }));
    const recentZero = (await (await fetch(`${base}/api/selftest`)).json()).recentFailures || [];
    const recZero = recentZero.find((x) => x.where === 'trial:gemini' && x.code === 'tier_refused');
    const zeroLog = output.join('').split('\n').filter((l) => l.startsWith('[gemini] Google refused '));
    const zeroLine = lines().find((l) => l.kind === 'trial' && l.provider === 'gemini' && l.ok === false && l.code === 'tier_refused');
    check('Gemini: that refusal is kept on /check (tier_refused, Google\'s words and where to see the key\'s project), in the log as one line, and in the ledger as a failed trial at medium, with no key anywhere',
      /GMZERO-8d4c/.test(recZero?.detail || '') && /Google AI Studio/.test(recZero?.detail || '') && !JSON.stringify(recZero).includes(GMKEY)
        && zeroLog.length === 1 && /^\[gemini\] Google refused gemini-4-argon at medium outright, its limit for this key being 0: "Rate limit exceeded .*GMZERO-8d4c.*"$/.test(zeroLog[0]) && !zeroLog[0].includes(GMKEY)
        && zeroLine?.effort === 'medium' && zeroLine.model === 'gemini-4-argon',
      JSON.stringify({ record: recZero, log: zeroLog, ledger: zeroLine }));

    // The operator's two levels, and no other.
    const beforeLevels = (await gmStats()).requests;
    const asks = [];
    for (const x of [{ effort: 'low' }, {}, { effort: 'max' }]) {
      const r = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claims: [claim], text: source, jobId: `gm-level-${x.effort || 'none'}-${stamp}`, model: 'gemini-4-argon', ...x }) });
      asks.push({ status: r.status, code: (await r.json().catch(() => ({})))?.error?.code });
    }
    check('Gemini: only the operator\'s two levels run: low, none and max are each refused (400 trial_effort), and nothing reaches Gemini',
      asks.every((a) => a.status === 400 && a.code === 'trial_effort') && (await gmStats()).requests === beforeLevels, JSON.stringify(asks));

    // /check: the trial's rows, the settings, and the trial table.
    const st = await (await fetch(`${base}/api/selftest`)).json();
    const row = (re) => (st.checks || []).find((c) => re.test(c.title));
    check('Gemini: /check says the trial on Gemini can run and that Google serves gemini-4-argon to this key (asked without a token); its settings line names both levels',
      row(/^Your trial on Gemini can run$/)?.state === 'ok' && row(/^Gemini serves gemini-4-argon to this key$/)?.state === 'ok'
        && /Gemini 4 Argon · medium; Gemini 4 Argon · high/.test(st.settings?.trialModels || '') && st.ready === true,
      JSON.stringify({ rows: (st.checks || []).filter((c) => /Gemini/.test(c.title)).map((c) => [c.state, c.title]), settings: st.settings?.trialModels }));
    const report = st.economics || {};
    const grow = (report.trial || []).find((x) => x.who === 'trial' && x.provider === 'gemini' && x.model === 'gemini-4-argon' && x.effort === 'high');
    check('Gemini: /check\'s trial table has Gemini 4 Argon at high (five delivered, one failed, two searches and a page each), kept out of the readers\' figures',
      grow?.n === 5 && grow.failed === 1 && grow.meanSearches === 2 && grow.meanReads === 1 && grow.meanUsd > 0 && report.durations?.determinations?.n === 1,
      JSON.stringify({ row: grow, readers: report.durations?.determinations?.n }));
    check('Gemini: the key is in no health line, check data, ledger line, failure record or the server\'s output, and the thought signature in no ledger line or failure record',
      ![await (await fetch(`${base}/api/health`)).text(), JSON.stringify(st), textOf(ledger), textOf(errlog), output.join('')].some((t) => t.includes(GMKEY))
        && !textOf(ledger).includes('GMSIG') && !textOf(errlog).includes('GMSIG'),
      '');

    // The price Google set for Argon changes on 1 December 2026 (UTC); a call is priced at the moment it went.
    const { estimateTextCost } = await import(`${pathToFileURL(path.join(root, 'server', 'pricing.js')).href}?gm=${stamp}`);
    const million = { input: 1_000_000, cached: 0, output: 1_000_000 };
    check('Gemini: Argon is priced $2 in and $10 out a million through 30 November 2026, $4 and $20 from 1 December, and $14 per 1,000 Google searches',
      estimateTextCost({ model: 'gemini-4-argon', usage: million, at: Date.parse('2026-11-30T23:59:59Z') }).usd === 12
        && estimateTextCost({ model: 'gemini-4-argon', usage: million, at: Date.parse('2026-12-01T00:00:00Z') }).usd === 24
        && estimateTextCost({ model: 'gemini-4-argon', usage: { input: 0, cached: 0, output: 0 }, searches: 1000, at: Date.parse('2026-10-18T00:00:00Z') }).usd === 14,
      '');

    // Without its key Gemini cannot run, and says so; DeepSeek V4 Pro still runs.
    const baseB = serve(PORT + 101, { GEMINI_API_KEY: '', CIVIC_SEARCH_URL: 'http://127.0.0.1:9/search', CIVIC_SEARCH_KEY: 'search-key-gemini-verify', DEEPSEEK_API_KEY: 'sk-dsgemini000000000000000000000' });
    await wait(`${baseB}/api/health`);
    const hB = await (await fetch(`${baseB}/api/health`)).json();
    const beforeB = (await gmStats()).requests;
    const rB = await fetch(`${baseB}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claims: [claim], text: source, jobId: `gm-nokey-${stamp}`, model: 'gemini-4-argon', effort: 'high' }) });
    const bB = await rB.json().catch(() => ({}));
    const stB = await (await fetch(`${baseB}/api/selftest`)).json();
    check('Gemini: without GEMINI_API_KEY its two entries are offered as unable to run, saying why, while DeepSeek V4 Pro runs; a request for it is refused (503 trial_unavailable) and nothing reaches Gemini; /check warns, and is ready for readers',
      (hB.trial?.entries || []).filter((e) => e.model === 'gemini-4-argon').length === 2 && (hB.trial?.entries || []).filter((e) => e.model === 'gemini-4-argon').every((e) => e.ready === false && /GEMINI_API_KEY is not set/.test(e.why || ''))
        && (hB.trial?.entries || []).find((e) => e.model === 'deepseek-v4-pro')?.ready === true && hB.trial?.ready === true
        && rB.status === 503 && bB?.error?.code === 'trial_unavailable' && (await gmStats()).requests === beforeB
        && stB.ready === true && (stB.checks || []).some((x) => x.state === 'warn' && x.title === 'Your trial on Gemini cannot run'),
      JSON.stringify({ entries: hB.trial?.entries, status: rB.status, body: bB }));

    // A key Google refuses.
    const baseC = serve(PORT + 102, { GEMINI_API_KEY: 'gm-bad-key-verify-0000' });
    await wait(`${baseC}/api/health`);
    const eC = await stream(`${baseC}/api/evaluate`, { claims: [claim], text: source, jobId: `gm-badkey-${stamp}`, model: 'gemini-4-argon', effort: 'high' });
    const errC = eC.find((e) => e.t === 'error');
    const stC = await (await fetch(`${baseC}/api/selftest`)).json();
    check('Gemini: a key Google refuses (401) ends the fact-check with FactEngine\'s own sentence and is not tried again; /check says Google rejected the key, in its words, and shows no key',
      errC?.code === 'invalid_key' && errC.message === '' && !eC.some((e) => e.t === 'retry')
        && (stC.recentFailures || []).some((x) => x.where === 'trial:gemini' && /Gemini rejected the key in GEMINI_API_KEY \(401: API key not valid/.test(x.detail || ''))
        && (stC.checks || []).some((x) => x.state === 'warn' && x.title === 'Gemini could not be asked for gemini-4-argon') && !JSON.stringify(stC).includes('gm-bad-key-verify'),
      JSON.stringify({ error: errC, rows: (stC.checks || []).filter((c) => /Gemini/.test(c.title)).map((c) => [c.state, c.title, c.detail]) }));

    // With accounts on: a reader's choice of Gemini is ignored; the operator's own fact-check there is never charged.
    const P = PORT + 103;
    const srv = accountServer(P, GMOCK, { ...gmEnv, CIVIC_LEDGER_FILE: path.join(os.tmpdir(), `civic-verify-gemini-acct-ledger-${stamp}.jsonl`), CIVIC_OPERATOR_EMAILS: 'op@example.com', CIVIC_OPERATOR_CLAIM: claimHash(), CIVIC_LIST_PRICE_CENTS: '125', CIVIC_TIER_ORDER: '1' });
    procs.push(srv.child);
    await wait(`http://localhost:${P}/api/health`, 20000);
    const people = accountClient(`http://localhost:${P}`);
    const reader = (await people.signup('reader@example.com')).cookie;
    const op = (await people.json('/api/account/claim', { method: 'POST', body: { token: CLAIM_TOKEN, email: 'op@example.com', password: PASSWORD, agree: true } })).cookie;
    const listAndTest = async (cookie, who, extra) => {
      const runId = `gm-${who}-run-${stamp}`;
      await people.stream('/api/extract', { jobId: runId, text: ACCT_TEXT }, cookie);
      return people.stream('/api/evaluate', { jobId: `gm-${who}-c1-${stamp}`, claims: ['The Eiffel Tower stands about 330 metres tall.'], text: ACCT_TEXT, runId, n: 1, ...extra }, cookie);
    };
    const rBal0 = await people.balance(reader);
    const gmBefore = (await gmStats()).requests;
    const rt = await listAndTest(reader, 'reader', { model: 'gemini-4-argon', effort: 'high' });
    const rDone = rt.events.find((e) => e.t === 'done');
    check('Gemini: a reader who names Gemini gets the readers\' determination on OpenAI, charged as always; nothing reaches Gemini',
      Boolean(rDone) && !rDone.trial && !rDone.provider && (await gmStats()).requests === gmBefore && (await people.balance(reader)) === rBal0 - 125,
      JSON.stringify({ done: Boolean(rDone), trial: rDone?.trial, gemini: (await gmStats()).requests - gmBefore, balance: [rBal0, await people.balance(reader)] }));
    const oBal0 = await people.balance(op);
    const ot = await listAndTest(op, 'operator', { model: 'gemini-4-argon', effort: 'medium' });
    const oDone = ot.events.find((e) => e.t === 'done');
    const quote = ot.events.find((e) => e.t === 'quote');
    check('Gemini: the operator\'s own fact-check on Gemini is delivered and never charged (free of price, not one of the document\'s free ones, the balance as it was)',
      oDone?.provider === 'gemini' && oDone.trial === true && oDone.effort === 'medium' && quote?.free === false && quote?.priceCents === 0 && (await people.balance(op)) === oBal0,
      JSON.stringify({ done: oDone?.provider, quote, balance: [oBal0, await people.balance(op)] }));
  } catch (err) {
    check('Gemini checks completed', false, err.stack || err.message);
  } finally {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  }
}
await geminiChecks();

// ---- the second pass: the claims a document rests on, the top quarter shown, an empirical headline first (16 October) ----
// The operator's rules: a claim that is not empirical is set aside; the empirical ones are force-ranked by how far the
// article would change, in its meaning and its worth, were each one false; the headline, when it is an empirical
// statement, is "the first fact tested"; "I only want the top 25% of the most important claims". The stand-in DeepSeek
// ranks by a rule of its own (the last listed first, claim 2 set aside) and takes each case from a mark in the document.
// The ranking prompt here is the guard's own stand-in, never the operator's.
async function rankChecks() {
  const RMOCK = MOCK_PORT + 60;
  const DSKEY = 'sk-dsrank000000000000000000000000';
  const MARK = 'RANKMOCK-9c1e';
  const SUMMARY_MARK = 'RANKSUM-4d2a';
  const COT = 'DSCOT-7f3a';
  const RANK_PROMPT = `${MARK} The guard's own stand-in for the second pass, never the operator's.\nTitle given: {{TITLE}}\nNumbered claims:\n{{CLAIMS}}\nAnswer under the six headings this test reads.\n`;
  const RANK_VERSION = crypto.createHash('sha256').update(RANK_PROMPT).digest('hex').slice(0, 8);
  const stamp = Date.now();
  const ledger = path.join(os.tmpdir(), `civic-verify-rank-ledger-${stamp}.jsonl`);
  const errlog = path.join(os.tmpdir(), `civic-verify-rank-errors-${stamp}.log`);
  const stats = async () => (await fetch(`http://localhost:${RMOCK}/deepseek/mock/stats`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  const procs = [];
  const output = [];   // the first server's log, for its [listing] and [rank] lines
  const dsEnv = { CIVIC_EXTRACT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: DSKEY, CIVIC_DEEPSEEK_BASE_URL: `http://localhost:${RMOCK}/deepseek`, CIVIC_PROMPT_RANK: RANK_PROMPT, CIVIC_RANK: 'operator' };
  const serve = (port, env = {}) => {
    const child = start([path.join(root, 'server', 'index.js')], {
      PORT: String(port), OPENAI_BASE_URL: `http://localhost:${RMOCK}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false',
      CIVIC_LEDGER_FILE: ledger, CIVIC_ERROR_LOG: errlog, DATABASE_URL: '', ...dsEnv, ...env,
    });
    if (!procs.length) child.stdout.on('data', (d) => output.push(String(d)));
    procs.push(child);
    return `http://localhost:${port}`;
  };
  // Thirteen sentences of over 25 characters: the stand-in lists thirteen claims, sets claim 2 aside and ranks twelve, a
  // quarter of which, rounded up, is three. A case's mark goes inside the first sentence, so the count never changes.
  const SENTENCES = [
    'The moon pulls the tides twice a day around the world.', 'Some people find the full moon beautiful above the sea.',
    'The moon orbits the Earth once every 27.3 days on average.', 'The moon is about 384,400 kilometres from the Earth.',
    'Apollo 11 landed on the moon on 20 July 1969.', 'Two astronauts walked on the lunar surface that day.',
    'The far side of the moon was first photographed in 1959.', 'Luna 3 took those first pictures of the far side.',
    'The surface gravity of the moon is about one sixth of the Earth\'s.', 'The moon has no global magnetic field like the Earth\'s.',
    'Its day and its night each last about two Earth weeks.', 'The largest crater on the near side is called Bailly.',
    'Lunar dust clings to suits and equipment by static charge.',
  ];
  const doc = (mark = '') => SENTENCES.map((x, i) => (i === 0 && mark ? x.replace(/\.$/, ` [rank:${mark}].`) : x)).join(' ');
  const META = { kind: 'link', url: 'https://news.example.org/2026/moon-tides', title: 'The moon pulls the tides twice a day around the world | The Stand-in Gazette', site: 'The Stand-in Gazette' };
  const HEADLINE = 'The moon pulls the tides twice a day around the world';
  const WANT = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 1];   // the stand-in's order: the last listed first, claim 2 set aside
  const list = async (base, mark, extra = {}) => {
    const jobId = `rank-${mark || 'base'}-${stamp}-${Math.random().toString(36).slice(2, 7)}`;
    const before = (await stats()).requests;
    const events = await stream(`${base}/api/extract`, { text: doc(mark), jobId, source: META, ...extra });
    return { jobId, events, done: events.find((e) => e.t === 'done'), sends: (await stats()).requests - before };
  };
  // Request ordinals at the stand-in DeepSeek: 1 and 2 the first run's listing and ranking; 3 a listing, 4 its ranking
  // refused with a 429 that names no wait, 5 the ranking again; 6 a listing, 7 its ranking closed before its first event,
  // 8 the ranking again. Everything after is clean.
  start([path.join(root, 'scripts', 'mock-openai.js')], {
    MOCK_PORT: String(RMOCK), MOCK_SPEED: '0.2', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '', MOCK_RANK_MARK: MARK,
    MOCK_DS_429: '4', MOCK_DS_CLOSE: '7',
  });
  try {
    await wait(`http://localhost:${RMOCK}/v1/responses`, 15000, { anyResponse: true });
    const base = serve(PORT + 71);
    await wait(`${base}/api/health`);
    const health = await (await fetch(`${base}/api/health`)).json();
    const rq = health.request?.rank || {};
    check('Ranking: the health line says the claims are ranked for the operator\'s runs on the listing\'s own model (deepseek-flash at high), the top 25% shown, with no search; its request keys are model, input, reasoning and stream',
      rq.mode === 'operator' && rq.model === 'deepseek-flash' && rq.effort === 'high' && rq.keepPercent === 25 && rq.webSearch === false
        && JSON.stringify(health.request?.keys?.rank) === JSON.stringify(['model', 'input', 'reasoning', 'stream']) && health.prompts?.rank === true,
      JSON.stringify({ rank: rq, keys: health.request?.keys?.rank, prompts: health.prompts }));

    const a = await list(base, '');
    const s1 = await stats();
    const body = s1.lastRankBody;
    check('Ranking: a listing makes two requests to DeepSeek, the listing and then the ranking, and completes',
      a.sends === 2 && s1.rankRequests === 1 && Boolean(a.done) && !a.events.some((e) => e.t === 'error'), JSON.stringify({ sends: a.sends, rank: s1.rankRequests }));
    const said = output.join('');
    const logged = said.split('\n').filter((l) => /^\[(listing|rank)\] /.test(l));
    check('Ranking: the service\'s log says where the listing\'s time and the ranking\'s went, one line each, in counts and times alone (18 October: five minutes, and nothing said how much was thinking): the claims, the characters, the seconds, the model at its effort, how long it thought before it wrote, its tokens of thinking and of writing; never a word of the document, the prompt or the chain of thought',
      /\[listing\] 13 claims from [\d,]+ characters in \d+ s on deepseek-flash at high: it thought \d+ s before it wrote; [\d,]+ tokens of thinking and [\d,]+ written/.test(said)
        && /\[rank\] 13 claims ranked in \d+ s on deepseek-flash at high, 3 shown: it thought \d+ s before it wrote; [\d,]+ tokens of thinking and [\d,]+ written/.test(said)
        && !SENTENCES.some((x) => logged.some((l) => l.includes(x.slice(0, 24)))) && !said.includes(MARK) && !said.includes(COT) && !said.includes(SUMMARY_MARK),
      JSON.stringify(logged));
    check('Ranking: its body carries exactly the model, the input, reasoning {effort: high} and stream: no tools, no store, no mode or summary',
      Boolean(body) && JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['input', 'model', 'reasoning', 'stream']) && JSON.stringify(body.reasoning) === JSON.stringify({ effort: 'high' })
        && body.model === 'deepseek-flash' && body.stream === true,
      JSON.stringify(body && { keys: Object.keys(body), reasoning: body.reasoning }));
    const listed = a.done?.claims || [];
    const block = listed.map((c) => `${c.n}. ${String(c.entry).trim()}`).join('\n\n');
    const expectPrompt = RANK_PROMPT.replace('{{TITLE}}', META.title).replace('{{CLAIMS}}', block);
    const [m0, m1] = (body?.input || []).map((m) => (m.content || []).map((c) => c.text || '').join(''));
    check('Ranking: the source goes first, exactly as a determination is given it (the page\'s title, site and address, then the text); the prompt second, verbatim but for its two slots: the headline as published, and each claim\'s number with its whole entry',
      body?.input?.length === 2 && body.input.every((m) => m.role === 'user') && m0 === sourceBlock(doc(''), META) && m1 === expectPrompt && !m1.includes('{{'),
      JSON.stringify({ messages: body?.input?.length, first: m0?.slice(0, 90), second: m1?.slice(0, 160) }));
    const r = a.done?.ranking;
    check('Ranking: the claims come back in the model\'s order with the one it found not empirical set aside; a quarter of the twelve ranked, rounded up, three, is what the page shows; the listing\'s own thirteen claims are unchanged',
      r?.ok === true && JSON.stringify(r.order) === JSON.stringify(WANT) && r.keep === 3 && r.ranked === 12 && JSON.stringify(r.notEmpirical) === JSON.stringify([2]) && r.missing === 0
        && listed.length === 13 && a.done.total === 13,
      JSON.stringify(r && { order: r.order, keep: r.keep, ranked: r.ranked, notEmpirical: r.notEmpirical, claims: listed.length }));
    check('Ranking: the headline, an empirical statement copied word for word from the page\'s title, is tested first',
      r?.headline?.kind === 'empirical' && r.headline.tested === true && r.headline.text === HEADLINE, JSON.stringify(r?.headline));
    const startEv = a.events.find((e) => e.t === 'start');
    const phaseEv = a.events.find((e) => e.t === 'phase' && e.phase === 'ranking');
    const streamed = a.events.filter((e) => e.t === 'summary').map((e) => e.delta || '').join('');
    const iDone = a.events.findIndex((e) => e.t === 'done');
    check('Ranking: the page is told at the start that the claims will be ranked, then when the ranking begins (with the count); the summary arrives as it is written, before done, and is the summary done carries',
      startEv?.rank === true && phaseEv?.claims === 13 && a.events.findIndex((e) => e.t === 'summary') < iDone && streamed.trim() === r?.summary && String(r?.summary).startsWith(SUMMARY_MARK),
      JSON.stringify({ start: startEv?.rank, phase: phaseEv, streamed, summary: r?.summary }));
    const replay = await stream(`${base}/api/extract`, { text: doc(''), jobId: a.jobId, cursor: 0, source: META });
    check('Ranking: the model\'s chain of thought reaches no page, in the stream or in its replay from the start, and no word of the ranking prompt reaches one either',
      replay.some((e) => e.t === 'done' && e.ranking?.ok) && ![...a.events, ...replay].some((e) => JSON.stringify(e).includes(COT)) && ![...a.events, ...replay].some((e) => JSON.stringify(e).includes(MARK)),
      JSON.stringify(replay.map((e) => e.t)));
    const lines = () => fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const rankLine = lines().find((l) => l.kind === 'rank' && l.run === a.jobId);
    check('Ranking: its ledger line is its own (kind rank, beside the listing\'s), on the run, priced at DeepSeek\'s rate for the hour, with its tokens, its time and what it found; no chain of thought in the ledger',
      Boolean(rankLine) && rankLine.provider === 'deepseek' && rankLine.model === 'deepseek-flash' && rankLine.effort === 'high' && rankLine.claims === 13 && rankLine.ranked === 12 && rankLine.kept === 3
        && rankLine.notEmpirical === 1 && rankLine.headline === 'empirical' && rankLine.headlineTested === true && rankLine.priced === true && rankLine.usd > 0 && rankLine.ms >= 0 && rankLine.usage?.input > 0
        && lines().some((l) => l.kind === 'extract' && l.run === a.jobId) && !fs.readFileSync(ledger, 'utf8').includes(COT),
      JSON.stringify(rankLine));
    const st = await (await fetch(`${base}/api/selftest`)).json();
    const row = (re) => (st.checks || []).find((x) => re.test(x.title));
    check('Ranking: /check shows the ranking prompt\'s version, that the claims are ranked for the operator\'s runs alone, and the setting; FactEngine is ready',
      st.ready === true && row(/^The ranking prompt is installed$/)?.state === 'ok' && (row(/^The ranking prompt is installed$/)?.detail || '').includes(RANK_VERSION)
        && row(/^The claims are ranked for your runs alone$/)?.state === 'ok' && st.settings?.rank === 'your runs alone: an empirical headline first, then the top 25%, rounded up, on deepseek-flash at high'
        && (st.settings?.prompts || '').includes(`rank ${RANK_VERSION}`),
      JSON.stringify({ rows: (st.checks || []).filter((x) => /rank/i.test(x.title)).map((x) => `${x.state}:${x.title}`), settings: st.settings?.rank, prompts: st.settings?.prompts }));

    // A wait is a wait, for the ranking alone: the listing is not asked again.
    const b = await list(base, '');
    const w = b.events.find((e) => e.t === 'rank-retry');
    check('Ranking: a 429 that names no wait is a wait of about a second for the ranking alone (the listing is not asked again); then the ranking completes',
      w?.reason === 'rate_limit' && w.waitMs >= 600 && w.waitMs <= 1000 && b.sends === 3 && b.done?.ranking?.ok === true && !b.events.some((e) => e.t === 'retry'),
      JSON.stringify({ retry: w, sends: b.sends, ok: b.done?.ranking?.ok }));
    const c = await list(base, '');
    const w2 = c.events.find((e) => e.t === 'rank-retry');
    check('Ranking: an answer that stops before its last event is a cut connection, and the ranking goes again; the run completes ranked',
      w2?.reason === 'connection' && c.sends === 3 && c.done?.ranking?.ok === true && JSON.stringify(c.done.ranking.order) === JSON.stringify(WANT),
      JSON.stringify({ retry: w2, sends: c.sends, ok: c.done?.ranking?.ok }));

    // A page whose connection is cut while the claims are ranked comes back to the same job and finds the ranking done.
    const jobD = `rank-cut-${stamp}`;
    const beforeD = (await stats()).requests;
    const got = [];
    const ac = new AbortController();
    try {
      const res = await fetch(`${base}/api/extract`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: doc(''), jobId: jobD, source: META }) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let cut = false;
      while (!cut) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while (!cut && (nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          got.push(ev);
          if (ev.t === 'phase' && ev.phase === 'ranking') { cut = true; ac.abort(); }
        }
      }
    } catch { /* the cut */ }
    const rest = await stream(`${base}/api/extract`, { text: doc(''), jobId: jobD, cursor: got.length, source: META });
    const doneD = rest.find((e) => e.t === 'done');
    check('Ranking: a connection cut while the claims are being ranked costs nothing: the page comes back to the same job and receives the summary and the ranking, and nothing is asked twice',
      got.some((e) => e.t === 'phase' && e.phase === 'ranking') && !got.some((e) => e.t === 'done') && rest[0]?.t === 'attached' && doneD?.ranking?.ok === true
        && JSON.stringify(doneD.ranking.order) === JSON.stringify(WANT) && (await stats()).requests - beforeD === 2,
      JSON.stringify({ before: got.map((e) => e.t), after: rest.map((e) => e.t), sends: (await stats()).requests - beforeD }));

    // Each case, from a mark in the document.
    const cases = {};
    for (const mark of ['question', 'notemp-headline', 'none', 'invented', 'dup', 'missing', 'allnot', 'garbage', 'decor']) cases[mark] = (await list(base, mark)).done;
    const R = (m) => cases[m]?.ranking;
    const failures = async () => (await (await fetch(`${base}/api/selftest`)).json()).recentFailures || [];
    check('Ranking: a headline phrased as a question is not tested, nor one that is not empirical, nor a page without one; the claims are ranked all the same',
      R('question')?.headline?.kind === 'question' && R('question').headline.tested === false && R('notemp-headline')?.headline?.kind === 'not_empirical' && R('notemp-headline').headline.tested === false
        && R('none')?.headline?.kind === 'none' && R('none').headline.tested === false && R('none').headline.text === null && R('question').keep === 3 && R('none').keep === 3,
      JSON.stringify({ question: R('question')?.headline, notEmpirical: R('notemp-headline')?.headline, none: R('none')?.headline }));
    check('Ranking: a headline the model wrote that is not, word for word, the page\'s title or a line of the document is never tested, and /check records it',
      R('invented')?.headline?.kind === 'empirical' && R('invented').headline.tested === false && (await failures()).some((f) => f.where === 'server:ranking' && f.code === 'headline_unmatched'),
      JSON.stringify(R('invented')?.headline));
    check('Ranking: a listed claim that says what the headline says is not shown twice: the headline is that test, and a quarter of the other eleven, rounded up, is three',
      R('dup')?.duplicate === 1 && !R('dup').order.includes(1) && R('dup').ranked === 11 && R('dup').keep === 3 && R('dup').headline?.tested === true,
      JSON.stringify(R('dup') && { duplicate: R('dup').duplicate, order: R('dup').order, keep: R('dup').keep }));
    check('Ranking: a claim the model left out of both lists is kept at the end of the order, behind the ones it ranked, never lost',
      R('missing')?.missing === 1 && R('missing').order[R('missing').order.length - 1] === 13 && R('missing').ranked === 11 && R('missing').keep === 3,
      JSON.stringify(R('missing') && { order: R('missing').order, missing: R('missing').missing }));
    check('Ranking: when the model finds nothing empirical, nothing is offered to test but the headline, and every statement is counted as set aside',
      R('allnot')?.ok === true && R('allnot').keep === 0 && R('allnot').order.length === 0 && R('allnot').notEmpirical.length === 13 && R('allnot').headline?.tested === true,
      JSON.stringify(R('allnot') && { keep: R('allnot').keep, notEmpirical: R('allnot').notEmpirical.length }));
    check('Ranking: an answer without its headings leaves the list whole, as before the ranking (the thirteen claims, unranked), shows no summary, and /check records it',
      R('garbage')?.ok === false && R('garbage').summary === null && cases.garbage?.claims?.length === 13 && (await failures()).some((f) => f.where === 'server:ranking' && f.code === 'rank_unread'),
      JSON.stringify(R('garbage')));
    check('Ranking: headings in Markdown\'s decorations, and "1. 12" lines (a place, then the claim), are read as written',
      R('decor')?.ok === true && JSON.stringify(R('decor').order) === JSON.stringify(WANT) && R('decor').keep === 3 && R('decor').headline?.tested === true,
      JSON.stringify(R('decor') && { order: R('decor').order, keep: R('decor').keep }));

    // The reading itself, in process.
    const rk = await import(pathToFileURL(path.join(root, 'server', 'rank.js')).href);
    check('Ranking: a quarter, rounded up, in whole millionths: 12 gives 3, 13 gives 4, 4 gives 1, 1 gives 1, 0 gives 0; 15% of 20 is 3, never 4; 33.4% of 10 is 4',
      rk.keepCount(12, 25) === 3 && rk.keepCount(13, 25) === 4 && rk.keepCount(4, 25) === 1 && rk.keepCount(1, 25) === 1 && rk.keepCount(0, 25) === 0 && rk.keepCount(20, 15) === 3 && rk.keepCount(10, 33.4) === 4 && rk.keepCount(3, 100) === 3,
      JSON.stringify([12, 13, 4, 1, 0].map((n) => rk.keepCount(n, 25))));
    const five = [1, 2, 3, 4, 5].map((n) => ({ n, entry: `Claim ${n}.` }));
    const p1 = rk.parseRanking('Summary: one line of summary.\nHEADLINE: A title here\nHEADLINE TYPE: Question\nRANKED: 3, 1, 9, 3\nNOT EMPIRICAL\nNONE\n', { claims: five, title: 'A title here | Site' });
    check('Ranking: an answer is read as a model may write it: a summary on its heading\'s line, a list on its heading\'s line, a number outside the list or named twice passed over, a claim named nowhere kept at the end, NONE as none',
      p1.ok && p1.summary === 'one line of summary.' && JSON.stringify(p1.order) === JSON.stringify([3, 1, 2, 4, 5]) && p1.ranked === 2 && p1.keep === 1 && p1.missing === 3 && p1.notEmpirical.length === 0 && p1.headline?.kind === 'question' && p1.headline.tested === false,
      JSON.stringify(p1));
    const partial = rk.summarySoFar('SUMMARY\nThe first line.\nThe second li');
    const stopped = rk.summarySoFar('SUMMARY\nThe only line.\n\nHEADLI');
    check('Ranking: the summary is sent in whole lines only, and never a heading that has begun to arrive',
      partial === 'The first line.' && stopped.trim() === 'The only line.', JSON.stringify({ partial, stopped }));
    check('Ranking: the headline as published is a page\'s own title; a link\'s host or the last part of its address (what the reader shows for a page without a title) and pasted text give none',
      rk.titleOf({ kind: 'link', url: 'https://news.example.org/a/b', title: 'A real headline | Paper' }) === 'A real headline | Paper' && rk.titleOf({ kind: 'link', url: 'https://news.example.org/a/b', title: 'news.example.org' }) === ''
        && rk.titleOf({ kind: 'link', url: 'https://news.example.org/files/report.pdf', title: 'report.pdf' }) === '' && rk.titleOf({ kind: 'text' }) === '' && rk.titleOf({ kind: 'file', name: 'x.pdf', title: 'The file\'s own title' }) === 'The file\'s own title',
      '');

    // The modes, and the places the ranking does not run.
    const off = serve(PORT + 72, { CIVIC_RANK: 'off' });
    await wait(`${off}/api/health`);
    const o = await list(off, '');
    check('Ranking: with CIVIC_RANK=off a listing is one request to DeepSeek; the page is told of no ranking, and done carries none',
      o.sends === 1 && Boolean(o.done) && !o.done.ranking && !o.events.some((e) => e.t === 'start' && e.rank) && !o.events.some((e) => e.t === 'summary'), JSON.stringify({ sends: o.sends }));
    const bad = serve(PORT + 73, { CIVIC_PROMPT_RANK: `${MARK} a stand-in prompt without its slot for the claims.\n` });
    await wait(`${bad}/api/health`);
    const bd = await list(bad, '');
    const stBad = await (await fetch(`${bad}/api/selftest`)).json();
    check('Ranking: a ranking prompt without {{CLAIMS}} is never sent: the claims are listed unranked, /check says why, and FactEngine is still ready',
      bd.sends === 1 && Boolean(bd.done) && !bd.done.ranking && stBad.ready === true && (stBad.checks || []).some((x) => x.state === 'warn' && x.title === 'The claims are listed unranked' && /\{\{CLAIMS\}\}/.test(x.detail || '')),
      JSON.stringify((stBad.checks || []).filter((x) => /rank/i.test(x.title)).map((x) => `${x.state}:${x.title}: ${x.detail}`)));
    const oa = serve(PORT + 74, { CIVIC_EXTRACT_PROVIDER: '', CIVIC_RANK: 'on' });
    await wait(`${oa}/api/health`);
    const oaRun = await stream(`${oa}/api/extract`, { text: doc(''), jobId: `rank-openai-${stamp}`, source: META });
    const stOa = await (await fetch(`${oa}/api/selftest`)).json();
    check('Ranking: with the listing on OpenAI the claims are listed unranked (the ranking runs on the listing\'s DeepSeek model), and /check says so',
      Boolean(oaRun.find((e) => e.t === 'done')) && !oaRun.find((e) => e.t === 'done')?.ranking && (stOa.checks || []).some((x) => x.state === 'warn' && x.title === 'The claims are listed unranked' && /DeepSeek/.test(x.detail || '')),
      JSON.stringify((stOa.checks || []).filter((x) => /rank/i.test(x.title)).map((x) => `${x.state}:${x.title}: ${x.detail}`)));

    // The ranking's own effort (the operator's answer of 19 October: the ranking thinks at low, as the listing does).
    const lowR = serve(PORT + 77, { CIVIC_RANK_EFFORT: 'low' });
    await wait(`${lowR}/api/health`);
    const hLow = await (await fetch(`${lowR}/api/health`)).json();
    const lr = await list(lowR, '');
    const lowBody = (await stats()).lastRankBody;
    check('Ranking: CIVIC_RANK_EFFORT sets the ranking\'s own effort (low on the service since 19 October): the health line says so, the ranking asks DeepSeek at low, and the listing keeps its own',
      hLow.request?.rank?.effort === 'low' && hLow.request?.extract?.effort === 'high' && JSON.stringify(lowBody?.reasoning) === JSON.stringify({ effort: 'low' }) && lr.done?.ranking?.ok === true,
      JSON.stringify({ rank: hLow.request?.rank?.effort, extract: hLow.request?.extract?.effort, body: lowBody?.reasoning }));

    // With accounts on: while CIVIC_RANK is `operator`, the operator's runs are ranked and a reader's are listed as before;
    // `on` ranks everyone's.
    const accountEnv = { ...dsEnv, CIVIC_OPERATOR_EMAILS: 'op@example.com', CIVIC_OPERATOR_CLAIM: claimHash() };
    const P = PORT + 75;
    const srv = accountServer(P, RMOCK, accountEnv);
    procs.push(srv.child);
    await wait(`http://localhost:${P}/api/health`, 20000);
    const people = accountClient(`http://localhost:${P}`);
    const reader = (await people.signup('reader@example.com')).cookie;
    const op = (await people.json('/api/account/claim', { method: 'POST', body: { token: CLAIM_TOKEN, email: 'op@example.com', password: PASSWORD, agree: true } })).cookie;
    const rr = await people.stream('/api/extract', { jobId: `rank-reader-${stamp}`, text: doc(''), source: META }, reader);
    const orr = await people.stream('/api/extract', { jobId: `rank-op-${stamp}`, text: doc(''), source: META }, op);
    const rDone = rr.events.find((e) => e.t === 'done');
    check('Ranking: while CIVIC_RANK is operator, a reader\'s claims are listed unranked, as before, and the operator\'s are ranked',
      Boolean(rDone) && !rDone.ranking && !rr.events.some((e) => e.t === 'summary' || (e.t === 'start' && e.rank)) && orr.events.find((e) => e.t === 'done')?.ranking?.ok === true,
      JSON.stringify({ reader: rDone ? Boolean(rDone.ranking) : 'no done', operator: orr.events.find((e) => e.t === 'done')?.ranking?.ok }));
    const P2 = PORT + 76;
    const srv2 = accountServer(P2, RMOCK, { ...accountEnv, CIVIC_RANK: 'on' });
    procs.push(srv2.child);
    await wait(`http://localhost:${P2}/api/health`, 20000);
    const people2 = accountClient(`http://localhost:${P2}`);
    const reader2 = (await people2.signup('reader2@example.com')).cookie;
    const rr2 = await people2.stream('/api/extract', { jobId: `rank-reader-on-${stamp}`, text: doc(''), source: META }, reader2);
    check('Ranking: with CIVIC_RANK=on a reader\'s claims are ranked too',
      rr2.events.find((e) => e.t === 'done')?.ranking?.ok === true, JSON.stringify(rr2.events.find((e) => e.t === 'done')?.ranking?.ok));
  } catch (err) {
    check('Ranking checks completed', false, err.stack || err.message);
  } finally {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  }
}
await rankChecks();

// ---- the listing on Fireworks: DeepSeek V4.1 Flash from a US company, FactEngine's own search, the chain of thought cut off ----
// The operator's choice of 5 October. Against a stand-in that speaks Fireworks' dialect (scripts/mock-openai.js): the
// model's reasoning inside the answer's text ahead of `</think>` (with no opening tag, with one, or sent apart), carrying a
// marker and numbered lines of its own; the input echoed among the output; usage as prompt_tokens and completion_tokens;
// no web search, and FactEngine's tool server called by the stand-in itself during the response, as Fireworks calls one.
async function fireworksChecks() {
  const FMOCK = MOCK_PORT + 85, SITE = PORT + 88;
  const FWKEY = 'fw_verify0000000000000000000000';
  const SKEY = 'search-key-fw-verify-5d2a';
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
      CIVIC_LEDGER_FILE: ledger, CIVIC_ERROR_LOG: errlog, DATABASE_URL: '',
      CIVIC_EXTRACT_PROVIDER: 'fireworks', FIREWORKS_API_KEY: FWKEY, CIVIC_FIREWORKS_BASE_URL: `http://localhost:${FMOCK}/fireworks`,
      RENDER_EXTERNAL_URL: `http://localhost:${port}`, CIVIC_TOOLS_URL: '', CIVIC_TOOLS_PASS: '',
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
    check('Fireworks: the health line says the listing goes to Fireworks\' DeepSeek V4.1 Flash at effort high with no mode and no summary, can search, and lists its keys (store among them); the determinations stay on OpenAI',
      sx.provider === 'fireworks' && sx.model === MODEL && sx.effort === 'high' && sx.mode === null && sx.summary === null && sx.webSearch === true && JSON.stringify(health.request?.keys?.extract) === JSON.stringify(wantKeys) && health.request?.evaluate?.model === config.evalModels[0],
      JSON.stringify({ extract: sx, keys: health.request?.keys?.extract }));

    const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
    const sentences = ['The Eiffel Tower stands about 330 metres tall.', 'Water boils at 100 degrees Celsius at sea level.', 'Mount Everest is 8,849 metres above sea level.'];
    const listing = async (label, cursor) => stream(`${base}/api/extract`, { text: source, jobId: `fw-${label}-${stamp}`, ...(cursor === undefined ? {} : { cursor }) });
    const a = await listing('a');
    const doneA = a.find((e) => e.t === 'done');
    const bodyA = fwBodies()[0]?.body;
    const toolStepsA = (doneA?.trail || []).filter((t) => t.kind === 'tool');
    check('Fireworks: a listing completes with exactly the document\'s three claims, on DeepSeek V4.1 Flash at effort high, no mode, its search and its page read on the trail',
      Boolean(doneA) && doneA.total === 3 && JSON.stringify(doneA.claims.map((c) => c.text)) === JSON.stringify(sentences) && doneA.model === MODEL && doneA.effort === 'high' && doneA.mode === null
        && toolStepsA.length === 2 && toolStepsA[0].name === 'search_web' && toolStepsA[0].query === 'height of the Eiffel Tower' && toolStepsA[0].status === 'completed' && toolStepsA[1].name === 'read_page' && toolStepsA[1].url === `http://localhost:${SITE}/tower` && !a.some((e) => e.t === 'error'),
      JSON.stringify(doneA && { total: doneA.total, claims: doneA.claims.map((c) => c.text), model: doneA.model, trail: doneA.trail }));
    // The tool server is named at a door of the listing's own, in the address: Fireworks forwards no header of the entry's.
    const doorOf = (b) => new RegExp(`^${base.replace(/[.]/g, '\\.')}/mcp/t/([0-9a-f]{48})$`).exec(String(b?.tools?.[0]?.server_url || ''))?.[1] || null;
    const entryA = bodyA?.tools?.[0];
    const doorA = doorOf(bodyA);
    check('Fireworks: the listing\'s body carries exactly the model, the prompt, reasoning {effort: high}, the one entry naming FactEngine\'s tool server at the service\'s own address through a door of the listing\'s own and with no header (no pass goes to Fireworks), stream, and store: false; no web search, mode or summary',
      Boolean(bodyA) && JSON.stringify(Object.keys(bodyA).sort()) === JSON.stringify([...wantKeys].sort()) && JSON.stringify(bodyA.reasoning) === JSON.stringify({ effort: 'high' })
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
        && row(/^Fireworks took the listing's effort as high$/)?.state === 'ok'
        && st.settings?.listingProvider === 'Fireworks' && st.settings?.listingModel === MODEL && st.settings?.listingEffort === 'high' && st.tools?.requests?.listing === true && st.tools?.requests?.determinations === false,
      JSON.stringify((st.checks || []).filter((x) => /Fireworks|OpenAI|tool server/.test(x.title)).map((x) => `${x.state}:${x.title}`)));
    check('Fireworks: the listing\'s ledger lines say Fireworks, are priced at its rates from its own token counts (cached apart), and keep Fireworks\' echo of the effort it was asked for; the chain of thought is in no ledger line and no failure record',
      (() => {
        const ex = lines().filter((l) => l.kind === 'extract');
        const errText = fs.existsSync(errlog) ? fs.readFileSync(errlog, 'utf8') : '';
        const all = fs.readFileSync(ledger, 'utf8');
        return ex.length >= 7 && ex.every((l) => l.provider === 'fireworks' && l.model === MODEL && l.priced === true && l.usd > 0 && l.usage?.input > 0 && l.usage?.cached === 7 && l.usage?.output > 0 && JSON.stringify(l.reasoningEcho) === JSON.stringify({ effort: 'high' }))
          && !all.includes(COT) && !all.includes(ECHO) && !errText.includes(COT);
      })(), JSON.stringify(lines().filter((l) => l.kind === 'extract').slice(0, 1)));

    // The price, in process, from Fireworks' release note (its serverless price from 1 October 2026): one price at every hour.
    delete process.env.CIVIC_PRICING_JSON;
    const { estimateTextCost } = await import(`${pathToFileURL(path.join(root, 'server', 'pricing.js')).href}?fw=${stamp}`);
    const priced = (usage, iso) => estimateTextCost({ model: MODEL, usage, at: Date.parse(iso) }).usd;
    check('Fireworks: a million tokens in and out cost $1.50 at any hour; a million cached $0.006',
      priced({ input: 1_000_000, cached: 0, output: 1_000_000 }, '2026-10-05T02:00:00Z') === 1.5 && priced({ input: 1_000_000, cached: 0, output: 1_000_000 }, '2026-10-04T14:00:00Z') === 1.5 && priced({ input: 1_000_000, cached: 1_000_000, output: 0 }, '2026-10-05T02:00:00Z') === 0.006,
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
        && said.includes(`extraction requests go to localhost (Fireworks) and carry: model ${MODEL} · reasoning.effort high · FactEngine's tool server (search_web, read_page, get_transcript) through a door opened for that listing alone · store false`),
      [['health', health2], ['check', check2], ['page', pageHtml], ['ledger', ledgerText], ['errors', errText], ['output', said]].filter(([, t]) => secretIn(t)).map(([n]) => n).join(', ') || said.split('\n').find((l) => l.startsWith('extraction requests')));
  } catch (err) {
    check('Fireworks checks completed', false, err.message);
  } finally {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
    site.close();
  }
}
await fireworksChecks();

// ---- what a determination's row remembers of its claim, and the entry's Name line -------------------------------------
// A delivered claim may go once more, free, when its result was lost on the way (server/economics.js): only for the
// same claim, which the row's fingerprint (a SHA-256 of the claim) proves, so a different claim under a delivered one's
// id is refused before the model is asked. And the inspector is read from the entry's Name line in whatever form the
// model wrote its label (server/verdict.js). Every name below is invented.
async function fingerprintChecks() {
  const { inspectorOf } = await import('../server/verdict.js');
  const FORMS_OF_NAME = [
    ['**Name**: Orin Vale\n\nbody', 'Orin Vale'],
    ['**Name:** Orin Vale', 'Orin Vale'],
    ['Name: Orin Vale', 'Orin Vale'],
    ['0. **Name:** Orin Vale', 'Orin Vale'],
    ['0. **Name**: [Orin Vale]', 'Orin Vale'],
    ['- **Name** — Ibn al-Qarrad (optics)', 'Ibn al-Qarrad'],
    ['### Name: Sir Edwin Cardale, physicist', 'Sir Edwin Cardale'],
    ['1. **Name:** Dr. Orin Vale.', 'Dr. Orin Vale'],
    ['**Name:**\nLena Sorvik\n\nmore', 'Lena Sorvik'],
    ['Preamble line\n  **NAME:** jonas earl wren', 'jonas earl wren'],
    ['The name of the act: Something\nno label here', null],
    ['Named: Bob', null],
  ];
  const read = FORMS_OF_NAME.map(([text, name]) => [inspectorOf(text) === name, text.slice(0, 30), inspectorOf(text)]);
  check('the inspector is read from the entry\'s Name line in every form the model writes its label in (bold or not, numbered, bulleted, a heading, the name on the next line), cut at a description, and never from a sentence of the body',
    read.every(([ok]) => ok), JSON.stringify(read.filter(([ok]) => !ok)));

  const MOCKF = MOCK_PORT + 33, PORTF = PORT + 33;
  const rec = path.join(os.tmpdir(), `civic-verify-fingerprint-${Date.now()}.jsonl`);
  fs.writeFileSync(rec, '');
  start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCKF), MOCK_RECORD: rec, MOCK_SPEED: '0.1', MOCK_EVAL_MARK: process.env.MOCK_EVAL_MARK_FOR_GATE || '' });
  await wait(`http://localhost:${MOCKF}/v1/mock/stats`, 15000, { anyResponse: true });
  const server = start([path.join(root, 'server', 'index.js')], { PORT: String(PORTF), OPENAI_BASE_URL: `http://localhost:${MOCKF}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), `civic-verify-fingerprint-ledger-${PORTF}.jsonl`) });
  try {
    await wait(`http://localhost:${PORTF}/api/health`, 20000);
    const sent = () => fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.path === '/v1/responses').length;
    const text = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level.';
    const claim = 'Claim: The Eiffel Tower stands about 330 metres tall.\nAttribution: The supplied text; no date given.';
    const ask = async (claimText) => {
      const r = await fetch(`http://localhost:${PORTF}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'fingerprint-check-0001', claims: [claimText], text, source: { kind: 'text' } }) });
      const body = r.ok ? await r.text() : await r.json().catch(() => ({}));
      await fetch(`http://localhost:${PORTF}/api/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobIds: ['fingerprint-check-0001'] }) });
      return { status: r.status, code: r.ok ? null : body?.error?.code || null, done: r.ok && body.includes('"t":"done"') };
    };
    const s0 = sent();
    const first = await ask(claim);
    const s1 = sent();
    const other = await ask('Claim: A different claim, tested free under a delivered one\'s id.');
    const s2 = sent();
    const again = await ask(claim);
    const s3 = sent();
    const third = await ask(claim);
    check('a delivered claim\'s free second go is for the same claim only: a different claim under its id is refused (already_tested) before the model is asked; the same claim goes once more, then is refused',
      first.done && s1 - s0 === 1 && other.status === 409 && other.code === 'already_tested' && s2 === s1 && again.done && s3 - s2 === 1 && third.status === 409 && third.code === 'already_tested' && sent() === s3,
      JSON.stringify({ first, other, again, third, sent: [s1 - s0, s2 - s1, s3 - s2, sent() - s3] }));
  } catch (err) {
    check('the fingerprint checks completed', false, err.stack);
  } finally {
    try { server.kill('SIGTERM'); } catch {}
  }
}
await fingerprintChecks();

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
    // The listing's provider (5 October, the operator's choice for speed): DeepSeek's own service, which processes data in
    // China and whose terms allow a small, de-identified part of the inputs to improve its models unless we opt out. The
    // operator's wording of 4 October, unchanged; no vendor named.
    const privacy = await page('/privacy');
    const terms = await page('/terms');
    check('/privacy and /terms: the listing\'s provider processes data in China and may use a small de-identified part of the inputs unless we opt out; the search provider may receive the model\'s searches; the transfer to those countries',
      privacy.text.includes('A model provider that lists the claims in what you submit: it processes the documents you submit and may search the web while doing so. It processes data in China, and its terms allow it to use a small part of the inputs it receives, de-identified, to improve its models unless we opt out.')
        && privacy.text.includes('A model provider that produces the determinations') && privacy.text.includes('A search provider, which may receive the searches a model makes while listing claims, and the words of a link&#39;s own address and date')
        && privacy.text.includes('Our servers are in the United States, and the model provider that lists claims processes data in China; by using the Service you understand your information is transferred to those countries')
        && terms.text.includes('search the web while doing so, themselves or through our search provider; a search provider performs the searches a model asks for and may be asked to find a licensed copy'),
      '');
    const home = await page('/');
    const footer = (home.text.match(/<footer class="footer">[\s\S]*?<\/footer>/) || [''])[0];
    check('the page\'s footer links Terms, Privacy, Refunds and Contact in a new tab and names Fact Engine LLC, an Operating Equity company',
      ['terms', 'privacy', 'refunds', 'contact'].every((q) => new RegExp(`<a href="${q}" target="_blank" rel="noopener" data-i18n="footer\\.${q}">`).test(footer)) && /class="footer-company">Fact Engine LLC,</.test(footer) && /data-i18n="footer\.parent">an Operating Equity company</.test(footer) && /aria-label="Terms, privacy, refunds and contact"/.test(footer),
      footer.slice(0, 300));
    check('the page carries the AI disclosure line under the results, translated by key',
      /<p class="score-note" data-i18n="score\.aiLine">Determinations are made by an AI model from the sources it cites and can be wrong; check the sources before relying on one\.<\/p>/.test(home.text), '');
    // Accounts and credit (5 October): the sentences approved with the plan, the account page, and no word of the codes.
    const refunds = await page('/refunds');
    check('/terms, /privacy and /refunds carry the account and credit sentences of 5 October',
      terms.text.includes('<h2>4. Your account</h2>') && terms.text.includes('You need an account to use the Service. Give an email address you control and keep your password to yourself; you are responsible for everything done through your account until you tell us at <a href="mailto:support@operatingequity.ai">support@operatingequity.ai</a> that it is compromised. One account per person. We may change, limit or withdraw access at any time.')
        && terms.text.includes('New accounts receive credit for testing claims, in the amount shown when you sign up. Testing a claim draws its price from your credit, and a test that fails is not charged. Credit has no cash value, cannot be transferred or exchanged for money, is not refunded, and may be changed or withdrawn, including from an account used against these Terms.')
        && privacy.text.includes('Your account: the email address and password you sign up with (the password is kept only as a one-way hash, which cannot be turned back into it), and when you agreed to these terms')
        && privacy.text.includes('Your credit: what was given when your account was made, each test&#39;s price and whether it was charged, and any monthly limit you set')
        && privacy.text.includes('to keep your account&#39;s credit;')
        && privacy.text.includes('the sign-in cookie holds only a random identifier and cannot be read by scripts; passwords are kept only as one-way hashes;')
        && refunds.text.includes('A test paid with credit is refunded as credit.'),
      '');
    const accountRes = await fetch(`${base}/account`);
    const account = { status: accountRes.status, cache: accountRes.headers.get('cache-control') || '', text: await accountRes.text() };
    check('/account is served as its own page, never cached, with its own script and the language picker',
      account.status === 200 && /no-store/.test(account.cache) && account.text.includes('<script type="module" src="js/account.js"></script>') && account.text.includes('id="lang-select"') && account.text.includes('data-still="golden"'),
      JSON.stringify({ status: account.status, cache: account.cache }));
    const fieldCount = (html) => (html.match(/class="field(?:\s[^"]*)?"/g) || []).length;
    check('the page and the account page carry one element each of the background\'s class (on 5 October two labels shared it and took every tap), and their fields sit in form-field labels',
      fieldCount(home.text) === 1 && fieldCount(account.text) === 1 && (home.text.match(/<label class="form-field">/g) || []).length >= 4 && /<label class="form-field"/.test(account.text),
      JSON.stringify({ home: fieldCount(home.text), account: fieldCount(account.text) }));
    const SERVED = ['/', '/account', '/check', '/terms', '/privacy', '/refunds', '/contact', '/js/app.js', '/js/api.js', '/js/account.js', '/js/check.js', '/locales/en.js', '/locales/es.js', '/locales/fr.js', '/locales/de.js'];
    const codesWords = /access code|c[oó]digos? de acceso|codes? d.acc[eè]s|Zugangscode|civic_access/i;
    const served = await Promise.all(SERVED.map(async (p) => [p, await page(p)]));
    check('no page or script a reader is served speaks of access codes or carries the codes\' cookie',
      served.every(([, r]) => r.status === 200 && !codesWords.test(r.text)), served.filter(([, r]) => r.status !== 200 || codesWords.test(r.text)).map(([p, r]) => `${p}:${r.status}`).join(' '));
    // The price, said once (the operator, 6 October): one line above the claims, and no price on a claim's row or on the
    // button. The locales carry the one line's words and none of the row's or the button's; the credit sentence says how
    // many fact-checks a balance covers, never a total.
    const appJs = served.find(([p]) => p === '/js/app.js')[1].text;
    const LINE = { en: 'Each fact-check is {amount}.', es: 'Cada verificación cuesta {amount}.', fr: 'Chaque vérification coûte {amount}.', de: 'Jeder Faktencheck kostet {amount}.' };
    const bundles = {};
    for (const code of Object.keys(LINE)) bundles[code] = (await import(pathToFileURL(path.join(root, 'public', 'locales', `${code}.js`)).href)).default;
    const lineOk = Object.entries(LINE).every(([code, words]) => {
      const b = bundles[code];
      return b.price?.each === words && JSON.stringify(Object.keys(b.price).sort()) === JSON.stringify(['each', 'eachFree_one', 'eachFree_other'])
        && !('balance' in b.credit) && /\{w\}/.test(b.credit.over_other) && typeof b.credit.overNone === 'string' && !/\{(cost|balance)\}/.test(b.credit.over_other) && typeof b.account?.page?.freeAmount === 'string';
    });
    check('the price is said once: the page carries one line for it above the claims and no price on a claim\'s row, the page\'s script says how many on the button and never what they cost, and the four locales carry the one line ("Each fact-check is {amount}.") and none of the row\'s or the button\'s price words',
      home.text.includes('<p class="price-line" id="price-line" hidden></p>') && home.text.indexOf('id="price-line"') < home.text.indexOf('id="claims-list"') && !home.text.includes('card-price')
        && appJs.includes("t('price.each'") && !/card-price|setPriceLabel|'price\.(test|hint|free)|'credit\.balance'/.test(appJs) && lineOk,
      JSON.stringify(Object.fromEntries(Object.entries(bundles).map(([c, b]) => [c, { price: b.price, credit: Object.keys(b.credit) }]))));
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
