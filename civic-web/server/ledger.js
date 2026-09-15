// Append-only cost ledger for internal accounting (revenue minus cost of goods sold).
// One JSON line per API call. Never stores claim text or the key; the claim is
// represented by a short hash so repeated claims can be recognised.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

let ready = false;
function ensure() {
  if (ready || !config.ledgerFile) return ready;
  fs.mkdirSync(path.dirname(config.ledgerFile), { recursive: true });
  ready = true;
  return ready;
}

export function claimHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
}

export function record(entry) {
  if (!config.ledgerFile || !ensure()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFile(config.ledgerFile, line + '\n', (err) => { if (err) console.error('[ledger] write failed:', err.code); });
}
