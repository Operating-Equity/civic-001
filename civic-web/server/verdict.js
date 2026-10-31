// Reading the verdict out of an entry, without changing the entry.
//
// The entry states its verdict under a heading, and its confidence and its inspector on lines of their own. The
// headings are the operator's words (server/names.js, kept with the prompts; unset, the words FactEngine has always
// read). The model writes them in more than one form: the heading with a colon, a dash of any kind, a bracket, or
// nothing with the verdict on the next line; the verdict first, or after a sentence or two of reasoning; plain, bold, or
// in capitals. This reader finds the model's own word wherever its verdict section states it. The page shows the
// undecided words as Unverified, as the operator specified. Nothing else is mapped, and nothing is guessed: an entry
// that states no verdict at all is Unverified by the operator's ruling of 17 September, with its source marked 'unread'
// so the ledger and /check can tell it apart.
//
// A reader sees the inspector by its mark alone ("Inspector A": the first letter of the name the entry gives, the
// operator's rule of 19 October), on the card and on the entry's own line (maskEntry, NameMasker); the operator sees the
// entry as written.
import { names, anyOf as any } from './names.js';

export const VERDICTS = ['true', 'false', 'unverified'];

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word edges that hold for every alphabet, and for a heading that ends in a question mark.
const EDGE0 = '(?<![\\p{L}\\p{N}])';
const EDGE1 = '(?![\\p{L}\\p{N}])';

const VERDICT_WORDS = {};
for (const [verdict, list] of Object.entries(names.verdicts)) for (const w of list) VERDICT_WORDS[w.toLowerCase()] = verdict;
const ALL_VERDICTS = any(Object.keys(VERDICT_WORDS));
const ANY_VERDICT = new RegExp(`${EDGE0}(${ALL_VERDICTS})${EDGE1}`, 'giu');
const HEADING = new RegExp(`(?:^|\\n)[^\\n]{0,12}\\**\\s*(?:${any(names.conclusion)})${EDGE1}\\**\\s*[:\\-–—(\\[]?\\s*`, 'giu');
// A section ends at the next heading: a numbered item, a Markdown heading, a bold label line, or the confidence line.
const SECTION_END = new RegExp(`\\n\\s*(?:#{1,6}\\s|\\d+[.)]\\s*\\*{0,2}[A-Z]|\\*{2}[A-Z][^*\\n]{1,40}\\*{2}\\s*[:\\-–—]|\\**\\s*(?:${any(names.confidence)})${EDGE1})`, 'u');
const TAG = new RegExp(`${EDGE0}(?:final\\s+)?(?:${any(names.verdictTags)})\\s*[:\\-–—]\\s*[*_]*\\s*(${ALL_VERDICTS})${EDGE1}`, 'iu');
const CONFIDENCE = new RegExp(`(?:${any(names.confidence)})\\**\\s*[:\\-–—]?\\s*\\**\\s*(\\d{1,3})\\s*%`, 'iu');

/**
 * Every verdict heading, in any decoration, with the section that follows it, from the last to the first. The last is
 * usually the one, but a later line can name the heading's word at its start without stating a verdict, and an entry
 * read from that line alone showed no verdict where the section above it stated one plainly. So each is tried in turn,
 * and the first that states a verdict wins.
 */
function conclusionSections(text) {
  const headings = [...text.matchAll(HEADING)];
  return headings.reverse().map((h) => {
    const rest = text.slice(h.index + h[0].length);
    const stop = rest.search(SECTION_END);
    return rest.slice(0, stop >= 0 ? stop : undefined);
  });
}

/**
 * The verdict a passage states. Every verdict word in it is a candidate; the one read is the
 * first that is stated rather than mentioned: at the head of the passage, at the start of a
 * sentence or a line, set off by a colon, a dash or a bracket, in bold, or in capitals. So
 * "It is not true that the figure was 19; the record shows 17. **False**." reads False. Failing
 * a stated one, the first candidate, so "the statement is true as worded" reads True.
 * With `statedOnly`, only a stated one counts.
 */
