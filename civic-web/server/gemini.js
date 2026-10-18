// Google's Gemini API, for the operator's trial alone (18 October): "I want to test the new Gemini model using argon
// medium and argon high. I have a Gemini key and have deposited $20 to test." Their answers: Gemini searches with
// Google's own search and opens pages itself; the pull-down has an entry for each of the two levels; its summary of its
// own reasoning shows on its card, as the readers' model's does. Readers' fact-checks never come here.
//
// Gemini 4 Argon is served by Google's Interactions API (POST /v1beta/interactions, the key in x-goog-api-key), which
// is not OpenAI's shape, so this file speaks it itself, through the same connection with no time limit of ours
// (server/http.js), and reads its server-sent events. What is Google's own, and handled here (Google's pages of 16
// October):
//   - Its key, the operator's: GEMINI_API_KEY, read whatever its capitals (server/key.js). Nothing of OpenAI's or
//     DeepSeek's travels with it.
//   - Its failures. 401 is a key refused; 403 a key without access to the model (Gemini 4 Argon is paid-tier only);
//     402 the prepaid balance used up ("don't retry": never a wait); 404 a model it does not serve. A 429 is a rate
//     limit, a daily quota or the spend limit of the account's tier, and is a wait, for Google's own figure when it
//     names one. The page shows FactEngine's own sentence; Google's words go to /check with the key taken out.
import { config } from './config.js';
import { HEADER_SAFE } from './key.js';
import { ApiError, describeError } from './openai.js';
import { openaiFetch } from './http.js';
import { providerWords } from './providers.js';

export const NAME = 'Gemini';

/** A model is Gemini's by its name: Google's ids begin so (gemini-4-argon). */
export const isGeminiModel = (id) => /^gemini-/i.test(String(id || ''));

