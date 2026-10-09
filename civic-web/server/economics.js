// Facts have a price, and every user is measured. The operator's program of 2 October, in their
// words: "All empirical facts are parsed and listed for Free, and the user can then decide which
// or all to test, with 0 to 3 free facts, and cost and revenue measured for all users in each
// tier"; "the average needs to be marked up 25% to start"; "change every 6 hours unless one is
// very unprofitable and I am losing a lot of money. Become 1 until we earn it back"; "I need to
// test, measure, and optimize."
//
// What this module decides, and nothing else:
//   the tier    a run's tier is fixed when its extraction starts and holds for that document:
//               tier 1 prices every claim, tiers 2 and 3 give the first one or two claims the
//               reader chooses free (and a tier 4 in CIVIC_TIER_ORDER three). The tiers rotate
//               every CIVIC_TIER_HOURS in CIVIC_TIER_ORDER (1,2,3 since 6 October: "0, 1, or 2
//               answers, not 3"), and each day the rotation starts CIVIC_TIER_SHIFT tiers later,
//               so every tier meets every time of day. CIVIC_TIER_FIXED holds one.
//   the price   one list price for everyone and every window, CIVIC_LIST_PRICE_CENTS (the
//               operator's of 6 October: "Remove all pricing from the application except the list
//               price ... each fact-check is $1.25"). Unset, nothing is priced. The measured average
//               cost of a determination over CIVIC_PRICE_WINDOW_DAYS is still measured, for the
//               operator's check page, and never sets the price. No figure of ours.
//   the guard   CIVIC_TIER_LOSS_GUARD_USD: when the current window's margin falls below minus
//               that figure, every new run goes to tier 1 and stays there until the margin
//               earned since covers the loss; then the rotation resumes. Unset, off.
//   the books   revenue is booked at list price for every priced determination that reaches
//               done, marked not collected until payments exist; a free one books nothing and
//               counts as given; a failed one keeps its cost, books nothing and never uses up a
//               free one. Cost is the determination's own ledger line (tokens and searches at
//               the price table); the extraction's cost stays on the run, apart.
// The rows live in Postgres when DATABASE_URL is set (server/db.js), so nothing resets with a
// deploy; without it, in this instance's memory, which a restart empties. The reader is told the
// tier, the free count and the price, and never a cost.
import { config } from './config.js';
import { dbOn, query, tx, migrate } from './db.js';
import * as credit from './credit.js';
import { ApiError } from './openai.js';

const DAY = 86400e3;
const HOUR = 3600e3;

// ---- the clock -----------------------------------------------------------------------------------
// Real time, unless the guard set CIVIC_CLOCK: then the instant it names, running from boot (server/clock.js).
export { now } from './clock.js';
import { now } from './clock.js';

export function enabled() { return Boolean(config.pricingEnabled); }

// ---- pure arithmetic (the guard drives these with any instant) ------------------------------------
const hoursOf = (h) => Math.max(1 / 60, Number(h) || 6) * HOUR;

export function windowStartAt(ms, hours = config.tierHours) { const w = hoursOf(hours); return Math.floor(ms / w) * w; }
export function nextChangeAt(ms, hours = config.tierHours) { return windowStartAt(ms, hours) + hoursOf(hours); }

/** The rotation's tier at an instant: order[(window index + day index × shift) mod the order's length], or the fixed tier. */
export function tierAt(ms, { hours = config.tierHours, order = config.tierOrder, shift = config.tierShift, fixed = config.tierFixed } = {}) {
  if (Number.isInteger(fixed) && fixed > 0) return fixed;
  const list = Array.isArray(order) && order.length ? order : [1, 2, 3];
  const w = hoursOf(hours);
  const windowIndex = Math.floor(ms / w);
  const dayIndex = Math.floor(ms / DAY);
  const n = list.length;
  const k = (((windowIndex + dayIndex * (Number.isInteger(shift) ? shift : 0)) % n) + n) % n;
  return list[k];
}

/** Claims the reader may test free on one document under a tier: tier 1 none, tier 2 one, tier 3 two (and a tier 4 three). */
export function freeFor(tier) { return Math.max(0, (Number.parseInt(tier, 10) || 1) - 1); }

/** The list price, in cents, or null when the operator has set none (then nothing is priced). */
export function listPrice() { return Number.isInteger(config.listPriceCents) && config.listPriceCents >= 0 ? config.listPriceCents : null; }

/** Settings of the price as it was measured before 6 October, that nothing reads any more: named while they are still set. */
export function retiredSettings() { return ['CIVIC_PRICE_START_CENTS', 'CIVIC_PRICE_MIN_SAMPLE'].filter((n) => String(process.env[n] || '').trim()); }

// ---- the rows -------------------------------------------------------------------------------------
const mem = { runs: new Map(), dets: new Map(), windows: new Map(), guard: [], lines: [], chat: [] };   // lines: { at, kind, ms, searches, tokens } of finished calls, for the durations; chat: the replies' ledger lines
// The attempts this instance has open, `${id}@${attempt}` → { id, attempt, holdId }: failed as `deploy` when it is told to
// stop. Keyed by attempt, so a job stopped while the same claim is taken up again here (the page's next request) closes
// its own attempt and never the new one.
const inFlight = new Map();
const attemptKey = (id, attempt) => `${id}@${attempt}`;

