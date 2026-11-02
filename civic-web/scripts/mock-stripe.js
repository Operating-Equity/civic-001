// A stand-in for the payment processor (1 November), for the guard and the browser checks, as scripts/mock-openai.js
// stands in for the models. It answers the calls server/payments.js makes (customers, hosted-page sessions, payments,
// saved cards, refunds), serves a hosted page of its own with Pay and Cancel, and sends the processor's notices to the
// server, signed as the processor signs them. Its test controls (under /mock/) let the guard pay, hold a notice back,
// send one twice or at once, refuse a card, refund and dispute.
//
//   MOCK_STRIPE_PORT     its port
//   MOCK_STRIPE_HOOK       where its notices go (the server's /hooks/stripe)
//   MOCK_STRIPE_HOOK_LIVE  where its live-mode notices go, as the processor's live endpoint is configured apart from the
//                          test one (unset: the same address)
//   MOCK_STRIPE_SECRET     the endpoints' signing secret (the server's CIVIC_STRIPE_WEBHOOK_SECRET)
//
// As the processor's, its test mode and live mode are apart: what a live key makes is live (livemode), and so are its
// notices.
//
// Cards, by the payment method the hosted page or the guard names: visa (pays), declined (refused), auth (the bank asks
// the cardholder to confirm, which an automatic charge cannot do).
import crypto from 'node:crypto';
import express from 'express';

const PORT = Number(process.env.MOCK_STRIPE_PORT || 4900);
const HOOK = process.env.MOCK_STRIPE_HOOK || '';
const HOOK_LIVE = process.env.MOCK_STRIPE_HOOK_LIVE || HOOK;
const SECRET = process.env.MOCK_STRIPE_SECRET || '';
const BASE = `http://localhost:${PORT}`;