const base = () => String(config.geminiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

export function host() {
  try { return new URL(base()).hostname; } catch { return 'generativelanguage.googleapis.com'; }
}

/** Google's key, the operator's. A refusal names no provider and no key on the page; what is wrong is in `detail`. */
export function key({ optional = false } = {}) {
  const k = config.geminiKey;
  if (!k) {
    if (optional) return '';
    const spellings = config.geminiKeyInfo?.ambiguous || [];
    throw new ApiError(503, 'no_operator_key', '', spellings.length
      ? `GEMINI_API_KEY is saved in Render under ${spellings.join(' and ')}, which differ only in capitals and hold different keys, so neither is used. Keep one, named GEMINI_API_KEY.`
      : 'The operator\'s trial offers Gemini, and GEMINI_API_KEY is not set. The operator pastes it in Render: the civic service, Environment.');
  }
  if (optional) return k;
  if (!HEADER_SAFE.test(k)) {
    throw new ApiError(400, 'key_not_sendable', '',
      `GEMINI_API_KEY (from ${config.geminiKeyInfo.source}) holds a space, a line break or another character a request cannot carry. Paste the key alone.`);
  }
  return k;
}

// The status each of Google's error codes stands for (its error page: snake_case codes on the Interactions API).
const STATUS_OF = {
  invalid_request: 400, failed_precondition: 400, parameter_unknown: 400, authentication: 401, payment_required: 402,
  permission_denied: 403, not_found: 404, model_not_found: 404, rate_limit_exceeded: 429, quota_exceeded: 429,
  too_many_requests: 429, resource_exhausted: 429, cancelled: 499, api_error: 500, internal: 500, unimplemented: 501,
  service_unavailable: 503, unavailable: 503, deadline_exceeded: 504, gateway_timeout: 504,
};

/** How long Google asks to wait, from its RetryInfo or a Retry-After header; null when it names nothing. */
function namedWaitMs(payload, headers) {
  for (const d of payload?.error?.details || []) {
    const m = String(d?.retryDelay || '').match(/^(\d+(?:\.\d+)?)s$/);
    if (m) return Math.round(Number(m[1]) * 1000);
  }
  const seconds = Number(headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** An error the shared helpers (server/openai.js) read as they read the others': a status, a code, a message, a wait. */
function failed({ status, code, message, waitMs = null }) {
  const err = new Error(message || `Gemini answered ${status}.`);
  err.status = status;
  err.code = code || null;
  err.error = { message: err.message, code: err.code };
  err.waitMs = waitMs;
  return err;
}

function refusal(status, payload, headers) {
  const e = payload?.error || {};
  const code = typeof e.code === 'string' ? e.code : e.status ? String(e.status).toLowerCase() : null;
  return failed({ status, code, message: String(e.message || '').slice(0, 2000) || `Gemini answered ${status}.`, waitMs: namedWaitMs(payload, headers) });
}

/** An `error` event inside a running reply, given the status its code stands for, so a rate limit there is a wait. */
export function streamError(ev) {
  const e = ev?.error || {};
  const code = String(e.code || '').toLowerCase();
  const status = STATUS_OF[code] ?? (/rate|quota|exhausted|too_many/.test(code) ? 429 : 502);
  return failed({ status, code: code || null, message: e.message || 'Gemini ended the reply with an error.' });
}

/** The prepaid balance used up: a 402, or (as Google has also sent it) a 429 that says the credits are depleted. */
export function balanceGone(err) {
  const said = String(err?.error?.message || err?.message || '');
  return err?.status === 402 || err?.code === 'payment_required' || /prepay(?:ment)?\s+credits?|credits?\s+(?:are|is)\s+depleted|credit balance\s+(?:is\s+)?depleted/i.test(said);
}

const DONE = Symbol('done');

/** One server-sent event: its `event_type` (or the event's own name) as `type`, and its data as Google sent it. */
function readBlock(block) {
  let name = '';
  const data = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  const raw = data.join('\n');
  if (raw.trim() === '[DONE]') return DONE;
  try {
    const parsed = JSON.parse(raw);
    return { ...parsed, type: parsed?.event_type || name || '' };
  } catch {
    return { type: name || 'unreadable' };
  }
}

async function* serverEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf = (buf + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let at;
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const ev = readBlock(buf.slice(0, at));
      buf = buf.slice(at + 2);
      if (ev === DONE) return;
      if (ev) yield ev;
    }
  }
  const last = readBlock((buf + decoder.decode()).replace(/\r\n/g, '\n').trim());
  if (last && last !== DONE) yield last;
}

/**
 * One interaction, streamed: the body as the caller wrote it, sent with the operator's key and nothing else of anyone's.
 * Returns the reply's events (an async iterator); a refusal at the door throws an error carrying Google's status, code,
 * words and wait. No time limit of ours: a reply at a high level of thinking takes as long as it takes.
 */
export async function stream(body, { key: k, signal }) {
  const res = await openaiFetch(`${base()}/v1beta/interactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-goog-api-key': k },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { error: { message: text.slice(0, 500) } }; }
    throw refusal(res.status, payload, res.headers);
  }
  return serverEvents(res.body);
}

/** Whether Google serves a model to this key, asked without spending a token (GET /v1beta/models/{id}). */
export async function model(id, { key: k }) {
  const res = await openaiFetch(`${base()}/v1beta/models/${encodeURIComponent(id)}`, { headers: { 'x-goog-api-key': k } });
  const text = await res.text().catch(() => '');
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { error: { message: text.slice(0, 500) } }; }
  if (!res.ok) throw refusal(res.status, payload, res.headers);
  return payload;
}

/**
 * The usage of an interaction, in the ledger's terms. Google counts thinking apart from the answer and bills both as
 * output; the pages URL context reads are billed as input (tool-use tokens). Google Search's own results are not
 * billed as input, so where they are counted among the tool-use tokens the estimate is an upper bound.
 */
export function usageOf(u) {
  const n = (v) => Number(v) || 0;
  return {
    input: n(u?.total_input_tokens) + n(u?.total_tool_use_tokens),
    output: n(u?.total_output_tokens) + n(u?.total_thought_tokens),
    reasoning: n(u?.total_thought_tokens),
    cached: n(u?.total_cached_tokens),
  };
}

/** The searches Google bills for an interaction (its grounding count), or null when the usage does not say. */
export function searchesBilled(u) {
  const counts = (u?.grounding_tool_count || []).filter((g) => g?.type === 'google_search');
  return counts.length ? counts.reduce((a, g) => a + (Number(g.count) || 0), 0) : null;
}

/**
 * A Gemini failure as the page may see it (no provider, no key) with Google's own words kept in `detail` for the
 * record on /check. Everything else keeps the shared description (openai.js).
 */
export function failure(err) {
  if (err instanceof ApiError) return err;
  const status = err?.status ?? null;
  const words = providerWords(err, config.geminiKey);
  if (status === 401) return new ApiError(401, 'invalid_key', '', `Gemini rejected the key in GEMINI_API_KEY (401${words ? `: ${words}` : ''}).`);
  if (balanceGone(err)) {
    return new ApiError(402, 'balance_exhausted', '',
      `Gemini answered ${status}${words ? ` (${words})` : ''}: the prepaid balance is used up. Add credits in Google AI Studio, Billing (aistudio.google.com).`);
  }
  if (status === 403) {
    return new ApiError(403, 'invalid_key', '',
      `Gemini refused the key in GEMINI_API_KEY for this model (403${words ? `: ${words}` : ''}). Gemini 4 Argon needs the key of a project on the paid tier, with Prepay credits.`);
  }
  if (status === 404) return new ApiError(404, 'model_not_found', '', `Gemini does not serve this model to this key (404${words ? `: ${words}` : ''}).`);
  const safe = describeError(err);
  return new ApiError(safe.status, safe.code, safe.message, `Gemini: ${words || safe.code}`);
}
