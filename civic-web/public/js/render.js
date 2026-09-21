// Small DOM and formatting helpers shared by the page.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** The name a formula is parked under while Markdown runs. Letters and digits only, so no part of
 *  Markdown can act on it. */
const mathToken = (i) => `civicformula${i}xq`;

/** Pulls the model's mathematics out of the text before Markdown sees it.
 *
 *  Markdown reads a line holding only `=` or only `-` as an underline for the line above, which turns
 *  the terms of a formula into headings and deletes the operators between them: words the model wrote
 *  would never reach the reader. So each formula is parked under a name Markdown cannot touch and put
 *  back afterwards, whole. Only `\[…\]`, `$$…$$` and `\(…\)` count as mathematics; a lone dollar
 *  sign never does, because the model writes sums of money. Fenced code is left exactly as written.
 *  Pure: it touches nothing in the browser, so the guard can drive it directly. */
export function splitMath(text) {
  const spans = [];
  const codes = [];
  let out = String(text || '')
    .replace(/(^|\n)(```|~~~)[\s\S]*?(?:\n\2[^\n]*|$)/g, (m) => `\u0000c${codes.push(m) - 1}\u0000`);
  const take = (re, display) => {
    out = out.replace(re, (_m, body) => {
      const tex = String(body).trim();
      if (!tex) return _m;
      spans.push({ tex, display });
      return mathToken(spans.length - 1);
    });
  };
  take(/\\\[([\s\S]*?)\\\]/g, true);
  take(/\$\$([\s\S]*?)\$\$/g, true);
  take(/\\\(([\s\S]*?)\\\)/g, false);
  out = out.replace(/\u0000c(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
  return { text: out, spans };
}

/** Markdown → sanitised HTML. The entry the model writes is rendered as encyclopedia prose. */
export function renderMarkdown(text) {
  const marked = window.marked;
  const purify = window.DOMPurify;
  const { text: raw, spans } = splitMath(text);
  let html;
  try {
    html = marked ? marked.parse(raw, { gfm: true, breaks: true }) : escapeHtml(raw).replace(/\n/g, '<br>');
  } catch {
    html = escapeHtml(raw).replace(/\n/g, '<br>');
  }
  if (purify) {
    html = purify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] });
  }
  html = html.replace(/<a /g, '<a target="_blank" rel="noopener" ');
  // The formulas go back after the sanitiser, so none of them ever passes through it.
  for (let i = 0; i < spans.length; i++) {
    const { tex, display } = spans[i];
    html = html.replace(mathToken(i), () => `<span class="math" data-display="${display ? '1' : '0'}">${escapeHtml(tex)}</span>`);
  }
  return html;
}

/** Typesets the formulas inside a rendered entry. A formula the typesetter cannot read is left exactly
 *  as the model wrote it: nothing is dropped and nothing is marked as an error. */
export function renderMath(root) {
  const katex = window.katex;
  if (!katex || !root) return;
  for (const node of $$('.math', root)) {
    const tex = node.textContent;
    try {
      const html = katex.renderToString(tex, { displayMode: node.dataset.display === '1', throwOnError: true, strict: false, trust: false });
      node.innerHTML = html;
    } catch { /* the formula stays as it was written */ }
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Sets a progress bar's fill (0..1). */
export function setBar(bar, fraction, { done = false } = {}) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  bar.querySelector('i').style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(pct));
  bar.classList.toggle('is-done', done);
  bar.classList.toggle('is-idle', pct === 0 && !done);
}

let toastTimer = null;
export function toast(message, { error = false, ms = 4200 } = {}) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('is-error', error);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

/** Eases a stream of characters into a fraction that approaches, but never reaches, `cap`. */
export function easeChars(chars, scale, cap = 0.95) {
  return cap * (1 - Math.exp(-chars / scale));
}

export function easeTime(elapsedMs, scaleMs, cap) {
  return cap * (1 - Math.exp(-elapsedMs / scaleMs));
}

/** Hands the reader a file. Served from your own origin, so a normal download link works. */
export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    try {
      const ta = el('textarea', { class: 'visually-hidden' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function bump(node) {
  node.classList.remove('is-bump');
  void node.offsetWidth;
  node.classList.add('is-bump');
}
