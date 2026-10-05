// The listing's provider (step 1): OpenAI, as the determinations; DeepSeek's own service (server/deepseek.js, the
// operator's choice of 4 October); or Fireworks, the same model served from the US (server/fireworks.js, 5 October).
// One setting chooses, CIVIC_EXTRACT_PROVIDER; extract.js, index.js and selftest.js ask here, and each provider's
// own rules live in its own file. Determinations are always OpenAI's.
import { config } from './config.js';
import { ApiError, operatorKey, clientFor } from './openai.js';
import { openaiHost } from './providers.js';
import * as deepseek from './deepseek.js';
import * as fireworks from './fireworks.js';

export { openaiHost };

const OWN = { deepseek, fireworks };
const own = () => OWN[config.extractProvider] || null;

export const onDeepSeek = () => config.extractProvider === 'deepseek';
export const onFireworks = () => config.extractProvider === 'fireworks';
/** The listing is not on OpenAI: it does not go through OpenAI's gate, and its waits name its own provider. */
export const onOwnProvider = () => Boolean(own());

/** The listing's provider as /check, the record and the startup line name it. */
export const listingProviderName = () => own()?.NAME || 'OpenAI';

/** The host the listing's requests go to. */
export const listingHost = () => (own() ? own().host() : openaiHost());

/**
 * The key the listing runs on: OpenAI's, as before, or its own provider's. The operator's in every case and never a
 * reader's. A refusal names no provider and no key on the page (the page shows its own sentence for the code); what is
 * wrong is in `detail`, for /check.
 */
export function listingKey({ optional = false } = {}) {
  if (!config.extractProviderKnown) {
    if (optional) return '';
    throw new ApiError(503, 'no_operator_key', '', `CIVIC_EXTRACT_PROVIDER is "${config.extractProvider}"; FactEngine knows openai, deepseek and fireworks. Set it to one of them.`);
  }
  return own() ? own().key({ optional }) : operatorKey({ optional });
}

/** The client the listing talks to. Another provider's carries its own key and address and nothing of OpenAI's. */
export const listingClient = (key) => (own() ? own().client(key) : clientFor(key));

/** A failure of the listing's provider as the page may see it, its own words kept for /check. OpenAI's pass as they are. */
export const listingFailure = (err) => (own() ? own().failure(err) : err);
