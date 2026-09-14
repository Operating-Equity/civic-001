// A real run from the command line, against a running CIVIC server.
//
//   OPENAI_API_KEY=sk-... node scripts/trial-run.mjs document.txt [--limit 3] [--no-echo] [--quiet]
//
// Streams extraction and the determinations exactly as the page does and prints EVERYTHING the
// models return: the full entry for every claim, the reasoning summary, every search performed,
// every source cited, plus tokens, duration and estimated cost. Nothing is summarised or cut.
// The whole run is also written to a Markdown file and a JSON file next to where you ran it.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const server = opt('--server', 'http://localhost:3000').replace(/\/$/, '');
const limit = Number(opt('--limit', '20'));
const echo = !args.includes('--no-echo');
const quiet = args.includes('--quiet'); // print the summary table only; files still get everything
const key = process.env.OPENAI_API_KEY || '';

if (!file || !fs.existsSync(file)) {
  console.error('usage: OPENAI_API_KEY=sk-... node scripts/trial-run.mjs document.txt [--limit N] [--no-echo] [--quiet]');
  process.exit(1);
}
if (!key) { console.error('set OPENAI_API_KEY to the key the page would send'); process.exit(1); }

const text = fs.readFileSync(file, 'utf8');
const usd = (n) => `$${(n || 0).toFixed(3)}`;
const secs = (ms) => `${((ms || 0) / 1000).toFixed(1)}s`;
const rule = (s) => `\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`;

async function stream(url, body, onEvent) {
  const res = await fetch(`${server}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-key': key }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${await res.text()}`);
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
console.log(`server ok · extract ${health.models.extract}/${health.models.extractEffort} · evaluate ${health.models.evaluate}/${health.models.evaluateEffort} · web search ${health.models.webSearch} · image ${health.models.illustrate}/${health.models.illustrateQuality}`);
console.log(`document: ${file} (${text.length} chars)\n`);

// The visual echo runs in parallel with extraction, as it does on the page.
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
  if (ev.t === 'phase' && ev.phase === 'incomplete') console.log(`  !! extraction ended early: ${ev.reason}`);
  if (ev.t === 'done') extraction = ev;
  if (ev.t === 'error') throw new Error(`extraction failed: ${ev.code} ${ev.message}`);
});
console.log(`\nextraction: ${extraction.total} claims in ${secs(extraction.ms)} · ${extraction.model} · tokens in/out ${extraction.usage?.input}/${extraction.usage?.output} · est ${usd(extraction.cost?.usd)}`);

const claims = extraction.claims.slice(0, Math.min(limit, 20)).map((c) => c.text);
console.log(`\ntesting ${claims.length} of ${extraction.total} claims in parallel…\n`);

const rows = [];
await stream('/api/evaluate', { claims }, (ev) => {
  if (ev.t === 'trail' && !quiet) console.log(`  [${ev.i + 1}] ${ev.step.kind}: ${ev.step.query || ev.step.url || ''}`);
  if (ev.t === 'retry') console.log(`  [${ev.i + 1}] retry ${ev.attempt}`);
  if (ev.t === 'note') console.log(`  [${ev.i + 1}] note: ${ev.code}`);
  if (ev.t === 'done') {
    rows.push(ev);
    const u = ev.usage || {};
    const verdict = (ev.verdict || 'UNREAD').toUpperCase();
    console.log(`  [${ev.i + 1}] ${verdict.padEnd(10)} conf ${String(ev.confidence ?? '?').padStart(3)}%  ${secs(ev.ms).padStart(7)}  in ${u.input} / out ${u.output} (reasoning ${u.reasoning})  searches ${ev.searches}  sources ${ev.sources?.length || 0}  est ${usd(ev.cost?.usd)}${ev.incomplete ? '  ENDED EARLY: ' + ev.incomplete : ''}  · ${ev.inspector || ''}`);
  }
  if (ev.t === 'error') console.log(`  [${(ev.i ?? -1) + 1}] ERROR ${ev.code}: ${ev.message}`);
  if (ev.t === 'complete') console.log(`\nall ${ev.completed}/${ev.total} finished in ${secs(ev.ms)}`);
});
rows.sort((a, b) => a.i - b.i);

