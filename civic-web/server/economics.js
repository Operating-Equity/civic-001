// Facts have a price, and every user is measured. The operator's program of 2 October, in their
// words: "All empirical facts are parsed and listed for Free, and the user can then decide which
// or all to test, with 0 to 3 free facts, and cost and revenue measured for all users in each
// tier"; "the average needs to be marked up 25% to start"; "change every 6 hours unless one is
// very unprofitable and I am losing a lot of money. Become 1 until we earn it back"; "I need to
// test, measure, and optimize."
//
// What this module decides, and nothing else:
//   the tier    a run's tier is fixed when its extraction starts and holds for that document:
//               tier 1 prices every claim, tiers 2, 3 and 4 give the first one, two or three
//               claims the reader chooses free. The tiers rotate every CIVIC_TIER_HOURS in
//               CIVIC_TIER_ORDER, and each day the rotation starts CIVIC_TIER_SHIFT tiers later,
//               so over four days every tier meets every time of day. CIVIC_TIER_FIXED holds one.
//   the price   one price for everyone, fixed at each window's start: the measured average cost
//               of a determination over the last CIVIC_PRICE_WINDOW_DAYS, marked up by
//               CIVIC_PRICE_MARKUP_PERCENT and rounded up to the cent, once CIVIC_PRICE_MIN_SAMPLE
//               determinations have been measured; before that CIVIC_PRICE_START_CENTS, and with
//               no start figure nothing is priced until the sample exists. No figure of ours.
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

const DAY = 86400e3;
const HOUR = 3600e3;

// ---- the clock -----------------------------------------------------------------------------------
// Real time, unless the guard set CIVIC_CLOCK: then the instant it names, running from boot.
const bootReal = Date.now();
const clockOffset = (() => { const t = config.clock ? Date.parse(config.clock) : NaN; return Number.isFinite(t) ? t - bootReal : 0; })();
export function now() { return Date.now() + clockOffset; }

export function enabled() { return Boolean(config.pricingEnabled); }

// ---- pure arithmetic (the guard drives these with any instant) ------------------------------------
const hoursOf = (h) => Math.max(1 / 60, Number(h) || 6) * HOUR;

export function windowStartAt(ms, hours = config.tierHours) { const w = hoursOf(hours); return Math.floor(ms / w) * w; }
export function nextChangeAt(ms, hours = config.tierHours) { return windowStartAt(ms, hours) + hoursOf(hours); }

/** The rotation's tier at an instant: order[(window index + day index × shift) mod the order's length], or the fixed tier. */
export function tierAt(ms, { hours = config.tierHours, order = config.tierOrder, shift = config.tierShift, fixed = config.tierFixed } = {}) {
  if (Number.isInteger(fixed) && fixed > 0) return fixed;
  const list = Array.isArray(order) && order.length ? order : [1, 2, 3, 4];
  const w = hoursOf(hours);
  const windowIndex = Math.floor(ms / w);
  const dayIndex = Math.floor(ms / DAY);
  const n = list.length;
  const k = (((windowIndex + dayIndex * (Number.isInteger(shift) ? shift : 0)) % n) + n) % n;
  return list[k];
}

/** Claims the reader may test free on one document under a tier: tier 1 none, tier 2 one, tier 3 two, tier 4 three. */
export function freeFor(tier) { return Math.max(0, (Number.parseInt(tier, 10) || 1) - 1); }

/** The price in cents from an average cost in dollars: marked up, rounded up to the cent, with the float noise taken out first. */
export function priceFromAverage(avgUsd, markupPercent = config.priceMarkupPercent) {
  if (!(avgUsd > 0)) return null;
  return Math.ceil(Number((avgUsd * (100 + (Number(markupPercent) || 0))).toFixed(6)));
}

// ---- the rows -------------------------------------------------------------------------------------
const mem = { runs: new Map(), dets: new Map(), windows: new Map(), guard: [] };
const inFlight = new Set();   // determinations this instance has open: failed as `deploy` when it is told to stop

const ms = (v) => (v === null || v === undefined ? null : (v instanceof Date ? v.getTime() : Number(v)));
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const rowRun = (r) => ({ id: r.id, owner: r.owner, email: r.email, codeFp: r.code_fp, startedAt: ms(r.started_at), tier: r.tier, windowStart: ms(r.window_start), priceCents: r.price_cents, freeAllowed: r.free_allowed, chars: r.chars, claimsTotal: r.claims_total, extractUsd: num(r.extract_usd), status: r.status });
const rowDet = (d) => ({ id: d.id, runId: d.run_id, n: d.n, startedAt: ms(d.started_at), endedAt: ms(d.ended_at), status: d.status, failure: d.failure, free: d.free, priceCents: d.price_cents, costUsd: num(d.cost_usd), priced: d.priced, searches: d.searches, verdict: d.verdict, model: d.model, chars: d.chars, collected: d.collected });
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