const ms = (v) => (v === null || v === undefined ? null : (v instanceof Date ? v.getTime() : Number(v)));
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const rowRun = (r) => ({ id: r.id, owner: r.owner, email: r.email, userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id), codeFp: r.code_fp, startedAt: ms(r.started_at), tier: r.tier, windowStart: ms(r.window_start), priceCents: r.price_cents, freeAllowed: r.free_allowed, chars: r.chars, claimsTotal: r.claims_total, extractUsd: num(r.extract_usd), status: r.status });
const rowDet = (d) => ({ id: d.id, runId: d.run_id, n: d.n, startedAt: ms(d.started_at), endedAt: ms(d.ended_at), status: d.status, failure: d.failure, free: d.free, priceCents: d.price_cents, costUsd: num(d.cost_usd), priced: d.priced, searches: d.searches, verdict: d.verdict, model: d.model, chars: d.chars, collected: d.collected, holdId: d.hold_id === null || d.hold_id === undefined ? null : Number(d.hold_id), attempt: Number(d.attempt || 1), rerun: Boolean(d.rerun), kind: d.kind || 'fact', parentId: d.parent_id ?? null, turn: d.turn ?? null, fingerprint: d.fingerprint ?? null });
const rowWindow = (w) => ({ windowStart: ms(w.window_start), tier: w.tier, priceCents: w.price_cents, avgCostUsd: w.avg_cost_usd === null ? null : num(w.avg_cost_usd), sample: w.sample, basis: w.basis });
const rowGuard = (g) => ({ at: ms(g.at), engaged: g.engaged, windowStart: ms(g.window_start), lossUsd: num(g.loss_usd), earnedUsd: num(g.earned_usd) });

const warn = (what, err) => console.error(`[economics] ${what}: ${err?.message || err}`);

async function loadRun(id) {
  if (!id) return null;
  if (dbOn()) { const r = await query('SELECT * FROM runs WHERE id = $1', [id]); return r.rows[0] ? rowRun(r.rows[0]) : null; }
  return mem.runs.get(id) || null;
}

async function runsSince(sinceMs) {
  if (dbOn()) return (await query('SELECT * FROM runs WHERE started_at >= $1 ORDER BY started_at', [new Date(sinceMs)])).rows.map(rowRun);
  return [...mem.runs.values()].filter((r) => r.startedAt >= sinceMs);
}

/** The fact-checks started in [from, to): the price, the tiers, the guard and the money are theirs. A conversation's replies are measured apart (chatReport). */
async function determinationsBetween(fromMs, toMs) {
  if (dbOn()) return (await query("SELECT * FROM determinations WHERE started_at >= $1 AND started_at < $2 AND kind = 'fact' ORDER BY started_at", [new Date(fromMs), new Date(Math.min(toMs, 8.64e15))])).rows.map(rowDet);
  return [...mem.dets.values()].filter((d) => d.startedAt >= fromMs && d.startedAt < toMs && (d.kind || 'fact') === 'fact');
}

/** Revenue at list, cost and margin of the determinations started in [from, to). A failed one keeps its cost and books nothing. */
async function moneyBetween(fromMs, toMs) {
  const dets = await determinationsBetween(fromMs, toMs);
  return money(dets);
}
function money(dets) {
  let revenue = 0, cost = 0, free = 0, done = 0, failed = 0;
  for (const d of dets) {
    cost += d.costUsd;
    if (d.status === 'done') { done++; if (d.free) free++; else revenue += d.priceCents / 100; }
    else if (d.status === 'failed') failed++;
  }
  return { revenue, cost, margin: revenue - cost, free, done, failed };
}

// ---- the price of a window ------------------------------------------------------------------------
async function windowRow(ws) {
  if (dbOn()) { const r = await query('SELECT * FROM windows WHERE window_start = $1', [new Date(ws)]); return r.rows[0] ? rowWindow(r.rows[0]) : null; }
  return mem.windows.get(ws) || null;
}

/** The measured average: done, priced determinations started in the days before `until`. */
async function measured(until, days = config.priceWindowDays) {
  const sample = (await determinationsBetween(until - Math.max(0, days) * DAY, until)).filter((d) => d.status === 'done' && d.priced);
  const n = sample.length;
  const avg = n ? sample.reduce((s, d) => s + d.costUsd, 0) / n : null;
  return { avgUsd: avg, sample: n };
}

/**
 * The window's price: the list price, whatever the window held before. A row priced otherwise (the 49 cents a window
 * was fixed at before 6 October, or a list price the operator has since changed) is rewritten the next time it is
 * asked, so the price changes from the deploy that brings it, the current window included; a document listed before
 * keeps the price it was told (runs.price_cents). The measured average and its sample go on the row as they stand
 * then, for the operator's history of the windows; they never set the price.
 */
export async function priceForWindow(ws) {
  const priceCents = listPrice();
  const basis = priceCents === null ? 'none' : 'list';
  const existing = await windowRow(ws);
  if (existing && existing.priceCents === priceCents && existing.basis === basis) return existing;
  const m = await measured(ws);
  const row = { windowStart: ws, tier: tierAt(ws), priceCents, avgCostUsd: m.avgUsd, sample: m.sample, basis };
  if (dbOn()) {
    await query(`INSERT INTO windows (window_start, tier, price_cents, avg_cost_usd, sample, basis) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (window_start) DO UPDATE SET tier = EXCLUDED.tier, price_cents = EXCLUDED.price_cents, avg_cost_usd = EXCLUDED.avg_cost_usd, sample = EXCLUDED.sample, basis = EXCLUDED.basis`,
    [new Date(ws), row.tier, priceCents, m.avgUsd, m.sample, basis]);
    return (await windowRow(ws)) || row;
  }
  mem.windows.set(ws, row);
  return row;
}

// ---- the loss guard -------------------------------------------------------------------------------
async function guardEvents() {
  if (dbOn()) return (await query('SELECT * FROM guard_events ORDER BY at, id')).rows.map(rowGuard);
  return mem.guard;
}
async function addGuardEvent(ev) {
  if (dbOn()) { await query('INSERT INTO guard_events (at, engaged, window_start, loss_usd, earned_usd) VALUES ($1, $2, $3, $4, $5)', [new Date(ev.at), ev.engaged, ev.windowStart === null ? null : new Date(ev.windowStart), ev.lossUsd, ev.earnedUsd]); return; }
  mem.guard.push(ev);
}

