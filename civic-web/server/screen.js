// What a conversation's reply must not carry (server/chat.js), looked for before the page sees a word of it.
//
// The inspector's name. In chat the model is told who it is and that it speaks of itself as Inspector A, never by
// name (the operator, 8 October: "I don't want the inspector's name to reach the user"). A reply that says the name
// anyway is counted: on the operator's trial it is delivered as written, so the trial measures how well the model
// keeps the secret; for a reader, the name is masked as the inspector's letter. The name is looked for whole (with and
// without a title, across Markdown's marks and line breaks, in any case) and by its surname alone, as written, in the
// reply's words and in its searches. A source's title and address are the web's own words: one that names the
// inspector is counted, never changed.
//
// The prompts. Any run of a prompt's words in a reply is held back, always (server/prompts.js).
import { holdBackPromptText } from './prompts.js';

const SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bounded = (body, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);

/** The patterns a reply could say the name in: the whole name, the name without its title, and the surname alone. */
export function nameMatchers(name, titles = []) {
  const words = String(name ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const skip = new Set(titles.map((x) => String(x).toLowerCase().replace(/\.$/, '')));
  let k = 0;
  while (k < words.length - 1 && skip.has(words[k].toLowerCase().replace(/\.$/, ''))) k++;
  const own = words.slice(k);
  const phrases = [...new Set([words, own].filter((ws) => ws.length > 1).map((ws) => ws.map(escape).join('[\\s*_~]+')))];
  const list = phrases.map((p) => bounded(p, 'giu'));
  const plain = own.filter((w) => !SUFFIX.test(w));
  const surname = (plain[plain.length - 1] || own[own.length - 1]).replace(/\.$/, '');
  if (surname && /\p{L}/u.test(surname)) list.push(bounded(escape(surname), surname === surname.toLowerCase() ? 'giu' : 'gu'));
  return list;
}

/** Where in `text` the name is said: each stretch once, however many patterns found it. */
function spans(text, matchers) {
  const found = [];
  for (const re of matchers) for (const m of String(text ?? '').matchAll(re)) found.push([m.index, m.index + m[0].length]);
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const s of found) {
    const last = merged[merged.length - 1];
    if (last && s[0] < last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged;
}

/** The text with the name counted, and replaced by `replacement` when one is given. */
export function screenName(text, matchers, replacement = null) {
  const raw = String(text ?? '');
  const at = spans(raw, matchers);
  if (!at.length || replacement === null) return { text: raw, count: at.length };
  let out = '';
  let last = 0;
  for (const [a, b] of at) { out += raw.slice(last, a) + replacement; last = b; }
  return { text: out + raw.slice(last), count: at.length };
}

/**
 * A reply, screened: its message items (each held to the prompts, then to the name), its searches (the name), and its
 * sources (counted only). `shown` is what the reader has already been shown (no secret). `mask`: the name becomes
 * "Inspector <letter>"; without it, the reply keeps the name and only the count says it was there.
 */
export function screenReply({ items = [], trail = [], sources = [], inspector, letter, titles = [], shown = [], mask = false }) {
  const matchers = nameMatchers(inspector, titles);
  const replacement = mask ? `Inspector ${letter}` : null;
  let name = 0;
  let prompt = 0;
  const outItems = items.map((it) => {
    const held = holdBackPromptText(it.text, { shown });
    prompt += held.held;
    const said = screenName(held.text, matchers, replacement);
    name += said.count;
    return { phase: it.phase ?? null, text: said.text };
  });
  const outTrail = trail.map((step) => {
    if (!step?.query) return step;
    const said = screenName(step.query, matchers, replacement);
    name += said.count;
    return { ...step, query: said.text };
  });
  const named = sources.filter((s) => spans(`${s?.title || ''} ${s?.url || ''}`, matchers).length > 0).length;
  return { items: outItems, trail: outTrail, sources, slips: { name, prompt, sources: named } };
}
