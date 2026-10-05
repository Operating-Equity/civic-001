// What every provider the listing can run on, other than OpenAI, shares: DeepSeek's own service (server/deepseek.js)
// and Fireworks (server/fireworks.js). Each answers OpenAI's Responses API at its own address, so the listing talks to
// it with the same SDK; what must never happen is that anything of OpenAI's travels with it.
import OpenAI from 'openai';
import { config } from './config.js';
import { openaiFetch, NO_LIMIT_MS } from './http.js';
import { redactPrompts } from './prompts.js';

/** OpenAI's host as the shared connection words name it (openai.js), so another provider's waits can name their own. */
export function openaiHost() {
  try { return new URL(config.openaiBaseUrl || 'https://api.openai.com/v1').hostname; } catch { return 'api.openai.com'; }
}

/** Header names OPENAI_CUSTOM_HEADERS would add, each cleared, so none of them reaches another provider. */
function clearedOpenAIHeaders() {
  const out = {};
  for (const line of String(process.env.OPENAI_CUSTOM_HEADERS || '').split('\n')) {
    const colon = line.indexOf(':');
    const name = colon >= 0 ? line.slice(0, colon).trim() : '';
    if (name) out[name] = null;
  }
  return out;
}

/**
 * A client for another provider: its key and its address, and nothing of OpenAI's. Built only with a non-empty key:
 * given none, the SDK would take OPENAI_API_KEY from the environment and send it there; so would it OpenAI's
 * organisation, project, admin key and custom headers, which are all cleared here.
 */
export function ownClient({ key, baseURL }) {
  return new OpenAI({
    apiKey: key,
    adminAPIKey: null,      // never OPENAI_ADMIN_KEY from the environment
    organization: null,     // never OPENAI_ORG_ID
    project: null,          // never OPENAI_PROJECT_ID
    webhookSecret: null,
    baseURL,
    defaultHeaders: clearedOpenAIHeaders(),
    maxRetries: 0,          // the listing does its own waiting, as on OpenAI
    timeout: NO_LIMIT_MS,   // no time limit of ours (http.js)
    fetch: openaiFetch,
  });
}

/** What a provider said, made safe to record: no prompt, no key. */
export function providerWords(err, key) {
  let s = redactPrompts(String(err?.error?.message || err?.message || ''));
  if (key) s = s.split(key).join('<key>');
  return s.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<key>').replace(/fw_[A-Za-z0-9_-]{8,}/g, 'fw_<key>').slice(0, 1000);
}
