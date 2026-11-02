// The Account page (5 October): the reader's balance, the credit's history, a monthly limit, and the sign-in's own
// settings; and, from a link, a new password (#reset=…) or the operator's own account (#claim=…). Adding credit (1
// November): an amount, then the payment processor's own page and back (?paid=…), a saved card (?card=…) and the
// automatic top-up the reader turns on with its agreement. Opened in a new tab from the main page, so a run there goes on.
import * as api from './api.js';
import { t, setLocale, initLocale, LOCALES, currentLocale } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); } for (const k of kids) n.append(k); return n; };

// The version of the automatic top-up's agreement as this page words it (account.topup.agreement, four languages): sent
// with the reader's consent, kept with it, and refused by the server if its own version is another (a page left open
// across a change of wording is asked to reload).
const TOPUP_AGREEMENT = '2026-11-01';

// state.choice: the amount chosen (cents, or 'other'). payNote, cardNote, topupNote: a sentence about the last payment,
// card or top-up action, as a function so it is said again in a language chosen afterwards. back: the return from the
// payment page, read once from the address.
const state = { account: null, lines: [], before: null, more: false, link: null, choice: null, payNote: null, cardNote: null, topupNote: null, back: null };

function money(cents) {
  const currency = state.account?.currency || 'USD';
  try { return new Intl.NumberFormat(currentLocale(), { style: 'currency', currency }).format((Number(cents) || 0) / 100); } catch { return `${((Number(cents) || 0) / 100).toFixed(2)} ${currency}`; }
}
const day = (iso) => { try { return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso)); } catch { return iso; } };
const when = (iso) => { try { return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };
const note = (node, text, bad = false) => { node.textContent = text || ''; node.hidden = !text; node.classList.toggle('is-bad', Boolean(bad)); };

/** A refusal in the reader's language, from its code. */
function words(err) {
  switch (err?.code) {
    case 'password_short': return t('account.err.short', { n: Number(state.minChars) || 8 });
    case 'password_long': return t('account.err.long');
    case 'wrong_password': return t('account.err.wrong');
    case 'email_invalid': return t('account.err.email');
    case 'email_taken': return t('account.err.taken');
    case 'terms_required': return t('account.err.terms');
    case 'tries_wait': return t('account.err.wait', { m: Math.max(1, Math.ceil((Number(err.waitSeconds) || 60) / 60)) });
    case 'account_closed': return t('account.err.closed');
    case 'reset_invalid': case 'claim_invalid': return err.message;
    case 'payments_off': return t('account.pay.off');
    case 'account_hold': return t('account.pay.hold');
    case 'amount_invalid': return t('account.pay.amountInvalid');
    case 'payment_unavailable': return t('account.pay.unavailable');
    case 'no_payment': return t('account.pay.noPayment');
    case 'card_needed': return t('account.topup.cardNeeded');
    case 'topup_invalid': return t('account.topup.invalid');
    case 'agreement_changed': return t('account.topup.changed');
    default: return err?.message || t('errors.server');
  }
}

// ---- the page's words, in the reader's language --------------------------------------------------------------
function render() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  document.title = `FactEngine · ${t('account.page.title')}`;
  const a = state.account;
  if (a) {
    $('#acct-who').textContent = t('account.page.signedInAs', { email: a.email });
    $('#acct-balance').textContent = money(a.balanceCents);
    $('#acct-balance-note').textContent = t('account.page.balanceNote', { amount: money(a.grantCents) });
    $('#acct-limit-now').textContent = a.monthlyLimitCents === null || a.monthlyLimitCents === undefined
      ? t('account.page.limitNowNone', { spent: money(a.monthSpentCents), date: day(a.monthEndsAt) })
      : t('account.page.limitNow', { spent: money(a.monthSpentCents), limit: money(a.monthlyLimitCents), date: day(a.monthEndsAt) });
    $('#acct-limit-remove').hidden = a.monthlyLimitCents === null || a.monthlyLimitCents === undefined;
    $('#acct-pw-email').value = a.email;
    $('#acct-delete-email').value = a.email;
    $('#acct-delete-box').hidden = Boolean(a.operator);
  }
  renderPayments();
  renderActivity();
  if (state.link?.kind === 'claim') renderClaimAgree();
}

