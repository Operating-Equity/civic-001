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
  throw new ApiError(res.status, e.code || `http_${res.status}`, e.message || `The server answered ${res.status}.`);
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

export async function parseFile(file, { signal } = {}) {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await call('api/parse', { method: 'POST', body: form, signal });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

/** POSTs JSON and reads back newline-delimited JSON events until the stream ends. */
export async function streamNdjson(url, body, { signal, onEvent }) {
  const res = await call(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await throwFromResponse(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.t === 'ping') continue;
      onEvent(event);
    }
  }
  if (buffer.trim()) {
    try { onEvent(JSON.parse(buffer)); } catch { /* trailing partial line */ }
  }
}

export function extract({ text, source, signal, onEvent }) {
  return streamNdjson('api/extract', { text, source }, { signal, onEvent });
}

export function evaluate({ claims, text, source, signal, onEvent }) {
  return streamNdjson('api/evaluate', { claims, text, source }, { signal, onEvent });
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
