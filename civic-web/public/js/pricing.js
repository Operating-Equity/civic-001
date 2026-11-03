// The Pricing page (3 November): what FactEngine costs, in the reader's language, from the server's own settings (GET
// /api/prices): the price of a fact-check, the free ones a document can have, a new account's credit, the amounts credit
// is bought in and the automatic top-up's choices. Nothing here is a figure of its own.
import * as api from './api.js';
import { t, setLocale, initLocale, LOCALES, currentLocale, numberWord } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); } for (const k of kids) n.append(k); return n; };

const state = { prices: null, failed: false };

function money(cents) {
  const currency = state.prices?.currency || 'USD';
  try { return new Intl.NumberFormat(currentLocale(), { style: 'currency', currency }).format((Number(cents) || 0) / 100); } catch { return `${((Number(cents) || 0) / 100).toFixed(2)} ${currency}`; }
}
/** "$5.00 or $10.00": a list of amounts as the reader's language joins choices. */
function either(list) {
  const items = list.map(money);
  try { return new Intl.ListFormat(currentLocale(), { type: 'disjunction' }).format(items); } catch { return items.join(', '); }
}
/** The currency's name as an amount of it is said ("US dollars"), in the reader's language. */
function currencyName(code) {
  try {
    const part = new Intl.NumberFormat(currentLocale(), { style: 'currency', currency: code, currencyDisplay: 'name' }).formatToParts(2).find((x) => x.type === 'currency');
    return part?.value || code;
  } catch { return code; }
}
/** A sentence with a {name} in it made a link. */
function withLink(text, name, href, label) {
  const parts = text.split(`{${name}}`);
  const out = [document.createTextNode(parts[0])];
  for (const rest of parts.slice(1)) out.push(el('a', { href, text: label }), document.createTextNode(rest));
  return out;
}

function render() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  document.title = `FactEngine · ${t('pricing.title')}`;
  $('#price-refunds').replaceChildren(...withLink(t('pricing.refunds'), 'refunds', 'refunds', t('account.refundsLink')));
  const p = state.prices;
  $('#price-unavailable').textContent = state.failed ? t('pricing.unavailable') : '';
  $('#price-unavailable').hidden = !state.failed;
  $('#price-cards').hidden = !p;
  if (!p) return;
  const priced = Number.isInteger(p.priceCents) && p.priceCents > 0;
  $('#price-each').hidden = !priced;
  $('#price-each-figure').textContent = priced ? money(p.priceCents) : '';
  const free = Number(p.freeUpTo) || 0;
  $('#price-each-free').hidden = !(priced && free > 0);
  $('#price-each-free').textContent = free > 0 ? t('pricing.freeUpTo', { n: free, w: numberWord(free) }) : '';
  const grant = Number(p.grantCents) || 0;
  $('#price-grant').hidden = grant <= 0;
  $('#price-grant-figure').textContent = grant > 0 ? money(grant) : '';
  const b = p.buying;
  $('#price-credit').hidden = !b;
  if (b) {
    $('#price-credit-soon').hidden = Boolean(b.open);
    $('#price-credit-soon').textContent = b.open ? '' : t('pricing.soon');
    const about = (cents) => (priced ? ` · ${t('account.pay.about', { n: Math.floor(cents / p.priceCents) })}` : '');
    $('#price-amounts').replaceChildren(...(b.amountsCents || []).map((c) => el('li', {}, [el('strong', { text: money(c) }), document.createTextNode(about(c))])));
    const other = Number.isInteger(b.minCents) && Number.isInteger(b.maxCents);
    $('#price-other').hidden = !other;
    $('#price-other').textContent = other ? t('pricing.other', { min: money(b.minCents), max: money(b.maxCents) }) : '';
  }
  const tu = b?.topup;
  $('#price-topup').hidden = !tu;
  $('#price-topup-text').textContent = tu ? t('pricing.topupText', { levels: either(tu.levelsCents), amounts: either(tu.amountsCents), caps: either(tu.capsCents) }) : '';
  $('#price-currency').hidden = !p.currency;
  $('#price-currency').textContent = p.currency ? t('pricing.currency', { name: currencyName(p.currency), code: p.currency }) : '';
}

async function boot() {
  for (const l of LOCALES) $('#lang-select').append(el('option', { value: l.code, text: l.name }));
  initLocale();
  $('#lang-select').value = currentLocale();
  $('#lang-select').addEventListener('change', () => setLocale($('#lang-select').value));
  document.addEventListener('civic:locale', render);
  render();
  try { state.prices = await api.prices(); } catch { state.failed = true; }
  render();
}

boot();