const db = { customers: new Map(), sessions: new Map(), intents: new Map(), charges: new Map(), methods: new Map(), setups: new Map(), refunds: [], held: [], n: 0 };
const stats = { calls: {}, keys: new Set(), events: 0, detached: [] };
const next = (prefix) => `${prefix}_${(++db.n).toString().padStart(6, '0')}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const CARDS = {
  visa: { brand: 'visa', last4: '4242', country: 'US' },
  declined: { brand: 'visa', last4: '0002', country: 'US', fail: { code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } },
  auth: { brand: 'visa', last4: '3184', country: 'US', fail: { code: 'authentication_required', message: 'This payment requires authentication.' } },
};
const cardOfMethod = (pmId) => CARDS[db.methods.get(pmId)?.kind] || CARDS.visa;

function method(kind, livemode = false) {
  const c = CARDS[kind] || CARDS.visa;
  const pm = { id: next('pm'), object: 'payment_method', type: 'card', kind, livemode, customer: null, card: { brand: c.brand, last4: c.last4, exp_month: 12, exp_year: new Date().getFullYear() + 3, country: c.country } };
  db.methods.set(pm.id, pm);
  return pm;
}
const publicMethod = (pm) => { if (!pm) return null; const { kind, ...rest } = pm; return rest; };

function sign(payload) {
  const t = nowSec();
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
function event(type, object) {
  return { id: next('evt'), object: 'event', api_version: '2026-10-28.endive', created: nowSec(), livemode: Boolean(object?.livemode), type, data: { object } };
}
async function send(ev, { times = 1, together = false, forge = false, to = null } = {}) {
  const hook = to === 'live' ? HOOK_LIVE : to === 'test' ? HOOK : ev.livemode ? HOOK_LIVE : HOOK;
  if (!hook) return [];
  const payload = JSON.stringify(ev);
  const one = async () => {
    stats.events++;
    const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': forge ? sign('{"forged":true}') : sign(payload) }, body: payload }).catch((e) => ({ status: 0, text: async () => e.message }));
    return r.status;
  };
  if (together) return Promise.all(Array.from({ length: times }, one));
  const out = [];
  for (let i = 0; i < times; i++) out.push(await one());
  return out;
}

function chargeFor(pi, cardKind) {
  const c = CARDS[cardKind] || CARDS.visa;
  const fee = Math.round(pi.amount * 0.029) + 30;
  const ch = {
    id: next('ch'), object: 'charge', livemode: Boolean(pi.livemode), amount: pi.amount, amount_refunded: 0, currency: pi.currency, payment_intent: pi.id,
    balance_transaction: { id: next('txn'), object: 'balance_transaction', amount: pi.amount, fee, net: pi.amount - fee },
    payment_method_details: { type: 'card', card: { brand: c.brand, country: c.country, last4: c.last4, wallet: null } },
  };
  db.charges.set(ch.id, ch);
  return ch;
}
function intentView(pi, expand = []) {
  const out = { ...pi };
  const ch = db.charges.get(pi.latest_charge);
  if (expand.some((e) => e.startsWith('latest_charge'))) out.latest_charge = ch ? { ...ch, balance_transaction: expand.includes('latest_charge.balance_transaction') ? ch.balance_transaction : ch.balance_transaction.id } : null;
  if (expand.includes('payment_method')) out.payment_method = publicMethod(db.methods.get(pi.payment_method)) || pi.payment_method;
  return out;
}
const stripeError = (res, status, err) => res.status(status).json({ error: { type: err.type || 'invalid_request_error', ...err } });

/** Completes a hosted-page session as the processor does: a payment (or a saved card) and its notices. */
async function complete(session, cardKind, { deliver = 'now' } = {}) {
  const c = CARDS[cardKind] || CARDS.visa;
  const notices = [];
  if (session.mode === 'setup') {
    const pm = method(cardKind, session.livemode);
    pm.customer = session.customer;
    const si = { id: next('seti'), object: 'setup_intent', livemode: session.livemode, status: 'succeeded', payment_method: pm.id, customer: session.customer, metadata: session.setup_intent_data?.metadata || {} };
    db.setups.set(si.id, si);
    Object.assign(session, { status: 'complete', setup_intent: si.id });
    notices.push(event('checkout.session.completed', { ...session }));
  } else {
    if (c.fail) return { failed: c.fail };   // on the hosted page a refused card can be tried again; nothing is sent
    const pm = method(cardKind, session.livemode);
    const save = session.payment_intent_data?.setup_future_usage === 'off_session';
    if (save) pm.customer = session.customer;
    const pi = { id: next('pi'), object: 'payment_intent', livemode: session.livemode, status: 'succeeded', amount: session.amount_total, amount_received: session.amount_total, currency: session.currency, customer: session.customer,
      payment_method: pm.id, metadata: session.payment_intent_data?.metadata || {}, latest_charge: null };
    pi.latest_charge = chargeFor(pi, cardKind).id;
    db.intents.set(pi.id, pi);
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: pi.id });
    notices.push(event('checkout.session.completed', { ...session }), event('payment_intent.succeeded', { ...pi }));
  }
  if (deliver === 'hold') db.held.push(...notices);
  else for (const n of notices) await send(n);
  return { session: session.id, intent: session.payment_intent || null, notices: notices.map((n) => n.id) };
}

const app = express();
app.set('query parser', 'extended');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/v1', (req, res, nextFn) => {
  const key = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^(sk|rk)_(test|live)_/.test(key)) return stripeError(res, 401, { message: 'Invalid API Key provided.' });
  stats.keys.add(key.slice(0, 8));
  req.live = /^(sk|rk)_live_/.test(key);
  const name = `${req.method} ${req.path.replace(/\/(cus|cs|pi|pm|seti|ch|re)_[A-Za-z0-9_]+/g, '/:id')}`;
  stats.calls[name] = (stats.calls[name] || 0) + 1;
  nextFn();
});

app.post('/v1/customers', (req, res) => {
  const c = { id: next('cus'), object: 'customer', livemode: req.live, email: req.body.email || null, metadata: req.body.metadata || {} };
  db.customers.set(c.id, c);
  res.json(c);
});

app.post('/v1/checkout/sessions', (req, res) => {
  const b = req.body;
  // A customer of the other mode does not exist in this one, as at the processor.
  if (!b.customer || !db.customers.has(b.customer) || db.customers.get(b.customer).livemode !== req.live) return stripeError(res, 400, { message: `No such customer: '${b.customer}'`, param: 'customer', code: 'resource_missing' });
  if (!b.success_url || !b.cancel_url) return stripeError(res, 400, { message: 'Missing success_url or cancel_url' });
  const id = `cs_test_${(++db.n).toString().padStart(6, '0')}`;
  const li = b.line_items?.[0];
  const amount = li ? Number(li.price_data?.unit_amount) * Number(li.quantity || 1) : null;
  if (b.mode === 'payment' && !(amount >= 50)) return stripeError(res, 400, { message: 'Amount must be at least 50 cents', param: 'line_items' });
  const s = {
    id, object: 'checkout.session', livemode: req.live, mode: b.mode, status: 'open', payment_status: b.mode === 'payment' ? 'unpaid' : 'no_payment_required',
    customer: b.customer, client_reference_id: b.client_reference_id || null, metadata: b.metadata || {}, amount_total: amount,
    currency: String(b.currency || li?.price_data?.currency || 'usd').toLowerCase(), url: `${BASE}/pay/${id}`, success_url: b.success_url, cancel_url: b.cancel_url,
    payment_intent: null, setup_intent: null, payment_intent_data: b.payment_intent_data || null, setup_intent_data: b.setup_intent_data || null,
  };
  db.sessions.set(id, s);
  res.json(s);
});

app.get('/v1/checkout/sessions/:id', (req, res) => {
  const s = db.sessions.get(req.params.id);
  if (!s || s.livemode !== req.live) return stripeError(res, 404, { message: 'No such checkout.session', code: 'resource_missing' });
  const expand = [].concat(req.query.expand || []);
  const out = { ...s };
  if (expand.includes('setup_intent') && s.setup_intent) out.setup_intent = db.setups.get(s.setup_intent);
  res.json(out);
});

app.post('/v1/payment_intents', async (req, res) => {
  const b = req.body;
  const pmId = b.payment_method;
  const pm = db.methods.get(pmId);
  if (!pm || pm.customer !== b.customer || pm.livemode !== req.live) return stripeError(res, 400, { message: 'No such PaymentMethod for this customer', param: 'payment_method', code: 'resource_missing' });
  const pi = { id: next('pi'), object: 'payment_intent', livemode: req.live, status: 'processing', amount: Number(b.amount), amount_received: 0, currency: String(b.currency).toLowerCase(), customer: b.customer,
    payment_method: pmId, metadata: b.metadata || {}, latest_charge: null };
  db.intents.set(pi.id, pi);
  const c = cardOfMethod(pmId);
  if (c.fail) {
    pi.status = 'requires_payment_method';
    pi.last_payment_error = { ...c.fail, type: 'card_error' };
    setTimeout(() => send(event('payment_intent.payment_failed', { ...pi })), 50);
    return stripeError(res, 402, { type: 'card_error', ...c.fail, payment_intent: { id: pi.id, status: pi.status } });
  }
  pi.status = 'succeeded';
  pi.amount_received = pi.amount;
  pi.latest_charge = chargeFor(pi, pm.kind).id;
  setTimeout(() => send(event('payment_intent.succeeded', { ...pi })), 50);
  res.json(pi);
});

app.get('/v1/payment_intents/:id', (req, res) => {
  const pi = db.intents.get(req.params.id);
  if (!pi || Boolean(pi.livemode) !== req.live) return stripeError(res, 404, { message: 'No such payment_intent', code: 'resource_missing' });
  res.json(intentView(pi, [].concat(req.query.expand || [])));
});

app.get('/v1/payment_methods/:id', (req, res) => {
  const pm = db.methods.get(req.params.id);
  if (!pm || pm.livemode !== req.live) return stripeError(res, 404, { message: 'No such PaymentMethod', code: 'resource_missing' });
  res.json(publicMethod(pm));
});

app.post('/v1/payment_methods/:id/detach', (req, res) => {
  const pm = db.methods.get(req.params.id);
  if (!pm || pm.livemode !== req.live) return stripeError(res, 404, { message: 'No such PaymentMethod', code: 'resource_missing' });
  pm.customer = null;
  stats.detached.push(pm.id);
  res.json(publicMethod(pm));
});

app.get('/v1/setup_intents/:id', (req, res) => {
  const si = db.setups.get(req.params.id);
  if (!si || si.livemode !== req.live) return stripeError(res, 404, { message: 'No such setupintent', code: 'resource_missing' });
  res.json(si);
});

app.get('/v1/refunds', (req, res) => {
  const pi = req.query.payment_intent;
  res.json({ object: 'list', data: db.refunds.filter((r) => r.payment_intent === pi), has_more: false });
});

// ---- the hosted page (for the browser checks) ----------------------------------------------------------------------
app.get('/pay/:id', (req, res) => {
  const s = db.sessions.get(req.params.id);
  if (!s) return res.status(404).send('No such session');
  const what = s.mode === 'setup' ? 'Save a card' : `Pay ${(s.amount_total / 100).toFixed(2)} ${s.currency.toUpperCase()}`;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Stand-in payment page</title><body style="font:16px system-ui;padding:24px">
    <h1 id="what">${what}</h1><p>The guard's stand-in for the payment processor's hosted page.</p>
    <form method="post" action="/pay/${s.id}"><label>Card <select name="card" id="card"><option value="visa">Visa 4242 (pays)</option><option value="declined">Visa 0002 (declined)</option><option value="auth">Visa 3184 (bank asks to confirm)</option></select></label>
    <p><button id="pay" name="go" value="pay">${s.mode === 'setup' ? 'Save' : 'Pay'}</button> <button id="cancel" name="go" value="cancel">Cancel</button></p></form>
    <p id="msg">${req.query.failed ? 'Your card was declined. Try another card.' : ''}</p></body>`);
});
app.post('/pay/:id', async (req, res) => {
  const s = db.sessions.get(req.params.id);
  if (!s) return res.status(404).send('No such session');
  if (req.body.go === 'cancel') return res.redirect(303, s.cancel_url);
  const out = await complete(s, req.body.card || 'visa');
  if (out.failed) return res.redirect(303, `/pay/${s.id}?failed=1`);
  res.redirect(303, s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id));
});

