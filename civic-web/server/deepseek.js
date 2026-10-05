// DeepSeek's own service, for the listing when the operator puts it there (CIVIC_EXTRACT_PROVIDER=deepseek): the
// operator's choice of 4 October, "I want use DeepSeek flash for the generating of empirical claims. It is 10 times
// faster and better." Determinations stay on OpenAI and never come near this file. (On 5 October the operator moved
// the listing's plan to the same model served from the US, server/fireworks.js; this stays as one setting.)
//
// DeepSeek answers OpenAI's Responses API at its own address (https://api.deepseek.com, POST /responses), so the
// listing keeps its request, its stream and its web search, and the SDK is the same one. Three things are DeepSeek's
// own and are handled here, through server/listing.js:
//   - Its key. The client carries DeepSeek's own key and nothing of OpenAI's (server/providers.js).
//   - Its failures. A key it rejects (401) or a balance used up (402) is shown to a reader as FactEngine's own
//     sentence, naming no provider and no key (the rule of 3 October); DeepSeek's own words go to the record on
//     /check, with the prompts and the key taken out.
//   - Its limits. DeepSeek sends no per-minute figures for the gate to pace by; its limit is 2,500 requests in
//     flight per account, enforced with a 429, which is a wait (extract.js), so the listing on DeepSeek does not
//     go through the gate.
import { config } from './config.js';
import { HEADER_SAFE } from './key.js';
import { ApiError, describeError } from './openai.js';
import { ownClient, providerWords } from './providers.js';

export const NAME = 'DeepSeek';

export function host() {
  try { return new URL(config.deepseekBaseUrl).hostname; } catch { return 'api.deepseek.com'; }
}

/** DeepSeek's key, the operator's. A refusal names no provider and no key on the page; what is wrong is in `detail`. */
export function key({ optional = false } = {}) {
  const k = config.deepseekKey;
  if (!k) {
    if (optional) return '';
    const spellings = config.deepseekKeyInfo?.ambiguous || [];
    throw new ApiError(503, 'no_operator_key', '', spellings.length
      ? `DEEPSEEK_API_KEY is saved in Render under ${spellings.join(' and ')}, which differ only in capitals and hold different keys, so neither is used. Keep one, named DEEPSEEK_API_KEY.`
      : 'The listing is set to run on DeepSeek (CIVIC_EXTRACT_PROVIDER=deepseek) and DEEPSEEK_API_KEY is not set. ' +
        'The operator pastes it in Render: the civic service, Environment.');
  }
  if (optional) return k;
  if (!HEADER_SAFE.test(k)) {
    throw new ApiError(400, 'key_not_sendable', '',
      `DEEPSEEK_API_KEY (from ${config.deepseekKeyInfo.source}) holds a space, a line break or another character a request cannot carry. Paste the key alone.`);
  }
  return k;
}

/** The client the listing talks to: DeepSeek's key and address, nothing of OpenAI's. */
export function client(k) {
  if (!k) throw new ApiError(503, 'no_operator_key', '', 'No DeepSeek key: nothing is sent to DeepSeek without one.');
  return ownClient({ key: k, baseURL: config.deepseekBaseUrl });
}

/**
 * A DeepSeek failure as the page may see it (no provider, no key) with DeepSeek's own words kept in `detail`
 * for the record on /check. Everything else keeps the shared description (openai.js).
 */
export function failure(err) {
  if (err instanceof ApiError) return err;
  const status = err?.status ?? null;
  const words = providerWords(err, config.deepseekKey);
  if (status === 401) return new ApiError(401, 'invalid_key', '', `DeepSeek rejected the key in DEEPSEEK_API_KEY (401${words ? `: ${words}` : ''}).`);
  if (status === 402) {
    return new ApiError(402, 'balance_exhausted', '',
      `DeepSeek answered 402${words ? ` (${words})` : ''}: the account's balance is used up. Top it up in DeepSeek's dashboard, platform.deepseek.com.`);
  }
  const safe = describeError(err);
  return new ApiError(safe.status, safe.code, safe.message, `DeepSeek: ${words || safe.code}`);
}
