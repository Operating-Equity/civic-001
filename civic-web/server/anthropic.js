// Anthropic's Claude models, for the operator's trial alone (26 October): "I've added a key for Anthropic … The two
// high-end models opus and fable at all levels other than the bottom two tiers … added to the menu of models and the
// inference power." Their answer when Anthropic declines a claim: the card shows the decline, and nothing else answers
// in its place. Readers' fact-checks never come here.
//
// Claude is served by Anthropic's Messages API, through Anthropic's own library (@anthropic-ai/sdk), with its retries
// off and no time limit of ours, over the same connection as the others (server/http.js). What is Anthropic's own, and
// handled here (Anthropic's pages of 26 October):
//   - Its key, the operator's: ANTHROPIC_API_KEY, read whatever its capitals (server/key.js), sent in x-api-key alone.
//     Nothing of OpenAI's, DeepSeek's or Google's travels with it, and the library is never left to read a key or an
//     address of its own from the environment.
//   - Its failures. 401 is a key refused; 403 a key without access; 404 a model it does not serve; a 400 that names
//     the credit balance is the balance used up (never a wait). A 429 is a rate limit, and a 529 Anthropic overloaded:
//     both are waits, for Anthropic's own retry-after when it gives one and a second when it gives none, shown on the
//     operator's card with Anthropic's words, as Google's are. A failure shows FactEngine's own sentence, with
//     Anthropic's words on /check, the key taken out.
//   - Its decline: a reply that ends `refusal`, with the category Anthropic names. It is the claim's end, on the card in
//     Anthropic's words; nothing is tried again and no other model is asked.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { HEADER_SAFE } from './key.js';
import { ApiError, describeError } from './openai.js';
import { openaiFetch, NO_LIMIT_MS } from './http.js';
import { providerWords } from './providers.js';

export const NAME = 'Anthropic';
/** Whose wait a 429 or a 529 is, in the words the operator's card uses: "Anthropic asks to wait". */
export const PROVIDER = 'Anthropic';

/**
 * Anthropic's own words for a refusal, as the operator's card and /check may carry them: the key and any prompt taken
 * out (providerWords), on one line, at most 300 characters.
 */
