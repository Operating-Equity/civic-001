// Credit (5 October): the append-only ledger whose sum is a reader's balance. The operator: "assume everyone who signs
// up gets $10 in their account", with payments the last step. A row is never changed once written:
//   grant       +amount  the credit a new account starts with (CIVIC_SIGNUP_GRANT_CENTS)
//   hold        -amount  a test's price, held when the test starts
//   charge       0       the hold was delivered: the test is paid (the hold's own -amount stands)
//   release     +amount  the hold was not delivered (an error, a stop, an update, a crash): the price comes back
//   adjustment  ±amount  the operator, on /check
//   purchase    +amount  payments, when they exist
//   refund      -amount  payments, when they exist
// A hold is settled once (a unique index on the settlements). The balance is the sum of `cents`; this month's spend is
// the held amounts of this month that were not released (charged, or still running).
//
// Postgres when DATABASE_URL is set, memory otherwise. The memory paths are synchronous from the check to the write, so
// two tests starting together on a balance for one cannot both pass the check (JavaScript runs one of them first).
import { dbOn, query } from './db.js';
import { now } from './clock.js';

export const KINDS = ['grant', 'hold', 'charge', 'release', 'adjustment', 'purchase', 'refund'];

// ---- memory ------------------------------------------------------------------------------------------
const mem = { rows: [], nextId: 1 };
const memSettled = (holdId) => mem.rows.find((r) => r.holdId === holdId && (r.kind === 'charge' || r.kind === 'release')) || null;
const memInsert = (row) => { const r = { id: mem.nextId++, at: now(), cents: 0, amountCents: 0, holdId: null, determinationId: null, runId: null, note: null, byEmail: null, ...row }; mem.rows.push(r); return r; };

