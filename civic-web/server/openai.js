// OpenAI client helpers. One client per request, built from the key the reader supplied.
import OpenAI from 'openai';
import { config } from './config.js';
import { HEADER_SAFE } from './key.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const KEY_HEADER = 'x-openai-key';

/** Reads and loosely validates the reader's key. Never logged. */
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

export function keyFromRequest(req, { optional = false } = {}) {
  const key = String(req.get(KEY_HEADER) || '').trim();
  // `optional` is the self-check asking. It must be able to look at a broken key and describe it,
  // so it is handed the key as it is; refusing here would break the one page that explains why.
  if (!key && config.serverKey) return optional ? config.serverKey : assertSendable(config.serverKey, config.key.source);
  if (key && !optional) assertSendable(key, 'this browser');
  if (!key && optional) return ''; // the self-check reports a missing key rather than refusing
  if (!key) throw new ApiError(401, 'missing_key', 'An OpenAI API key is required.');
  if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) throw new ApiError(401, 'malformed_key', 'That does not look like an OpenAI API key.');
  return key;
}

export function clientFor(apiKey) {
  return new OpenAI({
    apiKey,
    baseURL: config.openaiBaseUrl || undefined,
    maxRetries: 0, // we do our own retries so streaming stays predictable
    timeout: 30 * 60 * 1000,
  });
}

/** Translates SDK/HTTP errors into something safe to show. Never echoes request content. */
export function describeError(err) {
  const status = err?.status ?? err?.statusCode ?? 500;
  const code = err?.code || err?.error?.code || err?.error?.type || 'openai_error';
  let message = err?.error?.message || err?.message || 'The request to OpenAI failed.';
  message = String(message).slice(0, 2000);
  if (status === 401) return new ApiError(401, 'invalid_key', 'OpenAI rejected the API key.');
  if (status === 429) return new ApiError(429, code, 'OpenAI rate limit or quota reached. ' + message);
  if (status === 404 && /model/i.test(message)) return new ApiError(404, 'model_not_found', message);
  return new ApiError(status >= 400 && status < 600 ? status : 502, code, message);
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
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 504 || err?.code === 'ECONNRESET' || err?.name === 'APIConnectionError';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
