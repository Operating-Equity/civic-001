// First real run, from the command line, against a running CIVIC server.
//
//   OPENAI_API_KEY=sk-... node scripts/trial-run.mjs path/to/document.txt [--limit 3] [--no-echo] [--server http://localhost:3000]
//
// Streams extraction and the determinations exactly as the page does, then prints per-claim
// verdict, tokens, estimated cost and duration, and the run totals. Nothing is stored except
// what the server's own ledger records (data/ledger.jsonl).
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const server = opt('--server', 'http://localhost:3000').replace(/\/$/, '');
const limit = Number(opt('--limit', '20'));
const echo = !args.includes('--no-echo');
const key = process.env.OPENAI_API_KEY || '';

if (!file || !fs.existsSync(file)) { console.error('usage: OPENAI_API_KEY=sk-... node scripts/trial-run.mjs document.txt [--limit N] [--no-echo]'); process.exit(1); }
if (!key) { console.error('set OPENAI_API_KEY (the reader key the page would send)'); process.exit(1); }

const text = fs.readFileSync(file, 'utf8');
const usd = (n) => `$${(n || 0).toFixed(3)}`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function stream(path, body, onEvent) {
  const res = await fetch(`${server}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-key': key }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

const health = await (await fetch(`${server}/api/health`)).json();
console.log(`server ok · extract=${health.models.extract}/${health.models.extractEffort} · evaluate=${health.models.evaluate}/${health.models.evaluateEffort} · web search=${health.models.webSearch} · image=${health.models.illustrate}`);
console.log(`document: ${file} (${text.length} chars)\n`);

// Visual echo timing, in parallel with extraction (as on the page).
const echoPromise = echo
  ? (async () => {
      const t0 = Date.now();
      const r = await (await fetch(`${server}/api/illustrate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-key': key }, body: JSON.stringify({ text }) })).json();
      return { ...r, wall: Date.now() - t0 };
    })()
  : Promise.resolve(null);

let extraction = null;
const t0 = Date.now();
await stream('/api/extract', { text }, (ev) => {
  if (ev.t === 'claim') console.log(`  ${String(ev.n).padStart(2, '0')}. ${ev.text}`);
  if (ev.t === 'done') extraction = ev;
  if (ev.t === 'error') throw new Error(`extraction failed: ${ev.code} ${ev.message}`);
});
console.log(`\nextraction: ${extraction.total} claims in ${secs(extraction.ms)} · ${extraction.model} · tokens in/out ${extraction.usage?.input}/${extraction.usage?.output} · est ${usd(extraction.cost?.usd)}\n`);

const claims = extraction.claims.slice(0, Math.min(limit, 20)).map((c) => c.text);
console.log(`testing ${claims.length} claims in parallel…\n`);
const rows = [];
await stream('/api/evaluate', { claims }, (ev) => {
  if (ev.t === 'phase' && ev.phase === 'searching') process.stdout.write(`  [${ev.i + 1}] searching (${ev.searches})\n`);
  if (ev.t === 'retry') process.stdout.write(`  [${ev.i + 1}] retry ${ev.attempt}\n`);
  if (ev.t === 'done') {
    rows.push(ev);
    const u = ev.usage || {};
    console.log(`  [${ev.i + 1}] ${ev.verdict.toUpperCase().padEnd(10)} conf ${String(ev.confidence ?? '?').padStart(3)}%  ${secs(ev.ms).padStart(7)}  in ${u.input} / out ${u.output} (reasoning ${u.reasoning})  searches ${ev.searches}  est ${usd(ev.cost?.usd)}${ev.incomplete ? '  INCOMPLETE:' + ev.incomplete : ''}  · ${ev.inspector || ''}`);
  }
  if (ev.t === 'error') console.log(`  [${(ev.i ?? -1) + 1}] ERROR ${ev.code}: ${ev.message}`);
  if (ev.t === 'complete') console.log(`\nall ${ev.completed}/${ev.total} finished in ${secs(ev.ms)}`);
});

const echoResult = await echoPromise;
if (echoResult) console.log(echoResult.dataUrl || echoResult.url ? `visual echo: ready after ${secs(echoResult.wall)} (${echoResult.model})` : `visual echo: skipped (${echoResult.code || ''} ${echoResult.message || ''})`);

const totalUsd = rows.reduce((s, r) => s + (r.cost?.usd || 0), 0) + (extraction.cost?.usd || 0) + (echoResult?.cost?.usd || 0);
const totalOut = rows.reduce((s, r) => s + (r.usage?.output || 0), 0);
const totalIn = rows.reduce((s, r) => s + (r.usage?.input || 0), 0);
console.log(`\nRUN TOTAL: ${rows.length} determinations · tokens in ${totalIn} / out ${totalOut} · est ${usd(totalUsd)} · per determination ${usd(rows.length ? (totalUsd - (extraction.cost?.usd || 0)) / rows.length : 0)} · wall ${secs(Date.now() - t0)}`);
const byVerdict = rows.reduce((m, r) => { m[r.verdict] = (m[r.verdict] || 0) + 1; return m; }, {});
console.log(`verdicts: ${JSON.stringify(byVerdict)}`);
if (rows.length) {
  const out = `trial-${Date.now()}.json`;
  fs.writeFileSync(out, JSON.stringify({ file, extraction: { ...extraction, claims: undefined }, claims, results: rows }, null, 2));
  console.log(`full entries saved to ${out}`);
}
