// The sites kept out of the research (25 October; the operator: "I want the truth and the documents that support it"),
// and given zero credibility. All of it is the operator's, kept where the prompts are kept, never in this repository:
//   - CIVIC_BLOCKED_SITES (or CIVIC_BLOCKED_SITES_FILE, a secret file holding it): at most 100 sites, each a host name
//     written without "www." and covering its subdomains, as OpenAI's web search reads its `blocked_domains`;
//   - CIVIC_BLOCKED_MORE (or CIVIC_BLOCKED_MORE_FILE): more sites, and columns of other sites (a host and the path its
//     column sits under, `example.com/column`), with no ceiling of OpenAI's;
//   - CIVIC_BLOCKED_WORDS: words by which a page names itself one of the kinds kept out, in its address (a path segment
//     or a word of its slug, whatever its capitals, a plural, or a hyphen, an underscore or nothing between its parts);
//   - CIVIC_BLOCKED_MARKUP: structured-data types by which a page names itself one (its JSON-LD `@type` or its microdata
//     `itemtype`), seen only on a page FactEngine reads itself.
// Entries are separated by commas, spaces or lines. Where they hold:
//   - OpenAI's web search, on every fact-check that runs on OpenAI (the readers', the trial's, side by side): the first
//     list's sites are never returned (server/tools/request.js). OpenAI takes whole sites alone, so for the rest it is
//     counted and marked, never kept from the model;
//   - FactEngine's own tools (DeepSeek in the operator's trial, and the tool server): the search service is asked to leave
//     both lists out, a result it returns from them anyway or with one of the words is dropped, and the page reader
//     refuses them all, a page of one of the markup types included (server/tools/adapters);
//   - Gemini: Google's developer API cannot leave a site out, so what it cites or reads of them is counted and marked.
// What a fact-check took of them is counted on its ledger line and in the host's log, and marked "zero credibility" on
// the operator's card, never on a reader's. The reader's own document is never touched: a link to any of them is read
// when it is the document being tested. A list that cannot be read stops the start, naming the key and never an entry.
import crypto from 'node:crypto';
import fs from 'node:fs';

// The sentence the model reads when FactEngine's reader refuses one of them: the site is not named.
export const NOT_CONSULTED = 'This page is not consulted.';

// OpenAI's own ceiling for `blocked_domains`; the search service's for `excludeDomains`, both lists together.
export const MAX_SITES = 100;
export const MAX_SEARCH_ENTRIES = 1200;

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const split = (raw) => String(raw ?? '').split(/[\s,;]+/).filter(Boolean);

/** A host as written, lower case, without "www." or a final dot; '' when it is not the host name of a site. */
function hostOf(written) {
  let host = '';
  try { host = new URL(`https://${written}`).hostname; } catch { /* not a host */ }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  return HOST.test(host) ? host : '';
}

