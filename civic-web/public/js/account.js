// The Account page (5 October): the reader's balance, the credit's history, a monthly limit, and the sign-in's own
// settings; and, from a link, a new password (#reset=…) or the operator's own account (#claim=…). Add credit waits for
// payments, the last step. Opened in a new tab from the main page, so a run there goes on.
import * as api from './api.js';
import { t, setLocale, initLocale, LOCALES, currentLocale } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); } for (const k of kids) n.append(k); return n; };

const state = { account: null, lines: [], before: null, more: false, link: null };

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
    else if (l.kind === 'purchase') { what = t('account.page.addCredit'); amount = `+${money(l.amountCents)}`; plus = true; }
    else if (l.kind === 'test') {
      const n = l.n ?? '·';
      if (l.state === 'free') { what = t('account.page.free', { n, verdict: verdictWord(l.verdict) }); amount = t('price.free'); }
      else if (l.state === 'charged') { what = t('account.page.charged', { n, verdict: verdictWord(l.verdict) }); amount = `−${money(l.amountCents)}`; }
      else if (l.state === 'released') { what = t('account.page.released', { n }); amount = money(0); }
      else { what = t('account.page.held', { n }); amount = `−${money(l.amountCents)}`; }
    }
    return el('li', {}, [el('span', {}, [el('time', { datetime: l.at, text: when(l.at) }), document.createTextNode(what)]), el('span', { class: `acct-amount${plus ? ' is-plus' : ''}`, text: amount })]);
  }));
  $('#acct-more').hidden = !state.more;
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
        await api.claimOperator({ token: state.link.token, email: $('#acct-claim-email').value.trim(), password, agree: $('#acct-claim-agree').checked });
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
  wire();
  showLink();
  await loadAccount();
}

boot();
