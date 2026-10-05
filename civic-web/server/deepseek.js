// DeepSeek, for the listing when the operator puts it there (CIVIC_EXTRACT_PROVIDER=deepseek): the operator's
// choice of 4 October, "I want use DeepSeek flash for the generating of empirical claims. It is 10 times faster
// and better." Determinations stay on OpenAI and never come near this file.
//
// DeepSeek answers OpenAI's Responses API at its own address (https://api.deepseek.com, POST /responses), so
// the listing keeps its request, its stream and its web search, and the SDK is the same one. Three things are
// DeepSeek's own and are handled here:
//   - Its key. The client is built only with DeepSeek's own key. Given none, the SDK would take OPENAI_API_KEY
//     from the environment and send it to DeepSeek; so would it OpenAI's organisation, project, admin key and
//     custom headers. None of OpenAI's settings ever reaches DeepSeek.
//   - Its failures. A key it rejects (401) or a balance used up (402) is shown to a reader as FactEngine's own
//     sentence, naming no provider and no key (the rule of 3 October); DeepSeek's own words go to the record on
//     /check, with the prompts and the key taken out.
//   - Its limits. DeepSeek sends no per-minute figures for the gate to pace by; its limit is 2,500 requests in
//     flight per account, enforced with a 429, which is a wait (extract.js), so the listing on DeepSeek does not
//     go through the gate.
import OpenAI from 'openai';
import { config } from './config.js';
import { HEADER_SAFE } from './key.js';
import { openaiFetch, NO_LIMIT_MS } from './http.js';
import { redactPrompts } from './prompts.js';
import { ApiError, operatorKey, clientFor, describeError } from './openai.js';

export const onDeepSeek = () => config.extractProvider === 'deepseek';

export function deepseekHost() {
  try { return new URL(config.deepseekBaseUrl).hostname; } catch { return 'api.deepseek.com'; }
}

/** OpenAI's host as the shared connection words name it (openai.js), so DeepSeek's waits can name their own. */
export function openaiHost() {
  try { return new URL(config.openaiBaseUrl || 'https://api.openai.com/v1').hostname; } catch { return 'api.openai.com'; }
}

/** The listing's provider as /check and the record name it. */
export const listingProviderName = () => (onDeepSeek() ? 'DeepSeek' : 'OpenAI');

/**
 * The key the listing runs on: OpenAI's, as before, or DeepSeek's when the listing is there. The operator's in
 * either case and never a reader's. A refusal names no provider and no key on the page (the page shows its own
 * sentence for the code); what is wrong is in `detail`, for /check.
 */
export function listingKey({ optional = false } = {}) {
  if (!config.extractProviderKnown) {
    if (optional) return '';
    throw new ApiError(503, 'no_operator_key', '', `CIVIC_EXTRACT_PROVIDER is "${config.extractProvider}"; FactEngine knows openai and deepseek. Set it to one of them.`);
  }
  if (!onDeepSeek()) return operatorKey({ optional });
  const key = config.deepseekKey;
  if (!key) {
    if (optional) return '';
    throw new ApiError(503, 'no_operator_key', '',
      'The listing is set to run on DeepSeek (CIVIC_EXTRACT_PROVIDER=deepseek) and DEEPSEEK_API_KEY is not set. ' +
      'The operator pastes it in Render: the civic service, Environment.');
  }
  if (optional) return key;
  if (!HEADER_SAFE.test(key)) {
    throw new ApiError(400, 'key_not_sendable', '',
      `DEEPSEEK_API_KEY (from ${config.deepseekKeyInfo.source}) holds a space, a line break or another character a request cannot carry. Paste the key alone.`);
  }
  return key;
}

/** Header names OPENAI_CUSTOM_HEADERS would add, each cleared, so none of them reaches DeepSeek. */
function clearedOpenAIHeaders() {
  const out = {};
  for (const line of String(process.env.OPENAI_CUSTOM_HEADERS || '').split('\n')) {
    const colon = line.indexOf(':');
    const name = colon >= 0 ? line.slice(0, colon).trim() : '';
    if (name) out[name] = null;
  }
  return out;
}

/** The client the listing talks to. DeepSeek's carries DeepSeek's key and address and nothing of OpenAI's. */
export function listingClient(key) {
  if (!onDeepSeek()) return clientFor(key);
  if (!key) throw new ApiError(503, 'no_operator_key', '', 'No DeepSeek key: nothing is sent to DeepSeek without one.');
  return new OpenAI({
    apiKey: key,
    adminAPIKey: null,      // never OPENAI_ADMIN_KEY from the environment
    organization: null,     // never OPENAI_ORG_ID
    project: null,          // never OPENAI_PROJECT_ID
    webhookSecret: null,
    baseURL: config.deepseekBaseUrl,
    defaultHeaders: clearedOpenAIHeaders(),
    maxRetries: 0,          // the listing does its own waiting, as on OpenAI
    timeout: NO_LIMIT_MS,   // no time limit of ours (http.js)
    fetch: openaiFetch,
  });
}

/** Text from DeepSeek, made safe to record: no prompt, no key. */
function said(err) {
  let s = redactPrompts(String(err?.error?.message || err?.message || ''));
  if (config.deepseekKey) s = s.split(config.deepseekKey).join('<key>');
  return s.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<key>').slice(0, 1000);
}

/**
 * A DeepSeek failure as the page may see it (no provider, no key) with DeepSeek's own words kept in `detail`
 * for the record on /check. Everything else keeps the shared description (openai.js).
 */
export function deepseekFailure(err) {
  if (err instanceof ApiError) return err;
  const status = err?.status ?? null;
  const words = said(err);
  if (status === 401) return new ApiError(401, 'invalid_key', '', `DeepSeek rejected the key in DEEPSEEK_API_KEY (401${words ? `: ${words}` : ''}).`);
  if (status === 402) {
    return new ApiError(402, 'balance_exhausted', '',
      `DeepSeek answered 402${words ? ` (${words})` : ''}: the account's balance is used up. Top it up in DeepSeek's dashboard, platform.deepseek.com.`);
  }
  const safe = describeError(err);
  return new ApiError(safe.status, safe.code, safe.message, `DeepSeek: ${words || safe.code}`);
}
