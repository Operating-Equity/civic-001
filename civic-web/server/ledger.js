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
 * Where a reply's time went, in words for the service's log: how long the model thought before it wrote its first
 * word, and its tokens of thinking and of writing. Counts and times only, never a word of the reply or of the document.
 */
export function spentWords({ usage, thoughtMs }) {
  const n = (x) => Math.max(0, Number(x) || 0).toLocaleString('en-US');
  const time = thoughtMs == null ? 'it wrote nothing' : `it thought ${Math.round(thoughtMs / 1000)} s before it wrote`;
  const tokens = usage ? `${n(usage.reasoning)} tokens of thinking and ${n((usage.output || 0) - (usage.reasoning || 0))} written` : 'its tokens were not reported';
  return `${time}; ${tokens}`;
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
