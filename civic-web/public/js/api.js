// Browser side of the CIVIC API. The key is sent per request in a header; the prompts never come back.

const SESSION_KEY = 'civic.openai.key';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The reader's key: session by default, local storage when they ask to remember it. */
// An HTTP header may carry only these characters. A key copied out of a page that shortened it for
// display, ending in an ellipsis rather than the rest of the key, and handing that to fetch() throws
// a TypeError from deep inside the browser that means nothing to a reader. Catch it here instead.
const HEADER_SAFE = /^[\x21-\x7E]+$/;

export function cleanKey(raw) {
  return String(raw ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}
export function keyIsSendable(key) {
  return HEADER_SAFE.test(cleanKey(key));
}
/** The key header, or no header at all when the server carries the operator's own key. */
export function keyHeader(key) {
  const k = cleanKey(key);
  if (!k) return {};
  if (!keyIsSendable(k)) {
    const err = new Error('The key saved in this browser is not a usable key.');
    err.code = 'key_not_sendable';
    throw err;
  }
  return { 'x-openai-key': k };
}

export const keyStore = {
  get() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY) || '';
      const key = cleanKey(raw);
      if (raw && !keyIsSendable(key)) { keyStore.clear(); return ''; } // unusable: drop it rather than fail later
      return key;
    } catch { return ''; }
  },
  set(key, remember) {
    try {
      sessionStorage.setItem(SESSION_KEY, key);
      if (remember) localStorage.setItem(SESSION_KEY, key); else localStorage.removeItem(SESSION_KEY);
    } catch { /* storage unavailable: key lives in memory for this page only */ }
  },
  clear() {
    try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  },
  looksValid(key) {
    return /^sk-[A-Za-z0-9_\-]{20,}$/.test(cleanKey(key));
  },
};

async function throwFromResponse(res) {
  let payload = null;
  try { payload = await res.json(); } catch { /* not json */ }
  const err = payload?.error || {};
  throw new ApiError(res.status, err.code || 'http_error', err.message || `Request failed (${res.status}).`);
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
  const res = await fetch('api/read-url', {
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
  const res = await fetch('api/parse', { method: 'POST', body: form, signal });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

/** POSTs JSON and reads back newline-delimited JSON events until the stream ends. */
export async function streamNdjson(url, body, { key, signal, onEvent }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...keyHeader(key) },
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

export function extract({ text, key, signal, onEvent }) {
  return streamNdjson('api/extract', { text }, { key, signal, onEvent });
}

export function evaluate({ claims, key, signal, onEvent }) {
  return streamNdjson('api/evaluate', { claims }, { key, signal, onEvent });
}

export async function illustrate({ text, key, signal }) {
  const res = await fetch('api/illustrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...keyHeader(key) },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}

export async function challenge({ key, claim, verdict, originalEntry, message, files, signal }) {
  const form = new FormData();
  form.append('claim', claim);
  form.append('verdict', verdict || '');
  form.append('originalEntry', originalEntry || '');
  form.append('message', message || '');
  for (const f of files || []) form.append('files', f, f.name);
  const res = await fetch('api/challenge', { method: 'POST', headers: keyHeader(key), body: form, signal });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}
