// The dam. This script starts the mock and the server, runs an extraction and a determination,
// then reads the request bodies the server ACTUALLY SENT and fails if any of them is below the
// API ceiling, carries a cap, allows truncation, falls back to another model, or alters the
// prompts. Run it before every deploy: `npm run verify-ceiling`. A non-zero exit is a defect.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MOCK_PORT = 3999;
const PORT = 3007;
const record = path.join(os.tmpdir(), `civic-verify-${Date.now()}.jsonl`);
const KEY = 'sk-verify00000000000000000000';

const CEILING = { effort: 'max', mode: 'pro', summary: 'detailed', verbosity: 'high', searchContext: 'high', truncation: 'disabled' };

// The prompts must be installed for the verifier to run; it checks they were sent verbatim.
const promptDir = path.join(root, 'server', 'prompts');
const extractPrompt = readPrompt('extract');
const evaluatePrompt = readPrompt('evaluate');
function readPrompt(name) {
  const inline = process.env[`CIVIC_PROMPT_${name.toUpperCase()}`];
  if (inline) return inline.replace(/\r\n/g, '\n');
  const file = process.env[`CIVIC_PROMPT_${name.toUpperCase()}_FILE`] || path.join(promptDir, `${name}.txt`);
  if (!fs.existsSync(file)) { console.error(`verify-ceiling: ${name} prompt not installed (${file})`); process.exit(2); }
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

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
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-key': KEY }, body: JSON.stringify(body) });
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

try {
  fs.writeFileSync(record, '');
  start([path.join(root, 'scripts', 'mock-openai.js')], { MOCK_PORT: String(MOCK_PORT), MOCK_RECORD: record, MOCK_SPEED: '0.2' });
  await wait(`http://localhost:${MOCK_PORT}/v1/responses`, 15000, { anyResponse: true }); // any answer means the mock is up
  start([path.join(root, 'server', 'index.js')], { PORT: String(PORT), OPENAI_BASE_URL: `http://localhost:${MOCK_PORT}/v1`, CIVIC_IMAGE_ENABLED: 'false', CIVIC_LEDGER_FILE: path.join(os.tmpdir(), 'civic-verify-ledger.jsonl') });
  await wait(`http://localhost:${PORT}/api/health`);

  const health = await (await fetch(`http://localhost:${PORT}/api/health`)).json();
  check('server reports every setting at ceiling', health.ceiling?.all === true, JSON.stringify(health.ceiling?.checks));

  const source = 'The Eiffel Tower stands about 330 metres tall. Water boils at 100 degrees Celsius at sea level. Mount Everest is 8,849 metres above sea level.';
  const claim = 'The Eiffel Tower stands about 330 metres tall.';
  const ex = await stream(`http://localhost:${PORT}/api/extract`, { text: source });
  const ev = await stream(`http://localhost:${PORT}/api/evaluate`, { claims: [claim] });

  const sent = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.path === '/v1/responses');
  const exBody = sent.find((r) => r.body.instructions)?.body;
  const evBody = sent.find((r) => !r.body.instructions)?.body;
  check('extraction request captured', Boolean(exBody));
  check('determination request captured', Boolean(evBody));

  for (const [label, body] of [['extraction', exBody], ['determination', evBody]]) {
    if (!body) continue;
    check(`${label}: model is the configured model`, body.model === health.models.evaluate, body.model);
    check(`${label}: reasoning.effort = ${CEILING.effort}`, body.reasoning?.effort === CEILING.effort, JSON.stringify(body.reasoning));
    check(`${label}: reasoning.mode = ${CEILING.mode}`, body.reasoning?.mode === CEILING.mode, JSON.stringify(body.reasoning));
    check(`${label}: reasoning.summary = ${CEILING.summary}`, body.reasoning?.summary === CEILING.summary, JSON.stringify(body.reasoning));
    check(`${label}: text.verbosity = ${CEILING.verbosity}`, body.text?.verbosity === CEILING.verbosity, JSON.stringify(body.text));
    check(`${label}: truncation = ${CEILING.truncation}`, body.truncation === CEILING.truncation, String(body.truncation));
    check(`${label}: no max_output_tokens`, body.max_output_tokens === undefined, String(body.max_output_tokens));
    check(`${label}: no max_tool_calls`, body.max_tool_calls === undefined, String(body.max_tool_calls));
    check(`${label}: store = false (prompt never in the key owner's dashboard)`, body.store === false, String(body.store));
  }
  if (exBody) {
    check('extraction: prompt sent verbatim as instructions', exBody.instructions === extractPrompt, `${exBody.instructions?.length} vs ${extractPrompt.length} chars`);
    check('extraction: the document sent whole', exBody.input?.[0]?.content?.[0]?.text === source);
  }
  if (evBody) {
    const userText = evBody.input?.[0]?.content?.[0]?.text;
    check('determination: no instructions field (nothing added around the prompt)', evBody.instructions === undefined, String(evBody.instructions)?.slice(0, 60));
    check('determination: the prompt sent verbatim with the claim substituted', userText === evaluatePrompt.split('{{CLAIM}}').join(claim), `${userText?.length} chars`);
    check('determination: exactly one message, the prompt', Array.isArray(evBody.input) && evBody.input.length === 1);
    const ws = (evBody.tools || []).find((t) => t.type === 'web_search');
    check('determination: web_search tool present', Boolean(ws));
    check(`determination: search_context_size = ${CEILING.searchContext}`, ws?.search_context_size === CEILING.searchContext, JSON.stringify(ws));
  }
  check('no fallback or truncation warnings in either stream', ![...ex, ...ev].some((e) => e.t === 'warning'), JSON.stringify([...ex, ...ev].filter((e) => e.t === 'warning')));
  const done = ev.find((e) => e.t === 'done');
  const streamed = ev.filter((e) => e.t === 'delta' && e.i === 0).map((e) => e.text).join('');
  check('determination: final text equals every streamed character (nothing stripped)', Boolean(done?.text) && done.text === streamed, `${done?.text?.length} vs ${streamed.length} chars`);
  check('determination: verdict read from Conclusion (not guessed)', done?.verdictSource === 'conclusion' || done?.verdict === null, `source=${done?.verdictSource}`);
} catch (err) {
  check('run completed', false, err.message);
} finally {
  stop();
  try { fs.unlinkSync(record); } catch {}
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   ← ${r.detail}`}`);
console.log(failed.length ? `\n${failed.length} FAILED. A determination setting is below ceiling, capped, or altered.` : `\nAll ${results.length} checks passed. Nothing is capped, lowered, substituted, or altered.`);
process.exit(failed.length ? 1 : 0);
