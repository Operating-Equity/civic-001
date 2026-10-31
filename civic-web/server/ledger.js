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
 * A finished fact-check in words for the service's log (23 October, the operator's "Are you measuring the attributes of
 * the different models"): whose model, how its time went (its work, before the entry's first word and writing it, and
 * its waits apart), the entry's length, its searches, pages and sources, its tokens, its cost and its verdict, and what it
 * took from the operator's list of sites kept out of the research, when one is set. From the fact-check's own ledger
 * line: counts and times only, never a word of the claim or of the entry, never an address.
 */
export function factCheckWords(line) {
  const n = (x) => Math.max(0, Number(x) || 0).toLocaleString('en-US');
  const s = (ms) => `${Math.round((Number(ms) || 0) / 1000)} s`;
  // Every run of the operator's is a trial, whichever model and level (25 October); the readers' are the readers'.
  const who = line.kind !== 'trial' ? 'readers' : 'trial';
  const time = line.writeMs == null ? `worked ${s(line.workMs)} and wrote nothing`
    : `worked ${s(line.workMs)} (${s(line.firstWordMs)} before its first word, ${s(line.writeMs)} writing)`;
  const many = (x, one, more) => `${n(x)} ${Number(x) === 1 ? one : more}`;
  const work = [many(line.queries, 'search', 'searches'), many(line.reads, 'page read', 'pages read'), line.sources == null ? null : many(line.sources, 'source', 'sources')].filter(Boolean).join(', ');
  const u = line.usage;
  const tokens = u ? `; tokens ${n(u.input)} read, ${n(u.reasoning)} thought, ${n((Number(u.output) || 0) - (Number(u.reasoning) || 0))} written` : '';
  const cost = Number.isFinite(Number(line.usd)) ? `; $${Number(line.usd).toFixed(4)}${line.priced === false ? ', unpriced' : ''}` : '';
  const verdict = `${line.verdict || 'no verdict'}${line.verdictSource === 'unread' ? ' (unread)' : ''}${Number.isFinite(line.confidence) ? ` at ${line.confidence}%` : ''}`;
  // With anything kept out of the research set (server/sites.js): what the fact-check took of it ("zero credibility",
  // the operator's word of 25 October), and what it asked for and did not get.
  const listed = line.listed == null ? '' : ` · ${n(line.listed)} of zero credibility${line.keptOut ? `, ${n(line.keptOut)} kept out` : ''}`;
  // With the operator's class for the inspector's name set (31 October, evening): how the entry wrote the name, never it.
  const c = line.nameClass;
  const named = !c ? '' : c.written ? ` · the name ${many(c.written, 'time', 'times')} in its class${c.outside ? `, ${many(c.outside, 'time', 'times')} in full outside it` : ''}` : ' · the name not in its class';
  return `[fact-check] ${line.model} at ${line.effort} (${who}): ${time}, waited ${s(line.waitMs)}; entry ${n(line.entryChars)} characters, ${n(line.entryWords)} words; ${work}${tokens}${cost}; ${verdict}${line.incomplete ? `; stopped early (${line.incomplete})` : ''}${listed}${named}`;
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