/** The first instant of the calendar month (UTC) that `ms` falls in, and the first of the next. */
export function monthOf(ms) {
  const d = new Date(ms);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

const q = (c) => (c ? c.query.bind(c) : query);
const rowOf = (r) => ({ id: Number(r.id), userId: Number(r.user_id), at: r.at instanceof Date ? r.at.getTime() : Number(r.at), kind: r.kind, cents: r.cents, amountCents: r.amount_cents, holdId: r.hold_id === null ? null : Number(r.hold_id), determinationId: r.determination_id, runId: r.run_id, note: r.note, byEmail: r.by_email });

/** A reader's balance in cents. Inside a transaction, pass its client. */
export async function balanceOf(userId, c = null) {
  if (!dbOn()) return memBalance(userId);
  const r = await q(c)('SELECT COALESCE(sum(cents), 0)::bigint AS b FROM credit WHERE user_id = $1', [userId]);
  return Number(r.rows[0].b);
}
function memBalance(userId) { let b = 0; for (const r of mem.rows) if (r.userId === userId) b += r.cents; return b; }

/** What a reader's tests this month (UTC) have held and not had back: charged, or still running. */
export async function monthSpent(userId, atMs, c = null) {
  const { start } = monthOf(atMs);
  if (!dbOn()) return memMonthSpent(userId, start);
  const r = await q(c)(
    "SELECT COALESCE(sum(h.amount_cents), 0)::bigint AS s FROM credit h WHERE h.user_id = $1 AND h.kind = 'hold' AND h.at >= $2 AND NOT EXISTS (SELECT 1 FROM credit s WHERE s.hold_id = h.id AND s.kind = 'release')",
    [userId, new Date(start)]);
  return Number(r.rows[0].s);
}
function memMonthSpent(userId, start) {
  let s = 0;
  for (const r of mem.rows) if (r.userId === userId && r.kind === 'hold' && r.at >= start && memSettled(r.id)?.kind !== 'release') s += r.amountCents;
  return s;
}

/** The sign-up credit, inside the transaction that makes the account. */
export async function grant(userId, cents, note, c = null) {
  if (!(cents > 0)) return null;
  if (!dbOn()) return memInsert({ userId, kind: 'grant', cents, amountCents: cents, note }).id;
  const r = await q(c)("INSERT INTO credit (user_id, at, kind, cents, amount_cents, note) VALUES ($1, $4, 'grant', $2, $2, $3) RETURNING id", [userId, cents, note, new Date(now())]);
  return Number(r.rows[0].id);
}

/**
 * Holds a test's price, or says why not: { holdId } or { refused: 'credit_short' | 'month_limit', balanceCents,
 * priceCents, limitCents, spentCents }. In Postgres it runs inside the caller's transaction, with the user's row locked
 * first, so two tests starting together see each other's hold. In memory the check and the write are one synchronous step.
 */
export async function hold(userId, priceCents, { determinationId = null, runId = null, atMs = now(), limitCents = null } = {}, c = null) {
  if (!dbOn()) return memHold(userId, priceCents, { determinationId, runId, atMs, limitCents });
  await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const balanceCents = await balanceOf(userId, c);
  if (balanceCents < priceCents) return { refused: 'credit_short', balanceCents, priceCents };
  if (limitCents !== null && limitCents !== undefined) {
    const spentCents = await monthSpent(userId, atMs, c);
    if (spentCents + priceCents > limitCents) return { refused: 'month_limit', balanceCents, priceCents, limitCents, spentCents };
  }
  const r = await c.query("INSERT INTO credit (user_id, at, kind, cents, amount_cents, determination_id, run_id) VALUES ($1, $6, 'hold', $2, $3, $4, $5) RETURNING id",
    [userId, -priceCents, priceCents, determinationId, runId, new Date(atMs)]);
  return { holdId: Number(r.rows[0].id), balanceCents: balanceCents - priceCents, priceCents };
}
function memHold(userId, priceCents, { determinationId, runId, atMs, limitCents }) {
  const balanceCents = memBalance(userId);
  if (balanceCents < priceCents) return { refused: 'credit_short', balanceCents, priceCents };
  if (limitCents !== null && limitCents !== undefined) {
    const spentCents = memMonthSpent(userId, monthOf(atMs).start);
    if (spentCents + priceCents > limitCents) return { refused: 'month_limit', balanceCents, priceCents, limitCents, spentCents };
  }
  const row = memInsert({ userId, kind: 'hold', cents: -priceCents, amountCents: priceCents, determinationId, runId, at: atMs });
  return { holdId: row.id, balanceCents: balanceCents - priceCents, priceCents };
}

/** The memory store's hold and settlement, synchronous, for a caller that must check and write in one step. */
export function holdNow(userId, priceCents, opts = {}) { return memHold(userId, priceCents, { determinationId: null, runId: null, atMs: now(), limitCents: null, ...opts }); }
export function settleNow(holdId, kind) {
  if (!holdId || memSettled(holdId)) return false;
  const h = mem.rows.find((r) => r.id === holdId && r.kind === 'hold');
  if (!h) return false;
  memInsert({ userId: h.userId, kind, cents: kind === 'release' ? h.amountCents : 0, amountCents: h.amountCents, holdId, determinationId: h.determinationId, runId: h.runId });
  return true;
}

/** Settles a hold once: 'charge' (the test was delivered) or 'release' (it was not; the price comes back). A second settlement does nothing. */
export async function settle(holdId, kind, c = null) {
  if (!holdId) return false;
  if (kind !== 'charge' && kind !== 'release') throw new Error(`a hold is settled by a charge or a release, not ${kind}`);
  if (!dbOn()) return settleNow(holdId, kind);
  const r = await q(c)(
    `INSERT INTO credit (user_id, at, kind, cents, amount_cents, hold_id, determination_id, run_id)
       SELECT h.user_id, $3, $2, CASE WHEN $2 = 'release' THEN h.amount_cents ELSE 0 END, h.amount_cents, h.id, h.determination_id, h.run_id
         FROM credit h WHERE h.id = $1 AND h.kind = 'hold'
     ON CONFLICT (hold_id) WHERE kind IN ('charge', 'release') DO NOTHING`, [holdId, kind, new Date(now())]);
  return r.rowCount > 0;
}

/** The operator adds (or takes back) credit by hand, with a note. */
export async function adjust(userId, cents, { note = null, byEmail = null } = {}) {
  if (!Number.isInteger(cents) || cents === 0) throw new Error('an adjustment is a whole number of cents, not zero');
  if (!dbOn()) return memInsert({ userId, kind: 'adjustment', cents, amountCents: Math.abs(cents), note, byEmail }).id;
  const r = await query("INSERT INTO credit (user_id, at, kind, cents, amount_cents, note, by_email) VALUES ($1, $6, 'adjustment', $2, $3, $4, $5) RETURNING id", [userId, cents, Math.abs(cents), note, byEmail, new Date(now())]);
  return Number(r.rows[0].id);
}

/** A reader's ledger rows, newest first: up to `limit` from before the instant `beforeAt` (ms), with each hold's settlement. */
export async function rowsFor(userId, { beforeAt = null, limit = 50 } = {}) {
  // The settlements are not lines of their own: each hold's line says how it ended (charged, not charged, or running).
  let rows;
  const settlements = new Map();
  if (!dbOn()) {
    rows = mem.rows.filter((r) => r.userId === userId && r.kind !== 'charge' && r.kind !== 'release' && (beforeAt === null || r.at < beforeAt))
      .sort((a, b) => b.at - a.at || b.id - a.id).slice(0, limit + 1);
    for (const r of rows) if (r.kind === 'hold') { const s = memSettled(r.id); if (s) settlements.set(r.id, s.kind); }
  } else {
    rows = (await query("SELECT * FROM credit WHERE user_id = $1 AND kind NOT IN ('charge', 'release') AND ($2::timestamptz IS NULL OR at < $2) ORDER BY at DESC, id DESC LIMIT $3",
      [userId, beforeAt === null ? null : new Date(beforeAt), limit + 1])).rows.map(rowOf);
    const holds = rows.filter((r) => r.kind === 'hold').map((r) => r.id);
    if (holds.length) for (const s of (await query("SELECT hold_id, kind FROM credit WHERE hold_id = ANY($1::bigint[]) AND kind IN ('charge', 'release')", [holds])).rows) settlements.set(Number(s.hold_id), s.kind);
  }
  const more = rows.length > limit;
  return {
    rows: rows.slice(0, limit).map((r) => ({ ...r, state: r.kind === 'hold' ? (settlements.get(r.id) === 'charge' ? 'charged' : settlements.get(r.id) === 'release' ? 'released' : 'held') : null })),
    more,
  };
}

/** Every account's balance, this month's spend and charged tests, for the operator's table on /check. */
export async function summaryByUser(atMs) {
  const { start } = monthOf(atMs);
  const out = new Map();
  if (!dbOn()) {
    for (const r of mem.rows) {
      const s = out.get(r.userId) || { balanceCents: 0, monthCents: 0, tests: 0 };
      s.balanceCents += r.cents;
      if (r.kind === 'hold' && r.at >= start && memSettled(r.id)?.kind !== 'release') s.monthCents += r.amountCents;
      if (r.kind === 'charge') s.tests++;
      out.set(r.userId, s);
    }
    return out;
  }
  const r = await query(
    `SELECT user_id, COALESCE(sum(cents), 0)::bigint AS balance,
            COALESCE(sum(amount_cents) FILTER (WHERE kind = 'hold' AND at >= $1 AND NOT EXISTS (SELECT 1 FROM credit s WHERE s.hold_id = credit.id AND s.kind = 'release')), 0)::bigint AS month,
            count(*) FILTER (WHERE kind = 'charge') AS tests
       FROM credit GROUP BY user_id`, [new Date(start)]);
  for (const x of r.rows) out.set(Number(x.user_id), { balanceCents: Number(x.balance), monthCents: Number(x.month), tests: Number(x.tests) });
  return out;
}

/** The credit given and the credit spent, all accounts together: /check's line under the measurement. */
export async function totals() {
  if (!dbOn()) {
    let grantedCents = 0, spentCents = 0; const accounts = new Set();
    for (const r of mem.rows) {
      if (r.kind === 'grant' || (r.kind === 'adjustment' && r.cents > 0)) { grantedCents += r.cents; if (r.kind === 'grant') accounts.add(r.userId); }
      if (r.kind === 'charge') spentCents += r.amountCents;
    }
    return { grantedCents, spentCents, accounts: accounts.size, collectedCents: 0 };
  }
  const r = await query(`SELECT COALESCE(sum(cents) FILTER (WHERE kind = 'grant' OR (kind = 'adjustment' AND cents > 0)), 0)::bigint AS granted,
                                COALESCE(sum(amount_cents) FILTER (WHERE kind = 'charge'), 0)::bigint AS spent,
                                count(DISTINCT user_id) FILTER (WHERE kind = 'grant') AS accounts FROM credit`);
  return { grantedCents: Number(r.rows[0].granted), spentCents: Number(r.rows[0].spent), accounts: Number(r.rows[0].accounts), collectedCents: 0 };
}

/**
 * At boot, after the reaper has failed rows left running too long: every hold with no settlement is settled by its
 * determination. Charged when the row is done and names that hold as its own; left alone while the row is running and
 * names it (another instance may still be running it: a deploy's old instance); released in every other case (the row
 * failed, the hold was superseded by a later attempt, or the row is gone).
 */
export async function reconcile() {
  if (!dbOn()) return { charged: 0, released: 0 };
  const open = (await query(`SELECT h.id, d.status, d.hold_id FROM credit h LEFT JOIN determinations d ON d.id = h.determination_id
     WHERE h.kind = 'hold' AND NOT EXISTS (SELECT 1 FROM credit s WHERE s.hold_id = h.id AND s.kind IN ('charge', 'release'))`)).rows;
  let charged = 0, released = 0;
  for (const h of open) {
    const mine = h.hold_id !== null && Number(h.hold_id) === Number(h.id);
    if (h.status === 'running' && mine) continue;
    if (h.status === 'done' && mine) { if (await settle(Number(h.id), 'charge')) charged++; }
    else if (await settle(Number(h.id), 'release')) released++;
  }
  return { charged, released };
}

/** The guard's view of the memory ledger. */
export function memRows() { return mem.rows.map((r) => ({ ...r })); }
