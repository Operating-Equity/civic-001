// Minimal, dependency-free internationalisation. Every visible string lives in public/locales/*.js.
// Add a language: create locales/xx.js, import it here, add it to LOCALES. Right-to-left languages
// set dir: 'rtl' and the layout follows (the stylesheet uses logical properties).
import en from '../locales/en.js';
import es from '../locales/es.js';
import fr from '../locales/fr.js';
import de from '../locales/de.js';

export const LOCALES = [
  { code: 'en', name: 'English', dir: 'ltr', bundle: en },
  { code: 'es', name: 'Español', dir: 'ltr', bundle: es },
  { code: 'fr', name: 'Français', dir: 'ltr', bundle: fr },
  { code: 'de', name: 'Deutsch', dir: 'ltr', bundle: de },
];

const STORAGE_KEY = 'civic.locale';
let current = LOCALES[0];

function lookup(bundle, key) {
  return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), bundle);
}

function pluralForm(code, n) {
  try {
    return new Intl.PluralRules(code).select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

/** Translate a key with {param} interpolation and optional plural variants (key_one / key_other). */
export function t(key, params = {}) {
  let text;
  if (typeof params.n === 'number') {
    const form = pluralForm(current.code, params.n);
    text = lookup(current.bundle, `${key}_${form}`) ?? lookup(en, `${key}_${form}`) ?? lookup(current.bundle, `${key}_other`) ?? lookup(en, `${key}_other`);
  }
  if (text === undefined) text = lookup(current.bundle, key) ?? lookup(en, key);
  if (text === undefined) return key;
  return String(text).replace(/\{(\w+)\}/g, (m, name) => (params[name] !== undefined ? formatParam(params[name]) : m));
}

function formatParam(v) {
  if (typeof v === 'number') return fmtNumber(v);
  return String(v);
}

export function currentLocale() {
  return current.code;
}

export function fmtNumber(n) {
  try {
    return new Intl.NumberFormat(current.code).format(n);
  } catch {
    return String(n);
  }
}

export function fmtCompact(n) {
  try {
    return new Intl.NumberFormat(current.code, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

export function fmtUsd(usd) {
  const n = Number(usd) || 0;
  try {
    return new Intl.NumberFormat(current.code, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 1 ? 3 : 2 }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

export function fmtSeconds(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return t('time.seconds', { n: s });
  return t('time.minutes', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') });
}

/** Re-labels every element carrying a data-i18n attribute (and placeholder/title/alt/aria-label variants). */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    let params = {};
    if (el.dataset.i18nParams) {
      try { params = JSON.parse(el.dataset.i18nParams); } catch { params = {}; }
    }
    el.textContent = t(el.dataset.i18n, params);
  }
  for (const [attr, dataKey] of [['placeholder', 'i18nPlaceholder'], ['title', 'i18nTitle'], ['alt', 'i18nAlt'], ['aria-label', 'i18nAriaLabel']]) {
    for (const el of root.querySelectorAll(`[data-${attr === 'aria-label' ? 'i18n-aria-label' : 'i18n-' + attr}]`)) {
      el.setAttribute(attr, t(el.dataset[dataKey]));
    }
  }
}

export function setLocale(code, { persist = true } = {}) {
  const next = LOCALES.find((l) => l.code === code) || LOCALES[0];
  current = next;
  document.documentElement.lang = next.code;
  document.documentElement.dir = next.dir;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, next.code); } catch { /* private mode */ }
  }
  applyTranslations();
  document.dispatchEvent(new CustomEvent('civic:locale', { detail: { code: next.code } }));
}

export function initLocale() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  const wanted = saved || (navigator.language || 'en').slice(0, 2).toLowerCase();
  setLocale(LOCALES.some((l) => l.code === wanted) ? wanted : 'en', { persist: false });
}
