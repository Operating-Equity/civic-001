// What the source is, said plainly: for the prompt's attribution slot and for the page.
//
// The extraction prompt's slot asks for the source together with what is known of who produced
// it and when. FactEngine knows some of that: for a link, the page's title, author, site, date and
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
    // 'search' when a link's text came from the search service's copy of that address, because the
    // site turned FactEngine's own reader away (server/copies.js); the attribution then says so.
    via: raw?.via === 'search' ? 'search' : '',
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
    lines.push(m.via === 'search'
      ? `Read by FactEngine on ${day(now)} through a search service's copy of that address.`
      : `Read by FactEngine from that address on ${day(now)}.`);
  } else if (m.kind === 'file') {
    lines.push(`Source: the file ${m.name || '(unnamed)'}, provided to FactEngine on ${day(now)}.`);
    if (m.title) lines.push(`Title: ${m.title}`);
    if (m.author) lines.push(`By: ${m.author}`);
    if (m.published) lines.push(`Dated: ${m.published}`);
  } else {
    lines.push(`Source: text pasted into FactEngine on ${day(now)}; no title, author or date was given with it.`);
  }
  return lines;
}

/** The source as it goes into the prompt's slot: its attribution lines, a blank line, the text. */
export function sourceBlock(text, meta, now = new Date()) {
  return `${attributionLines(meta, now).join('\n')}\n\n${text}`;
}

/** What fills {{TITLE}} when FactEngine was given no headline. */
export const NO_TITLE = '(none given)';

/**
 * The headline as published, when FactEngine was given one: a link's page title, a video's title, a file's own title.
 * Not a link's host or the last part of its address, which is what the reader shows for a page without a title.
 */
export function titleOf(meta) {
  const m = meta || {};
  const title = String(m.title || '').trim();
  if (!title) return '';
  if (m.kind === 'link' && m.url) {
    try {
      const u = new URL(m.url);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      if (title === u.hostname || (last && title === last)) return '';
    } catch { /* not an address: the title stands */ }
  }
  return title;
}

/**
 * The document as a prompt without a slot is given it (24 October, the operator's answer): the headline FactEngine was
 * given, or "(none given)", a blank line, then the text. The text read from a link holds no headline of its own (the
 * page's title is kept apart from it), so without this line the model would not know it. A prompt with a slot gets its
 * attribution lines instead (sourceBlock).
 */
export function headlineBlock(text, meta) {
  return `Headline: ${titleOf(meta) || NO_TITLE}\n\n${text}`;
}