function verdictWord(v) { return v === 'true' || v === 'false' || v === 'unverified' ? t(`score.${v}`) : '—'; }

function renderActivity() {
  const list = $('#acct-activity');
  if (!state.account) { list.replaceChildren(); return; }
  if (!state.lines.length) { list.replaceChildren(el('li', { text: t('account.page.none') })); $('#acct-more').hidden = true; return; }
  list.replaceChildren(...state.lines.map((l) => {
    let what = '', amount = '', plus = false;
    if (l.kind === 'grant') { what = t('account.page.grant'); amount = `+${money(l.amountCents)}`; plus = true; }
    else if (l.kind === 'adjustment') { what = l.cents > 0 ? t('account.page.adjustment') : t('account.page.adjustmentTaken'); amount = `${l.cents > 0 ? '+' : '−'}${money(Math.abs(l.cents))}`; plus = l.cents > 0; if (l.note) what += ` · ${l.note}`; }
    else if (l.kind === 'purchase') { what = l.via === 'auto' ? t('account.page.topup') : t('account.page.purchase'); amount = `+${money(l.amountCents)}`; plus = true; }
    else if (l.kind === 'refund') { what = t('account.page.refund'); amount = `−${money(l.amountCents)}`; }
    else if (l.kind === 'dispute') { what = t('account.page.dispute'); amount = `−${money(l.amountCents)}`; }
    else if (l.kind === 'dispute_won') { what = t('account.page.disputeWon'); amount = `+${money(l.amountCents)}`; plus = true; }
    else if (l.kind === 'test') {
      const n = l.n ?? '·';
      if (l.state === 'free') { what = t('account.page.free', { n, verdict: verdictWord(l.verdict) }); amount = t('account.page.freeAmount'); }
      else if (l.state === 'charged') { what = t('account.page.charged', { n, verdict: verdictWord(l.verdict) }); amount = `−${money(l.amountCents)}`; }
      else if (l.state === 'released') { what = t('account.page.released', { n }); amount = money(0); }
      else { what = t('account.page.held', { n }); amount = `−${money(l.amountCents)}`; }
    }
    return el('li', {}, [el('span', {}, [el('time', { datetime: l.at, text: when(l.at) }), document.createTextNode(what)]), el('span', { class: `acct-amount${plus ? ' is-plus' : ''}`, text: amount })]);
  }));
  $('#acct-more').hidden = !state.more;
}

// ---- adding credit: the amounts, the payment page, the saved card and the automatic top-up --------------------------
const pay = () => state.account?.payments || { on: false };
const BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay', cartes_bancaires: 'Cartes Bancaires', eftpos_au: 'eftpos', interac: 'Interac' };
const cardName = (card) => (card ? t('account.pay.card', { brand: BRANDS[card.brand] || card.brand || '', last4: card.last4 || '' }) : t('account.topup.yourCard'));
const hasOther = (p) => Number.isInteger(p.minCents) && Number.isInteger(p.maxCents);

function renderPayments() {
  const p = pay();
  const on = Boolean(state.account && p.on);
  $('#acct-add-credit').hidden = on;
  $('#acct-hold').hidden = !(on && p.hold);
  $('#acct-buy').hidden = !on || Boolean(p.hold);
  $('#auto-topup').hidden = !on || !p.topup;
  note($('#acct-paid-note'), state.payNote?.text() || '', state.payNote?.bad);
  if (!on) return;
  renderBuy(p);
  if (p.topup) renderTopUp(p);
}

