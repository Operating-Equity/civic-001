// Browser side of the CIVIC API. No key is held or sent here; the prompts never come back.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// There is no key in the browser. CIVIC runs on the operator's key, held by the server, and never
// on a reader's: a prompt run on someone else's key is a prompt handed to them. Nothing here stores
// a key, sends one, or asks for one.

/** The server's refusal, as the server wrote it: its status, its code and its message. */
async function throwFromResponse(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const e = body?.error || {};
  const err = new ApiError(res.status, e.code || `http_${res.status}`, e.message || `The server answered ${res.status}.`);
  if (e.site) err.site = e.site; // the site a link led to, for the page's own sentence about it
  // The figures of a refusal the reader is expected to meet (a balance, a price, a limit, a wait), so the page can say
  // them in the reader's own language.
  for (const k of ['balanceCents', 'priceCents', 'limitCents', 'spentCents', 'waitSeconds']) if (Number.isFinite(e[k])) err[k] = e[k];
  throw err;
}

// Sign-in. When the server refuses a request for want of a sign-in (401, signin_required), the
// page is asked to obtain one (the account box); once it has, the same request is sent again, so the
// action the reader asked for proceeds on its own once they are signed in. A sign-in the reader
// abandons ends with an AbortError, which every caller treats as silence.
let obtainSignIn = null;
export function onSignInRequired(fn) { obtainSignIn = fn; }
// A sign-in under way is the reader's own time: a stream waiting on it is not a silent connection (streamNdjson).
let signingIn = 0;

async function call(url, init) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 401 && attempt === 0 && obtainSignIn) {
      const body = await res.clone().json().catch(() => null);
      if (body?.error?.code === 'signin_required') {
        signingIn++;
        try { await obtainSignIn(); } finally { signingIn--; }
        continue;
      }
    }
    return res;
  }
}

// How often the server's streams say they are alive (server/stream.js), from /api/health and from each stream's first
// line. A connection that has said nothing for three of these is dead, whatever the browser thinks: on 18 October the
// operator's Safari sat on one for over a minute (a VPN changing its exit), showing "21 claims found" while the listing
// finished at the server. Until the server has said, nothing is counted and the browser alone decides, as before.
let heartbeatMs = null;
const SILENT_BEATS = 3;
const noteHeartbeat = (ms) => { if (Number.isFinite(ms) && ms > 0) heartbeatMs = ms; };

// The account (5 October): sign up, sign in, sign out, and the account's own page. Every body is JSON, and every call
// is the page's own (the server refuses another site's).
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}
async function get(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}
export const signup = ({ email, password, agree }) => post('api/account/signup', { email, password, agree });
export const signin = ({ email, password }) => post('api/account/signin', { email, password });
export const signout = () => post('api/account/signout', {});
export const signoutAll = () => post('api/account/signout-all', {});
export const resetPassword = ({ token, password }) => post('api/account/reset', { token, password });
export const claimAccount = ({ token, email, password, agree }) => post('api/account/claim', { token, email, password, agree });
export const account = () => get('api/account');
export const activity = (before) => get(`api/account/activity${before ? `?before=${encodeURIComponent(before)}` : ''}`);
export const setLimit = (cents) => post('api/account/limit', { cents });
export const changePassword = ({ current, next }) => post('api/account/password', { current, next });
export const deleteAccount = ({ password }) => post('api/account/delete', { password });
// Buying credit (1 November): the server makes the payment and answers with the payment page's address, which the page
// moves to; back from it, the page asks how the payment or the saved card stands. No key or script of the processor's here.
export const startCheckout = ({ amountCents, saveCard }) => post('api/account/checkout', { amountCents, saveCard });
export const checkoutReturn = (session) => get(`api/account/checkout?session=${encodeURIComponent(session)}`);
export const startCardSetup = () => post('api/account/card', {});
export const cardReturn = (session) => get(`api/account/card?session=${encodeURIComponent(session)}`);
export const removeCard = () => post('api/account/card/remove', {});
export const setTopUp = ({ on, levelCents, amountCents, capCents, agreement }) => post('api/account/topup', { on, levelCents, amountCents, capCents, agreement });

export async function health() {
  const res = await fetch('api/health', { cache: 'no-store' });
  if (!res.ok) await throwFromResponse(res);
  const h = await res.json();
  noteHeartbeat(h?.heartbeatMs);
  return h;
}

