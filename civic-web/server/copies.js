// A refused link, found elsewhere. When a site turns CIVIC's server away, the same article is often
// published at another address: papers that republish it with permission end it with "This article
// originally appeared in <the paper>", and other outlets report the same story. This asks a search
// service for both, with only what the link itself carries (the words of its address, and its date)
// and the paper's name, and hands back what came, for the reader to pick from. Nothing here decides
// which copy is the article: the reader does, by its headline, because a paper often runs more than
// one article on the same event on the same day.
//
// The operator's question of 1 October started it: ChatGPT found, by keywords, the Times article the
// Times had refused CIVIC, in The Straits Times' republication.
import { config } from './config.js';
import { siteFetch } from './http.js';
import { assertPublic } from './fetchurl.js';
import { record as ledger } from './ledger.js';
import { record as failure } from './diagnostics.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 24 * 60 * 60 * 1000;

// The name a paper prints at the end of the articles others republish ("This article originally
// appeared in The New York Times"). A site not listed here is searched for by its own address.
const PUBLISHERS = {
  'nytimes.com': 'The New York Times', 'washingtonpost.com': 'The Washington Post', 'wsj.com': 'The Wall Street Journal',
  'bloomberg.com': 'Bloomberg', 'ft.com': 'Financial Times', 'economist.com': 'The Economist', 'theatlantic.com': 'The Atlantic',
  'newyorker.com': 'The New Yorker', 'latimes.com': 'Los Angeles Times', 'bostonglobe.com': 'The Boston Globe',
  'reuters.com': 'Reuters', 'apnews.com': 'The Associated Press', 'politico.com': 'Politico', 'thehill.com': 'The Hill',
  'axios.com': 'Axios', 'businessinsider.com': 'Business Insider', 'newsweek.com': 'Newsweek', 'time.com': 'Time',
  'wired.com': 'Wired', 'thetimes.co.uk': 'The Times', 'telegraph.co.uk': 'The Telegraph', 'foreignpolicy.com': 'Foreign Policy',
  'foreignaffairs.com': 'Foreign Affairs',
};

/** The paper behind a site's address: its printed name when known, else the address itself. */
export function publisherOf(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  for (const [domain, name] of Object.entries(PUBLISHERS)) if (h === domain || h.endsWith(`.${domain}`)) return name;
  return h;
}

/** What a link itself says: the words of its address (the segment carrying the most words; an
 *  article's id segments carry none), and the date its address carries, if any. Nothing is guessed. */
export function linkWords(raw) {
  let url;
  try { url = new URL(raw); } catch { return { words: '', date: '', day: null }; }
  const segments = url.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const wordsOf = (s) => s.replace(/\.(s?html?|php|aspx?|amp|cms)$/i, '').split(/[-_+.~]+/).filter((w) => /^\p{L}+$/u.test(w));
  let best = [];
  for (const s of segments) { const w = wordsOf(s); if (w.length > best.length) best = w; }
  // A date in the address: /2026/09/30/ or 2026-09-30, or 20260930 standing alone at a segment's end.
  const path = url.pathname;
  const m = path.match(/(?:^|[/_-])((?:19|20)\d{2})[/_-](0?[1-9]|1[0-2])[/_-](0?[1-9]|[12]\d|3[01])(?=$|[/_.-])/)
    || path.match(/(?:^|[/_-])((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?=$|[/_.-])/);
  let date = '', day = null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const at = new Date(Date.UTC(y, mo - 1, d));
    if (at.getUTCMonth() === mo - 1 && at.getUTCDate() === d) { date = `${MONTHS[mo - 1]} ${d} ${y}`; day = at; }
  }
  return { words: best.join(' '), date, day };
}

/** Whether the search service is set: both its address and its key. */
export function searchOn() { return Boolean(String(config.searchUrl || '').trim() && String(config.searchKey || '').trim()); }

/** The key, carried the way the service asks for it (the transcript door's rule: raw in its own header
 *  unless a prefix is named). */
function searchHeaders() {
  const prefix = String(config.searchPrefix || '').trim();
  const key = String(config.searchKey || '').trim();
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  headers[String(config.searchHeader || 'x-api-key').toLowerCase()] = prefix ? `${prefix} ${key}` : key;
  return headers;
}

