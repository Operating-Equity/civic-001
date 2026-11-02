// Payments (1 November): credit bought on the payment processor's hosted page, and topped up automatically when the
// reader has asked for it. The operator: "my next step is the integration of stripe", the strawman theirs to approve
// "with the idea that this service runs with a very comfortable 25% margin on all costs"; auto-reload, the reader
// opting in; purchased credit not refundable; the Terms enough for the adults-only rule.
//
// What this module does, and nothing else:
//   the page     a purchase opens the processor's own hosted page: the server makes the payment and the reader's page
//                only moves there, so no key and no script of the processor's is ever in the reader's page
//   the notices  the processor's signed notices (POST /hooks/stripe, read as the raw body) write each purchase, refund
//                and dispute to the credit ledger exactly once, whatever their number, order or timing; the reader's
//                return from the hosted page writes it too when it comes first
//   the top-up   when the reader has turned it on: below their level, their amount, never past their monthly total,
//                one at a time, on the card they saved; a card the bank refuses pauses it, and the reader is told
//   the card     saved on the hosted page (with the reader's tick), shown by brand and last four digits, replaced or
//                removed from the Account page; its number never reaches us
//   disputes     testing, buying and the top-up pause on that account while a dispute is open; the amount comes off the
//                balance when the processor takes the funds and goes back if the dispute is won
//   the books    collected, the processor's own fees, refunds, disputes, and the margin with every cost in, for /check
//   two modes    the processor's test mode and live mode are apart: each payment keeps its mode, and an account's
//                customer and saved card exist in the mode they were made in alone, so the test-mode trial's card is
//                never charged with live keys, and a test payment never counts as money
// It needs the database (the payments live there) and CIVIC_PAYMENTS; every amount is a setting of the operator's.
import crypto from 'node:crypto';
import Stripe from 'stripe';
import { config } from './config.js';
import { dbOn, query, tx } from './db.js';
import { now } from './clock.js';
import { ApiError } from './openai.js';
import * as credit from './credit.js';
import * as accounts from './accounts.js';
import { listPrice } from './economics.js';

const API_VERSION = '2026-10-28.endive';
// The version of the automatic top-up's agreement as the Account page words it: kept with each reader's consent.
export const TOPUP_AGREEMENT = '2026-11-01';
const PAID = ['paid', 'refunded', 'disputed', 'lost', 'won'];

const expected = (err) => Object.assign(err, { expected: true });
let unhandled = 0;
let lastFault = null;
function fault(what, err) {
  unhandled += 1;
  lastFault = `${what}: ${err?.message || err}`;
  console.error(`[payments] ${lastFault}`);
}

// The client's own limits (the SDK's defaults, set here so that the sum below holds): a request may take REQUEST_MS, and
// is tried up to RETRIES more times, at most RETRY_DELAY_MS apart. A top-up still pending after LONGEST_MS is under way
// nowhere: the instance that started it stopped in the middle (a deploy, a crash).
const REQUEST_MS = 80000;
const RETRIES = 2;
const RETRY_DELAY_MS = 5000;
const LONGEST_MS = REQUEST_MS * (RETRIES + 1) + RETRY_DELAY_MS * RETRIES;

let client = null;
function stripe() {
  if (client) return client;
  const opts = { apiVersion: API_VERSION, timeout: REQUEST_MS, maxNetworkRetries: RETRIES };
  if (config.stripeApi) {   // the guard's stand-in
    const u = new URL(config.stripeApi);
    Object.assign(opts, { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), protocol: u.protocol.replace(':', '') });
  }
  client = new Stripe(config.stripeKey, opts);
  return client;
}

/** test or live, read from the key's own prefix; null for a key of another form. The key itself is never shown. */
export function mode() {
  const k = config.stripeKey;
  return /^(sk|rk)_test_/.test(k) ? 'test' : /^(sk|rk)_live_/.test(k) ? 'live' : null;
}
const otherRange = () => (Number.isInteger(config.topupMinCents) && Number.isInteger(config.topupMaxCents)
  && config.topupMinCents > 0 && config.topupMaxCents >= config.topupMinCents ? { min: config.topupMinCents, max: config.topupMaxCents } : null);
