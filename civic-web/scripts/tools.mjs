// Prints the tool table exactly as the model reads it, for the environment this is run in
// (`npm run tools`, with .env if present): every verb that a source answers, its description, its
// parameters, and the sources behind it. Nothing secret is printed: names and words, never a key.
import { loadAdapters, buildRegistry, settingsOf } from '../server/tools/registry.js';
import { VERBS } from '../server/tools/verbs.js';

const loaded = await loadAdapters();
const registry = buildRegistry(loaded);
const on = new Set(registry.active.map((e) => e.adapter.id));

console.log(`Sources (${loaded.length}; ${on.size} on):`);
for (const { adapter } of loaded) {
  const { values } = settingsOf(adapter);
  const needs = Object.entries(adapter.settings || {}).filter(([, s]) => s.fallback === undefined).map(([k, s]) => `${s.env}${values[k] ? ' (set)' : ' (not set)'}`);
  console.log(`  ${on.has(adapter.id) ? 'on ' : 'off'} ${adapter.id}: ${adapter.name} — ${adapter.blurb}${needs.length ? `  [${needs.join(', ')}]` : ''}  verbs: ${Object.keys(adapter.verbs).join(', ')}`);
}
console.log(`\nVerbs known (${Object.keys(VERBS).length}): ${Object.keys(VERBS).join(', ')}`);
console.log(`\nWhat the model reads (${registry.table.length} tool${registry.table.length === 1 ? '' : 's'}):`);
for (const tool of registry.table) {
  console.log(`\n${tool.name}\n  ${tool.description}`);
  for (const [k, p] of Object.entries(tool.inputSchema.properties)) {
    console.log(`  ${k}${tool.inputSchema.required.includes(k) ? '' : ' (optional)'}: ${p.type}${p.enum ? ` one of ${p.enum.join(', ')}` : ''} — ${p.description}`);
  }
}
if (!registry.table.length) console.log('  (none: no source is on)');
