// Summarises the internal cost ledger (data/ledger.jsonl): cost of goods sold per determination.
//   node scripts/ledger-summary.mjs [path/to/ledger.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, '..', 'data', 'ledger.jsonl');
if (!fs.existsSync(file)) { console.log(`no ledger yet at ${file}`); process.exit(0); }

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const usd = (n) => `$${(n || 0).toFixed(4)}`;
const group = (arr, key) => arr.reduce((m, r) => { (m[r[key] || '?'] ||= []).push(r); return m; }, {});
const stats = (arr, f) => { const v = arr.map(f).filter((x) => typeof x === 'number'); if (!v.length) return null; v.sort((a, b) => a - b); return { n: v.length, min: v[0], median: v[Math.floor(v.length / 2)], mean: v.reduce((s, x) => s + x, 0) / v.length, max: v[v.length - 1] }; };

console.log(`${rows.length} ledger rows in ${file}\n`);
for (const [kind, list] of Object.entries(group(rows, 'kind'))) {
  const ok = list.filter((r) => r.ok !== false);
  const cost = stats(ok, (r) => r.usd);
  const ms = stats(ok, (r) => r.ms);
  const out = stats(ok, (r) => r.usage?.output);
  console.log(`${kind}: ${list.length} calls (${list.length - ok.length} failed) · total ${usd(ok.reduce((s, r) => s + (r.usd || 0), 0))}`);
  if (cost) console.log(`   cost per call   min ${usd(cost.min)}  median ${usd(cost.median)}  mean ${usd(cost.mean)}  max ${usd(cost.max)}`);
  if (out) console.log(`   output tokens   min ${out.min}  median ${out.median}  mean ${Math.round(out.mean)}  max ${out.max}`);
  if (ms) console.log(`   seconds         min ${(ms.min / 1000).toFixed(1)}  median ${(ms.median / 1000).toFixed(1)}  mean ${(ms.mean / 1000).toFixed(1)}  max ${(ms.max / 1000).toFixed(1)}`);
  if (kind === 'evaluate') {
    for (const [verdict, vs] of Object.entries(group(ok, 'verdict'))) {
      const c = stats(vs, (r) => r.usd);
      console.log(`   ${verdict.padEnd(11)} ${String(vs.length).padStart(4)} · mean ${usd(c?.mean)} · mean seconds ${((stats(vs, (r) => r.ms)?.mean || 0) / 1000).toFixed(1)}`);
    }
    for (const [model, ms2] of Object.entries(group(ok, 'model'))) console.log(`   model ${model}: ${ms2.length} · mean ${usd(stats(ms2, (r) => r.usd)?.mean)}`);
    const unpriced = ok.filter((r) => r.priced === false).length;
    if (unpriced) console.log(`   note: ${unpriced} calls used a model with no price in server/pricing.js (counted at $0 + search fees)`);
  }
  console.log();
}