/** Where the guard stands at an instant: off, watching this window's margin, or engaged and counting what has been earned back. */
export async function guardState(at = now()) {
  const threshold = config.tierLossGuardUsd;
  if (!(threshold > 0)) return { configured: false, engaged: false, thresholdUsd: null };
  const events = await guardEvents();
  const last = events[events.length - 1] || null;
  if (last && last.engaged) {
    const since = await moneyBetween(last.at, Infinity);
    return { configured: true, engaged: true, thresholdUsd: threshold, since: last.at, lossUsd: last.lossUsd, earnedUsd: since.margin };
  }
  const ws = windowStartAt(at);
  const window = await moneyBetween(ws, Infinity);
  return { configured: true, engaged: false, thresholdUsd: threshold, windowStart: ws, windowMarginUsd: window.margin, released: last ? last.at : null };
}

/** The guard's decision for a run starting now: tier 1 or the rotation; the switch either way is recorded as an event. */
async function guardDecide(at) {
  const g = await guardState(at);
  if (!g.configured) return { tier1: false, state: g };
  if (g.engaged) {
    if (g.earnedUsd >= g.lossUsd) {
      await addGuardEvent({ at, engaged: false, windowStart: windowStartAt(at), lossUsd: g.lossUsd, earnedUsd: g.earnedUsd });
      return { tier1: false, state: { ...g, engaged: false, released: at } };
    }
    return { tier1: true, state: g };
  }
  if (g.windowMarginUsd < -g.thresholdUsd) {
    const lossUsd = -g.windowMarginUsd;
    await addGuardEvent({ at, engaged: true, windowStart: g.windowStart, lossUsd, earnedUsd: 0 });
    return { tier1: true, state: { ...g, engaged: true, since: at, lossUsd, earnedUsd: 0 } };
  }
  return { tier1: false, state: g };
}

// ---- runs and determinations ----------------------------------------------------------------------
/**
 * A run starts: its tier and its window's price are fixed here and hold for the document. The same id asked for again
 * (a page joining its run on a new instance) gets the row it already has, and only its own: with accounts on, a run
 * belongs to the account that started it.
 */
export async function openRun({ id, owner = null, email = null, userId = null, codeFp = null, chars = null }) {
  if (!enabled() || !id) return null;
  const existing = await loadRun(id);
  if (existing) {
    if ((existing.owner ?? null) !== (owner ?? null)) throw Object.assign(new ApiError(403, 'not_your_job', 'That run belongs to another sign-in.'), { expected: true });
    return existing;
  }
  const at = now();
  const ws = windowStartAt(at);
  const guard = await guardDecide(at);
  const tier = guard.tier1 ? 1 : tierAt(at);
  const win = await priceForWindow(ws);
  const run = { id, owner, email, userId, codeFp, startedAt: at, tier, windowStart: ws, priceCents: win.priceCents, freeAllowed: freeFor(tier), chars, claimsTotal: null, extractUsd: 0, status: 'running' };
  if (dbOn()) {
    await query('INSERT INTO runs (id, owner, email, user_id, code_fp, started_at, tier, window_start, price_cents, free_allowed, chars, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING',
      [id, owner, email, userId, codeFp, new Date(at), tier, new Date(ws), win.priceCents, run.freeAllowed, chars, 'running']);
    return (await loadRun(id)) || run;
  }
  mem.runs.set(id, run);
  return run;
}

export async function finishRun(id, { claimsTotal = null, status = 'done' } = {}) {
  if (!enabled() || !id) return;
  try {
    if (dbOn()) await query("UPDATE runs SET claims_total = COALESCE($2, claims_total), status = $3 WHERE id = $1 AND status = 'running'", [id, claimsTotal, status]);
    else { const r = mem.runs.get(id); if (r && r.status === 'running') { r.claimsTotal = claimsTotal ?? r.claimsTotal; r.status = status; } }
  } catch (err) { warn('the run could not be closed', err); }
}

/** What the page is told for one determination: free, priced at the run's price, or nothing when nothing is priced. */
const quoteOf = (det, run) => {
  if (!run || run.priceCents === null || run.priceCents === undefined) return { free: null, priceCents: null };
  return det.free ? { free: true, priceCents: 0 } : { free: false, priceCents: run.priceCents };
};

const fmtCents = (cents) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: config.currency }).format((Number(cents) || 0) / 100); } catch { return `${((Number(cents) || 0) / 100).toFixed(2)} ${config.currency}`; } };
const expected = (err, extra = null) => Object.assign(err, { expected: true }, extra ? { extra } : {});
/** The refusals of a claim the reader's credit or limit cannot cover: before any model call, with the figures. */
function creditRefusal(h) {
  if (h.refused === 'credit_short') {
    return expected(new ApiError(402, 'credit_short', `Testing this claim costs ${fmtCents(h.priceCents)}; your balance is ${fmtCents(h.balanceCents)}.`),
      { balanceCents: h.balanceCents, priceCents: h.priceCents });
  }
  return expected(new ApiError(402, 'month_limit', `This test would take this month's tests past your limit of ${fmtCents(h.limitCents)}.`),
    { limitCents: h.limitCents, spentCents: h.spentCents, priceCents: h.priceCents, balanceCents: h.balanceCents });
}
const runRequired = () => expected(new ApiError(400, 'run_required', 'Test a claim from a document listed under this account.'));
const alreadyTested = () => expected(new ApiError(409, 'already_tested', 'This claim was tested already.'));

