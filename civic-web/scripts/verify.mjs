// The guard. Starts the mock and the server, runs an extraction and a determination, then reads
// the request bodies the server ACTUALLY SENT to the API and fails if they carry anything but the
// operator's configuration: the configured model, the configured reasoning effort, the prompts
// verbatim, web search. Any other key in a request body is a failure, whoever added it.
// It also runs the prompt leak guard: no committed file may contain a fragment of the prompts.
// Run before every deploy: `npm run verify`. A non-zero exit is a defect.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leakChecks } from './leak-check.mjs';
import { sourceBlock } from '../server/source.js';
import { Bucket, parseRefusal } from '../server/gate.js';

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
