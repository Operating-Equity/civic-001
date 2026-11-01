// The record (1 November): what is submitted and what FactEngine finds, kept apart from every account, to test and
// improve the service. The operator: "have you made any provisions for saving the users' outputs and the questions, not
// any user information … it's just real world usage and answers and provides valuable data for testing and of course,
// monitoring, such as being able to predict cost based on question type or even model routing"; their answers: keep the
// documents too, and say so on the privacy page.
//
// Two tables (server/migrations/004-record.sql): the documents, each with its listing; and the fact-checks, each with
// every output and its measures. Nothing of the reader is kept: no account, email, address, run or determination number,
// no fingerprint the books keep of a claim, and no time but the day. A fact-check is tied to its document by a
// fingerprint of the document's text, kept in the record alone.
//
// Whose runs: the operator's (and an open door's), always; a reader's once their account has agreed to the Terms that
// say so (CIVIC_RECORD_TERMS_FROM, the first such version of the Terms), and nothing before. CIVIC_RECORD turns it on;
// without the database there is nothing to keep it in. A row that cannot be written is counted for /check, and the run
// goes on: the record never slows or stops a run.
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
import { dbOn, query } from './db.js';
import { now } from './clock.js';
import { promptVersions } from './prompts.js';

// A run's or a claim's last cost line (its tokens and times), from server/ledger.js, until its end is kept or let go.
const lines = new Map();
let unwritten = 0;            // rows that could not be written since this start
let lastFault = null;         // the last one's words, for /check

const fingerprint = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
const newId = () => crypto.randomUUID();
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
// A day is read as it is written (YYYY-MM-DD), never turned into a moment in this machine's time zone.
pg.types.setTypeParser(1082, (v) => v);

/** Whether the record runs at all: switched on, with the database to keep it in. */
export const recordOn = () => config.record && dbOn();

/**
 * Whether this run is kept: the record on, and the run the operator's (or an open door's), or a reader's whose account
 * agreed to the Terms that say so. `operator` is the server's own reading of the request (server/index.js, seesAll).
 */
export function keeps({ operator, termsVersion }) {
  if (!recordOn()) return false;
  if (operator) return true;
  const from = String(config.recordTermsFrom || '').trim();
  return Boolean(from) && String(termsVersion || '') >= from;
}

/** A cost line, noted for the end it belongs to (server/ledger.js calls this with every line it writes). */
export function noteLine(line, ctx = {}) {
  if (!recordOn()) return;
  if (ctx.determinationId && (line.kind === 'evaluate' || line.kind === 'trial')) lines.set(`d:${ctx.determinationId}`, line);
  else if (ctx.runId && line.kind === 'extract') lines.set(`r:${ctx.runId}`, line);
}

/** The figures of a cost line, without what would tie it to a person or a moment: no ids, no claim fingerprint, no time. */
function measuresOf(line) {
  if (!line) return null;
  const { ts, run, determination, owner, claim, ...rest } = line;
  return rest;
}

/** A row the record could not write: counted, said once in the log, and the run goes on. */
function fault(what, err) {
  unwritten += 1;
  lastFault = `${what}: ${err?.message || err}`;
  console.error(`[record] ${lastFault}`);
}