const echoResult = await echoPromise;
if (echoResult) {
  console.log(echoResult.dataUrl || echoResult.url
    ? `visual echo: ready after ${secs(echoResult.wall)} (${echoResult.model}${echoResult.artDirected ? ', art-directed' : ''})`
    : `visual echo: skipped (${echoResult.code || ''} ${echoResult.message || ''})`);
}

// Everything, printed. This is the point of the trial run.
if (!quiet) {
  for (const r of rows) {
    console.log(rule(`CLAIM ${r.i + 1}: ${claims[r.i]}`));
    if (r.reasoning) console.log(`\n— reasoning summary —\n${r.reasoning}`);
    if (r.trail?.length) console.log(`\n— searches —\n${r.trail.map((s) => `  ${s.kind}: ${s.query || s.url || s.pattern || ''}`).join('\n')}`);
    console.log(`\n— entry —\n${r.text}`);
    if (r.sources?.length) console.log(`\n— sources cited —\n${r.sources.map((s) => `  ${s.title} — ${s.url}`).join('\n')}`);
  }
}

const totalUsd = rows.reduce((s, r) => s + (r.cost?.usd || 0), 0) + (extraction.cost?.usd || 0) + (echoResult?.cost?.usd || 0);
const totalOut = rows.reduce((s, r) => s + (r.usage?.output || 0), 0);
const totalIn = rows.reduce((s, r) => s + (r.usage?.input || 0), 0);
const perClaim = rows.length ? rows.reduce((s, r) => s + (r.cost?.usd || 0), 0) / rows.length : 0;
console.log(rule('RUN TOTAL'));
console.log(`${rows.length} determinations · tokens in ${totalIn} / out ${totalOut} · est ${usd(totalUsd)} · per determination ${usd(perClaim)} · wall ${secs(Date.now() - t0)}`);
const byVerdict = rows.reduce((m, r) => { const k = r.verdict || 'unread'; m[k] = (m[k] || 0) + 1; return m; }, {});
console.log(`verdicts: ${JSON.stringify(byVerdict)}`);
const unread = rows.filter((r) => !r.verdict);
if (unread.length) console.log(`NOTE: ${unread.length} entries had no readable Conclusion line; they are not counted in any verdict.`);

// Files: the complete record, nothing dropped.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = path.resolve(`civic-trial-${stamp}`);
fs.writeFileSync(`${base}.json`, JSON.stringify({ file, server: health, extraction, claims, results: rows, echo: echoResult && { ...echoResult, dataUrl: undefined } }, null, 2));
const md = [
  `# CIVIC trial run — ${new Date().toLocaleString()}`, '',
  `Document: ${file} (${text.length} characters)`,
  `Extraction: ${extraction.total} claims, ${extraction.model}, ${secs(extraction.ms)}`,
  `Tested: ${rows.length} · ${JSON.stringify(byVerdict)}`,
  `Tokens in ${totalIn} / out ${totalOut} · estimated ${usd(totalUsd)} · ${usd(perClaim)} per determination`, '',
  '## Extraction output (verbatim)', '', '```', extraction.raw || '(not captured)', '```', '',
  '## Determinations', '',
  ...rows.flatMap((r) => [
    `### ${r.i + 1}. ${claims[r.i]}`, '',
    `**Verdict:** ${r.verdict || 'not readable'}${r.confidence != null ? ` · ${r.confidence}%` : ''}${r.inspector ? ` · ${r.inspector}` : ''}`, '',
    ...(r.incomplete ? [`> Output ended early: ${r.incomplete}`, ''] : []),
    r.text, '',
    ...(r.reasoning ? ['#### Reasoning summary', '', r.reasoning, ''] : []),
    ...(r.trail?.length ? ['#### Searches', '', ...r.trail.map((s) => `- ${s.kind}: ${s.query || s.url || ''}`), ''] : []),
    ...(r.sources?.length ? ['#### Sources cited', '', ...r.sources.map((s) => `- [${s.title}](${s.url})`), ''] : []),
    `_tokens in ${r.usage?.input} / out ${r.usage?.output} (reasoning ${r.usage?.reasoning}) · ${usd(r.cost?.usd)} · ${secs(r.ms)}_`, '', '---', '',
  ]),
].join('\n');
fs.writeFileSync(`${base}.md`, md);
console.log(`\nfull record written to:\n  ${base}.md\n  ${base}.json`);
