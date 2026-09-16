// OpenAI client helpers. One client per request, built from the key the reader supplied.
import OpenAI from 'openai';
import { config } from './config.js';
import { redactPrompts } from './prompts.js';
import { HEADER_SAFE } from './key.js';
import { openaiFetch, NO_LIMIT_MS } from './http.js';
import { gateFor } from './gate.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}


/** Refuses a key an HTTP header cannot carry, before it reaches the library that would. */
function assertSendable(key, where) {
  if (HEADER_SAFE.test(key)) return key;
  // Without this the key reaches the HTTP library, which refuses it with a message about
  // ByteStrings and character codes: true, and useless to the person reading it.
  const bad = [...key].find((c) => c.codePointAt(0) > 126 || c.codePointAt(0) < 33);
  throw new ApiError(400, 'key_not_sendable',
    `The OpenAI key from ${where} contains a character that cannot be sent in a request` +
    (bad ? ` (${JSON.stringify(bad)})` : '') +
    '. It was probably copied from somewhere that shortened it for display. Open /check for what to do.');
}

/**
 * The key CIVIC runs on. It is the operator's, always, and it is the only one.
 *
 * A reader's own key is never accepted, and this is the first requirement of the product rather
 * than a convenience. Running a prompt on someone else's key hands them the prompt: it travels to
 * OpenAI under their account, appears in whatever their account retains, and any error their
 * account raises can quote it back. `store: false` narrows that exposure; it does not remove it,
 * and it is not the operator's to accept on a stranger's account. So there is no path by which a
 * request from a browser can choose the key. Anything arriving in a key header is ignored outright,
 * not validated and not reported, because there is nothing a reader could send that would be used.
 */
export function operatorKey({ optional = false } = {}) {
  if (!config.serverKey) {
    if (optional) return ''; // the self-check reports a missing key rather than refusing
    throw new ApiError(503, 'no_operator_key',
      'This CIVIC has no OpenAI key of its own, and it will not run on anyone else\'s. ' +
      'The operator sets OPENAI_API_KEY in the settings file beside the server. Open /check.');
  }
  // The self-check must be able to look at a broken key in order to explain it.
  return optional ? config.serverKey : assertSendable(config.serverKey, config.key.source);
}

export function clientFor(apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: config.openaiBaseUrl || undefined,
    maxRetries: 0, // we do our own retries so streaming stays predictable
    timeout: NO_LIMIT_MS, // the SDK insists on a number; this one never arrives (see http.js)
    fetch: openaiFetch,   // the connection with no time limit of its own
  });
}

/** Translates SDK/HTTP errors into something safe to show. Never echoes request content. */
export function describeError(err) {
  const status = err?.status ?? err?.statusCode ?? 500;
  const code = err?.code || err?.error?.code || err?.error?.type || 'openai_error';
  let message = err?.error?.message || err?.message || 'The request to OpenAI failed.';
  // A connection failure arrives as one word ("terminated") with the reason underneath it, in a
  // chain of causes. The whole chain is the message, so the reason is never lost.
  for (let c = err?.cause, depth = 0; c && depth < 3; c = c.cause, depth++) {
    const part = c.message || c.code;
    if (part && !String(message).includes(part)) message += `: ${part}`;
  }
  // An API can quote part of a request back in an error. Nothing of the prompt leaves this way.
  message = redactPrompts(String(message)).slice(0, 2000);
  if (status === 401) return new ApiError(401, 'invalid_key', 'OpenAI rejected the API key.');
  if (status === 429) return isRateLimit(err) ? new ApiError(429, 'rate_limited', message) : new ApiError(429, 'quota_exhausted', message);
  if (status === 404 && /model/i.test(message)) return new ApiError(404, 'model_not_found', message);
  if (isConnectionDrop(err)) return new ApiError(502, 'connection_dropped', message);
  return new ApiError(status >= 400 && status < 600 ? status : 502, code, message);
}

/**
 * The connection failed or was cut, before or during the reply. Nothing OpenAI decided: no status,
 * no verdict on the request. Such a failure is retried like a rate limit; a model or parameter
 * error never is.
 */
export function isConnectionDrop(err) {
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
    'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']);
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.status) return false;
    if (codes.has(e.code)) return true;
    if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true;
    if (/terminated|fetch failed|other side closed|socket hang up|network error/i.test(String(e.message))) return true;
  }
  return false;
}