/** The document's row: found by its fingerprint, or kept now (with its listing when there is one). Returns its id. */
async function documentId({ text, meta, listing = null }) {
  const fp = fingerprint(text);
  const found = await query('SELECT id, listing IS NULL AS bare FROM record_documents WHERE fingerprint = $1', [fp]);
  if (found.rows[0]) {
    if (listing && found.rows[0].bare) await query('UPDATE record_documents SET listing = $2 WHERE id = $1', [found.rows[0].id, listing]);
    return found.rows[0].id;
  }
  const id = newId();
  const m = meta || {};
  const made = await query(
    `INSERT INTO record_documents (id, fingerprint, day, kind, title, author, site, published, url, chars, text, listing)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
    [id, fp, dayOf(now()), m.kind || null, m.title || null, m.author || null, m.site || null, m.published || null, m.url || null, String(text).length, String(text), listing]);
  if (made.rows[0]) return made.rows[0].id;
  return (await query('SELECT id FROM record_documents WHERE fingerprint = $1', [fp])).rows[0]?.id || null;   // kept meanwhile by another claim
}

/** A listing's end: its document and its listing kept (when the run is kept), and its cost line let go either way. */
export function listingEnded({ runId, keep, text, meta, done = null, failure = null }) {
  const line = lines.get(`r:${runId}`) || null;
  lines.delete(`r:${runId}`);
  if (!keep || !text) return;
  const listing = {
    raw: done?.raw ?? null, claims: (done?.claims || []).map((c) => ({ n: c.n, text: c.text, top: c.top })), total: done?.total ?? null,
    model: done?.model ?? line?.model ?? null, effort: done?.effort ?? null, promptVersion: promptVersions().extract?.version || null,
    ms: done?.ms ?? line?.ms ?? null, usd: done?.cost?.usd ?? line?.usd ?? null, priced: done?.cost?.priced ?? line?.priced ?? null,
    incomplete: done?.incomplete ?? null, failure, measures: measuresOf(line),
  };
  documentId({ text, meta, listing }).catch((err) => fault('a document could not be kept', err));
}

/**
 * A claim's end (its `done` or its `error`, as the operator receives it): the fact-check kept (when the run is kept),
 * with its document, and its cost line let go either way.
 */
export function claimEnded({ determinationId, keep, claim, document = null, meta = null, ev, trial = false }) {
  const line = lines.get(`d:${determinationId}`) || null;
  lines.delete(`d:${determinationId}`);
  if (!keep || !claim || !ev) return;
  const done = ev.t === 'done';
  const standby = done && Boolean(ev.standby || ev.fellBack);
  const trail = done && Array.isArray(ev.trail) ? ev.trail : null;
  const row = [
    newId(), dayOf(now()), trial ? 'trial' : standby ? 'standby' : 'readers', String(claim),
    (done ? ev.model : line?.model) || null, (done ? ev.effort : line?.effort) || null,
    standby ? (ev.requested || ev.fellBack?.requested || null) : null, promptVersions().evaluate?.version || null,
    done ? ev.verdict || null : null, done && Number.isFinite(ev.confidence) ? ev.confidence : null,
    done ? ev.conclusion ?? null : null, done ? ev.text ?? null : null, done ? ev.reasoning ?? null : null,
    done && Array.isArray(ev.sources) ? JSON.stringify(ev.sources) : null, trail ? JSON.stringify(trail) : null,
    done ? ev.searches ?? line?.searches ?? null : line?.searches ?? null,
    trail ? trail.filter((s) => s?.kind === 'open_page' || s?.verb === 'open').length : null,
    (done ? ev.cost?.usd : null) ?? line?.usd ?? null, (done ? ev.cost?.priced : null) ?? line?.priced ?? null,
    measuresOf(line) ? JSON.stringify(measuresOf(line)) : null, done ? null : String(ev.code || 'failed'),
  ];
  (async () => {
    const docId = document ? await documentId({ text: document, meta }) : null;
    await query(
      `INSERT INTO record_fact_checks (id, document_id, day, path, claim, model, effort, requested, prompt_version, verdict, confidence,
         conclusion, entry, reasoning, sources, trail, searches, pages, usd, priced, measures, failure)
       VALUES ($1, $22, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [...row, docId]);
  })().catch((err) => fault('a fact-check could not be kept', err));
}

/** The notes of claims that ended without a result (the page stopped the run, the request failed): let go. */
export function letGo(determinationIds = []) {
  for (const id of determinationIds) lines.delete(`d:${id}`);
}

/** The record as /check shows it: whether it runs, whose runs it keeps, how much it holds and since when, its size. */
export async function recordState() {
  const state = { on: recordOn(), switched: config.record, database: dbOn(), termsFrom: String(config.recordTermsFrom || '').trim() || null, unwritten, lastFault };
  if (!state.on) return state;
  try {
    const r = (await query(`SELECT (SELECT count(*) FROM record_documents) AS documents, (SELECT count(*) FROM record_fact_checks) AS fact_checks,
      (SELECT min(day) FROM record_fact_checks) AS since, pg_total_relation_size('record_documents') + pg_total_relation_size('record_fact_checks') AS bytes`)).rows[0];
    return { ...state, documents: Number(r.documents), factChecks: Number(r.fact_checks), since: r.since || null, bytes: Number(r.bytes) };
  } catch (err) {
    return { ...state, error: err.message };
  }
}

const TABLES = { documents: 'record_documents', 'fact-checks': 'record_fact_checks' };
const PAGE = 200;   // rows read at a time, so a large record streams instead of being held whole

/** One table of the record, as JSON lines, oldest first (the operator's download on /check). */
export async function writeRecord(what, res) {
  const table = TABLES[what];
  if (!table) return false;
  res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="factengine-${what}.jsonl"` });
  let after = '';
  let afterDay = '0001-01-01';
  for (;;) {
    const rows = (await query(`SELECT * FROM ${table} WHERE (day, id) > ($1::date, $2) ORDER BY day, id LIMIT ${PAGE}`, [afterDay, after])).rows;
    for (const r of rows) res.write(`${JSON.stringify(r)}\n`);
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1];
    after = last.id;
    afterDay = last.day;
  }
  res.end();
  return true;
}
