// Reading the verdict out of an entry, without changing the entry.
//
// The operator's output format ends "6. Conclusion: True / False / Uncertain" and "7. Confidence:
// N%". The model writes that in more than one form: the heading with a colon, a dash of any
// kind, a bracket, or nothing with the verdict on the next line; the verdict first, or after a
// sentence or two of reasoning; plain, bold, or in capitals. An earlier reader took only a colon
// or a dash on the heading's line and the first verdict word within 400 characters, and when the
// model wrote otherwise it showed a label of its own instead of the model's answer. This reader
// finds the model's own word wherever its Conclusion states it. The page shows Uncertain as
// Unverified, as the operator specified. Nothing else is mapped, and nothing is guessed: an
// entry that states no verdict at all is Unverified by the operator's ruling of 17 September,
// with its source marked 'unread' so the ledger and /check can tell it apart.

export const VERDICTS = ['true', 'false', 'unverified'];

const VERDICT_WORDS = {
  true: 'true',
  false: 'false',
  uncertain: 'unverified',
  unverified: 'unverified',
  unverifiable: 'unverified',
  indeterminate: 'unverified',
  inconclusive: 'unverified',
};
const ANY_VERDICT = /\b(true|false|uncertain|unverified|unverifiable|indeterminate|inconclusive)\b/gi;

/**
 * Every "Conclusion" heading, in any decoration, with the section that follows it, from the last
 * to the first. The last is usually the one (section 6 of the format), but the Logic Audit that
 * follows it often names the conclusion at the start of a line ("3. **Conclusion–evidence
 * match:** ..."), and an entry read from that line alone showed no verdict where the section
 * above it stated one plainly. So each is tried in turn, and the first that states a verdict wins.
 */
function conclusionSections(text) {
  const headings = [...text.matchAll(/(?:^|\n)[^\n]{0,12}\**\s*Conclusion\b\**\s*[:\-–—(\[]?\s*/gi)];
  return headings.reverse().map((h) => {
    const rest = text.slice(h.index + h[0].length);
    // The section ends at the next heading: a numbered item, a Markdown heading, a bold label
    // line, or the Confidence line.
    const stop = rest.search(/\n\s*(?:#{1,6}\s|\d+[.)]\s*\*{0,2}[A-Z]|\*{2}[A-Z][^*\n]{1,40}\*{2}\s*[:\-–—]|\**\s*Confidence\b)/);
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
 * changing it. `verdictSource` says where the verdict came from: 'conclusion' (the Conclusion
 * section), 'tag' (a closing verdict line), 'closing' (an emphasised verdict in the entry's last
 * lines), or 'unread' (none stated: Unverified by the operator's ruling).
 */
export function parseEntry(raw) {
  const text = String(raw || '');
  let verdict = null;
  let source = 'none';

  // 1. The Conclusion section, in whatever form the model wrote its heading: the last heading
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
    const tag = text.match(/\b(?:final\s+)?(?:verdict|determination)\s*[:\-–—]\s*[*_]*\s*(true|false|uncertain|unverified|unverifiable|indeterminate|inconclusive)\b/i);
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

  const conf = text.match(/Confidence\**\s*[:\-–—]?\s*\**\s*(\d{1,3})\s*%/i);
  const confidence = conf ? Math.min(100, Number(conf[1])) : null;

  const name = text.match(/\*\*Name\*\*\s*[:\-–—]?\s*\**\s*([^\n*]+)/i) || text.match(/^\s*0\.\s*\**Name\**\s*[:\-–—]?\s*([^\n]+)/im);
  const inspector = name ? name[1].replace(/[\[\]]/g, '').trim().slice(0, 160) : null;

  // text is returned untouched.
  return { verdict, verdictSource: source, confidence, inspector, conclusion, text };
}

/** The entry around its last "Conclusion", for the record of a verdict that could not be read. */
export function conclusionExcerpt(text) {
  const s = String(text || '');
  const at = s.toLowerCase().lastIndexOf('conclusion');
  const piece = at >= 0 ? s.slice(Math.max(0, at - 40), at + 240) : s.slice(-240);
  return (at >= 0 ? 'At the entry\'s last "Conclusion": ' : 'No "Conclusion" in the entry; its end: ') + piece.replace(/\s+/g, ' ').trim();
}
