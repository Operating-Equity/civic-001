// The adapter contract: what a source must provide to become a tool the model can reach for.
//
// One file per source under server/tools/adapters/ (its default export is the adapter), and beside it a
// stand-in file, <id>.standin.js, that the guard runs the adapter against. Nothing outside server/tools
// ever names a source: adding one is one adapter, one stand-in and its settings, and the registry does
// the rest (server/tools/registry.js). The shape:
//
//   {
//     id: 'courtlistener',                 // a-z, digits, dashes; the name in the ledger and on /check
//     name: 'CourtListener',               // the name the model and the operator see
//     blurb: 'US case law and PACER …',    // THE MODEL READS THIS (the operator's text): one line on what the source holds
//     settings: {                          // the environment names that switch the source on and point it
//       url: { env: 'CIVIC_COURTLISTENER_URL', fallback: 'https://www.courtlistener.com/api/rest/v4' },
//       key: { env: 'CIVIC_COURTLISTENER_KEY' },   // no fallback: the source is off until the operator sets it
//     },
//     usdPerCall: { env: 'CIVIC_COURTLISTENER_USD_PER_CALL', fallback: '0' },   // the operator's figure, recorded per call; never invented
//     verbs: {                             // the verbs it answers (server/tools/verbs.js), each an async function
//       search_law: async (args, ctx) => ({ items: [...], cursor: null }),
//     },
//   }
//
// `ctx` is what every adapter gets and none builds: `settings` (the values), `signal` (the run's abort),
// `siteFetch` (the reader's fetch with the silence rules, server/http.js), `wait(ms)` (an abortable
// pause). A source's rate limit is a wait, never a failure: an adapter throws `RateLimited` with the
// figure the source gave (its Retry-After), and the registry waits that long and asks again, as often
// as the source says, until the run is abandoned.
//
// A result is one shape for every source, so the model can cite it and the operator can read it:
//   { items: [{ kind, title, site, url, id, date, text, note }], cursor }
// `cursor` is the source's own next page, if it has one; the model asks for more by calling again with
// it. A single document is one item. The registry adds `source` (the source's name) and `retrievedAt`.
// What a source keeps back (a refusal, a paywall, nothing found) is thrown as `ToolRefusal` with the
// sentence the model should read; anything else that fails becomes a failure record for the operator,
// and the model reads that the source did not answer.

/** The source's answer when it keeps something back: information for the model, not a failure. */
export class ToolRefusal extends Error {
  constructor(message, code = 'tool_refusal', detail = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** The source asked for a pause. `retryAfterMs` is the source's own figure, never one of ours. */
export class RateLimited extends Error {
  constructor(retryAfterMs, message = 'the source asked for a pause') {
    super(message);
    this.retryAfterMs = Number(retryAfterMs);
  }
}

const ID = /^[a-z][a-z0-9-]*$/;

/** Every way an adapter can fail the contract, in words; an empty list is a valid adapter. */
export function validateAdapter(a, verbs) {
  const out = [];
  if (!a || typeof a !== 'object') return ['the default export is not an object'];
  if (!ID.test(String(a.id || ''))) out.push('id must be a-z, digits and dashes');
  if (!a.name || typeof a.name !== 'string') out.push('name (a string) is required');
  if (!a.blurb || typeof a.blurb !== 'string') out.push('blurb (the line the model reads) is required');
  if (a.settings && typeof a.settings !== 'object') out.push('settings must be an object of { env, fallback? }');
  for (const [k, s] of Object.entries(a.settings || {})) {
    if (!s || typeof s.env !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(s.env)) out.push(`setting ${k} needs an environment name in capitals`);
  }
  if (a.usdPerCall !== undefined && (typeof a.usdPerCall !== 'object' || typeof a.usdPerCall.env !== 'string')) out.push('usdPerCall must be { env, fallback }');
  const names = Object.keys(a.verbs || {});
  if (!names.length) out.push('verbs must name at least one verb');
  for (const v of names) {
    if (!verbs[v]) out.push(`verb ${v} is not in server/tools/verbs.js`);
    if (typeof a.verbs[v] !== 'function') out.push(`verb ${v} must be an async function`);
  }
  return out;
}

/** The stand-in beside an adapter: what the guard needs to run it without the real source. */
export function validateStandIn(s) {
  const out = [];
  if (!s || typeof s !== 'object') return ['the default export is not an object'];
  if (typeof s.mount !== 'function') out.push('mount(app) must add the stand-in\'s routes');
  if (typeof s.settings !== 'function') out.push('settings(base) must return the environment that points the adapter at the stand-in');
  if (typeof s.probes !== 'function') out.push('probes(base) must return the calls that prove the adapter reads the stand-in');
  return out;
}

/** One item in the shape every source shares; missing fields are null, never absent. */
export function itemOf(x = {}) {
  return {
    kind: x.kind || 'document',
    title: x.title ?? null,
    site: x.site ?? null,
    url: x.url ?? null,
    id: x.id ?? null,
    date: x.date ?? null,
    text: String(x.text ?? ''),
    note: x.note ?? null,
  };
}
