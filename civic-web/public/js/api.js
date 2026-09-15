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
export const keyStore = {
  get() {
    try { return sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
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
    return /^sk-[A-Za-z0-9_\-]{20,}$/.test(String(key || '').trim());
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
    headers: { 'content-type': 'application/json', 'x-openai-key': key },
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
    headers: { 'content-type': 'application/json', 'x-openai-key': key },
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
  const res = await fetch('api/challenge', { method: 'POST', headers: { 'x-openai-key': key }, body: form, signal });
  if (!res.ok) await throwFromResponse(res);
  return res.json();
}
