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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MOCK_PORT = 3999;
const PORT = 3007;
const record = path.join(os.tmpdir(), `civic-verify-${Date.now()}.jsonl`);
const KEY = 'sk-verify00000000000000000000';          // the operator's, set on the server below
const READER_KEY = 'sk-reader11111111111111111111';   // a stranger's, offered in a header and ignored

// The only keys a request may carry. Nothing else, ever.
const ALLOWED = {
  extract: ['model', 'instructions', 'input', 'reasoning', 'tools', 'stream', 'store'],
  evaluate: ['model', 'input', 'reasoning', 'tools', 'stream', 'store'],
  reasoning: ['effort', 'summary'],
  webSearchTool: ['type'],
};

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
  start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK_PORT), MOCK_RECORD: record, MOCK_SPEED: '0.2' });
  await wait(`http://localhost:${MOCK_PORT}/v1/responses`, 15000, { anyResponse: true });
  start([path.join(root, 'server', 'index.js')], { PORT: String(PORT), OPENAI_BASE_URL: `http://localhost:${MOCK_PORT}/v1`, OPENAI_API_KEY: KEY, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl') });
  await wait(`http://localhost:${PORT}/api/health`);

  const health = await (await fetch(`http://localhost:${PORT}/api/health`)).json();
  const shape = health.request;
  check('no fallback list on either step', shape.extract.fallback === false && shape.evaluate.fallback === false);

  const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
  const claim = 'The Eiffel Tower stands about 330 metres tall.';
  const ex = await stream(`http://localhost:${PORT}/api/extract`, { text: source });
  const ev = await stream(`http://localhost:${PORT}/api/evaluate`, { claims: [claim] });

  const sent = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.path === '/v1/responses');
  const exBody = sent.find((r) => r.body.instructions)?.body;
  const evBody = sent.find((r) => !r.body.instructions)?.body;
  check('extraction request captured', Boolean(exBody));
  check('determination request captured', Boolean(evBody));

  if (exBody) {
    check('extraction: model is the configured model', exBody.model === shape.extract.model, exBody.model);
    check('extraction: reasoning.effort is the configured effort', exBody.reasoning?.effort === shape.extract.effort, JSON.stringify(exBody.reasoning));
    check('extraction: no keys beyond model, instructions, input, reasoning, tools, stream, store', extraKeys(exBody, ALLOWED.extract).length === 0, extraKeys(exBody, ALLOWED.extract).join(', '));
    const exTools = exBody.tools || [];
    check('extraction: web search available (exactly one web_search, no options)', exTools.length === 1 && exTools[0].type === 'web_search' && extraKeys(exTools[0], ALLOWED.webSearchTool).length === 0, JSON.stringify(exTools));
    check('extraction: no reasoning keys beyond effort, summary', extraKeys(exBody.reasoning, ALLOWED.reasoning).length === 0, extraKeys(exBody.reasoning, ALLOWED.reasoning).join(', '));
    check('extraction: prompt sent verbatim as instructions', exBody.instructions === extractPrompt, `${exBody.instructions?.length} vs ${extractPrompt.length} chars`);
    check('extraction: the document sent whole, as the only message', exBody.input?.length === 1 && exBody.input[0]?.content?.[0]?.text === source);
    check('extraction: store = false', exBody.store === false);
  }
  if (evBody) {
    const userText = evBody.input?.[0]?.content?.[0]?.text;
    check('determination: model is the configured model', evBody.model === shape.evaluate.model, evBody.model);
    check('determination: reasoning.effort is the configured effort', evBody.reasoning?.effort === shape.evaluate.effort, JSON.stringify(evBody.reasoning));
    check('determination: no keys beyond model, input, reasoning, tools, stream, store', extraKeys(evBody, ALLOWED.evaluate).length === 0, extraKeys(evBody, ALLOWED.evaluate).join(', '));
    check('determination: no reasoning keys beyond effort, summary', extraKeys(evBody.reasoning, ALLOWED.reasoning).length === 0, extraKeys(evBody.reasoning, ALLOWED.reasoning).join(', '));
    check('determination: no instructions field (nothing added around the prompt)', evBody.instructions === undefined);
    check('determination: the prompt sent verbatim with the claim substituted', userText === evaluatePrompt.split('{{CLAIM}}').join(claim), `${userText?.length} chars`);
    check('determination: exactly one message, the prompt', Array.isArray(evBody.input) && evBody.input.length === 1);
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
  const streamed = ev.filter((e) => e.t === 'delta' && e.i === 0).map((e) => e.text).join('');
  check('determination: final text equals every streamed character (nothing stripped)', Boolean(done?.text) && done.text === streamed, `${done?.text?.length} vs ${streamed.length} chars`);
  check('determination: verdict read from the Conclusion or left unread (never guessed)', done?.verdictSource === 'conclusion' || done?.verdict === null, `source=${done?.verdictSource}`);
} catch (err) {
  check('run completed', false, err.message);
} finally {
  stop();
  try { fs.unlinkSync(record); } catch {}
}

for (const r of leakChecks()) results.push(r); // no line of the prompts may sit in a committed file

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   ← ${r.detail}`}`);
console.log(failed.length
  ? `\n${failed.length} FAILED. A request carries something the operator did not configure.`
  : `\nAll ${results.length} checks passed. Requests carry the configured model and effort, the prompts verbatim, web search on both steps, and nothing else.`);
process.exit(failed.length ? 1 : 0);
