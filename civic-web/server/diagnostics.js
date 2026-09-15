// What went wrong, kept where it can be read afterwards.
//
// A message that appears for nine seconds and vanishes is no use to anyone. Every failure, from the
// server or from the page, is recorded here with a time, so /check can show it long after it
// happened and it never has to be caught as it goes past.
//
// Nothing secret is recorded: no key, no prompt text, no document. Only what failed.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX = 50;
const entries = [];

function redact(s) {
  return String(s ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<key>')
    .slice(0, 2000);
}

export function record({ where, code, message, detail, status }) {
  const entry = {
    at: new Date().toISOString(),
    where: String(where || 'server').slice(0, 60),
    code: String(code || '').slice(0, 80),
    status: status ?? null,
    message: redact(message),
    detail: detail ? redact(detail) : null,
  };
  entries.unshift(entry);
  if (entries.length > MAX) entries.length = MAX;
  if (config.errorLogFile) {
    try {
      fs.mkdirSync(path.dirname(config.errorLogFile), { recursive: true });
      fs.appendFileSync(config.errorLogFile, `${JSON.stringify(entry)}\n`);
    } catch { /* a log that cannot be written must never break a run */ }
  }
  return entry;
}

export function recent(n = 10) {
  return entries.slice(0, n);
}

export function clear() {
  entries.length = 0;
}
