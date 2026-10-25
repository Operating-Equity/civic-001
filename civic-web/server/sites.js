// The sites kept out of the research (25 October; the operator: "I want the truth and the documents that support it"):
// the operator's list, kept where the prompts are kept, never in this repository: CIVIC_BLOCKED_SITES (sites separated
// by commas, spaces or lines) or CIVIC_BLOCKED_SITES_FILE (a secret file holding them).
//
// A site is a host name, written without "www.", and covers its subdomains, as OpenAI's web search reads its
// `blocked_domains`. Where the list holds:
//   - OpenAI's web search, on every fact-check that runs on OpenAI (the readers', the trial's, side by side): the search
//     never returns a page of a site on it (server/tools/request.js);
//   - FactEngine's own tools (DeepSeek in the operator's trial, and the tool server): the search service is asked to
//     leave the sites out, a result it returns from one anyway is dropped, and the page reader refuses them
//     (server/tools/adapters);
//   - Gemini: Google's developer API cannot leave a site out, so what it cites or reads from the list is counted, never
//     kept from it.
// What a fact-check took from the list is counted on its ledger line and in the host's log, and marked on the operator's
// card, never on a reader's. The reader's own document is never touched: a link to a site on the list is read when it is
// the document being tested. A list that cannot be read stops the start, naming the key and never a site.
import crypto from 'node:crypto';
import fs from 'node:fs';

// OpenAI's own ceiling for `blocked_domains`; the search service takes more.
export const MAX_SITES = 100;

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** The list as written: each entry a host, lower case, without "www."; once each, in order. Throws naming `key` alone. */
export function parseSites(raw, key = 'CIVIC_BLOCKED_SITES') {
  const fail = (why) => { throw new Error(`${key}: ${why}`); };
  const out = new Set();
  for (const entry of String(raw ?? '').split(/[\s,;]+/).filter(Boolean)) {
    if (/[/:?#@\\]/.test(entry)) fail('an entry carries a scheme, a path or a port; a site is written as its host alone');
    let host = '';
    try { host = new URL(`https://${entry}`).hostname; } catch { /* not a host */ }
    host = host.replace(/\.$/, '').replace(/^www\./, '');
    if (!HOST.test(host)) fail('an entry is not the host name of a site');
    out.add(host);
  }
  const sites = [...out].sort();
  if (sites.length > MAX_SITES) fail(`it holds ${sites.length} sites, and OpenAI's web search takes ${MAX_SITES} at most`);
  return sites;
}

/** The list's fingerprint (the first 8 hex of the SHA-256 of its sites, one to a line, in order): the same sites, the same fingerprint, however they were written. */
export const sitesFingerprint = (sites) => `#${crypto.createHash('sha256').update(sites.join('\n')).digest('hex').slice(0, 8)}`;

/** The list in force, read from the environment: its sites and fingerprint, or null when none is set. */
export function loadSites(env = process.env) {
  let raw = String(env.CIVIC_BLOCKED_SITES || '');
  let key = 'CIVIC_BLOCKED_SITES';
  const file = String(env.CIVIC_BLOCKED_SITES_FILE || '').trim();
  if (!raw.trim() && file) {
    key = 'CIVIC_BLOCKED_SITES_FILE';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`${key}: the file could not be read`); }
  }
  const sites = parseSites(raw, key);
  return sites.length ? { sites, fingerprint: sitesFingerprint(sites) } : null;
}

const list = loadSites();

/** The sites in force, in order; an empty list when none is set. */
export const blockedSites = () => (list ? list.sites : []);

/** The list's sites, fingerprint and count for /check and the boot line; null when none is set. */
export const sitesState = () => (list ? { count: list.sites.length, fingerprint: list.fingerprint } : null);

/** The site of the list a host belongs to (the host itself, or a domain it is under), or null. */
function siteOfHost(host, sites) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  for (const site of sites) if (h === site || h.endsWith(`.${site}`)) return site;
  return null;
}

// Google's search cites a page through a link of its own, with the site's name as the link's title (Google's grounding
// redirect); the site is read from that title.
const GOOGLE_REDIRECT = /^(?:[a-z0-9-]+\.)*vertexaisearch\.cloud\.google\.com$/;

/**
 * The site of the list an address belongs to, or null: its host; or an address it carries inside it (an archived copy,
 * a redirect: `https://web.archive.org/web/…/https://site/…`); or, for Google's own link to a page it cites, the site
 * named by its title. `sites` defaults to the list in force.
 */
export function listedSite(address, { title = null, sites = blockedSites() } = {}) {
  if (!sites.length || !address) return null;
  const raw = String(address).trim();
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const own = siteOfHost(url.hostname, sites);
  if (own) return own;
  if (title && GOOGLE_REDIRECT.test(url.hostname)) {
    const named = siteOfHost(String(title).trim().replace(/^www\./i, ''), sites);
    if (named) return named;
  }
  let inner = `${url.pathname}${url.search}${url.hash}`;
  try { inner = decodeURIComponent(inner); } catch { /* as written */ }
  for (const m of inner.matchAll(/https?:\/\/([^/?#\s"'<>]+)/gi)) {
    const site = siteOfHost(m[1].replace(/:\d+$/, ''), sites);
    if (site) return site;
  }
  return null;
}

/**
 * What a fact-check took from the list (counts only, never an address): `listed`, the addresses of sites on it among
 * what it cited, the pages it opened or read, and what its search says it consulted; `keptOut`, those it asked for and
 * did not get (a read refused, or one whose step ended other than completed). Null when no list is set, so a line holds
 * no figure it could not have.
 */
export function listedCounts({ sources = [], trail = [], consulted = [] } = {}) {
  const sites = blockedSites();
  if (!sites.length) return null;
  const got = new Set();
  const asked = new Set();
  for (const s of sources) if (listedSite(s?.url, { title: s?.title, sites })) got.add(String(s.url));
  for (const u of consulted) if (listedSite(u, { sites })) got.add(String(u));
  for (const step of trail) {
    if (!step?.url || !listedSite(step.url, { sites })) continue;
    (step.status && step.status !== 'completed' ? asked : got).add(String(step.url));
  }
  for (const u of got) asked.delete(u);
  return { listed: got.size, keptOut: asked.size };
}
