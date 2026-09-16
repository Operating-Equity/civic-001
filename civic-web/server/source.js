// What the source is, said plainly: for the prompt's attribution slot and for the page.
//
// The extraction prompt asks for the source together with its available attribution and date
// information. CIVIC knows some of that: for a link, the page's title, author, site, date and
// address, and the day it read them; for a file, its name and the day; for pasted text, only the
// day. Only what is known is said, and nothing is guessed.
const KINDS = new Set(['text', 'file', 'link']);

function clean(v, max = 300) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }

/** The reader-supplied description of the source, checked and trimmed. */
export function sourceMeta(raw = {}) {
  const kind = KINDS.has(raw?.kind) ? raw.kind : 'text';
  return {
    kind,
    title: clean(raw?.title), author: clean(raw?.author), site: clean(raw?.site),
    published: clean(raw?.published, 60), url: clean(raw?.url, 2000), name: clean(raw?.name),
  };
}

const day = (d) => d.toISOString().slice(0, 10);

/** The attribution lines the prompt is given ahead of the text. */
export function attributionLines(meta, now = new Date()) {
  const m = sourceMeta(meta);
  const lines = [];
  if (m.kind === 'link') {
    if (m.title) lines.push(`Source: ${m.title}`);
    if (m.author) lines.push(`By: ${m.author}`);
    if (m.site && m.site !== m.title) lines.push(`Site: ${m.site}`);
    if (m.published) lines.push(`Published: ${m.published}`);
    if (m.url) lines.push(`Address: ${m.url}`);
    lines.push(`Read by CIVIC from that address on ${day(now)}.`);
  } else if (m.kind === 'file') {
    lines.push(`Source: the file ${m.name || '(unnamed)'}, provided to CIVIC on ${day(now)}.`);
    if (m.title) lines.push(`Title: ${m.title}`);
    if (m.author) lines.push(`By: ${m.author}`);
    if (m.published) lines.push(`Dated: ${m.published}`);
  } else {
    lines.push(`Source: text pasted into CIVIC on ${day(now)}; no title, author or date was given with it.`);
  }
  return lines;
}

/** The source as it goes into the prompt's slot: its attribution lines, a blank line, the text. */
export function sourceBlock(text, meta, now = new Date()) {
  return `${attributionLines(meta, now).join('\n')}\n\n${text}`;
}