/** The amounts as choices (each with about how many fact-checks it buys at today's price), Other, and the card's tick. */
function renderBuy(p) {
  const presets = Array.isArray(p.amountsCents) ? p.amountsCents : [];
  const other = hasOther(p);
  const valid = (c) => (c === 'other' ? other : presets.includes(c));
  if (!valid(state.choice)) state.choice = presets.length ? presets[0] : other ? 'other' : null;
  const about = (cents) => (p.priceCents > 0 ? t('account.pay.about', { n: Math.floor(cents / p.priceCents) }) : '');
  const option = (value, label, sub) => {
    const input = el('input', { type: 'radio', name: 'acct-amount', value: String(value) });
    input.checked = state.choice === value;
    const wrap = el('label', { class: 'acct-choice' }, [input, el('strong', { text: label }), ...(sub ? [el('span', { text: sub })] : [])]);
    input.addEventListener('change', () => { if (input.checked) { state.choice = value; syncBuy(); if (value === 'other') $('#acct-other').focus(); } });
    input.addEventListener('focus', () => wrap.classList.toggle('is-focus', input.matches(':focus-visible')));
    input.addEventListener('blur', () => wrap.classList.remove('is-focus'));
    return wrap;
  };
  const legend = $('#acct-amounts legend');
  legend.textContent = t('account.pay.choose');
  $('#acct-amounts').replaceChildren(legend, ...presets.map((c) => option(c, money(c), about(c))),
    ...(other ? [option('other', t('account.pay.other'), t('account.pay.otherRange', { min: money(p.minCents), max: money(p.maxCents) }))] : []));
  $('#acct-price-note').textContent = p.priceCents > 0 ? t('account.pay.priceNote', { price: money(p.priceCents) }) : '';
  $('#acct-price-note').hidden = !(p.priceCents > 0);
  $('#acct-other-label').textContent = other ? t('account.pay.otherLabel', { min: money(p.minCents), max: money(p.maxCents) }) : '';
  $('#acct-other').placeholder = other ? (p.minCents / 100).toFixed(2) : '';
  $('#acct-save-field').hidden = !p.topup;
  $('#acct-save-text').textContent = p.card ? t('account.pay.saveReplace', { card: cardName(p.card) }) : t('account.pay.save');
  syncBuy();
}

function syncBuy() {
  for (const input of document.querySelectorAll('#acct-amounts input')) input.closest('.acct-choice').classList.toggle('is-chosen', input.checked);
  $('#acct-other-field').hidden = state.choice !== 'other';
  $('#acct-buy-go').disabled = state.choice === null;
}

async function buy(e) {
  e.preventDefault();
  const p = pay();
  let cents = state.choice;
  if (cents === 'other') {
    const raw = $('#acct-other').value.trim().replace(',', '.');
    const v = Number(raw);
    cents = /^\d+(\.\d{1,2})?$/.test(raw) && Number.isFinite(v) ? Math.round(v * 100) : NaN;
    if (!(cents >= p.minCents && cents <= p.maxCents)) { note($('#acct-buy-note'), t('account.pay.otherInvalid', { min: money(p.minCents), max: money(p.maxCents) }), true); $('#acct-other').focus(); return; }
  }
  if (!Number.isInteger(cents)) return;
  note($('#acct-buy-note'), '');
  $('#acct-buy-go').disabled = true;
  try {
    const out = await api.startCheckout({ amountCents: cents, saveCard: !$('#acct-save-field').hidden && $('#acct-save').checked });
    if (!out?.url) throw new Error(t('account.pay.unavailable'));
    location.assign(out.url);   // the button stays held while the page moves
  } catch (err) {
    note($('#acct-buy-note'), words(err), true);
    $('#acct-buy-go').disabled = false;
  }
}

/** The automatic top-up: its state, the card's line, the three choices, the agreement in full, and the switch. */
function renderTopUp(p) {
  const tu = p.topup;
  $('#acct-topup-status').textContent = tu.on
    ? t('account.topup.statusOn', { level: money(tu.levelCents), amount: money(tu.amountCents), cap: money(tu.capCents), month: money(tu.monthCents) })
    : t('account.topup.statusOff');
  note($('#acct-topup-paused'), tu.on && tu.paused ? t(`account.topup.paused.${['declined', 'confirm', 'dispute'].includes(tu.paused) ? tu.paused : 'declined'}`) : '', true);
  const btn = (key, fn, cls = 'btn btn-outline btn-small') => { const b = el('button', { type: 'button', class: cls, text: t(key) }); b.addEventListener('click', fn); return b; };
  $('#acct-card-line').replaceChildren(...(p.card
    ? [el('span', { text: t('account.pay.cardLine', { card: cardName(p.card), exp: p.card.exp || '' }) }), el('span', { class: 'acct-card-tools' }, [btn('account.pay.replace', addCard), btn('account.pay.remove', removeCard, 'btn btn-text btn-small')])]
    : [el('span', { class: 'acct-note', text: t('account.pay.noCard') }), btn('account.pay.addCard', addCard)]));
  note($('#acct-card-note'), state.cardNote?.text() || '', state.cardNote?.bad);
  const fill = (sel, list, chosen) => {
    const node = $(sel);
    const keep = node.dataset.chosen ? Number(node.dataset.chosen) : null;   // the reader's own choice, kept across a re-render
    const value = list.includes(keep) ? keep : list.includes(chosen) ? chosen : list[0];
    node.replaceChildren(...list.map((c) => el('option', { value: String(c), text: money(c) })));
    node.value = String(value);
  };
  fill('#acct-topup-level', tu.levelsCents, tu.levelCents);
  fill('#acct-topup-amount', tu.amountsCents, tu.amountCents);
  fill('#acct-topup-cap', tu.capsCents, tu.capCents);
  syncTopUp();
  $('#acct-topup-on').textContent = tu.on && !tu.paused ? t('account.topup.save') : t('account.topup.agree');
  $('#acct-topup-on').disabled = !p.card;
  $('#acct-topup-off').hidden = !tu.on;
  note($('#acct-topup-note'), state.topupNote?.text() || '', state.topupNote?.bad);
}