export function words(err) {
  const s = providerWords(err, config.anthropicKey).replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

/** A model is Anthropic's by its name: Anthropic's ids begin so (claude-opus-5-5). */
export const isAnthropicModel = (id) => /^claude-/i.test(String(id || ''));

const base = () => String(config.anthropicBaseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');

export function host() {
  try { return new URL(base()).hostname; } catch { return 'api.anthropic.com'; }
}

/** Anthropic's key, the operator's. A refusal names no provider and no key on the page; what is wrong is in `detail`. */
export function key({ optional = false } = {}) {
  const k = config.anthropicKey;
  if (!k) {
    if (optional) return '';
    const spellings = config.anthropicKeyInfo?.ambiguous || [];
    throw new ApiError(503, 'no_operator_key', '', spellings.length
      ? `ANTHROPIC_API_KEY is saved in Render under ${spellings.join(' and ')}, which differ only in capitals and hold different keys, so neither is used. Keep one, named ANTHROPIC_API_KEY.`
      : 'The operator\'s trial offers Claude, and ANTHROPIC_API_KEY is not set. The operator pastes it in Render: the civic service, Environment.');
  }
  if (optional) return k;
  if (!HEADER_SAFE.test(k)) {
    throw new ApiError(400, 'key_not_sendable', '',
      `ANTHROPIC_API_KEY (from ${config.anthropicKeyInfo.source}) holds a space, a line break or another character a request cannot carry. Paste the key alone.`);
  }
  return k;
}

/**
 * The library's client for this key: its own retries off (FactEngine waits and goes again itself, saying why), no time
 * limit, the address from the settings, and no token or key but this one.
 */
function client(k) {
  return new Anthropic({ apiKey: k, authToken: null, baseURL: base(), maxRetries: 0, timeout: NO_LIMIT_MS, fetch: openaiFetch });
}

// The status each of Anthropic's error types stands for (its errors page), for an error that arrives inside a running
// reply, where there is no HTTP status of its own.
const STATUS_OF = {
  invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403, not_found_error: 404,
  request_too_large: 413, rate_limit_error: 429, api_error: 500, timeout_error: 504, overloaded_error: 529,
};

/** How long Anthropic asks to wait, from its retry-after header; null when it names nothing. */
function namedWaitMs(headers) {
  const said = String(headers?.get?.('retry-after') ?? '').trim();
  const seconds = said ? Number(said) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** An error the shared helpers (server/openai.js) read as they read the others': a status, a code, a message, a wait. */
function failed({ status, code, message, waitMs = null }) {
  const err = new Error(message || `Anthropic answered ${status}.`);
  err.status = status;
  err.code = code || null;
  err.error = { message: err.message, code: err.code };
  err.waitMs = waitMs;
  return err;
}

/**
 * The library's error in the shared shape. A refusal at the door keeps its status; an `error` event in a running reply
 * gets the status its type stands for, so an overload there is a wait. A connection that broke is passed on as it is,
 * for the shared reading of a cut connection.
 */
function asFailure(err) {
  if (!(err instanceof Anthropic.APIError) || err instanceof Anthropic.APIConnectionError) return err;
  const body = err.error || {};
  const e = body.error || body;
  const type = typeof e.type === 'string' ? e.type : err.type || null;
  const status = err.status ?? STATUS_OF[type] ?? 502;
  const message = String(e.message || '').slice(0, 2000) || `Anthropic answered ${status}.`;
  return failed({ status, code: type, message, waitMs: namedWaitMs(err.headers) });
}

/** A wait of Anthropic's: a rate limit (429) or Anthropic overloaded (529). */
export const isWait = (err) => err?.status === 429 || err?.status === 529;

/** The credit balance used up: Anthropic says so in a 400 (or a billing error), and no wait changes it. */
export function balanceGone(err) {
  const said = String(err?.error?.message || err?.message || '');
  return err?.code === 'billing_error' || err?.status === 402 || /credit balance is too low/i.test(said);
}

/**
 * One reply, streamed: the body as the caller wrote it, sent with the operator's key and nothing else of anyone's.
 * Returns the reply's events (an async iterator) and, once they are read, the whole message as Anthropic sent it
 * (`final`), which is what a paused turn sends back. A refusal at the door, or an error inside the reply, throws an
 * error carrying Anthropic's status, type, words and wait. No time limit of ours.
 */
export function stream(body, { key: k, signal }) {
  const s = client(k).messages.stream(body, { signal });
  async function* events() {
    try {
      for await (const ev of s) yield ev;
    } catch (err) {
      throw asFailure(err);
    }
  }
  const final = async () => {
    try { return await s.finalMessage(); } catch (err) { throw asFailure(err); }
  };
  return { events: events(), final };
}

/**
 * Whether Anthropic serves a model to this key, asked without spending a token (GET /v1/models/{id}). Its answer names
 * the model's own ceiling for `max_tokens`.
 */
export async function model(id, { key: k }) {
  try { return await client(k).models.retrieve(id); } catch (err) { throw asFailure(err); }
}

// Each model's ceiling for `max_tokens`, as Anthropic's Models API names it, asked once for each model and kept while
// the service runs; Anthropic's own documented figure when its answer names none.
const ceilings = new Map();
const DOCUMENTED_CEILING = 128000;   // Anthropic's models page, 26 October: both models write up to 128,000 tokens
export async function ceiling(id, { key: k }) {
  if (ceilings.has(id)) return ceilings.get(id);
  const info = await model(id, { key: k });
  const n = Number(info?.max_tokens) > 0 ? Number(info.max_tokens) : DOCUMENTED_CEILING;
  ceilings.set(id, n);
  return n;
}

/**
 * The usage of a reply, in the ledger's terms. Anthropic bills thinking as output and counts it apart
 * (output_tokens_details.thinking_tokens); what is read from its cache is counted apart from the rest of the input.
 */
export function usageOf(u) {
  const n = (v) => Number(v) || 0;
  return {
    input: n(u?.input_tokens) + n(u?.cache_creation_input_tokens) + n(u?.cache_read_input_tokens),
    output: n(u?.output_tokens),
    reasoning: n(u?.output_tokens_details?.thinking_tokens),
    cached: n(u?.cache_read_input_tokens),
  };
}

/** The searches Anthropic bills for a reply ($10 a thousand), or null when the usage does not say. */
export function searchesBilled(u) {
  const n = u?.server_tool_use?.web_search_requests;
  return typeof n === 'number' ? n : null;
}

/** Anthropic's decline, in its words for the card: its category, and its explanation when it gives one. */
export function declineWords(details) {
  const category = details?.category || null;
  const explanation = String(details?.explanation || '').replace(/\s+/g, ' ').trim();
  const said = category ? `Anthropic declined this claim (${category})` : 'Anthropic declined this claim';
  return explanation ? `${said}: ${explanation.length > 300 ? `${explanation.slice(0, 299)}…` : explanation}` : `${said}.`;
}

/**
 * An Anthropic failure as the page may see it (no provider, no key) with Anthropic's own words kept in `detail` for
 * the record on /check. Everything else keeps the shared description (openai.js).
 */
export function failure(err) {
  if (err instanceof ApiError) return err;
  const status = err?.status ?? null;
  const said = providerWords(err, config.anthropicKey);
  if (status === 401) return new ApiError(401, 'invalid_key', '', `Anthropic rejected the key in ANTHROPIC_API_KEY (401${said ? `: ${said}` : ''}).`);
  if (balanceGone(err)) {
    return new ApiError(402, 'balance_exhausted', '',
      `Anthropic answered ${status}${said ? ` (${said})` : ''}: the credit balance is used up. Add credits in the Claude Console, Billing (platform.claude.com).`);
  }
  if (status === 403) return new ApiError(403, 'invalid_key', '', `Anthropic refused the key in ANTHROPIC_API_KEY for this model (403${said ? `: ${said}` : ''}).`);
  if (status === 404) return new ApiError(404, 'model_not_found', '', `Anthropic does not serve this model to this key (404${said ? `: ${said}` : ''}).`);
  const safe = describeError(err);
  return new ApiError(safe.status, safe.code, safe.message, `Anthropic: ${said || safe.code}`);
}