/**
 * True only when the MODEL ITSELF is unavailable to this key. Deliberately narrow: an error about
 * a parameter (an unsupported reasoning effort, say) must surface as an error, never as a silent
 * switch to a different, weaker model.
 */
export function isModelNotFound(err) {
  const msg = String(err?.error?.message || err?.message || '');
  if (err?.status !== 404 && err?.status !== 400) return false;
  if (/parameter|effort|reasoning|summar|tool|temperature|max_output_tokens/i.test(msg)) return false;
  return /does not exist|do(es)? not have access|not found|no access|unknown model|model_not_found|is not available/i.test(msg);
}

export function isRetryable(err) {
  const s = err?.status;
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 504 || isConnectionDrop(err);
}

/**
 * How many times a failed attempt may be repeated. A rate limit or a 5xx costs nothing, so the
 * operator's full budget applies. A connection cut during the reply has already spent the tokens
 * of that attempt, so it is repeated at most twice: a bad network must not spend nine
 * determinations' worth of tokens on one claim.
 */
export function retryBudget(err) {
  if (isRateLimit(err)) return Infinity;   // pacing, not failure: wait as long as it takes
  return isConnectionDrop(err) ? Math.min(config.evalRetries, 2) : config.evalRetries;
}

/**
 * A rate limit is OpenAI pacing this key: twenty claims at once against a per-minute budget that
 * holds seven, say. That is a queue, never a failure. A used-up quota is not a rate limit.
 */
export function isRateLimit(err) {
  if (err?.status !== 429) return false;
  const code = err?.error?.code || err?.code || '';
  const msg = String(err?.error?.message || err?.message || '');
  return !(code === 'insufficient_quota' || /exceeded your current quota|billing details/i.test(msg));
}

/** How long OpenAI asks to wait, from its headers or its own message; null when it does not say. */
export function rateLimitWaitMs(err) {
  const h = err?.headers;
  const get = (k) => (h && typeof h.get === 'function' ? h.get(k) : h?.[k]) || '';
  const ms = parseFloat(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = parseFloat(get('retry-after'));
  if (Number.isFinite(s) && s > 0) return s * 1000;
  const m = String(err?.error?.message || err?.message || '').match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (m) return Number(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000);
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends one request through the gate for its model: waits until the budget covers it, sends it,
 * gives the gate OpenAI's headers from the reply (or from the refusal), and hands back the reply.
 * `stream` is the Stream for a streaming request, the response object otherwise. The caller must
 * call `release()` when the reply has been consumed, so the gate knows the request is over.
 */
export async function throughGate(client, body, { signal, onHold } = {}) {
  const gate = gateFor(body.model);
  const seq = await gate.admit({ signal, onHold });
  try {
    const { data, response } = await client.responses.create(body, { signal }).withResponse();
    gate.observe(response.headers, { seq });
    return { data, release: () => gate.done() };
  } catch (err) {
    gate.observe(err?.headers, { seq, message: err?.error?.message || err?.message || '', refused: err?.status === 429, waitMs: err?.status === 429 ? rateLimitWaitMs(err) : null });
    gate.done();
    throw err;
  }
}

/**
 * Tries each model id in order until one is accepted by the account. Remembers the winner
 * for the life of the process so later calls skip straight to it.
 */
const resolved = new Map();
export async function withModelFallback(kind, models, run, onFallback) {
  const first = models[0];
  const order = resolved.has(kind) ? [resolved.get(kind), ...models.filter((m) => m !== resolved.get(kind))] : models;
  let lastErr;
  for (const model of order) {
    try {
      const out = await run(model);
      resolved.set(kind, model);
      // A downgrade is never silent: the caller reports it on the card and in the ledger.
      if (model !== first && typeof onFallback === 'function') onFallback({ used: model, requested: first });
      return out;
    } catch (err) {
      lastErr = err;
      if (isModelNotFound(err)) continue;
      throw err;
    }
  }
  throw lastErr;
}

/** Extracts a compact usage record from a completed response. */
export function usageOf(response) {
  const u = response?.usage || {};
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    reasoning: u.output_tokens_details?.reasoning_tokens || 0,
    cached: u.input_tokens_details?.cached_tokens || 0,
  };
}
