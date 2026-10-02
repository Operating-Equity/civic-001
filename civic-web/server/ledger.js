// Append-only cost ledger for internal accounting (revenue minus cost of goods sold).
// One JSON line per API call. Never stores claim text or the key; the claim is
// represented by a short hash so repeated claims can be recognised.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { costLine } from './economics.js';

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

/**
 * One line per call. `ctx` names whose work it was (the run, the determination, the sign-in that
 * started it), so the economics can put the cost on the right row; the ids go on the JSONL line too.
 */
export function record(entry, ctx = {}) {
  const line = { ts: new Date().toISOString(), ...entry, ...(ctx.runId ? { run: ctx.runId } : {}), ...(ctx.determinationId ? { determination: ctx.determinationId } : {}), ...(ctx.owner ? { owner: ctx.owner } : {}) };
  try { costLine(line, ctx); } catch (err) { console.error('[ledger] the economics could not take the line:', err?.message || err); }
  if (!config.ledgerFile || !ensure()) return;
  fs.appendFile(config.ledgerFile, JSON.stringify(line) + '\n', (err) => { if (err) console.error('[ledger] write failed:', err.code); });
}