/** A monthly total below the amount is never offered; the agreement says exactly what the choices mean. */
function syncTopUp() {
  const p = pay();
  if (!p.topup) return;
  const amount = Number($('#acct-topup-amount').value);
  const cap = $('#acct-topup-cap');
  for (const o of cap.options) o.disabled = Number(o.value) < amount;
  if (Number(cap.value) < amount) { const ok = [...cap.options].find((o) => !o.disabled); if (ok) cap.value = ok.value; }
  $('#acct-topup-agreement').textContent = t('account.topup.agreement', {
    level: money(Number($('#acct-topup-level').value)), amount: money(amount), cap: money(Number(cap.value)),
    card: p.card ? t('account.topup.onCard', { card: cardName(p.card) }) : t('account.topup.yourCard'),
  });
}

async function topUpOn(e) {
  e.preventDefault();
  const p = pay();
  if (!p.topup || !p.card) return;
  $('#acct-topup-on').disabled = true;
  try {
    const out = await api.setTopUp({ on: true, levelCents: Number($('#acct-topup-level').value), amountCents: Number($('#acct-topup-amount').value), capCents: Number($('#acct-topup-cap').value), agreement: TOPUP_AGREEMENT });
    state.account.payments = out.payments;
    for (const sel of ['#acct-topup-level', '#acct-topup-amount', '#acct-topup-cap']) delete $(sel).dataset.chosen;
    state.topupNote = { text: () => t('account.topup.savedOn') };
  } catch (err) {
    const message = words(err);
    state.topupNote = { text: () => message, bad: true };
  }
  render();
}

async function topUpOff() {
  try {
    const out = await api.setTopUp({ on: false });
    state.account.payments = out.payments;
    state.topupNote = { text: () => t('account.topup.savedOff') };
  } catch (err) {
    const message = words(err);
    state.topupNote = { text: () => message, bad: true };
  }
  render();
}

async function addCard() {
  try {
    const out = await api.startCardSetup();
    if (!out?.url) throw new Error(t('account.pay.unavailable'));
    location.assign(out.url);
  } catch (err) {
    const message = words(err);
    state.cardNote = { text: () => message, bad: true };
    render();
  }
}

async function removeCard() {
  if (!window.confirm(t('account.pay.removeConfirm', { card: cardName(pay().card) }))) return;
  try {
    const out = await api.removeCard();
    state.account.payments = out.payments;
    state.cardNote = { text: () => t('account.pay.removed') };
  } catch (err) {
    const message = words(err);
    state.cardNote = { text: () => message, bad: true };
  }
  render();
}