// ---- the guard's controls -------------------------------------------------------------------------------------------
app.post('/mock/pay/:id', async (req, res) => {
  const s = db.sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  res.json(await complete(s, req.body.card || 'visa', { deliver: req.body.deliver || 'now' }));
});
app.post('/mock/deliver', async (req, res) => {
  const held = db.held.splice(0);
  if (req.body.reverse === true) held.reverse();   // out of order: the payment's notice before the page's
  const out = [];
  for (const ev of held) out.push(await send(ev, { times: Number(req.body.times) || 1, together: req.body.together === true }));
  res.json({ sent: held.map((e) => e.type), statuses: out });
});
app.post('/mock/forge', async (req, res) => {
  const s = db.sessions.get(req.body.session);
  const ev = event('checkout.session.completed', { ...(s || {}), payment_status: 'paid' });
  res.json({ statuses: await send(ev, { forge: true }) });
});
// A payment the guard makes up, succeeded, with the metadata and amount it is given, and its notice sent signed: a
// payment that names another account, or another amount, than the one it was made for.
// `live` makes it a live-mode payment; `to` sends its notice to the test or the live endpoint whatever its mode.
app.post('/mock/intent', async (req, res) => {
  const amount = Number(req.body.amount) || 0;
  const live = req.body.live === true;
  const pm = method('visa', live);
  const pi = { id: next('pi'), object: 'payment_intent', livemode: live, status: 'succeeded', amount, amount_received: amount, currency: 'usd', customer: null, payment_method: pm.id, metadata: req.body.metadata || {}, latest_charge: null };
  pi.latest_charge = chargeFor(pi, 'visa').id;
  db.intents.set(pi.id, pi);
  const ev = event('payment_intent.succeeded', { ...pi });
  res.json({ intent: pi.id, event: ev.id, statuses: await send(ev, { to: req.body.to || null }) });
});
app.post('/mock/refund', async (req, res) => {
  const pi = db.intents.get(req.body.intent);
  if (!pi) return res.status(404).json({ error: 'no intent' });
  const ch = db.charges.get(pi.latest_charge);
  const amount = Number(req.body.amount) || pi.amount;
  const re = { id: next('re'), object: 'refund', amount, status: 'succeeded', payment_intent: pi.id, charge: ch.id };
  db.refunds.push(re);
  ch.amount_refunded += amount;
  res.json({ refund: re.id, statuses: await send(event('charge.refunded', { ...ch, balance_transaction: ch.balance_transaction.id }), { times: Number(req.body.times) || 1 }) });
});
app.post('/mock/dispute', async (req, res) => {
  const pi = db.intents.get(req.body.intent);
  if (!pi) return res.status(404).json({ error: 'no intent' });
  const id = req.body.dispute || next('dp');
  const step = req.body.step || 'created';
  const d = { id, object: 'dispute', livemode: Boolean(pi.livemode), amount: pi.amount, currency: pi.currency, payment_intent: pi.id, charge: pi.latest_charge, status: req.body.status || 'needs_response',
    balance_transactions: step === 'funds_withdrawn' ? [{ id: next('txn'), amount: -pi.amount, fee: 1500 }] : [] };
  res.json({ dispute: id, statuses: await send(event(`charge.dispute.${step}`, d), { times: Number(req.body.times) || 1 }) });
});
app.get('/mock/stats', (req, res) => res.json({ calls: stats.calls, keys: [...stats.keys], events: stats.events, detached: stats.detached, held: db.held.length,
  methods: [...db.methods.values()].map((m) => ({ id: m.id, kind: m.kind, customer: m.customer, livemode: m.livemode })), customers: db.customers.size,
  liveCustomers: [...db.customers.values()].filter((c) => c.livemode).length }));

app.listen(PORT, () => console.log(`[mock-stripe] listening on ${PORT}`));