async function determinationsBetween(fromMs, toMs) {
  if (dbOn()) return (await query('SELECT * FROM determinations WHERE started_at >= $1 AND started_at < $2 ORDER BY started_at', [new Date(fromMs), new Date(Math.min(toMs, 8.64e15))])).rows.map(rowDet);
  return [...mem.dets.values()].filter((d) => d.startedAt >= fromMs && d.startedAt < toMs);
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

/** The window's price: read once made; made at the window's first use from the lines before its start. */
export async function priceForWindow(ws) {
  const existing = await windowRow(ws);
  if (existing) return existing;
  const m = await measured(ws);
  let priceCents = null, basis = 'none';
  if (m.sample >= config.priceMinSample && m.avgUsd !== null) { priceCents = priceFromAverage(m.avgUsd); basis = 'measured'; }
  else if (Number.isInteger(config.priceStartCents) && config.priceStartCents >= 0) { priceCents = config.priceStartCents; basis = 'start'; }
  const row = { windowStart: ws, tier: tierAt(ws), priceCents, avgCostUsd: m.avgUsd, sample: m.sample, basis };
  if (dbOn()) {
    await query('INSERT INTO windows (window_start, tier, price_cents, avg_cost_usd, sample, basis) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (window_start) DO NOTHING',
      [new Date(ws), row.tier, priceCents, m.avgUsd, m.sample, basis]);
    return (await windowRow(ws)) || row;
  }
  if (!mem.windows.has(ws)) mem.windows.set(ws, row);
  return mem.windows.get(ws);
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
 * A run starts: its tier and its window's price are fixed here and hold for the document. The same
 * id asked for again (a page joining its run on a new instance) gets the row it already has.
 */
export async function openRun({ id, owner = null, email = null, codeFp = null, chars = null }) {
  if (!enabled() || !id) return null;
  const existing = await loadRun(id);
  if (existing) return existing;
  const at = now();
  const ws = windowStartAt(at);
  const guard = await guardDecide(at);
  const tier = guard.tier1 ? 1 : tierAt(at);
  const win = await priceForWindow(ws);
  const run = { id, owner, email, codeFp, startedAt: at, tier, windowStart: ws, priceCents: win.priceCents, freeAllowed: freeFor(tier), chars, claimsTotal: null, extractUsd: 0, status: 'running' };
  if (dbOn()) {
    await query('INSERT INTO runs (id, owner, email, code_fp, started_at, tier, window_start, price_cents, free_allowed, chars, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING',
      [id, owner, email, codeFp, new Date(at), tier, new Date(ws), win.priceCents, run.freeAllowed, chars, 'running']);
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

/**
 * A determination starts: the server decides, never the page, whether it is one of the document's
 * free ones (the run's count so far, failed ones excepted) or priced at the run's price. The run's
 * row is locked while the count is taken, so three claims starting together cannot all be the last
 * free one. An id asked for again gets the row it already has.
 */
export async function openDetermination({ id, runId = null, n = null, chars = null }) {
  if (!enabled() || !id) return null;
  const at = now();
  if (dbOn()) {
    return tx(async (c) => {
      const had = (await c.query('SELECT * FROM determinations WHERE id = $1', [id])).rows[0];
      if (had) { const run = had.run_id ? rowRun((await c.query('SELECT * FROM runs WHERE id = $1', [had.run_id])).rows[0] || {}) : null; return quoteOf(rowDet(had), run && run.id ? run : null); }
      let run = null;
      if (runId) { const r = await c.query('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [runId]); run = r.rows[0] ? rowRun(r.rows[0]) : null; }
      let free = false;
      if (run) {
        const used = Number((await c.query("SELECT count(*) FROM determinations WHERE run_id = $1 AND free AND status <> 'failed'", [runId])).rows[0].count);
        free = used < run.freeAllowed;
      }
      const price = run && !free && Number.isInteger(run.priceCents) ? run.priceCents : 0;
      await c.query('INSERT INTO determinations (id, run_id, n, started_at, status, free, price_cents, chars) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING',
        [id, run ? run.id : null, n, new Date(at), 'running', free, price, chars]);
      inFlight.add(id);
      return quoteOf({ free }, run);
    });
  }
  const had = mem.dets.get(id);
  if (had) return quoteOf(had, had.runId ? mem.runs.get(had.runId) : null);
  const run = runId ? mem.runs.get(runId) || null : null;
  let free = false;
  if (run) {
    let used = 0;
    for (const d of mem.dets.values()) if (d.runId === run.id && d.free && d.status !== 'failed') used++;
    free = used < run.freeAllowed;
  }
  const det = { id, runId: run ? run.id : null, n, startedAt: at, endedAt: null, status: 'running', failure: null, free, priceCents: run && !free && Number.isInteger(run.priceCents) ? run.priceCents : 0, costUsd: 0, priced: true, searches: 0, verdict: null, model: null, chars, collected: false };
  // Memory is not a database: a long-lived instance without one lets its oldest finished rows go past twenty thousand.
  if (mem.dets.size >= 20000) { for (const [k, d] of mem.dets) { if (d.status !== 'running') { mem.dets.delete(k); if (mem.dets.size < 15000) break; } } }
  mem.dets.set(id, det);
  inFlight.add(id);
  return quoteOf(det, run);
}

/** The determination's end: done books its revenue at list (already on the row); anything else books nothing and keeps the cost. */
export async function book(id, { status = 'done', verdict = null, model = null, failure = null } = {}) {
  if (!enabled() || !id) return;
  inFlight.delete(id);
  const done = status === 'done';
  const at = now();
  try {
    if (dbOn()) {
      await query("UPDATE determinations SET status = $2, ended_at = $3, verdict = COALESCE($4, verdict), model = COALESCE($5, model), failure = $6, price_cents = CASE WHEN $2 = 'done' THEN price_cents ELSE 0 END WHERE id = $1 AND status = 'running'",
        [id, done ? 'done' : 'failed', new Date(at), verdict, model, done ? null : (failure || status)]);
    } else {
      const d = mem.dets.get(id);
      if (d && d.status === 'running') Object.assign(d, { status: done ? 'done' : 'failed', endedAt: at, verdict: verdict ?? d.verdict, model: model ?? d.model, failure: done ? null : (failure || status), priceCents: done ? d.priceCents : 0 });
    }
  } catch (err) { warn('the determination could not be booked', err); }
}

/** Determinations of a request that ended without a result of their own (the job was stopped, or the whole request failed). */
export async function closeOpen(ids, failure = 'ended') {
  for (const id of ids || []) if (inFlight.has(id)) await book(id, { status: 'failed', failure });
}

/** This instance is being stopped (a deploy): everything it still has in flight is failed as such, cost kept, nothing booked. */
export async function closeAllOpen(failure = 'deploy') {
  await closeOpen([...inFlight], failure);
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
    if (ctx.determinationId && kind === 'evaluate') {
      query('UPDATE determinations SET cost_usd = cost_usd + $2, priced = priced AND $3, searches = searches + $4 WHERE id = $1', [ctx.determinationId, usd, priced, searches]).catch((err) => warn('a determination\'s cost could not be kept', err));
    } else if (ctx.runId && kind === 'extract') {
      query('UPDATE runs SET extract_usd = extract_usd + $2 WHERE id = $1', [ctx.runId, usd]).catch((err) => warn('a run\'s listing cost could not be kept', err));
    }
    return;
  }
  if (ctx.determinationId && kind === 'evaluate') { const d = mem.dets.get(ctx.determinationId); if (d) { d.costUsd += usd; d.priced = d.priced && priced; d.searches += searches; } }
  else if (ctx.runId && kind === 'extract') { const r = mem.runs.get(ctx.runId); if (r) r.extractUsd += usd; }
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
  return {
    at: new Date(t).toISOString(),
    currency: config.currency,
    price: { cents: win.priceCents, basis: win.basis, windowStart: new Date(ws).toISOString(), windowAvgUsd: win.avgCostUsd, windowSample: win.sample, measuredAvgUsd: soFar.avgUsd, measuredSample: soFar.sample, minSample: config.priceMinSample, days: config.priceWindowDays, markupPercent: config.priceMarkupPercent, startCents: config.priceStartCents },
    tier: { now: tier, freeFacts: freeFor(tier), hours: config.tierHours, order: config.tierOrder, shift: config.tierShift, fixed: config.tierFixed, nextChangeAt: new Date(nextChangeAt(t)).toISOString(), underGuard: Boolean(guard.engaged) },
    guard: { ...guard, since: guard.since ? new Date(guard.since).toISOString() : null, windowStart: guard.windowStart ? new Date(guard.windowStart).toISOString() : null, released: guard.released ? new Date(guard.released).toISOString() : null },
    byTier, byUser, byWindow,
    store: dbOn() ? 'postgres' : 'memory',
    note: 'Revenue is at list price; nothing is collected yet.',
  };
}

// ---- boot and stop -----------------------------------------------------------------------------------
export async function boot() {
  if (!enabled()) { console.log('[economics] pricing is off (CIVIC_PRICING_ENABLED=false): nothing is priced or measured beyond the ledger'); return; }
  if (!dbOn()) { console.log('[economics] no DATABASE_URL: prices and tiers work; the measurement lives in this instance\'s memory until it restarts'); return; }
  const m = await migrate();
  // Rows an instance left running when it died without a word (a crash): failed as lost, cost kept.
  await query("UPDATE determinations SET status = 'failed', failure = 'lost', ended_at = now(), price_cents = 0 WHERE status = 'running' AND started_at < now() - interval '12 hours'").catch((err) => warn('lost rows could not be closed', err));
  await query("UPDATE runs SET status = 'failed' WHERE status = 'running' AND started_at < now() - interval '12 hours'").catch((err) => warn('lost runs could not be closed', err));
  console.log(`[economics] measuring in Postgres${m.applied.length ? ` · schema ${m.applied.join(', ')} applied` : ''}${config.clock ? ` · the clock reads ${new Date(now()).toISOString()}` : ''}`);
}