/** Back from the payment page (?paid=…) or from saving a card (?card=…): read once, then taken out of the address. */
function readReturn() {
  const q = new URLSearchParams(location.search);
  const paid = q.get('paid');
  const card = q.get('card');
  if (!paid && !card) return null;
  try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* not important */ }
  return paid ? { kind: 'paid', session: paid } : { kind: 'card', session: card };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = () => (document.visibilityState === 'visible' ? Promise.resolve() : new Promise((resolve) => document.addEventListener('visibilitychange', function on() { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', on); resolve(); } })));

/**
 * How the payment or the card stands, said in the box it belongs to; while the processor has not confirmed it yet, asked
 * again every few seconds the page is open, until it has.
 */
async function settleReturn() {
  const b = state.back;
  state.back = null;
  if (!b || !state.account) return;
  const say = (key, text, bad = false) => { state[key] = { text, bad }; render(); };
  if (b.session === 'none') { say(b.kind === 'paid' ? 'payNote' : 'cardNote', () => t(b.kind === 'paid' ? 'account.pay.none' : 'account.pay.cardNone')); return; }
  for (;;) {
    let out;
    try { out = b.kind === 'paid' ? await api.checkoutReturn(b.session) : await api.cardReturn(b.session); }
    catch (err) { const message = words(err); say(b.kind === 'paid' ? 'payNote' : 'cardNote', () => message, true); return; }
    if (b.kind === 'paid') {
      const cents = out.amountCents;
      if (out.status === 'pending') { say('payNote', () => t('account.pay.waiting')); await pause(3000); await visible(); continue; }
      if (out.status === 'failed') { say('payNote', () => t('account.pay.failed'), true); return; }
      if (out.status === 'cancelled') { say('payNote', () => t('account.pay.none')); return; }
      state.payNote = { text: () => t('account.pay.received', { amount: money(cents) }) };
      await loadAccount();
      return;
    }
    if (out.state === 'pending') { say('cardNote', () => t('account.pay.cardWaiting')); await pause(3000); await visible(); continue; }
    if (out.payments) state.account.payments = out.payments;
    if (out.state === 'saved') { const card = out.payments?.card; say('cardNote', () => t('account.pay.cardSaved', { card: cardName(card) })); return; }
    say('cardNote', () => t('account.pay.cardFailed'), true);
    return;
  }
}

function renderClaimAgree() {
  const link = (href, key) => el('a', { href, target: '_blank', rel: 'noopener', text: t(key) });
  const parts = t('account.agree').split(/(\{terms\}|\{privacy\})/);
  $('#acct-claim-agree-text').replaceChildren(...parts.map((p) => (p === '{terms}' ? link('terms', 'account.terms') : p === '{privacy}' ? link('privacy', 'account.privacy') : document.createTextNode(p))));
}

// ---- loading -------------------------------------------------------------------------------------------------
async function loadAccount() {
  try {
    const out = await api.account();
    state.account = out.account;
  } catch (err) {
    state.account = null;
    if (err?.status !== 401) { $('#acct-who').textContent = words(err); }
  }
  // Filled first, then shown: the boxes never appear empty while the activity loads.
  if (state.account) await loadActivity(true);
  render();
  $('#acct-signed-in').hidden = !state.account;
  $('#acct-signed-out').hidden = Boolean(state.account) || Boolean(state.link);
}

async function loadActivity(fresh = false) {
  try {
    const out = await api.activity(fresh ? null : state.before);
    state.lines = fresh ? out.lines : [...state.lines, ...out.lines];
    state.before = out.before;
    state.more = Boolean(out.more);
  } catch { /* the list stays as it was */ }
  renderActivity();
}

// ---- the limit, the password, signing out, deleting ----------------------------------------------------------------
async function setLimit(cents) {
  try {
    await api.setLimit(cents);
    await loadAccount();
  } catch (err) { $('#acct-limit-now').textContent = words(err); }
}

function wire() {
  $('#acct-buy').addEventListener('submit', buy);
  $('#acct-topup-form').addEventListener('submit', topUpOn);
  $('#acct-topup-off').addEventListener('click', topUpOff);
  for (const sel of ['#acct-topup-level', '#acct-topup-amount', '#acct-topup-cap']) {
    $(sel).addEventListener('change', () => { $(sel).dataset.chosen = $(sel).value; syncTopUp(); });
  }
  // Back from the payment page with the browser's own Back: the page is shown as it was left, its button held.
  window.addEventListener('pageshow', (e) => { if (e.persisted) { $('#acct-buy-go').disabled = state.choice === null; } });
  $('#acct-limit-set').addEventListener('click', () => {
    const raw = $('#acct-limit-amount').value.trim().replace(',', '.');
    const v = Number(raw);
    if (!raw || !Number.isFinite(v) || v < 0) { $('#acct-limit-now').textContent = t('account.page.limitInvalid'); return; }
    setLimit(Math.round(v * 100));
  });
  $('#acct-limit-remove').addEventListener('click', () => { $('#acct-limit-amount').value = ''; setLimit(null); });
  $('#acct-more').addEventListener('click', () => loadActivity(false));
  $('#acct-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = $('#acct-pw-current').value;
    const next = $('#acct-pw-next').value;
    try {
      await api.changePassword({ current, next });
      $('#acct-pw-current').value = ''; $('#acct-pw-next').value = '';
      note($('#acct-pw-note'), t('account.page.changed'));
    } catch (err) { note($('#acct-pw-note'), words(err), true); }
  });
  $('#acct-signout-all').addEventListener('click', async () => {
    try { await api.signoutAll(); } catch { /* the cookie goes either way */ }
    state.account = null;
    await loadAccount();
  });
  $('#acct-delete-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.deleteAccount({ password: $('#acct-delete-password').value });
      state.account = null;
      $('#acct-signed-in').hidden = true;
      $('#acct-who').textContent = t('account.page.deleted');
      $('#acct-signed-out').hidden = false;
    } catch (err) { note($('#acct-delete-note'), words(err), true); }
  });
  $('#acct-reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#acct-reset-password').value;
    $('#acct-reset-submit').disabled = true;
    try {
      if (state.link.kind === 'claim') {
        await api.claimAccount({ token: state.link.token, email: $('#acct-claim-email').value.trim(), password, agree: $('#acct-claim-agree').checked });
      } else {
        await api.resetPassword({ token: state.link.token, password });
      }
      state.link = null;
      $('#acct-reset').hidden = true;
      await loadAccount();
      $('#acct-who').textContent = `${t('account.page.resetDone')} ${state.account ? t('account.page.signedInAs', { email: state.account.email }) : ''}`.trim();
    } catch (err) { note($('#acct-reset-note'), words(err), true); }
    finally { $('#acct-reset-submit').disabled = false; }
  });
}

