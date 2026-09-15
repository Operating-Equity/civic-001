// The connection to OpenAI, arranged for determinations that think in silence for a long time.
//
// Node's fetch gives up on a response body that has been silent for five minutes. A determination
// at a high reasoning effort can be silent for longer than that while the model reasons and
// searches, and when the silence ran out every claim in a run failed at once with the one word
// "terminated". Here the silence is allowed to last: the first byte of a reply must still arrive
// promptly, TCP keepalive keeps the path open through routers that drop idle connections, and the
// client's own overall limit still applies to the whole request.
import { Agent, fetch as undiciFetch } from 'undici';

export const openaiAgent = new Agent({
  headersTimeout: 5 * 60 * 1000,   // the reply must begin within five minutes
  bodyTimeout: 0,                   // silence between chunks is not a failure
  keepAliveTimeout: 30 * 1000,
  connect: { timeout: 30 * 1000, keepAlive: true, keepAliveInitialDelay: 30 * 1000 },
});

/** fetch bound to that connection. The SDK is given this, so every request to OpenAI uses it. */
export const openaiFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: openaiAgent });
