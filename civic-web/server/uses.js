// Uses of a code. A use is a run started under it: the request that starts an extraction, and
// nothing else (a connection that joins a run already started is the same run). The operator's
// rule of 18 September, for cost control until there is revenue against it: a code allows five
// runs, or the number its own entry in CIVIC_ACCESS_CODES gives (ABCD234:150).
//
// The record is a file with one line per use, holding the code's fingerprint (never the code),
// the two characters the sign-in log also shows, the email typed at the sign-in, and the run's
// job id. It is read at start, so a restart forgets nothing; in the cloud it lives on the
// persistent disk, so a deploy forgets nothing either.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { codes, fingerprintOf } from './access.js';

const counts = new Map();   // fingerprint → uses so far

try {
  if (config.usesFile && fs.existsSync(config.usesFile)) {
    for (const line of fs.readFileSync(config.usesFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e?.fp) counts.set(e.fp, (counts.get(e.fp) || 0) + 1); } catch { /* a torn line */ }
    }
  }
} catch { /* the count starts at nothing */ }

/** Runs this code allows: its own entry's figure, or the general one. */
export function allowance(code) {
  const own = config.accessAllowances[code];
  return Number.isFinite(own) ? own : config.codeUses;
}

export function used(code) { return counts.get(fingerprintOf(code)) || 0; }

/** The use is written before the run starts, so a crash in between never gives a run for free. */
export function recordUse(code, email, jobId) {
  const fp = fingerprintOf(code);
  const entry = { at: new Date().toISOString(), fp, code: code.slice(-2), email: String(email || '').slice(0, 254), job: jobId };
  counts.set(fp, (counts.get(fp) || 0) + 1);
  if (config.usesFile) {
    try {
      fs.mkdirSync(path.dirname(config.usesFile), { recursive: true });
      fs.appendFileSync(config.usesFile, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      console.error(`[civic] the uses record could not be written: ${err?.message || err}`);
    }
  }
  console.log(`[civic] run ${counts.get(fp)} of ${allowance(code)} under the code ending ${entry.code} (${entry.email || 'no email given'})`);
  return entry;
}

/** Every listed code, by its last two characters, with what it has used and what it allows. For /check. */
export function summary() {
  return codes().map((code) => ({ ending: code.slice(-2), used: used(code), allowed: allowance(code) }));
}