// ---- a link: a new password, or the operator's account ------------------------------------------------------------
/** The token travels after `#`, which never reaches a server or another site; it is read once and taken out of the address. */
function readLink() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const reset = params.get('reset');
  const claim = params.get('claim');
  if (!reset && !claim) return null;
  try { history.replaceState(null, '', location.pathname); } catch { /* not important */ }
  return reset ? { kind: 'reset', token: reset } : { kind: 'claim', token: claim, email: params.get('email') || '' };
}

function showLink() {
  if (!state.link) return;
  const claim = state.link.kind === 'claim';
  $('#acct-reset').hidden = false;
  $('#acct-reset-title').dataset.i18n = claim ? 'account.page.claimTitle' : 'account.page.resetTitle';
  $('#acct-reset-submit').dataset.i18n = claim ? 'account.page.claimButton' : 'account.page.resetButton';
  $('#acct-reset-lede').hidden = !claim;
  if (claim) $('#acct-reset-lede').dataset.i18n = 'account.page.claimLede';
  $('#acct-claim-email-field').hidden = !claim;
  $('#acct-claim-agree-field').hidden = !claim;
  if (claim) $('#acct-claim-email').value = state.link.email;
}

async function boot() {
  for (const l of LOCALES) $('#lang-select').append(el('option', { value: l.code, text: l.name }));
  initLocale();
  $('#lang-select').value = currentLocale();
  $('#lang-select').addEventListener('change', () => setLocale($('#lang-select').value));
  document.addEventListener('civic:locale', render);
  try { const h = await api.health(); state.minChars = h?.access?.minChars; } catch { /* the defaults stand */ }
  state.link = readLink();
  state.back = readReturn();
  wire();
  showLink();
  await loadAccount();
  // Opened at a box (#add-credit, #auto-topup): it is shown once the account is, so the page goes to it then, at once, as
  // a link to a place on a page does (not with the page's smooth scrolling).
  const at = location.hash && /^#[a-z-]+$/.test(location.hash) ? document.querySelector(location.hash) : null;
  if (at && !at.hidden && state.account) {
    const html = document.documentElement;
    html.style.scrollBehavior = 'auto';
    at.scrollIntoView({ block: 'start' });
    html.style.scrollBehavior = '';
  }
  await settleReturn();
}

boot();