/** The first list as written: each entry a host; once each, in order. Throws naming `key` alone. */
export function parseSites(raw, key = 'CIVIC_BLOCKED_SITES') {
  const fail = (why) => { throw new Error(`${key}: ${why}`); };
  const out = new Set();
  for (const entry of split(raw)) {
    if (/[/:?#@\\]/.test(entry)) fail('an entry carries a scheme, a path or a port; a site is written as its host alone');
    const host = hostOf(entry);
    if (!host) fail('an entry is not the host name of a site');
    out.add(host);
  }
  const sites = [...out].sort();
  if (sites.length > MAX_SITES) fail(`it holds ${sites.length} sites, and OpenAI's web search takes ${MAX_SITES} at most`);
  return sites;
}

/** The second list as written: sites (a host) and columns (a host and a path, `example.com/column`), once each, in order. */
export function parseMore(raw, key = 'CIVIC_BLOCKED_MORE') {
  const fail = (why) => { throw new Error(`${key}: ${why}`); };
  const out = new Set();
  for (const entry of split(raw)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) || /[?#@\\]/.test(entry)) fail('an entry carries a scheme, a query or an account; an entry is a host, or a host and a path');
    const slash = entry.indexOf('/');
    const hostPart = slash < 0 ? entry : entry.slice(0, slash);
    if (hostPart.includes(':')) fail('an entry carries a port; an entry is a host, or a host and a path');
    const host = hostOf(hostPart);
    if (!host) fail('an entry is not the host name of a site');
    const path = slash < 0 ? '' : entry.slice(slash).replace(/\/+$/, '').toLowerCase();
    out.add(path ? `${host}${path}` : host);
  }
  return [...out].sort();
}

/** Words or markup types as written: once each, in order. Throws naming `key` alone. */
function parseWords(raw, key, pattern, what) {
  const out = new Set();
  for (const entry of split(raw)) {
    if (!pattern.test(entry)) throw new Error(`${key}: an entry is not ${what}`);
    out.add(entry.toLowerCase());
  }
  return [...out].sort();
}
export const parseAddressWords = (raw, key = 'CIVIC_BLOCKED_WORDS') => parseWords(raw, key, /^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*$/u, 'a word of letters and digits, its parts joined by hyphens');
export const parseMarkupTypes = (raw, key = 'CIVIC_BLOCKED_MARKUP') => parseWords(raw, key, /^[A-Za-z][A-Za-z0-9]*$/, 'a structured-data type name');

/** A list's fingerprint (the first 8 hex of the SHA-256 of its entries, one to a line, in order): the same entries, the same fingerprint, however they were written. */
export const sitesFingerprint = (entries) => `#${crypto.createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 8)}`;

/** One setting's text: the variable, or else its file; and the key that was read, for a refusal. */
function settingText(env, name) {
  const raw = String(env[name] || '');
  const file = String(env[`${name}_FILE`] || '').trim();
  if (raw.trim() || !file) return { raw, key: name };
  try { return { raw: fs.readFileSync(file, 'utf8'), key: `${name}_FILE` }; } catch { throw new Error(`${name}_FILE: the file could not be read`); }
}

/** Everything in force, read from the environment; null when nothing is set. */
export function loadSites(env = process.env) {
  const first = settingText(env, 'CIVIC_BLOCKED_SITES');
  const more = settingText(env, 'CIVIC_BLOCKED_MORE');
  const sites = parseSites(first.raw, first.key);
  const extra = parseMore(more.raw, more.key).filter((e) => !covered(e, sites));
  const words = parseAddressWords(env.CIVIC_BLOCKED_WORDS);
  const markup = parseMarkupTypes(env.CIVIC_BLOCKED_MARKUP);
  if (sites.length + extra.length > MAX_SEARCH_ENTRIES) {
    throw new Error(`${more.key}: with CIVIC_BLOCKED_SITES it holds ${sites.length + extra.length} entries, and the search service takes ${MAX_SEARCH_ENTRIES} at most`);
  }
  if (!sites.length && !extra.length && !words.length && !markup.length) return null;
  return {
    sites, extra, words, markup,
    fingerprint: sites.length ? sitesFingerprint(sites) : null,
    extraFingerprint: extra.length ? sitesFingerprint(extra) : null,
    kindFingerprint: words.length || markup.length ? sitesFingerprint([...words, '', ...markup]) : null,
  };
}

/** Whether an entry of the second list is already covered by a site of the first (the host, or a domain it is under). */
function covered(entry, sites) {
  const host = entry.split('/')[0];
  return sites.some((s) => host === s || host.endsWith(`.${s}`));
}

const list = loadSites();

/** The first list's sites, in order: what OpenAI's web search leaves out; an empty list when none is set. */
export const blockedSites = () => (list ? list.sites : []);

/** Everything the search service is asked to leave out: both lists, sites and columns, in order. */
export const searchExclusions = () => (list ? [...list.sites, ...list.extra] : []);

/** What is in force, in words for /check and the boot line: counts and fingerprints, never an entry; '' when nothing is set. */
export function sitesWords() {
  const k = sitesState();
  if (!k) return '';
  const many = (n, one, more) => `${n} ${n === 1 ? one : more}`;
  return [
    k.count ? `${many(k.count, 'site', 'sites')} (list ${k.fingerprint}) blocked in OpenAI's web search and in FactEngine's own search and page reader` : null,
    k.extraSites || k.extraColumns ? `${many(k.extraSites, 'more site', 'more sites')} and ${many(k.extraColumns, 'column', 'columns')} (list ${k.extraFingerprint}) blocked in FactEngine's own search and page reader` : null,
    k.words || k.markup ? `pages that name themselves one of the kinds by ${many(k.words, 'address word', 'address words')} and ${many(k.markup, 'markup type', 'markup types')} (${k.kindFingerprint}) blocked in FactEngine's own search and page reader` : null,
  ].filter(Boolean).join('; ');
}

/** What /check and the boot line say of it, by counts and fingerprints, never an entry; null when nothing is set. */
export const sitesState = () => (list ? {
  count: list.sites.length, fingerprint: list.fingerprint,
  extraSites: list.extra.filter((e) => !e.includes('/')).length, extraColumns: list.extra.filter((e) => e.includes('/')).length, extraFingerprint: list.extraFingerprint,
  words: list.words.length, markup: list.markup.length, kindFingerprint: list.kindFingerprint,
} : null);

/** Whether a host is a site of the entries' (the host itself, or a domain it is under), or a column's host with its path. */
function entryFor(host, path, entries) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  const p = String(path || '').toLowerCase();
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    const site = slash < 0 ? entry : entry.slice(0, slash);
    if (h !== site && !h.endsWith(`.${site}`)) continue;
    if (slash < 0) return entry;
    const column = entry.slice(slash);
    if (p === column || p.startsWith(`${column}/`)) return entry;
  }
  return null;
}

