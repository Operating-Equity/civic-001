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
  throw err;
}

// Sign-in. When the server refuses a request for want of a sign-in (401, signin_required), the
// page is asked to obtain one; once it has, the same request is sent again, so the action the
// reader asked for proceeds on its own after the code is accepted. A sign-in the reader abandons
// ends with an AbortError, which every caller treats as silence.
let obtainSignIn = null;
export function onSignInRequired(fn) { obtainSignIn = fn; }

async function call(url, init) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 401 && attempt === 0 && obtainSignIn) {
      const body = await res.clone().json().catch(() => null);
      if (body?.error?.code === 'signin_required') { await obtainSignIn(); continue; }
    }
    return res;
  }
}

export async function signin({ email, code }) {
  const res = await fetch('api/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

export async function signout() {
  const res = await fetch('api/signout', { method: 'POST' });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

export async function health() {
  const res = await fetch('api/health', { cache: 'no-store' });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
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

/** True when the box holds one web address and nothing else. */
export function looksLikeUrl(s) {
  const v = String(s || '').trim();
  if (!v || /\s/.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(v) && /\.[a-z]{2,}/i.test(v);
}

/** A link from a Google app carries a token, not the article's address; the page says so at once. */
export function appLink(s) {
  const v = String(s || '').trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return false; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const open = /^https?:\/\//i.test(u.searchParams.get('q') || u.searchParams.get('url') || '');
  if (host === 'google.com' && (u.pathname === '/goto' || (u.pathname === '/url' && !open))) return true;
  return host === 'news.google.com' && /^\/(articles|read|rss\/articles)\//.test(u.pathname);
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
 * `isEnd` names the event that closes the job's story; `onCut` and `onAttached` let the page say
 * what is happening.
 */
export async function streamNdjson(url, body, { signal, onEvent, isEnd = () => false, onCut, onAttached }) {
  let cursor = 0;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    if (attempt > 0) { onCut?.(); await pause(1000, signal); }
    let res;
    try {
      res = await call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, cursor }), signal });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      continue;   // CIVIC could not be reached at all; the job may well be running there: go again
    }
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
      if (event.t === 'attached') { cursor = event.from; finished = Boolean(event.finished); onAttached?.(event); return; }
      cursor++;
      if (isEnd(event)) ended = true;
      onEvent(event);
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
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
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      if (ended) return;
      // Cut in the middle of the reply (Safari says "Load failed", Chrome "network error"): the
      // job goes on at the server; this connection is opened again above.
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

export function evaluate({ jobId, claims, text, source, signal, onEvent, onCut, onAttached }) {
  // A determination's story ends when the server closes the batch, or with an error for the run itself.
  return streamNdjson('api/evaluate', { jobId, claims, text, source }, { signal, onEvent, onCut, onAttached, isEnd: (ev) => ev.t === 'complete' || (ev.t === 'error' && ev.i === undefined) });
}

export async function illustrate({ text, signal }) {
  const res = await call('api/illustrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

export async function challenge({ claim, verdict, originalEntry, message, files, signal }) {
  const form = new FormData();
  form.append('claim', claim);
  form.append('verdict', verdict || '');
  form.append('originalEntry', originalEntry || '');
  form.append('message', message || '');
  for (const f of files || []) form.append('files', f, f.name);
  const res = await call('api/challenge', { method: 'POST', body: form, signal });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}
