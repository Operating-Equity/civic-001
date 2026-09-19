// The connection to OpenAI. It has no time limit of its own.
//
// Node's fetch gives up on a response body that has been silent for five minutes, and every claim
// in a run once failed at that mark with the one word "terminated". No limit of ours replaces it:
// an extraction of a very long document, or a determination at a high reasoning effort, takes as
// long as it takes, and nothing here predicts how long that is. The only thing that ends a request
// early is a connection the network itself reports dead, and that is made again, not counted as a
// failure (openai.js, connectionWait). TCP keepalive makes the report arrive: the operating system
// probes a silent connection and errors it if the other side has gone, and it keeps the path open
// through routers that drop idle connections.
import { Agent, fetch as undiciFetch } from 'undici';

export const openaiAgent = new Agent({
  headersTimeout: 0,               // no limit on when the reply begins
  bodyTimeout: 0,                  // no limit on silence between chunks
  keepAliveTimeout: 30 * 1000,     // an idle pooled connection is dropped after this; not a request limit
  connect: { keepAlive: true, keepAliveInitialDelay: 30 * 1000 },
});

/** fetch bound to that connection. The SDK is given this, so every request to OpenAI uses it. */
export const openaiFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: openaiAgent });

/** The connection to other people's sites, for the link reader. A site can keep two silences: it
 *  can leave the connection attempt unanswered, and it can take the connection and the request and
 *  send nothing back. The Washington Post's servers keep the second for a cloud address: the
 *  connection and the handshake go through, then the request is never answered, and the operating
 *  system reported that after about 71 seconds (ETIMEDOUT read). Both silences are found in the
 *  platform's own ten seconds, the operator's figure: undici's connect timeout for the first and its
 *  headers timeout, set to the same ten seconds, for the second. Nothing else is limited: a page
 *  that has begun to answer takes as long as it takes. */
export const SITE_SILENCE_MS = 10 * 1000;
export const siteAgent = new Agent({ connect: { timeout: SITE_SILENCE_MS }, headersTimeout: SITE_SILENCE_MS });
export const siteFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: siteAgent });

/** The largest delay a timer accepts (about 24.8 days), for a library that insists on one. */
export const NO_LIMIT_MS = 2147483647;