const amountsSet = () => config.topupAmountsCents.length > 0 || Boolean(otherRange());
const topupOffered = () => config.reloadLevelsCents.length > 0 && config.reloadCapsCents.length > 0 && config.topupAmountsCents.length > 0;
function missing() {
  const out = [];
  if (!config.stripeKey) out.push('CIVIC_STRIPE_KEY');
  else if (!mode()) out.push('CIVIC_STRIPE_KEY (a test or a live key of the processor\'s)');
  if (!config.stripeWebhookSecret) out.push('CIVIC_STRIPE_WEBHOOK_SECRET');
  if (!dbOn()) out.push('DATABASE_URL');
  if (!amountsSet()) out.push('CIVIC_TOPUP_AMOUNTS_CENTS (or CIVIC_TOPUP_MIN_CENTS with CIVIC_TOPUP_MAX_CENTS)');
  return out;
}
/** Whether anything can be bought at all: switched on, with its key, its signing secret, the database and amounts. */
export const ready = () => config.payments !== 'off' && missing().length === 0;
/** Whether this account may buy: payments ready, the account open, and switched on for everyone or this is the operator's. */
export const openTo = (user) => ready() && Boolean(user) && !user.deletedAt && !user.blockedAt && (config.payments === 'on' || Boolean(user.operator));
const validAmount = (cents) => Number.isInteger(cents) && (config.topupAmountsCents.includes(cents) || (Boolean(otherRange()) && cents >= otherRange().min && cents <= otherRange().max));
const money = (cents) => `${(cents / 100).toFixed(2)} ${config.currency}`;

/** The start-up line: off, set but not ready (naming what is missing, never a value), or on: its mode, for whom, its amounts. */
export function bootLine() {
  if (config.payments === 'off') return '[payments] off (CIVIC_PAYMENTS): nothing can be bought';
  const m = missing();
  if (m.length) return `[payments] CIVIC_PAYMENTS=${config.payments}, but not ready (missing ${m.join(', ')}): nothing can be bought`;
  const r = otherRange();
  const amounts = [config.topupAmountsCents.length ? config.topupAmountsCents.map(money).join(', ') : null, r ? `any amount from ${money(r.min)} to ${money(r.max)}` : null].filter(Boolean).join('; or ');
  const topup = topupOffered()
    ? `; automatic top-ups, the reader's choice: below ${config.reloadLevelsCents.map(money).join(' or ')}, add ${config.topupAmountsCents.map(money).join(', ')}, at most ${config.reloadCapsCents.map(money).join(', ')} a month`
    : '; no automatic top-ups (CIVIC_RELOAD_LEVELS_CENTS and CIVIC_RELOAD_CAPS_CENTS unset)';
  return `[payments] on, ${mode() || 'unknown'} mode, ${config.payments === 'on' ? 'for every account' : "for the operator's account alone"}: ${amounts}${topup}`;
}

/** This account's customer, card and top-up belong to the mode the key is in (not a test-mode trial's, under live keys). */
const here = (user) => Boolean(user?.payCustomer) && user.payMode === mode();