/** What the service said went wrong, in its own words, for the operator's record; never the key. */
function reasonOf(data, text) {
  let said = '';
  if (data && typeof data === 'object') {
    said = [typeof data.error === 'string' ? data.error : (data.error?.message || ''), typeof data.message === 'string' ? data.message : ''].filter(Boolean).join(': ');
  }
  if (!said) said = String(text || '').replace(/\s+/g, ' ').trim();
  const key = String(config.searchKey || '').trim();
  return (key ? said.split(key).join('<key>') : said).slice(0, 160);
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

/** One search. A refusal for the minute is a wait (the service's own Retry-After, else a doubling from
 *  a second) and never a failure; nothing here limits how long the reader is willing to wait, and the
 *  reader leaving is what stops it. Any other refusal is a note for the operator and no copies. */
async function searchOnce(kind, query, exclude, { signal }) {
  const address = await assertPublic(String(config.searchUrl).trim());
  const body = JSON.stringify({ query, type: 'auto', numResults: config.searchResults, excludeDomains: exclude, contents: { text: true } });
  for (let backoff = 1000; ;) {
    if (signal?.aborted) throw new Error('aborted');
    const started = Date.now();
    let res;
    try {
      res = await siteFetch(address, { method: 'POST', headers: searchHeaders(), body, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      return { results: [], note: `the search service could not be reached (${err?.cause?.code || err?.message || 'no answer'})` };
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      await wait(Number.isFinite(after) && after >= 0 ? after * 1000 : backoff, signal);
      backoff *= 2;
      continue;
    }
    if (!res.ok) {
      const reason = reasonOf(data, text);
      return { results: [], note: `the search service answered ${res.status}${reason ? ` (${reason})` : ''}` };
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    // The cost is the service's own figure for this call, when it gives one; nothing is estimated.
    const usd = Number(data?.costDollars?.total);
    ledger({ kind: 'search', step: 'find-copies', search: kind, results: results.length, ms: Date.now() - started, usd: Number.isFinite(usd) ? usd : null });
    return { results };
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bare = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();
const clean = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function normal(u) {
  const x = new URL(u);
  return `${x.protocol}//${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/$/, '')}${x.search}`;
}
/** A page that says it is the paper's article: the line republishers print, or the paper's copyright. */
function creditPattern(publisher) {
  const name = escapeRe(bare(publisher));
  return new RegExp(`(?:originally|first)\\s+(?:appeared|published|ran)\\s+in\\s+(?:the\\s+)?${name}|©\\s*\\d{4}\\s+(?:the\\s+)?${name}`, 'i');
}

/** The same article republished elsewhere, then other reports of the same story. Copies that say they
 *  are the paper's article come first, each group in the service's own order; when the link carries a
 *  date, a page dated more than two days from it is not that day's story (two: the world's time zones,
 *  and a paper that republishes in the next day's edition). */
export async function findCopies(rawUrl, { signal } = {}) {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const publisher = publisherOf(host);
  const { words, date, day } = linkWords(url.toString());
  if (!words) return { site: host, publisher, words, date, copies: [] }; // an address without words gives a search nothing to go on
  const subject = [words, date].filter(Boolean).join(' ');
  const [republished, reported] = await Promise.all([
    searchOnce('republished', `${subject} "This article originally appeared in ${publisher}"`, [host], { signal }),
    searchOnce('reported', `${subject} ${publisher}`, [host], { signal }),
  ]);
  for (const r of [republished, reported]) {
    if (r.note) failure({ where: 'server:find-copies', code: 'search_failed', message: `Looking for ${host}'s article elsewhere: ${r.note}.`, detail: r.note });
  }
  const credit = creditPattern(publisher);
  const seen = new Set([normal(url.toString())]);
  const copies = [];
  for (const r of [...republished.results, ...reported.results]) {
    let at;
    try { at = new URL(String(r?.url || '')); } catch { continue; }
    if (!/^https?:$/.test(at.protocol)) continue;
    const site = at.hostname.replace(/^www\./, '').toLowerCase();
    if (site === host || site.endsWith(`.${host}`)) continue; // the site that refused is no copy of itself
    const key = normal(at.toString());
    if (seen.has(key)) continue;
    const published = String(r?.publishedDate || '');
    if (day && published) {
      const t = Date.parse(published);
      if (Number.isFinite(t)) {
        const d = new Date(t);
        const onDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        if (Math.abs(onDay - day.getTime()) > 2 * DAY) continue;
      }
    }
    seen.add(key);
    const text = String(r?.text || '');
    copies.push({
      url: at.toString(), title: clean(r?.title) || site, site, published: published.slice(0, 10), author: clean(r?.author),
      credited: credit.test(text) || (Boolean(r?.author) && bare(r.author) === bare(publisher)), text, chars: text.length,
    });
  }
  copies.sort((a, b) => Number(b.credited) - Number(a.credited)); // stable: within each group, the service's order
  return { site: host, publisher, words, date, copies };
}