/**
 * A determination starts: the server decides, never the page, whether it is one of the document's free ones (the run's
 * count so far, failed ones and this one excepted) or priced at the run's price, and, with accounts on, holds that price
 * from the reader's credit (server/credit.js) or refuses before the model is asked. The run's row and then the reader's
 * are locked while that is decided, so three claims starting together cannot all be the last free one, and two tabs
 * cannot spend one balance twice.
 *
 * Each start is an attempt with a hold of its own. The same id coming back with no job behind it here (a deploy's new
 * instance, a crash, a stop and a new request) opens the next attempt: decided and held again, the earlier attempt's
 * hold released, and only the newest attempt can be charged. A claim already delivered gets one more go, never charged
 * again (its result was lost on the way), and only for the same claim: the row keeps a fingerprint of what was asked,
 * so the free second go cannot test another claim under a delivered one's id; after that one go, 409.
 *
 * A conversation's reply (server/chat.js) is a row of kind `chat` under its fact-check (`parentId`, `turn`): never one
 * of the document's free ones, and not priced while the operator's trial runs (nothing is held for it).
 *
 * Returns the quote, { free, priceCents }, with the attempt, its hold and the balance after it.
 */
export async function openDetermination({ id, runId = null, n = null, chars = null, userId = null, owner = null, limitCents = null, requireRun = false, kind = 'fact', parentId = null, turn = null, fingerprint = null }) {
  if (!enabled() || !id) return null;
  const at = now();
  const chat = kind === 'chat';
  if (dbOn()) {
    return tx(async (c) => {
      const hadRow = (await c.query('SELECT * FROM determinations WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const had = hadRow ? rowDet(hadRow) : null;
      const rid = had ? had.runId : runId;
      let run = null;
      if (rid) { const r = await c.query('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [rid]); run = r.rows[0] ? rowRun(r.rows[0]) : null; }
      if (requireRun && (!run || (run.owner ?? null) !== (owner ?? null))) throw runRequired();
      if (had && had.status === 'done') {
        if (had.rerun || (had.fingerprint && fingerprint && had.fingerprint !== fingerprint)) throw alreadyTested();
        const attempt = had.attempt + 1;
        await c.query("UPDATE determinations SET status = 'running', attempt = $2, rerun = true, hold_id = NULL WHERE id = $1", [id, attempt]);
        inFlight.set(attemptKey(id, attempt), { id, attempt, holdId: null });
        return { ...quoteOf({ free: had.free }, run), attempt, holdId: null, balanceCents: null, rerun: true };
      }
      let free = false;
      if (run && !chat) {
        const used = Number((await c.query("SELECT count(*) FROM determinations WHERE run_id = $1 AND free AND status <> 'failed' AND id <> $2", [run.id, id])).rows[0].count);
        free = used < run.freeAllowed;
      }
      const price = run && !free && !chat && Number.isInteger(run.priceCents) ? run.priceCents : 0;
      let holdId = null, balanceCents = null;
      if (userId && price > 0) {
        const h = await credit.hold(userId, price, { determinationId: id, runId: run.id, atMs: at, limitCents }, c);
        if (h.refused) throw creditRefusal(h);
        holdId = h.holdId; balanceCents = h.balanceCents;
      }
      let attempt = 1;
      if (had) {
        attempt = had.attempt + 1;
        if (had.holdId) await credit.settle(had.holdId, 'release', c);   // the earlier attempt's hold: its price comes back
        await c.query("UPDATE determinations SET status = 'running', started_at = $2, ended_at = NULL, failure = NULL, free = $3, price_cents = $4, hold_id = $5, attempt = $6, rerun = false, fingerprint = COALESCE($7, fingerprint) WHERE id = $1",
          [id, new Date(at), free, price, holdId, attempt, fingerprint]);
      } else {
        await c.query('INSERT INTO determinations (id, run_id, n, started_at, status, free, price_cents, chars, hold_id, attempt, kind, parent_id, turn, fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12, $13)',
          [id, run ? run.id : null, n, new Date(at), 'running', free, price, chars, holdId, chat ? 'chat' : 'fact', parentId, turn, fingerprint]);
      }
      inFlight.set(attemptKey(id, attempt), { id, attempt, holdId });
      return { ...quoteOf({ free }, run), attempt, holdId, balanceCents };
    });
  }
  // Memory: everything from the free count to the hold and the row is one synchronous step, so nothing interleaves.
  const had = mem.dets.get(id) || null;
  const run = (had ? had.runId : runId) ? mem.runs.get(had ? had.runId : runId) || null : null;
  if (requireRun && (!run || (run.owner ?? null) !== (owner ?? null))) throw runRequired();
  if (had && had.status === 'done') {
    if (had.rerun || (had.fingerprint && fingerprint && had.fingerprint !== fingerprint)) throw alreadyTested();
    const attempt = had.attempt + 1;
    Object.assign(had, { status: 'running', attempt, rerun: true, holdId: null });
    inFlight.set(attemptKey(id, attempt), { id, attempt, holdId: null });
    return { ...quoteOf(had, run), attempt, holdId: null, balanceCents: null, rerun: true };
  }
  let free = false;
  if (run && !chat) {
    let used = 0;
    for (const d of mem.dets.values()) if (d.runId === run.id && d.id !== id && d.free && d.status !== 'failed') used++;
    free = used < run.freeAllowed;
  }
  const price = run && !free && !chat && Number.isInteger(run.priceCents) ? run.priceCents : 0;
  let holdId = null, balanceCents = null;
  if (userId && price > 0) {
    const h = credit.holdNow(userId, price, { determinationId: id, runId: run.id, atMs: at, limitCents });
    if (h.refused) throw creditRefusal(h);
    holdId = h.holdId; balanceCents = h.balanceCents;
  }
  let attempt = 1;
  if (had) {
    attempt = had.attempt + 1;
    if (had.holdId) credit.settleNow(had.holdId, 'release');
    Object.assign(had, { status: 'running', startedAt: at, endedAt: null, failure: null, free, priceCents: price, holdId, attempt, rerun: false, fingerprint: fingerprint ?? had.fingerprint });
  } else {
    const det = { id, runId: run ? run.id : null, n, startedAt: at, endedAt: null, status: 'running', failure: null, free, priceCents: price, costUsd: 0, priced: true, searches: 0, verdict: null, model: null, chars, collected: false, holdId, attempt: 1, rerun: false, kind: chat ? 'chat' : 'fact', parentId, turn, fingerprint };
    // Memory is not a database: a long-lived instance without one lets its oldest finished rows go past twenty thousand.
    if (mem.dets.size >= 20000) { for (const [k, d] of mem.dets) { if (d.status !== 'running') { mem.dets.delete(k); if (mem.dets.size < 15000) break; } } }
    mem.dets.set(id, det);
  }
  inFlight.set(attemptKey(id, attempt), { id, attempt, holdId });
  return { ...quoteOf({ free }, run), attempt, holdId, balanceCents };
}

/**
 * The end of one attempt. If it is still the row's own: done books its revenue at list and charges its hold; anything
 * else books nothing, keeps the cost and releases the hold. A superseded attempt (the claim was taken up again
 * meanwhile) only ever has its hold released. A second go at a delivered claim ends done, whatever happens to it.
 */
export async function book(id, { attempt = null, status = 'done', verdict = null, model = null, failure = null } = {}) {
  if (!enabled() || !id) return;
  let k = attempt === null ? null : attemptKey(id, attempt);
  if (k === null) for (const [x, v] of inFlight) if (v.id === id) { k = x; attempt = v.attempt; }
  const open = (k && inFlight.get(k)) || { id, attempt, holdId: null };
  if (k) inFlight.delete(k);
  const done = status === 'done';
  const at = now();
  try {
    if (dbOn()) {
      await tx(async (c) => {
        const row = (await c.query('SELECT status, attempt, hold_id, rerun FROM determinations WHERE id = $1 FOR UPDATE', [id])).rows[0];
        const current = row && row.status === 'running' && (open.attempt === null || Number(row.attempt) === open.attempt);
        if (!current) { if (open.holdId) await credit.settle(open.holdId, 'release', c); return; }
        if (row.rerun) {
          await c.query("UPDATE determinations SET status = 'done', ended_at = $2, verdict = COALESCE($3, verdict), model = COALESCE($4, model) WHERE id = $1", [id, new Date(at), done ? verdict : null, done ? model : null]);
          return;
        }
        await c.query("UPDATE determinations SET status = $2, ended_at = $3, verdict = COALESCE($4, verdict), model = COALESCE($5, model), failure = $6, price_cents = CASE WHEN $2 = 'done' THEN price_cents ELSE 0 END WHERE id = $1",
          [id, done ? 'done' : 'failed', new Date(at), verdict, model, done ? null : (failure || status)]);
        if (row.hold_id !== null) await credit.settle(Number(row.hold_id), done ? 'charge' : 'release', c);
      });
    } else {
      const d = mem.dets.get(id);
      const current = d && d.status === 'running' && (open.attempt === null || d.attempt === open.attempt);
      if (!current) { if (open.holdId) credit.settleNow(open.holdId, 'release'); return; }
      if (d.rerun) { Object.assign(d, { status: 'done', endedAt: at, verdict: done ? verdict ?? d.verdict : d.verdict, model: done ? model ?? d.model : d.model }); return; }
      Object.assign(d, { status: done ? 'done' : 'failed', endedAt: at, verdict: verdict ?? d.verdict, model: model ?? d.model, failure: done ? null : (failure || status), priceCents: done ? d.priceCents : 0 });
      if (d.holdId) credit.settleNow(d.holdId, done ? 'charge' : 'release');
    }
  } catch (err) { warn('the determination could not be booked', err); }
}

/** Attempts of a request that ended without a result of their own (the job was stopped, or the whole request failed): [{ id, attempt }]. */
export async function closeOpen(entries, failure = 'ended') {
  for (const e of entries || []) {
    const { id, attempt } = typeof e === 'string' ? { id: e, attempt: null } : e;
    if (attempt === null || attempt === undefined) { for (const v of [...inFlight.values()]) if (v.id === id) await book(id, { attempt: v.attempt, status: 'failed', failure }); }
    else if (inFlight.has(attemptKey(id, attempt))) await book(id, { attempt, status: 'failed', failure });
  }
}

/** This instance is being stopped (a deploy): every attempt it still has open is failed as such, cost kept, nothing booked, its hold released. */
export async function closeAllOpen(failure = 'deploy') {
  await closeOpen([...inFlight.values()].map((v) => ({ id: v.id, attempt: v.attempt })), failure);
}

/** The tests of an account that were free (its runs' free determinations that did not fail), newest first: its Activity. */
export async function freeTestsFor(userId, { beforeAt = null, limit = 50 } = {}) {
  if (!userId) return { rows: [], more: false };
  let rows;
  if (dbOn()) {
    rows = (await query(`SELECT d.* FROM determinations d JOIN runs r ON r.id = d.run_id
      WHERE r.user_id = $1 AND d.free AND d.status <> 'failed' AND ($2::timestamptz IS NULL OR d.started_at < $2)
      ORDER BY d.started_at DESC LIMIT $3`, [userId, beforeAt === null ? null : new Date(beforeAt), limit + 1])).rows.map(rowDet);
  } else {
    rows = [...mem.dets.values()].filter((d) => d.free && d.status !== 'failed' && mem.runs.get(d.runId)?.userId === userId && (beforeAt === null || d.startedAt < beforeAt))
      .sort((a, b) => b.startedAt - a.startedAt).slice(0, limit + 1);
  }
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** The claim number and verdict of each determination named: id → { n, verdict, status }. Never the claim's text, which is not kept. */
export async function testsByIds(ids) {
  const out = new Map();
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return out;
  if (dbOn()) for (const d of (await query('SELECT id, n, verdict, status FROM determinations WHERE id = ANY($1::text[])', [list])).rows) out.set(d.id, { n: d.n, verdict: d.verdict, status: d.status });
  else for (const id of list) { const d = mem.dets.get(id); if (d) out.set(id, { n: d.n, verdict: d.verdict, status: d.status }); }
  return out;
}

/** A ledger line arrives (server/ledger.js): kept whole with its ids, and its cost put on the determination or the run it belongs to. */
export function costLine(line, ctx = {}) {
  if (!enabled()) return;
  const usd = Number(line.usd) || 0;
  const priced = line.priced !== false;
  const searches = Number(line.searches) || 0;
  const kind = String(line.kind || '');
  if (dbOn()) {
    query('INSERT INTO cost_lines (at, kind, run_id, determination_id, owner, model, usd, priced, ok, line) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [new Date(line.ts || now()), kind || 'unknown', ctx.runId || null, ctx.determinationId || null, ctx.owner || null, line.model || null, usd, line.priced ?? null, line.ok ?? null, JSON.stringify(line)])
      .catch((err) => warn('a cost line could not be kept', err));
    if (ctx.determinationId && (kind === 'evaluate' || kind === 'chat')) {
      query('UPDATE determinations SET cost_usd = cost_usd + $2, priced = priced AND $3, searches = searches + $4 WHERE id = $1', [ctx.determinationId, usd, priced, searches]).catch((err) => warn('a determination\'s cost could not be kept', err));
    } else if (ctx.runId && kind === 'extract') {
      query('UPDATE runs SET extract_usd = extract_usd + $2 WHERE id = $1', [ctx.runId, usd]).catch((err) => warn('a run\'s listing cost could not be kept', err));
    }
    return;
  }
  if (ctx.determinationId && (kind === 'evaluate' || kind === 'chat')) { const d = mem.dets.get(ctx.determinationId); if (d) { d.costUsd += usd; d.priced = d.priced && priced; d.searches += searches; } }
  else if (ctx.runId && kind === 'extract') { const r = mem.runs.get(ctx.runId); if (r) r.extractUsd += usd; }
  if (line.ok !== false && Number.isFinite(Number(line.ms))) { mem.lines.push({ at: Number(line.ts) || now(), kind, ms: Number(line.ms), searches, tokens: tokensOf(line.usage) }); if (mem.lines.length > 20000) mem.lines.splice(0, mem.lines.length - 15000); }
  if (kind === 'chat' && line.ok !== false) { mem.chat.push({ at: Number(new Date(line.ts)) || now(), line }); if (mem.chat.length > 20000) mem.chat.splice(0, mem.chat.length - 15000); }
}

/** The latest turn a fact-check's conversation has had delivered (0: none): a page's older history cannot go on past it. */
export async function latestReply(parentId) {
  if (!enabled() || !parentId) return 0;
  if (dbOn()) return Number((await query("SELECT COALESCE(max(turn), 0) AS turn FROM determinations WHERE parent_id = $1 AND kind = 'chat' AND status = 'done'", [parentId])).rows[0].turn) || 0;
  let turn = 0;
  for (const d of mem.dets.values()) if (d.parentId === parentId && d.kind === 'chat' && d.status === 'done') turn = Math.max(turn, d.turn || 0);
  return turn;
}

/**
 * The conversation's replies over the window, measured apart from the fact-checks (the operator's trial): how many, and
 * for each turn the mean tokens (read and written, cached included), cost and minutes; and, for each version of the chat
 * prompt, how many replies said the inspector's name (and how often), had a prompt's words held back, or cited a source
 * that names the inspector. From the ledger's lines, which carry no text.
 */
async function chatReport(since) {
  let lines;
  if (dbOn()) lines = (await query("SELECT line FROM cost_lines WHERE at >= $1 AND kind = 'chat' AND ok IS NOT FALSE", [new Date(since)])).rows.map((r) => r.line);
  else lines = mem.chat.filter((x) => x.at >= since).map((x) => x.line);
  const byTurn = new Map();
  const byVersion = new Map();
  for (const l of lines) {
    const turn = Number(l.turn) || 0;
    if (!byTurn.has(turn)) byTurn.set(turn, { turn, replies: 0, tokens: 0, counted: 0, usd: 0, ms: 0 });
    const t = byTurn.get(turn);
    t.replies++; t.usd += Number(l.usd) || 0; t.ms += Number(l.ms) || 0;
    const tokens = tokensOf(l.usage);
    if (tokens) { t.tokens += tokens; t.counted++; }
    const version = l.prompts?.chat || 'unknown';
    if (!byVersion.has(version)) byVersion.set(version, { version, replies: 0, named: 0, nameSaid: 0, held: 0, sourcesNaming: 0 });
    const v = byVersion.get(version);
    v.replies++;
    if (Number(l.nameSaid) > 0) { v.named++; v.nameSaid += Number(l.nameSaid); }
    if (Number(l.promptHeld) > 0) v.held++;
    if (Number(l.sourcesNaming) > 0) v.sourcesNaming++;
  }
  return {
    replies: lines.length,
    byTurn: [...byTurn.values()].sort((a, b) => a.turn - b.turn).map((t) => ({ turn: t.turn, replies: t.replies, meanTokens: t.counted ? Math.round(t.tokens / t.counted) : null, meanUsd: t.replies ? Math.round((t.usd / t.replies) * 10000) / 10000 : null, meanMs: t.replies ? Math.round(t.ms / t.replies) : null })),
    byVersion: [...byVersion.values()],
  };
}

/** The tokens one call put through the provider: what it read (its cached part included: OpenAI's minute counts it too) and what it wrote. */
const tokensOf = (u) => { const t = (Number(u?.input) || 0) + (Number(u?.output) || 0); return t > 0 ? t : null; };

/**
 * How long the model's calls take, from the ledger lines of finished calls over the window: the count, the mean and the
 * 75th percentile of each kind's milliseconds (which begin before admission, so a wait at the gate is inside them),
 * the mean web searches per determination, and the mean tokens per determination (read and written, cached included).
 * The figures the operator decides the extraction's effort by, and the key's capacity: a determination's tokens over its
 * minutes is what one running determination takes of the key's minute.
 */
async function durations(since) {
  let rows;
  if (dbOn()) {
    const r = await query(`SELECT kind, (line->>'ms')::float8 AS ms, COALESCE((line->>'searches')::float8, 0) AS searches,
        COALESCE((line->'usage'->>'input')::float8, 0) + COALESCE((line->'usage'->>'output')::float8, 0) AS tokens
      FROM cost_lines WHERE at >= $1 AND ok IS NOT FALSE AND kind IN ('evaluate', 'extract') AND line->>'ms' IS NOT NULL`, [new Date(since)]);
    rows = r.rows.map((x) => ({ kind: x.kind, ms: Number(x.ms), searches: Number(x.searches), tokens: Number(x.tokens) > 0 ? Number(x.tokens) : null }));
  } else rows = mem.lines.filter((l) => l.at >= since && (l.kind === 'evaluate' || l.kind === 'extract'));
  const stat = (list) => {
    const ms = list.map((l) => l.ms).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!ms.length) return { n: 0, meanMs: null, p75Ms: null };
    return { n: ms.length, meanMs: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), p75Ms: ms[Math.min(ms.length - 1, Math.floor(0.75 * ms.length))] };
  };
  const dets = rows.filter((l) => l.kind === 'evaluate');
  const d = stat(dets);
  const counted = dets.filter((l) => l.tokens > 0);
  return {
    determinations: { ...d, meanSearches: dets.length ? Math.round((dets.reduce((a, l) => a + (l.searches || 0), 0) / dets.length) * 10) / 10 : null,
      meanTokens: counted.length ? Math.round(counted.reduce((a, l) => a + l.tokens, 0) / counted.length) : null, tokensMeasured: counted.length },
    extractions: stat(rows.filter((l) => l.kind === 'extract')),
  };
}

// ---- what the page and the operator are told --------------------------------------------------------
let publicCache = { at: 0, value: null };

/** For /api/health and the page: the tier, the free count, the price and the operator's note. Never a cost. */
export async function publicState() {
  if (!enabled()) return null;
  const t = now();
  if (publicCache.value && t - publicCache.at < 5000) return publicCache.value;
  const g = await guardState(t);
  const tier = g.engaged ? 1 : tierAt(t);
  const win = await priceForWindow(windowStartAt(t));
  const value = { tier, freeFacts: freeFor(tier), priceCents: win.priceCents, currency: config.currency, note: config.pricingNote || null };
  publicCache = { at: t, value };
  return value;
}

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;   // the ledger's own precision: a listing that cost a tenth of a cent is not nothing
const coverageOf = (revenue, cost) => (cost > 0 ? round2(revenue / (cost * (1 + (config.priceMarkupPercent || 0) / 100))) : null);

/** The operator's measurement, for /check: the price, the tier clock, the guard, and the money per tier, per user and per window. */
export async function report() {
  if (!enabled()) return null;
  const t = now();
  const since = t - 90 * DAY;
  const runs = await runsSince(since);
  const dets = await determinationsBetween(since, Infinity);
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const byRun = new Map();
  for (const d of dets) { if (!d.runId) continue; if (!byRun.has(d.runId)) byRun.set(d.runId, []); byRun.get(d.runId).push(d); }
  const group = (keyOf) => {
    const groups = new Map();
    for (const r of runs) {
      const key = keyOf(r);
      if (!groups.has(key)) groups.set(key, { runs: [], dets: [] });
      const g = groups.get(key);
      g.runs.push(r);
      g.dets.push(...(byRun.get(r.id) || []));
    }
    return groups;
  };
  const line = (g) => {
    const m = money(g.dets);
    const extract = g.runs.reduce((s, r) => s + r.extractUsd, 0);
    const users = new Set(g.runs.map((r) => r.owner || 'open door')).size;
    return { users, runs: g.runs.length, determinations: m.done, failed: m.failed, freeGiven: m.free, costUsd: round4(m.cost), extractUsd: round4(extract), revenueUsd: round2(m.revenue), marginUsd: round4(m.margin), marginPerUserUsd: users ? round4(m.margin / users) : null, coverage: coverageOf(m.revenue, m.cost) };
  };
  const byTier = [...group((r) => r.tier)].sort((a, b) => a[0] - b[0]).map(([tier, g]) => ({ tier, freeFacts: freeFor(tier), ...line(g) }));
  const byUser = [...group((r) => r.owner || 'open door')].map(([owner, g]) => ({ owner, email: g.runs.find((r) => r.email)?.email || null, ...line(g) }))
    .sort((a, b) => b.runs - a.runs || (a.email || a.owner).localeCompare(b.email || b.owner));
  const byWindow = [...group((r) => r.windowStart ?? 0)].sort((a, b) => b[0] - a[0]).slice(0, 8)
    .map(([ws, g]) => ({ windowStart: ws ? new Date(ws).toISOString() : null, tier: g.runs[0]?.tier ?? null, priceCents: g.runs[0]?.priceCents ?? null, ...line(g) }));
  const ws = windowStartAt(t);
  const win = await priceForWindow(ws);
  const soFar = await measured(t);
  const guard = await guardState(t);
  const tier = guard.engaged ? 1 : tierAt(t);
  const took = await durations(t - config.priceWindowDays * DAY).catch((err) => { warn('the durations could not be read', err); return null; });
  return {
    at: new Date(t).toISOString(),
    currency: config.currency,
    // The list price, and what it covers: the measured average cost of a determination over the window's days, and the list
    // price against that cost plus the markup (1.00: exactly covered). The average never sets the price.
    price: { cents: win.priceCents, basis: win.basis, listCents: listPrice(), windowStart: new Date(ws).toISOString(), measuredAvgUsd: soFar.avgUsd, measuredSample: soFar.sample, days: config.priceWindowDays, markupPercent: config.priceMarkupPercent,
      coverage: Number.isInteger(win.priceCents) && soFar.avgUsd > 0 ? coverageOf(win.priceCents / 100, soFar.avgUsd) : null, retired: retiredSettings() },
    tier: { now: tier, freeFacts: freeFor(tier), hours: config.tierHours, order: config.tierOrder, shift: config.tierShift, fixed: config.tierFixed, nextChangeAt: new Date(nextChangeAt(t)).toISOString(), underGuard: Boolean(guard.engaged) },
    guard: { ...guard, since: guard.since ? new Date(guard.since).toISOString() : null, windowStart: guard.windowStart ? new Date(guard.windowStart).toISOString() : null, released: guard.released ? new Date(guard.released).toISOString() : null },
    byTier, byUser, byWindow,
    durations: took,   // over the price window: how long a determination and a listing take, and the searches per determination
    chat: await chatReport(t - config.priceWindowDays * DAY).catch((err) => { warn('the replies could not be read', err); return null; }),   // the conversation's replies, apart
    store: dbOn() ? 'postgres' : 'memory',
    credit: await credit.totals().catch((err) => { warn('the credit totals could not be read', err); return null; }),
    note: 'Revenue is at list price; nothing is collected yet.',
  };
}

// ---- boot and stop -----------------------------------------------------------------------------------
/** The price as the boot line says it: the list price or none, and any setting of the measured price still on the service. */
function priceWords() {
  const list = listPrice();
  const retired = retiredSettings();
  return `${list === null ? 'no list price is set (CIVIC_LIST_PRICE_CENTS), so nothing is priced' : `the list price is ${list} cents a fact-check`} · the rotation ${config.tierOrder.join(',')}`
    + `${retired.length ? ` · no longer read: ${retired.join(', ')}` : ''}`;
}

/**
 * What one running determination takes of the key's minute, from the last days' measurements: on average T tokens (read and
 * written, cached included) over M minutes, so R = T ÷ M tokens a minute each. The key's own minute figure divided by R is
 * how many can run at once. For the operator, in the host's log: nothing of any reader's, and no key.
 */
async function capacityLine() {
  const d = (await durations(now() - config.priceWindowDays * DAY)).determinations;
  const days = `last ${config.priceWindowDays} day${config.priceWindowDays === 1 ? '' : 's'}`;
  if (!d.n || !(d.meanTokens > 0) || !(d.meanMs > 0)) return `[capacity] ${days}: no fact-check measured yet`;
  const minutes = d.meanMs / 60000;
  const perMinute = Math.round(d.meanTokens / minutes);
  const n = (v) => Number(v).toLocaleString('en-US');
  return `[capacity] ${days}: ${n(d.n)} fact-check${d.n === 1 ? '' : 's'}, on average ${n(d.meanTokens)} tokens over ${Number(minutes.toPrecision(3))} min (${n(perMinute)} a minute each)`;
}

export async function boot() {
  if (!enabled()) { console.log('[economics] pricing is off (CIVIC_PRICING_ENABLED=false): nothing is priced or measured beyond the ledger'); return; }
  if (!dbOn()) { console.log(`[economics] no DATABASE_URL: prices and tiers work; the measurement lives in this instance's memory until it restarts · ${priceWords()}`); return; }
  const m = await migrate();
  // Rows an instance left running when it died without a word (a crash): failed as lost, cost kept.
  await query("UPDATE determinations SET status = 'failed', failure = 'lost', ended_at = now(), price_cents = 0 WHERE status = 'running' AND NOT rerun AND started_at < now() - interval '12 hours'").catch((err) => warn('lost rows could not be closed', err));
  await query("UPDATE determinations SET status = 'done' WHERE status = 'running' AND rerun AND ended_at < now() - interval '12 hours'").catch((err) => warn('lost second goes could not be closed', err));
  // Holds no attempt will settle any more (a crash): charged where the row is done and names them, released otherwise.
  const settled = await credit.reconcile().catch((err) => { warn('holds could not be settled', err); return null; });
  if (settled && (settled.charged || settled.released)) console.log(`[economics] holds settled at boot: ${settled.charged} charged, ${settled.released} released`);
  await query("UPDATE runs SET status = 'failed' WHERE status = 'running' AND started_at < now() - interval '12 hours'").catch((err) => warn('lost runs could not be closed', err));
  console.log(`[economics] measuring in Postgres${m.applied.length ? ` · schema ${m.applied.join(', ')} applied` : ''}${config.clock ? ` · the clock reads ${new Date(now()).toISOString()}` : ''} · ${priceWords()}`);
  console.log(await capacityLine().catch((err) => `[capacity] could not be read: ${err?.message || err}`));
}