/** What the automatic top-ups of this month (UTC) add up to, in this mode, the one under way included. */
async function topupsThisMonth(userId) {
  const { start } = credit.monthOf(now());
  return Number((await query(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM payments WHERE user_id = $1 AND kind = 'auto' AND mode = $3 AND status IN ('pending', ${PAID.map((x) => `'${x}'`).join(', ')}) AND created_at >= $2`,
    [userId, new Date(start), mode()])).rows[0].s);
}

/** What the Account page is told: whether this account may buy, the amounts, its card (brand, last four, expiry), its top-up. */
export async function viewFor(user) {
  if (!openTo(user)) return { on: false };
  const r = otherRange();
  const mine = here(user);
  let topup = null;
  if (topupOffered()) {
    topup = {
      levelsCents: config.reloadLevelsCents, amountsCents: config.topupAmountsCents, capsCents: config.reloadCapsCents, agreement: TOPUP_AGREEMENT,
      on: mine && user.topupOn, levelCents: user.topupLevelCents, amountCents: user.topupAmountCents, capCents: user.topupCapCents,
      paused: mine && user.topupOn && user.topupPausedAt ? (user.topupPausedReason || 'declined') : null, monthCents: await topupsThisMonth(user.id),
    };
  }
  // priceCents: today's price of a fact-check, so the page can say about how many an amount buys.
  return {
    on: true, mode: mode(), currency: config.currency, amountsCents: config.topupAmountsCents, minCents: r?.min ?? null, maxCents: r?.max ?? null,
    priceCents: listPrice(), hold: Boolean(user.payHoldAt), card: mine && user.cardLast4 ? { brand: user.cardBrand, last4: user.cardLast4, exp: user.cardExp } : null, topup,
  };
}

function refuseUnlessOpen(user) {
  if (!openTo(user)) throw expected(new ApiError(404, 'payments_off', 'Adding credit is not open yet.'));
  if (user.payHoldAt) throw expected(new ApiError(403, 'account_hold', 'This account is paused while a payment dispute is open. Write to support.'));
}
function processorError(err) {
  fault('the processor refused a request', err);
  return expected(new ApiError(502, 'payment_unavailable', 'The payment page could not be opened just now. Nothing was charged. Try again in a moment.'));
}
const codeOf = (err) => String(err?.raw?.decline_code || err?.raw?.code || err?.code || err?.type || 'failed').slice(0, 80);

/**
 * The processor's customer for this account in this mode, made once (its email, for the processor's receipts). One of the
 * other mode (the test-mode trial's, once live keys are set) is replaced, with its saved card and top-up: neither exists
 * in this mode.
 */
async function customerFor(user) {
  const m = mode();
  if (user.payCustomer && user.payMode === m) return user.payCustomer;
  const c = await stripe().customers.create({ ...(user.email ? { email: user.email } : {}), metadata: { account: String(user.id) } }, { idempotencyKey: `customer-${m}-${user.id}` });
  const r = await query(`UPDATE users SET pay_customer = $2, pay_mode = $3, card_method = NULL, card_brand = NULL, card_last4 = NULL, card_exp = NULL, topup_on = false
                         WHERE id = $1 AND (pay_customer IS NULL OR pay_mode IS DISTINCT FROM $3) RETURNING pay_customer`, [user.id, c.id, m]);
  if (r.rows[0]) return r.rows[0].pay_customer;
  return (await query('SELECT pay_customer FROM users WHERE id = $1', [user.id])).rows[0]?.pay_customer || c.id;
}

/** A purchase: the payment is written first, then the hosted page made; the page moves to the address returned. */
export async function startCheckout(user, { amountCents, saveCard = false, origin }) {
  refuseUnlessOpen(user);
  const amount = Number(amountCents);
  if (!validAmount(amount)) throw expected(new ApiError(400, 'amount_invalid', 'That amount cannot be bought here.'));
  const save = Boolean(saveCard) && topupOffered();
  let customer;
  try { customer = await customerFor(user); } catch (err) { throw processorError(err); }
  const id = crypto.randomUUID();
  await query("INSERT INTO payments (id, user_id, kind, mode, amount_cents, currency, status, created_at, save_card) VALUES ($1, $2, 'checkout', $7, $3, $4, 'pending', $5, $6)",
    [id, user.id, amount, config.currency, new Date(now()), save, mode()]);
  const meta = { payment: id, account: String(user.id) };
  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment', customer, client_reference_id: id, metadata: meta,
      line_items: [{ quantity: 1, price_data: { currency: config.currency.toLowerCase(), unit_amount: amount, product_data: { name: 'FactEngine credit' } } }],
      payment_intent_data: { metadata: meta, ...(save ? { setup_future_usage: 'off_session' } : {}) },
      success_url: `${origin}/account?paid={CHECKOUT_SESSION_ID}#add-credit`,
      cancel_url: `${origin}/account?paid=none#add-credit`,
    }, { idempotencyKey: `checkout-${id}` });
    await query('UPDATE payments SET session_id = $2 WHERE id = $1', [id, session.id]);
    return { url: session.url };
  } catch (err) {
    await query("UPDATE payments SET status = 'failed', failure = $2 WHERE id = $1", [id, codeOf(err)]).catch(() => {});
    throw processorError(err);
  }
}

