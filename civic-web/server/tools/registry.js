// The registry: every adapter in server/tools/adapters, the ones that are on, and the tool table the
// model reads. Built once at startup from the environment; nothing here names a source.
//
// A source is on when every setting of its adapter that has no fallback is set. No key, no entry: the
// model never sees a tool it cannot use, and a source is switched on by setting its key, as the
// transcript service is. The table lists each verb (server/tools/verbs.js) that at least one source
// answers; a verb with several sources gains a required `source` parameter listing them by id, with
// each source's own line, so the model chooses the source and CIVIC's code never does.
import fs from 'node:fs';
import { VERBS } from './verbs.js';
import { validateAdapter, ToolRefusal, RateLimited, itemOf } from './contract.js';
import { siteFetch } from '../http.js';
import { UrlError } from '../fetchurl.js';
import { record as ledger } from '../ledger.js';
import { record as recordFailure } from '../diagnostics.js';

export const ADAPTERS_DIR = new URL('./adapters/', import.meta.url);

/** The adapter files, in name order; a stand-in (`*.standin.js`) is not an adapter. */
export function adapterFiles() {
  return fs.readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.standin.js')).sort();
}

/** Every adapter, validated against the contract; one that fails it stops the server at startup. */
export async function loadAdapters() {
  const all = [];
  for (const f of adapterFiles()) {
    const mod = await import(new URL(f, ADAPTERS_DIR));
    const problems = validateAdapter(mod.default, VERBS);
    if (problems.length) throw new Error(`server/tools/adapters/${f} does not meet the contract: ${problems.join('; ')}`);
    all.push({ file: f, adapter: mod.default });
  }
  return all;
}

const read = (env, s) => {
  const v = env[s.env];
  return v === undefined || v === '' ? (s.fallback === undefined ? '' : String(s.fallback)) : v;
};

/** The values of an adapter's settings from the environment, and whether they switch it on. */
export function settingsOf(adapter, env = process.env) {
  const values = {};
  let on = true;
  for (const [k, s] of Object.entries(adapter.settings || {})) {
    values[k] = read(env, s);
    if (!values[k] && s.fallback === undefined) on = false;
  }
  return { values, on };
}

const abortable = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); };
  signal?.addEventListener('abort', stop, { once: true });
});

/** The registry for an environment: the sources on, the tool table, and the call the gateway makes. */
export function buildRegistry(loaded, env = process.env) {
  const active = [];
  for (const { file, adapter } of loaded) {
    const { values, on } = settingsOf(adapter, env);
    if (!on) continue;
    const usd = adapter.usdPerCall ? Number(read(env, adapter.usdPerCall)) : 0;
    active.push({ file, adapter, settings: values, usdPerCall: Number.isFinite(usd) ? usd : 0 });
  }
  const byVerb = new Map();
  for (const entry of active) {
    for (const verb of Object.keys(entry.adapter.verbs)) {
      if (!byVerb.has(verb)) byVerb.set(verb, []);
      byVerb.get(verb).push(entry);
    }
  }
  const table = [];
  for (const [verb, def] of Object.entries(VERBS)) {
    const entries = byVerb.get(verb);
    if (!entries) continue;
    const properties = { ...def.params };
    const required = [...(def.required || [])];
    if (entries.length > 1) {
      properties.source = {
        type: 'string',
        enum: entries.map((e) => e.adapter.id),
        description: 'Which source answers. ' + entries.map((e) => `${e.adapter.id}: ${e.adapter.name}, ${e.adapter.blurb}`).join(' · '),
      };
      required.push('source');
    }
    table.push({ name: verb, description: def.description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
  }

  const summary = () => ({
    on: active.length > 0,
    sources: active.map((e) => ({ id: e.adapter.id, name: e.adapter.name, verbs: Object.keys(e.adapter.verbs), usdPerCall: e.usdPerCall })),
    verbs: table.map((t) => t.name),
  });

  /** One tool call from the model: the source's answer, or what it kept back, in the model's hands. */
  async function call(name, args = {}, { signal } = {}) {
    const entries = byVerb.get(name);
    const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true });
    if (!entries) return refuse(`No tool is named ${name}.`);
    const entry = entries.length === 1 ? entries[0] : entries.find((e) => e.adapter.id === args.source);
    if (!entry) return refuse(`The source must be one of: ${entries.map((e) => e.adapter.id).join(', ')}.`);
    const { adapter } = entry;
    const ctx = { settings: entry.settings, signal, siteFetch, wait: (ms) => abortable(ms, signal) };
    const startedAt = Date.now();
    const line = (extra) => ledger({ kind: 'tool', source: adapter.id, verb: name, ms: Date.now() - startedAt, usd: entry.usdPerCall, priced: true, ...extra });
    try {
      let result;
      for (;;) {
        try { result = await adapter.verbs[name](args, ctx); break; } catch (err) {
          if (!(err instanceof RateLimited) || !Number.isFinite(err.retryAfterMs)) throw err;
          await ctx.wait(err.retryAfterMs); // the source's own figure; a limit is a wait, never a failure
        }
      }
      const retrievedAt = new Date().toISOString();
      const items = (result?.items || []).map((x) => ({ source: adapter.name, ...itemOf(x), retrievedAt }));
      const out = { items, cursor: result?.cursor ?? null };
      line({ ok: true, items: items.length, chars: items.reduce((n, x) => n + x.text.length, 0) });
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof ToolRefusal || err instanceof UrlError) {
        // The source's answer, in the sentence the reader would get: information for the model.
        line({ ok: false, code: err.code || 'tool_refusal' });
        recordFailure({ where: `tool:${name}`, code: err.code || 'tool_refusal', message: err.message, detail: err.detail || null });
        return refuse(err.message);
      }
      line({ ok: false, code: 'tool_failed' });
      recordFailure({ where: `tool:${name}`, code: 'tool_failed', message: `${adapter.name}: ${err?.message || err}`, detail: err?.cause?.code || null });
      return refuse(`${adapter.name} did not answer.`);
    }
  }

  return { active, table, summary, call };
}