/** A pattern for the address words: each a path segment or a word of a slug, whatever its capitals, a final "s", or a
 *  hyphen, an underscore or nothing between its parts. */
function wordsPattern(words) {
  if (!words.length) return null;
  const alt = words.map((w) => w.split(/[-_]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-_]?') + 's?');
  return new RegExp(`(?:^|[/._-])(?:${alt.join('|')})(?=$|[/._-])`, 'iu');
}
const WORDS = wordsPattern(list ? list.words : []);

// Google's search cites a page through a link of its own, with the site's name as the link's title (Google's grounding
// redirect); the site is read from that title.
const GOOGLE_REDIRECT = /^(?:[a-z0-9-]+\.)*vertexaisearch\.cloud\.google\.com$/;

/**
 * What an address is of, among what is kept out: a site of either list or a column of the second, by its host (and path);
 * a page that names itself one of the kinds by its address; an address carried inside it (an archived copy, a redirect:
 * `https://web.archive.org/web/…/https://site/…`); or, for Google's own link to a page it cites, the site named by its
 * title. Null when none. `lists` defaults to what is in force.
 */
export function listedSite(address, { title = null, lists = null } = {}) {
  const entries = lists ? [...(lists.sites || []), ...(lists.extra || [])] : searchExclusions();
  const words = lists ? wordsPattern(lists.words || []) : WORDS;
  if ((!entries.length && !words) || !address) return null;
  const raw = String(address).trim();
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* as written */ }
  const own = entryFor(url.hostname, path, entries);
  if (own) return own;
  if (words && words.test(path)) return 'word';
  if (title && GOOGLE_REDIRECT.test(url.hostname)) {
    const named = entryFor(String(title).trim().replace(/^www\./i, ''), '', entries);
    if (named) return named;
  }
  let inner = `${url.pathname}${url.search}${url.hash}`;
  try { inner = decodeURIComponent(inner); } catch { /* as written */ }
  for (const m of inner.matchAll(/https?:\/\/([^/?#\s"'<>]+)([^?#\s"'<>]*)/gi)) {
    const site = entryFor(m[1].replace(/:\d+$/, ''), m[2], entries);
    if (site) return site;
    if (words && words.test(m[2])) return 'word';
  }
  return null;
}

/** Whether a page's markup names it one of the kinds kept out: a JSON-LD `@type`, or a microdata `itemtype`, among the
 *  operator's types. `types` defaults to what is in force. */
export function markedByMarkup(html, { types = null } = {}) {
  const wanted = types || (list ? list.markup : []);
  if (!wanted.length || !html) return false;
  const text = String(html);
  for (const t of wanted) {
    const name = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`"@type"\\s*:\\s*(?:\\[[^\\]]*?)?"(?:https?://schema\\.org/)?${name}"`, 'i').test(text)) return true;
    if (new RegExp(`itemtype\\s*=\\s*["']?https?://schema\\.org/${name}\\b`, 'i').test(text)) return true;
  }
  return false;
}

/**
 * What a fact-check took of what is kept out (counts only, never an address): `listed`, the addresses among what it
 * cited, the pages it opened or read, and what its search says it consulted; `keptOut`, those it asked for and did not
 * get (a read refused, or one whose step ended other than completed). Null when nothing is set, so a line holds no figure
 * it could not have.
 */
export function listedCounts({ sources = [], trail = [], consulted = [] } = {}) {
  if (!list) return null;
  const got = new Set();
  const asked = new Set();
  for (const s of sources) if (listedSite(s?.url, { title: s?.title })) got.add(String(s.url));
  for (const u of consulted) if (listedSite(u)) got.add(String(u));
  for (const step of trail) {
    const kept = step?.url && (step.listed || listedSite(step.url));
    if (!kept) continue;
    (step.status && step.status !== 'completed' ? asked : got).add(String(step.url));
  }
  for (const u of got) asked.delete(u);
  return { listed: got.size, keptOut: asked.size };
}