function statedVerdict(passage, { statedOnly = false } = {}) {
  const s = String(passage || '');
  const candidates = [];
  for (const m of s.matchAll(ANY_VERDICT)) {
    const word = m[1];
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + word.length);
    const opening = /(?:^|[.!?:;\-–—(\[]\s*|\n\s*)[*_"“'\s]*$/.test(before);
    const bold = /\*\*\s*$/.test(before) && /^[.!,;:]?\s*\*\*/.test(after);
    const caps = word.length > 1 && word === word.toUpperCase();
    candidates.push({ word, stated: opening || bold || caps });
  }
  const pick = candidates.find((c) => c.stated) || (statedOnly ? null : candidates[0]);
  return pick ? VERDICT_WORDS[pick.word.toLowerCase()] : null;
}

/**
 * Reads the verdict, the confidence and the inspector out of the finished entry without
 * changing it. `verdictSource` says where the verdict came from: 'conclusion' (the verdict
 * section), 'tag' (a closing verdict line), 'closing' (an emphasised verdict in the entry's last
 * lines), or 'unread' (none stated: Unverified by the operator's ruling).
 */
export function parseEntry(raw) {
  const text = String(raw || '');
  let verdict = null;
  let source = 'none';

  // 1. The verdict section, in whatever form the model wrote its heading: the last heading
  //    whose section states a verdict, and the row's closing text comes from that section.
  const sections = conclusionSections(text);
  let conclusion = null;
  const asText = (s) => s.replace(/^\s*\*+\s*/, '').replace(/\*\*/g, '').trim().slice(0, 1500) || null;
  for (const section of sections) {
    const stated = statedVerdict(section);
    if (stated) { verdict = stated; source = 'conclusion'; conclusion = asText(section); break; }
  }
  if (!conclusion && sections.length) conclusion = asText(sections[0]);

  // 2. A closing verdict line, wherever it is: "Verdict: False", "Final verdict — True".
  if (!verdict) {
    const tag = text.match(TAG);
    if (tag) { verdict = VERDICT_WORDS[tag[1].toLowerCase()]; source = 'tag'; }
  }

  // 3. An emphasised verdict in the entry's closing lines: the model's own closing statement.
  if (!verdict) {
    const closing = statedVerdict(text.slice(-600), { statedOnly: true });
    if (closing) { verdict = closing; source = 'closing'; }
  }

  // An entry that states no verdict at all is Unverified, by the operator's ruling; the source
  // stays 'unread', and the caller records the entry's closing words for /check.
  if (!verdict) { verdict = 'unverified'; source = 'unread'; }

  const conf = text.match(CONFIDENCE);
  const confidence = conf ? Math.min(100, Number(conf[1])) : null;

  const inspector = inspectorOf(text);

  // text is returned untouched.
  return { verdict, verdictSource: source, confidence, inspector, conclusion, text };
}

// The entry's inspector line, in whatever form the model wrote its label: "Label: X", "**Label:** X", "**Label**: X",
// "0. **Label:** X", "- Label — X", "### Label: X". The label opens its line, so a sentence of the body that happens to
// use the word is never read as one.
const DECOR = '[ \\t]*(?:[-*+][ \\t]+|\\d+[.)][ \\t]*|#{1,6}[ \\t]*)?(?:\\*\\*|__|\\*|_)?[ \\t]*';
const LABEL = `(?:${any(names.name)})[ \\t]*(?:\\*\\*|__|\\*|_)?[ \\t]*[:\\-–—][ \\t]*`;
const NAME_LINE = new RegExp(`^${DECOR}${LABEL}(.*)$`, 'imu');
const LABEL_LINE = new RegExp(`^(${DECOR}${LABEL})(.*)$`, 'iu');
const DECOR_START = new RegExp(`^${DECOR}`, 'u');
const SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i;
const LOOKS_LIKE_A_NAME = /^[\p{L}][\p{L} .'’-]*$/u;

/** A name as a name: without Markdown's marks or brackets, up to the first mark that ends one ("Orin Vale (geologist)" is Orin Vale). */
export function cleanName(raw) {
  let s = String(raw ?? '').replace(/[*_`~]/g, '').replace(/[[\]]/g, '').trim();
  s = s.split(/\s[-–—]\s|[,;:(|/]|[–—]/)[0];
  s = s.replace(/\s+/g, ' ').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  const words = s.split(' ');
  const last = words[words.length - 1] || '';
  if (words.length > 1 && /\.$/.test(last) && last.length > 3 && !SUFFIX.test(last)) s = s.replace(/\.$/, '');
  return /\p{L}/u.test(s) ? s.slice(0, 160) : null;
}

/** The inspector the entry names on its label's line (the label's own line, or the line after a label left bare), or null. */
export function inspectorOf(text) {
  const m = String(text ?? '').match(NAME_LINE);
  if (!m) return null;
  const same = cleanName(m[1]);
  if (same) return same;
  const after = String(text).slice(m.index + m[0].length).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return LOOKS_LIKE_A_NAME.test(after.replace(/[*_]/g, '').trim()) ? cleanName(after) : null;
}

// Words that come before a name and are not it, so "Sir Isaac Newton" is Inspector J and "Dr. Ada Lovelace" Inspector B.
const TITLES = new Set(['dr', 'doctor', 'prof', 'professor', 'sir', 'dame', 'lord', 'lady', 'mr', 'mrs', 'ms', 'mx', 'miss',
  'rev', 'reverend', 'fr', 'father', 'st', 'saint', 'hon', 'judge', 'justice', 'capt', 'captain', 'gen', 'general', 'col',
  'colonel', 'president', 'king', 'queen', 'prince', 'princess', 'inspector', ...names.titles.map((w) => w.toLowerCase())]);
const MARK = new RegExp(`^${esc(names.inspector).replace('\\{initial\\}', '\\p{L}')}$`, 'u');

/**
 * The letter a reader sees for an inspector (31 October: "the 1st letter of their 1st name plus one letter and if the
 * letter is Z, it goes to a"), so the letter never matches the name it stands for: Albert Einstein is Inspector B. An
 * accented letter counts as its plain letter (É is E, so F); a name with no Latin letter has none.
 */
export function markLetter(initial) {
  const plain = String(initial || '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
  if (!/^[A-Z]$/.test(plain)) return '';
  return plain === 'Z' ? 'A' : String.fromCharCode(plain.charCodeAt(0) + 1);
}

/**
 * The inspector as a reader sees it, in the operator's form: the letter after the first letter of the name's first word
 * that is not a title (markLetter); the form's word alone when that letter is not a Latin one.
 */
export function inspectorMark(raw) {
  const name = cleanName(raw);
  if (!name) return null;
  if (MARK.test(name)) return name;   // the entry already gives the mark
  const words = name.split(' ').map((w) => w.replace(/[.,]+$/, '')).filter(Boolean);
  const first = words.find((w) => !TITLES.has(w.toLowerCase())) || words[0] || '';
  const initial = (first.match(/\p{L}/u) || [''])[0];
  if (!initial) return null;
  const letter = markLetter(initial);
  return letter ? names.inspector.replace('{initial}', letter) : names.inspector.replace('{initial}', '').replace(/\s+/g, ' ').trim();
}

// A surname written alone: the same word often names a law, a unit or a theory ("Newton's second law", "the Curie
// point"), where it is not the inspector, and a mark there would read as broken and say who the inspector is. The
// operator's answer (31 October): left as written. The full name, the first name and a title with either are not.
const MASK_SURNAME_ALONE = false;

/**
 * The words of a text a reader already has (the claim, the document), read once: a name's word or phrase there stays as
 * written. A view passes the result to each maskName of its run, so a long document is read once and not for every text.
 */
export function keptWords(keep) {
  if (keep && typeof keep === 'object' && keep.words instanceof Set) return keep;
  const text = String(keep ?? '').toLowerCase();
  const words = new Set(text.match(/[\p{L}\p{N}'’-]+/gu) || []);
  const phrases = new Map();
  const hasPhrase = (p) => { const q = p.toLowerCase(); if (!phrases.has(q)) phrases.set(q, text.includes(q)); return phrases.get(q); };
  return { words, hasPhrase };
}

/**
 * Text a reader receives (the entry, the thinking's summary, a search's question, the conclusion), with the inspector's
 * name made the mark wherever it stands for the inspector (31 October: "eliminating the name everywhere the reviewer or
 * inspector appears"): in full as the entry gives it, without its titles ("Sir Edwin Cardale", "Edwin Cardale"), with a
 * title before the first name or the surname ("Sir Edwin", "Dr. Cardale"), and the first name alone; a surname alone as
 * MASK_SURNAME_ALONE says. A form that is in the claim or the document itself (`keep`) stays as written, so a claim about
 * a person reads with that person's name. A word alone is matched in its own capitals, so a name that is also a common
 * word ("Grace", "Hope") is not made the mark where it is a word.
 */
export function maskName(text, name, keep = '') {
  let s = String(text ?? '');
  const full = cleanName(name);
  const mark = inspectorMark(name);
  if (!s || !full || !mark || MARK.test(full)) return s;
  const bare = (w) => w.replace(/[.,]+$/, '');
  const words = full.split(' ');
  let k = 0;
  while (k < words.length - 1 && TITLES.has(bare(words[k]).toLowerCase())) k++;
  const own = words.slice(k).map(bare).filter((w) => w && !SUFFIX.test(w));
  const kept = keptWords(keep);
  const keptWord = (w) => kept.words.has(w.toLowerCase());
  const longest = (a, b) => b.length - a.length;
  const swap = (pattern, flags) => { s = s.replace(new RegExp(`${EDGE0}(?:${pattern})${EDGE1}`, flags), mark); };
  // The name in full, and without its titles: in any capitals.
  const many = [...new Set([full, words.slice(k).join(' ')])].filter((f) => f.includes(' ') && !kept.hasPhrase(f)).sort(longest);
  if (many.length) swap(any(many), 'giu');
  if (own.length === 1) {   // a one-word name is its full form
    if (own[0].length > 1 && !keptWord(own[0])) swap(esc(own[0]), 'giu');
    return s;
  }
  // A title before the first name or the surname ("Sir Edwin", "Dr. Cardale", "Professor Cardale").
  const titles = [...TITLES].sort(longest).map(esc).join('|');
  for (const w of [own[0], own[own.length - 1]]) {
    if (w.length > 1 && !keptWord(w)) swap(`(?:${titles})\\.?[ \\t]+${esc(w)}`, 'giu');
  }
  // The first name alone, and the surname alone as MASK_SURNAME_ALONE says: in the name's own capitals.
  const alone = [own[0], ...(MASK_SURNAME_ALONE ? [own[own.length - 1]] : [])].filter((w) => w.length > 1 && !keptWord(w));
  if (alone.length) swap([...new Set(alone)].sort(longest).map(esc).join('|'), 'gu');
  return s;
}

/** The value of an inspector line with its name made the mark; its Markdown around the name is kept. */
function maskValue(value) {
  const lead = value.match(/^[*_`\s]*/)[0];
  const rest = value.slice(lead.length);
  const trail = rest.match(/[*_`\s]*$/)[0];
  const mark = inspectorMark(value);
  return mark ? `${lead}${mark}${trail}` : value;
}

/**
 * An entry for a reader, as it streams: every inspector line's name made the mark, nothing else changed. A line is held
 * only while it could still be an inspector line (its first few characters, or a whole inspector line until it ends);
 * every other line passes as it comes. The text out, put together, is the same however the entry was cut into pieces.
 */
export class NameMasker {
  constructor() {
    this.held = '';         // the current line, not yet sent
    this.passing = false;   // the current line was let through: the rest of it goes as it comes
    this.bare = false;      // the line before was a label with no name: the name is the next line with words
  }

  /** The text to send now, for the next piece of the entry. */
  push(piece) {
    let out = '';
    let rest = String(piece ?? '');
    while (rest) {
      const nl = rest.indexOf('\n');
      const part = nl < 0 ? rest : rest.slice(0, nl);
      rest = nl < 0 ? '' : rest.slice(nl + 1);
      if (this.passing) {
        out += part;
        if (nl >= 0) { out += '\n'; this.passing = false; }
        continue;
      }
      this.held += part;
      if (nl >= 0) { out += `${this.line(this.held)}\n`; this.held = ''; continue; }
      if (!this.couldBeName(this.held)) { out += this.held; this.held = ''; this.passing = true; }
    }
    return out;
  }

  /** What is still held, at the entry's end. */
  flush() {
    const out = this.held ? this.line(this.held) : '';
    this.held = '';
    this.passing = false;
    return out;
  }

  line(text) {
    const cr = text.endsWith('\r') ? '\r' : '';
    const body = cr ? text.slice(0, -1) : text;
    if (this.bare) {
      if (!body.trim()) return text;
      this.bare = false;
      return LOOKS_LIKE_A_NAME.test(body.replace(/[*_]/g, '').trim()) ? `${body.match(/^\s*/)[0]}${maskValue(body.trim())}${cr}` : text;
    }
    const m = body.match(LABEL_LINE);
    if (!m) return text;
    if (!cleanName(m[2])) { this.bare = true; return text; }
    return `${m[1]}${maskValue(m[2])}${cr}`;
  }

  couldBeName(partial) {
    if (this.bare) return true;
    if (/^[ \t#*_+\-\d.)]*$/.test(partial)) return true;
    const head = partial.replace(DECOR_START, '').replace(/\s+/g, ' ').toLowerCase();
    return names.name.some((w) => {
      const label = w.toLowerCase().replace(/\s+/g, ' ');
      if (head.length <= label.length) return label.startsWith(head);
      return head.startsWith(label) && /^[ \t]*(?:\*\*|__|\*|_)?[ \t]*(?:[:\-–—]|$)/u.test(head.slice(label.length));
    });
  }
}

/**
 * A whole entry for a reader: every inspector line's name made the mark (as its pieces through a NameMasker), then the
 * name made the mark wherever else the entry writes it (maskName), but in the words of the claim or the document
 * (`keep`). The name is the one given (`name`), or the one the entry's own inspector line names.
 */
export function maskEntry(text, { name = null, keep = '' } = {}) {
  const m = new NameMasker();
  const lines = m.push(text) + m.flush();
  const who = name || inspectorOf(text);
  return who ? maskName(lines, who, keep) : lines;
}

/** The entry around its last verdict heading, for the record of a verdict that could not be read. */
export function conclusionExcerpt(text) {
  const s = String(text || '');
  const low = s.toLowerCase();
  let at = -1;
  let word = names.conclusion[0];
  for (const w of names.conclusion) { const k = low.lastIndexOf(w.toLowerCase()); if (k > at) { at = k; word = w; } }
  const piece = at >= 0 ? s.slice(Math.max(0, at - 40), at + 240) : s.slice(-240);
  return (at >= 0 ? `At the entry's last "${word}": ` : `No "${word}" in the entry; its end: `) + piece.replace(/\s+/g, ' ').trim();
}