/** Tells the server what failed, so /check can show it after the message on screen has gone. */
export async function reportFailure(entry) {
  await fetch('api/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

/** Hands a web address to the server, which returns the source's own text. */
export async function readUrl(url, { signal } = {}) {
  const res = await call('api/read-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

/** A link a site refused, looked for elsewhere by the server's search service: { site, publisher, copies }. */
export async function findCopies(url, { signal } = {}) {
  const res = await call('api/find-copies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

/** True when the box holds one web address and nothing else. */
export function looksLikeUrl(s) {
  const v = String(s || '').trim();
  if (!v || /\s/.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(v) && /\.[a-z]{2,}/i.test(v);
}

export async function parseFile(file, { signal } = {}) {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await call('api/parse', { method: 'POST', body: form, signal });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

/** A job id for a run's work, made here so the server keeps the work under it and a cut connection can come back to it. */
export function newJobId(prefix = 'job') {
  const c = globalThis.crypto;
  const rnd = c?.randomUUID ? c.randomUUID() : Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${rnd}`;
}

const abortError = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const id = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(id); reject(abortError()); };
  signal?.addEventListener('abort', stop, { once: true });
});

/**
 * POSTs JSON and reads back newline-delimited JSON events until the job's end.
 *
 * The work is the server's (server/jobs.js): the request names a job (`body.jobId`) and how many
 * of its events this page already holds. A connection that cannot be opened, or is cut before the
 * end, is opened again a second later against the same job, and only the events not yet received
 * are sent, so a cut costs the wait and nothing else: nothing is run twice, nothing is paid twice.
 * Only the server's own refusal of the request (no sign-in, no key, nothing to test) ends it.
 * A connection that goes silent for three of the server's heartbeats, before its reply or in the
 * middle of it, is dead whatever the browser thinks, and is dropped and opened again the same way.
 * `isEnd` names the event that closes the job's story; `onCut` and `onAttached` let the page say
 * what is happening.
 */
export async function streamNdjson(url, body, { signal, onEvent, isEnd = () => false, onCut, onAttached }) {
  let cursor = 0;
  // The id this page gave. The server keeps the work under it, or under one of its own when it
  // would not keep this one; the server's is what every later connection, stop and let-go names.
  let jobId = body?.jobId;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    if (attempt > 0) { onCut?.(); await pause(1000, signal); }
    // This connection's own stop: the page's (`signal`), or the silence's. Only the page's ends the run; the silence's
    // is a cut like any other, and the next connection names the same job and the events it already has.
    const own = new AbortController();
    const stopOwn = () => own.abort();
    signal?.addEventListener('abort', stopOwn, { once: true });
    let heardAt = Date.now();
    const silence = setInterval(() => {
      if (signingIn) { heardAt = Date.now(); return; }
      if (heartbeatMs && Date.now() - heardAt > SILENT_BEATS * heartbeatMs) own.abort();
    }, 1000);
    // The page's own stop, or an abandoned sign-in, ends the run; the silence's stop does not.
    const ends = (err) => signal?.aborted || (err?.name === 'AbortError' && !own.signal.aborted);
    try {
      let res;
      try {
        res = await call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, jobId, cursor }), signal: own.signal });
      } catch (err) {
        if (ends(err)) throw err;
        continue;   // CIVIC could not be reached at all, or did not answer; the job may well be running there: go again
      }
      heardAt = Date.now();
      if (!res.ok) {
        // CIVIC's own refusal (it says so, in its own words) ends the run. A bare 5xx with no word from
        // CIVIC is the way to it (a proxy, a deploy switching over), not CIVIC: the job may well be
        // running, so this is a cut like any other, and the connection is opened again.
        const body = await res.json().catch(() => null);
        if (body?.error || res.status < 500) throw new ApiError(res.status, body?.error?.code || `http_${res.status}`, body?.error?.message || `The server answered ${res.status}.`);
        continue;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let ended = false;
      let finished = false;   // the server said the job is already over when this connection joined
      const take = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.t === 'ping') return;
        if (event.t === 'attached') { cursor = event.from; finished = Boolean(event.finished); if (event.job && event.job !== jobId) jobId = event.job; noteHeartbeat(event.heartbeatMs); onAttached?.(event); return; }
        cursor++;
        if (isEnd(event)) ended = true;
        onEvent(event);
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          heardAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) take(line);
          }
        }
        if (buffer.trim()) take(buffer.trim());
        if (ended || finished) return;   // the job's story is told, or the job is over with no more to tell
      } catch (err) {
        if (ends(err)) throw err;
        if (ended) return;
        // Cut in the middle of the reply (Safari says "Load failed", Chrome "network error"), or silent for too long:
        // the job goes on at the server; this connection is opened again above.
      }
    } finally {
      clearInterval(silence);
      signal?.removeEventListener('abort', stopOwn);
    }
  }
}

/** The page says stop: the jobs' model calls are aborted at the server. `beacon` is for leaving the page. */
export function cancel(jobIds, { beacon = false } = {}) {
  const ids = (jobIds || []).filter(Boolean);
  if (!ids.length) return Promise.resolve();
  const payload = JSON.stringify({ jobIds: ids });
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon('api/cancel', new Blob([payload], { type: 'application/json' }));
    return Promise.resolve();
  }
  return fetch('api/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
}

/** The page says it has all of a finished job, so the server can forget it. */
export function release(jobIds) {
  const ids = (jobIds || []).filter(Boolean);
  if (!ids.length) return Promise.resolve();
  return fetch('api/release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobIds: ids }), keepalive: true }).catch(() => {});
}

export function extract({ jobId, text, source, signal, onEvent, onCut, onAttached }) {
  // The extraction's story ends with its result, or with the server's own error for the run.
  return streamNdjson('api/extract', { jobId, text, source }, { signal, onEvent, onCut, onAttached, isEnd: (ev) => ev.t === 'done' || ev.t === 'error' });
}

export function evaluate({ jobId, claims, text, source, runId, n, extra = {}, signal, onEvent, onCut, onAttached }) {
  // A determination's story ends when the server closes the batch, or with an error for the run itself.
  // The run's name and the claim's number go with it, so the server can say whether this one is free.
  // `extra`: what the page's additions ask of the run (on the operator's page, server/trial.js); the server reads it from
  // no one else. It never takes the place of the request's own fields.
  return streamNdjson('api/evaluate', { ...extra, jobId, claims, text, source, runId: runId || undefined, n: Number.isInteger(n) ? n : undefined }, { signal, onEvent, onCut, onAttached, isEnd: (ev) => ev.t === 'complete' || (ev.t === 'error' && ev.i === undefined) });
}
