// The connection to OpenAI. It has no time limit of its own.
//
// Node's fetch gives up on a response body that has been silent for five minutes, and every claim
// in a run once failed at that mark with the one word "terminated". No limit of ours replaces it:
// an extraction of a very long document, or a determination at a high reasoning effort, takes as
// long as it takes, and nothing here predicts how long that is. The only failure is a connection
// the network itself reports dead. TCP keepalive makes that report arrive: the operating system
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

/** The largest delay a timer accepts (about 24.8 days), for a library that insists on one. */
export const NO_LIMIT_MS = 2147483647;