/** The reader is back from the hosted page: the purchase is written now if the notice has not done it yet. */
export async function checkoutReturn(user, sessionId) {
  const row = (await query('SELECT * FROM payments WHERE session_id = $1 AND user_id = $2', [String(sessionId || ''), user.id])).rows[0];
  if (!row) throw expected(new ApiError(404, 'no_payment', 'There is no such payment.'));
  if (row.status === 'pending' && ready() && row.mode === mode()) {
    try {
      const s = await stripe().checkout.sessions.retrieve(row.session_id);
      const intent = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
      if (s.payment_status === 'paid' && intent) await creditPayment(row.id, intent);
      else if (s.status === 'expired') await query("UPDATE payments SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [row.id]);
    } catch (err) { fault('a return could not be confirmed', err); }
  }
  const p = (await query('SELECT status, amount_cents FROM payments WHERE id = $1', [row.id])).rows[0];
  return { status: p.status, amountCents: Number(p.amount_cents), balanceCents: await credit.balanceOf(user.id) };
}

/**
 * A payment the processor says succeeded: written to the ledger once (the payment's status moves from pending in the
 * same transaction as its `purchase` row, whose ref is the processor's payment id), with the processor's own fee and
 * the card's brand and country for the books. Its card is kept for the top-up when the reader asked.
 */
async function creditPayment(paymentId, intentId) {
  const row = (await query('SELECT * FROM payments WHERE id = $1', [paymentId])).rows[0];
  if (!row) return 'unknown';
  if (row.mode !== mode()) return 'other mode';
  if (!['pending', 'failed', 'cancelled'].includes(row.status)) return 'already';
  const pi = await stripe().paymentIntents.retrieve(intentId, { expand: ['latest_charge.balance_transaction', 'payment_method'] });
  if (pi.status !== 'succeeded') return pi.status;
  if (pi.metadata?.payment !== paymentId || String(pi.metadata?.account) !== String(row.user_id)) { fault('a payment named another account or payment', new Error(`payment ${paymentId}`)); return 'mismatch'; }
  const amount = Number(pi.amount_received ?? pi.amount);
  if (amount !== Number(row.amount_cents) || String(pi.currency).toLowerCase() !== String(row.currency).toLowerCase()) { fault('a payment came for another amount', new Error(`payment ${paymentId}`)); return 'mismatch'; }
  const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const bt = ch?.balance_transaction && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
  const card = ch?.payment_method_details?.card || null;
  const wallet = card?.wallet?.type || (ch?.payment_method_details?.type && ch.payment_method_details.type !== 'card' ? ch.payment_method_details.type : null);
  const userId = Number(row.user_id);
  const done = await tx(async (c) => {
    const u = await c.query(`UPDATE payments SET status = 'paid', paid_at = $2, intent_id = $3, fee_cents = $4, net_cents = $5, card_brand = $6, card_country = $7, wallet = $8, failure = NULL
                               WHERE id = $1 AND status IN ('pending', 'failed', 'cancelled') RETURNING kind`,
    [paymentId, new Date(now()), pi.id, bt?.fee ?? null, bt?.net ?? null, card?.brand ?? null, card?.country ?? null, wallet]);
    if (!u.rows[0]) return false;
    await credit.paymentEntry(userId, 'purchase', amount, { paymentId, ref: pi.id, note: u.rows[0].kind }, c);
    return true;
  });
  if (done && row.save_card && pi.payment_method) await keepCard(userId, pi.payment_method).catch((err) => fault('a saved card could not be kept', err));
  return done ? 'credited' : 'already';
}

/** The card the reader saved: its brand, last four digits and expiry, never its number. A new card replaces the old one. */
async function keepCard(userId, pm) {
  const m = typeof pm === 'string' ? await stripe().paymentMethods.retrieve(pm) : pm;
  if (!m?.card) return;
  const prev = (await query('SELECT card_method FROM users WHERE id = $1', [userId])).rows[0]?.card_method;
  await query(`UPDATE users SET card_method = $2, card_brand = $3, card_last4 = $4, card_exp = $5,
                 topup_paused_at = CASE WHEN topup_paused_reason = 'dispute' THEN topup_paused_at ELSE NULL END,
                 topup_paused_reason = CASE WHEN topup_paused_reason = 'dispute' THEN topup_paused_reason ELSE NULL END
               WHERE id = $1`, [userId, m.id, m.card.brand, m.card.last4, `${String(m.card.exp_month).padStart(2, '0')}/${String(m.card.exp_year).slice(-2)}`]);
  if (prev && prev !== m.id) await stripe().paymentMethods.detach(prev).catch((err) => fault('the replaced card could not be removed at the processor', err));
}

/** "Add a card" or "Replace": the hosted page in its saving form; nothing is charged. */
export async function startCardSetup(user, { origin }) {
  refuseUnlessOpen(user);
  if (!topupOffered()) throw expected(new ApiError(404, 'payments_off', 'Automatic top-ups are not offered.'));
  try {
    const customer = await customerFor(user);
    const meta = { account: String(user.id), purpose: 'card' };
    const session = await stripe().checkout.sessions.create({
      mode: 'setup', customer, currency: config.currency.toLowerCase(), metadata: meta, setup_intent_data: { metadata: meta },
      success_url: `${origin}/account?card={CHECKOUT_SESSION_ID}#auto-topup`, cancel_url: `${origin}/account?card=none#auto-topup`,
    });
    return { url: session.url };
  } catch (err) { throw processorError(err); }
}

/**
 * Back from saving a card: kept now if the notice has not done it yet. Returns the card's state on the processor's side
 * (saved, pending while it is still being confirmed, or failed) and the account's payments as they now stand.
 */
export async function cardReturn(user, sessionId) {
  refuseUnlessOpen(user);
  let state = 'pending';
  try {
    const s = await stripe().checkout.sessions.retrieve(String(sessionId || ''), { expand: ['setup_intent'] });
    if (s.mode !== 'setup' || String(s.metadata?.account) !== String(user.id)) throw expected(new ApiError(404, 'no_payment', 'There is no such card.'));
    const si = s.setup_intent && typeof s.setup_intent === 'object' ? s.setup_intent : null;
    if (si?.status === 'succeeded' && si.payment_method) { await keepCard(user.id, si.payment_method); state = 'saved'; }
    else if (si?.status === 'canceled' || s.status === 'expired') state = 'failed';
  } catch (err) {
    if (err.expected) throw err;
    if (err?.type === 'StripeInvalidRequestError' && err?.statusCode === 404) throw expected(new ApiError(404, 'no_payment', 'There is no such card.'));
    fault('a saved card could not be confirmed', err);
  }
  return { state, payments: await viewFor(await accounts.userById(user.id)) };
}

/** "Remove": the card goes from the processor and from the account, and the top-up turns off. */
export async function removeCard(user) {
  const pm = user.cardMethod;
  await query('UPDATE users SET card_method = NULL, card_brand = NULL, card_last4 = NULL, card_exp = NULL, topup_on = false WHERE id = $1', [user.id]);
  if (pm && ready() && here(user)) await stripe().paymentMethods.detach(pm).catch((err) => fault('a removed card could not be removed at the processor', err));
}

/**
 * The reader's automatic top-up: off, or on at a level, an amount and a monthly total from the operator's settings,
 * with the agreement's version the page showed (kept with the time of the reader's consent).
 */
export async function setTopUp(user, { on, levelCents, amountCents, capCents, agreement }) {
  refuseUnlessOpen(user);
  if (!topupOffered()) throw expected(new ApiError(404, 'payments_off', 'Automatic top-ups are not offered.'));
  if (on !== true) { await query('UPDATE users SET topup_on = false WHERE id = $1', [user.id]); return; }
  if (!user.cardMethod || !here(user)) throw expected(new ApiError(409, 'card_needed', 'Save a card first.'));
  const level = Number(levelCents), amount = Number(amountCents), cap = Number(capCents);
  if (!config.reloadLevelsCents.includes(level) || !config.topupAmountsCents.includes(amount) || !config.reloadCapsCents.includes(cap) || cap < amount) {
    throw expected(new ApiError(400, 'topup_invalid', 'Choose a level, an amount and a monthly total from the lists.'));
  }
  if (agreement !== TOPUP_AGREEMENT) throw expected(new ApiError(409, 'agreement_changed', 'The wording of this agreement has changed. Reload the page and read it again.'));
  await query(`UPDATE users SET topup_on = true, topup_level_cents = $2, topup_amount_cents = $3, topup_cap_cents = $4, topup_consent_at = $5, topup_consent_version = $6,
                 topup_paused_at = CASE WHEN topup_paused_reason = 'dispute' THEN topup_paused_at ELSE NULL END,
                 topup_paused_reason = CASE WHEN topup_paused_reason = 'dispute' THEN topup_paused_reason ELSE NULL END
               WHERE id = $1`, [user.id, level, amount, cap, new Date(now()), TOPUP_AGREEMENT]);
}

async function pauseTopUp(userId, reason) {
  await query('UPDATE users SET topup_paused_at = COALESCE(topup_paused_at, $2), topup_paused_reason = $3 WHERE id = $1', [userId, new Date(now()), reason]);
}

/** The account's top-up under way, if one is. */
async function pendingTopUp(userId) {
  return (await query("SELECT * FROM payments WHERE user_id = $1 AND kind = 'auto' AND status = 'pending'", [userId])).rows[0] || null;
}

/**
 * A pending top-up older than LONGEST_MS is under way nowhere: it is settled from the processor's record of its payment
 * when it has one (credited if it succeeded; a refusal pauses the top-up, as always), and otherwise let go as failed; if
 * the processor did take it after all, its notice credits it then (a failed payment is credited when its success is
 * told). Returns 'young' while it may still be under way, 'processing' while the processor is still settling it, or
 * 'settled'.
 */
async function settleStale(row) {
  if (now() - new Date(row.created_at).getTime() < LONGEST_MS) return 'young';
  let failure = 'stopped';
  if (row.intent_id && row.mode === mode()) {
    try {
      const pi = await stripe().paymentIntents.retrieve(row.intent_id);
      if (pi.status === 'succeeded') { await creditPayment(row.id, pi.id); return 'settled'; }
      if (pi.status === 'processing') return 'processing';
      const e = pi.last_payment_error;
      if (e) {
        failure = e.decline_code || e.code || pi.status;
        await pauseTopUp(Number(row.user_id), e.code === 'authentication_required' ? 'confirm' : 'declined');
      } else failure = pi.status;
    } catch (err) {
      fault('a stopped top-up could not be read from the processor', err);
      return 'processing';
    }
  }
  await query("UPDATE payments SET status = 'failed', failure = $2 WHERE id = $1 AND status = 'pending'", [row.id, String(failure).slice(0, 80)]);
  return 'settled';
}

/**
 * Until the account's top-up under way is settled (or is found stopped, and settled): a claim that waits on it goes on
 * then. Asked every half second; a top-up takes a second or two.
 */
export async function awaitTopUp(userId) {
  for (;;) {
    const row = await pendingTopUp(userId);
    if (!row || (await settleStale(row)) !== 'young') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The automatic top-up, when the reader has turned it on and the balance is below their level (or below `needCents`,
 * the price of a test about to be refused): their amount, on their saved card, never past their monthly total, one at
 * a time (a unique index on the account's pending top-up; one an instance stopped in the middle of is settled first). A
 * card refused (declined, or the bank asking the reader to confirm) pauses it. Returns { done, why }.
 */
export async function topUp(userId, { needCents = 0 } = {}, again = false) {
  if (!ready()) return { done: false, why: 'off' };
  const user = await accounts.userById(userId);
  if (!openTo(user) || !topupOffered() || !user.topupOn || user.topupPausedAt || user.payHoldAt || !user.cardMethod || !here(user)) return { done: false, why: 'off' };
  const amount = Number(user.topupAmountCents);
  if (!(amount > 0)) return { done: false, why: 'off' };
  const balance = await credit.balanceOf(userId);
  if (balance >= Math.max(Number(user.topupLevelCents) || 0, Number(needCents) || 0)) return { done: false, why: 'enough' };
  if ((await topupsThisMonth(userId)) + amount > (Number(user.topupCapCents) || 0)) return { done: false, why: 'cap' };
  const id = crypto.randomUUID();
  try {
    await query("INSERT INTO payments (id, user_id, kind, mode, amount_cents, currency, status, created_at) VALUES ($1, $2, 'auto', $6, $3, $4, 'pending', $5)", [id, userId, amount, config.currency, new Date(now()), mode()]);
  } catch (err) {
    if (err?.code !== '23505') throw err;
    // One is under way: this waits on it. One an instance stopped in the middle of is settled, and the top-up is asked
    // again from the start (that one may have added the credit).
    const row = await pendingTopUp(userId);
    if (!again && row && (await settleStale(row)) === 'settled') return topUp(userId, { needCents }, true);
    return { done: false, why: 'running' };
  }
  let pi;
  try {
    pi = await stripe().paymentIntents.create({
      amount, currency: config.currency.toLowerCase(), customer: user.payCustomer, payment_method: user.cardMethod, off_session: true, confirm: true,
      metadata: { payment: id, account: String(userId), kind: 'auto' }, description: 'FactEngine credit, automatic top-up',
    }, { idempotencyKey: `topup-${id}` });
  } catch (err) {
    const code = codeOf(err);
    await query("UPDATE payments SET status = 'failed', failure = $2, intent_id = COALESCE($3, intent_id) WHERE id = $1", [id, code, err?.raw?.payment_intent?.id || null]).catch(() => {});
    await pauseTopUp(userId, (err?.raw?.code || err?.code) === 'authentication_required' ? 'confirm' : 'declined');
    return { done: false, why: code };
  }
  await query('UPDATE payments SET intent_id = $2 WHERE id = $1', [id, pi.id]);
  if (pi.status === 'succeeded') {
    await creditPayment(id, pi.id);
    return { done: true, amountCents: amount };
  }
  return { done: false, why: pi.status };   // still processing: its notice settles it
}

// ---- the processor's notices ----------------------------------------------------------------------------------------
async function paymentByIntent(intentId) { return (await query('SELECT * FROM payments WHERE intent_id = $1', [intentId])).rows[0] || null; }

async function liftIfNoOpenDispute(userId) {
  const open = Number((await query("SELECT count(*) AS n FROM payments WHERE user_id = $1 AND status = 'disputed'", [userId])).rows[0].n);
  if (open === 0) await liftHold(userId);
}

async function handle(event) {
  const o = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (o.mode === 'setup') {
        const userId = Number(o.metadata?.account);
        if (!Number.isInteger(userId) || !o.setup_intent) return 'no account';
        const si = await stripe().setupIntents.retrieve(typeof o.setup_intent === 'string' ? o.setup_intent : o.setup_intent.id);
        if (si.status === 'succeeded' && si.payment_method) await keepCard(userId, si.payment_method);
        return 'card';
      }
      const paymentId = o.client_reference_id || o.metadata?.payment;
      const intent = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      if (o.payment_status === 'paid' && paymentId && intent) return creditPayment(paymentId, intent);
      return 'waiting';
    }
    case 'checkout.session.async_payment_failed': {
      const paymentId = o.client_reference_id || o.metadata?.payment;
      if (paymentId) await query("UPDATE payments SET status = 'failed', failure = 'async_payment_failed' WHERE id = $1 AND status = 'pending'", [paymentId]);
      return 'failed';
    }
    case 'checkout.session.expired': {
      const paymentId = o.client_reference_id || o.metadata?.payment;
      if (paymentId) await query("UPDATE payments SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [paymentId]);
      return 'cancelled';
    }
    case 'payment_intent.succeeded': {
      const paymentId = o.metadata?.payment;
      return paymentId ? creditPayment(paymentId, o.id) : 'not ours';
    }
    case 'payment_intent.payment_failed': {
      // A refused attempt on the hosted page can be tried again there; only an automatic top-up fails for good.
      if (o.metadata?.kind !== 'auto' || !o.metadata?.payment) return 'not final';
      const code = String(o.last_payment_error?.decline_code || o.last_payment_error?.code || 'failed').slice(0, 80);
      const r = await query("UPDATE payments SET status = 'failed', failure = $2, intent_id = COALESCE(intent_id, $3) WHERE id = $1 AND status = 'pending' RETURNING user_id", [o.metadata.payment, code, o.id]);
      if (r.rows[0]) await pauseTopUp(Number(r.rows[0].user_id), o.last_payment_error?.code === 'authentication_required' ? 'confirm' : 'declined');
      return 'failed';
    }
    case 'charge.refunded': {
      const intent = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id;
      const p = intent ? await paymentByIntent(intent) : null;
      if (!p) return 'not ours';
      const refunds = await stripe().refunds.list({ payment_intent: intent, limit: 100 });
      for (const rf of refunds.data || []) {
        if (rf.status === 'succeeded') await credit.paymentEntry(Number(p.user_id), 'refund', Number(rf.amount), { paymentId: p.id, ref: rf.id });
      }
      await query("UPDATE payments SET refunded_cents = $2, status = CASE WHEN $2 >= amount_cents AND status IN ('paid', 'won') THEN 'refunded' ELSE status END WHERE id = $1", [p.id, Number(o.amount_refunded) || 0]);
      return 'refunded';
    }
    case 'charge.dispute.created': {
      const p = o.payment_intent ? await paymentByIntent(typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent.id) : null;
      if (!p) return 'not ours';
      await query("UPDATE payments SET status = 'disputed' WHERE id = $1", [p.id]);
      await query('UPDATE users SET pay_hold_at = COALESCE(pay_hold_at, $2), pay_hold_reason = $3 WHERE id = $1', [p.user_id, new Date(now()), 'dispute']);
      await pauseTopUp(Number(p.user_id), 'dispute');
      return 'held';
    }
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated': {
      const p = o.payment_intent ? await paymentByIntent(typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent.id) : null;
      if (!p) return 'not ours';
      const withdrawn = event.type === 'charge.dispute.funds_withdrawn';
      await credit.paymentEntry(Number(p.user_id), withdrawn ? 'dispute' : 'dispute_won', Number(o.amount), { paymentId: p.id, ref: o.id });
      if (withdrawn) {
        const fee = (o.balance_transactions || []).reduce((s, b) => s + (Number(b?.fee) || 0), 0);
        if (fee) await query('UPDATE payments SET dispute_fee_cents = $2 WHERE id = $1', [p.id, fee]);
      }
      return withdrawn ? 'taken' : 'given back';
    }
    case 'charge.dispute.closed': {
      const p = o.payment_intent ? await paymentByIntent(typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent.id) : null;
      if (!p) return 'not ours';
      if (o.status === 'won') { await query("UPDATE payments SET status = 'won' WHERE id = $1", [p.id]); await liftIfNoOpenDispute(Number(p.user_id)); return 'won'; }
      if (o.status === 'lost') { await query("UPDATE payments SET status = 'lost' WHERE id = $1", [p.id]); return 'lost'; }
      return o.status || 'closed';
    }
    default:
      return 'ignored';
  }
}

/**
 * A notice from the processor (POST /hooks/stripe): its signature checked against the raw body, then handled once
 * (its id kept; one that failed is handled again when the processor sends it again). Returns { status }.
 */
export async function onNotice(rawBody, signature) {
  if (!ready()) return { status: 404 };
  let event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  } catch {
    return { status: 400, error: 'signature' };
  }
  // A notice of the other mode (the test-mode endpoint still sending after live keys are set) is acknowledged, and nothing more.
  if (typeof event.livemode === 'boolean' && event.livemode !== (mode() === 'live')) return { status: 200, otherMode: true };
  const fresh = (await query('INSERT INTO payment_notices (id, type, received_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id', [event.id, event.type, new Date(now())])).rows[0];
  if (!fresh) {
    const seen = (await query('SELECT done_at FROM payment_notices WHERE id = $1', [event.id])).rows[0];
    if (seen?.done_at) return { status: 200, duplicate: true };
  }
  try {
    const outcome = await handle(event);
    await query('UPDATE payment_notices SET done_at = $2, outcome = $3 WHERE id = $1', [event.id, new Date(now()), String(outcome || 'ok').slice(0, 80)]);
    return { status: 200 };
  } catch (err) {
    fault(`a notice (${event.type}) could not be handled`, err);
    return { status: 500, error: 'not handled' };   // the processor sends it again
  }
}

/** The operator lifts a dispute's hold on /check (or a won dispute does): testing, buying and the top-up resume. */
export async function liftHold(userId) {
  await query(`UPDATE users SET pay_hold_at = NULL, pay_hold_reason = NULL,
                 topup_paused_at = CASE WHEN topup_paused_reason = 'dispute' THEN NULL ELSE topup_paused_at END,
                 topup_paused_reason = CASE WHEN topup_paused_reason = 'dispute' THEN NULL ELSE topup_paused_reason END
               WHERE id = $1`, [userId]);
}

/** Each account's purchases in this mode, for the operator's table on /check. */
export async function byAccount() {
  const out = new Map();
  if (!dbOn()) return out;
  const r = await query(`SELECT user_id, COALESCE(sum(amount_cents) FILTER (WHERE status IN (${PAID.map((s) => `'${s}'`).join(', ')})), 0)::bigint AS paid,
                                count(*) FILTER (WHERE status = 'disputed') AS disputed FROM payments WHERE mode = $1 GROUP BY user_id`, [mode() || 'live']).catch(() => ({ rows: [] }));
  for (const x of r.rows) out.set(Number(x.user_id), { purchasedCents: Number(x.paid), disputed: Number(x.disputed) });
  return out;
}

/**
 * The books for /check, in the mode the key is in (a test payment is never money): collected, the processor's own fees,
 * net, refunds, disputes, the top-ups, and the margin on all costs since the first payment: what readers paid and kept paid (collected less refunds and disputed funds) less every
 * cost (the models' cost of readers' work, their fact-checks, free and paid, and their listings; the processor's fees;
 * dispute fees), as a share of those costs.
 */
export async function books() {
  const out = { switched: config.payments, ready: ready(), mode: mode(), missing: config.payments === 'off' ? [] : missing(), marginTargetPercent: config.marginTargetPercent, unhandled, lastFault };
  if (!dbOn()) return out;
  try {
    const m = mode() || 'live';
    const paidIn = PAID.map((s) => `'${s}'`).join(', ');
    const p = (await query(`SELECT
        COALESCE(sum(amount_cents) FILTER (WHERE status IN (${paidIn})), 0)::bigint AS collected,
        COALESCE(sum(fee_cents) FILTER (WHERE status IN (${paidIn})), 0)::bigint AS fees,
        count(*) FILTER (WHERE status IN (${paidIn}) AND fee_cents IS NULL) AS fee_unknown,
        count(*) FILTER (WHERE status IN (${paidIn})) AS payments,
        COALESCE(sum(refunded_cents), 0)::bigint AS refunded,
        COALESCE(sum(dispute_fee_cents), 0)::bigint AS dispute_fees,
        count(*) FILTER (WHERE status = 'disputed') AS open, count(*) FILTER (WHERE status = 'won') AS won, count(*) FILTER (WHERE status = 'lost') AS lost,
        count(*) FILTER (WHERE kind = 'auto' AND status IN (${paidIn})) AS topups, count(*) FILTER (WHERE kind = 'auto' AND status = 'failed') AS topups_failed,
        min(paid_at) AS since
      FROM payments WHERE mode = $1`, [m])).rows[0];
    const d = (await query(`SELECT COALESCE(-sum(c.cents) FILTER (WHERE c.kind = 'dispute'), 0)::bigint AS taken, COALESCE(sum(c.cents) FILTER (WHERE c.kind = 'dispute_won'), 0)::bigint AS back
                            FROM credit c JOIN payments p ON p.id = c.payment_id WHERE p.mode = $1`, [m])).rows[0];
    const u = (await query(`SELECT count(*) FILTER (WHERE topup_on AND pay_mode = $1) AS topup_on, count(*) FILTER (WHERE topup_on AND pay_mode = $1 AND topup_paused_at IS NOT NULL) AS topup_paused,
                                   count(*) FILTER (WHERE pay_hold_at IS NOT NULL) AS holds FROM users`, [m])).rows[0];
    const collected = Number(p.collected), fees = Number(p.fees), refunded = Number(p.refunded), disputeFees = Number(p.dispute_fees);
    const disputedNet = Number(d.taken) - Number(d.back);
    let margin = null;
    if (p.since) {
      const readers = '(r.email IS NULL OR r.email NOT IN (SELECT email FROM users WHERE operator))';
      const c = (await query(`SELECT
          COALESCE((SELECT sum(d.cost_usd) FROM determinations d JOIN runs r ON r.id = d.run_id WHERE d.started_at >= $1 AND ${readers}), 0) AS tests,
          COALESCE((SELECT sum(r.extract_usd) FROM runs r WHERE r.started_at >= $1 AND ${readers}), 0) AS listings`, [p.since])).rows[0];
      const modelCents = Math.round((Number(c.tests) + Number(c.listings)) * 100);
      const revenueCents = collected - refunded - disputedNet;
      const costCents = modelCents + fees + disputeFees;
      const percent = costCents > 0 ? Math.round(((revenueCents - costCents) / costCents) * 1000) / 10 : null;
      margin = { revenueCents, costCents, modelCents, feeCents: fees + disputeFees, percent, below: percent !== null && percent < config.marginTargetPercent };
    }
    return {
      ...out, payments: Number(p.payments), since: p.since ? new Date(p.since).toISOString() : null,
      collectedCents: collected, feeCents: fees, feeUnknown: Number(p.fee_unknown), netCents: collected - fees, refundedCents: refunded,
      disputes: { open: Number(p.open), won: Number(p.won), lost: Number(p.lost), takenCents: Number(d.taken), backCents: Number(d.back), feeCents: disputeFees },
      topups: { made: Number(p.topups), failed: Number(p.topups_failed), on: Number(u.topup_on), paused: Number(u.topup_paused) },
      holds: Number(u.holds), margin,
    };
  } catch (err) {
    return { ...out, error: err.message };
  }
}
