// Reading a link. A reader should be able to paste a web address and press the button, so this
// turns an address into the text CIVIC tests: an article, a transcript, a PDF, a plain file.
//
// Two rules it keeps:
//   1. Nothing is summarised, shortened or rewritten. The page's own words come back, with the
//      navigation, scripts and boilerplate removed and nothing else.
//   2. The server refuses to fetch anything that is not a public web address. It holds the
//      operator's key, so it must not be usable as a way to reach machines behind the firewall.
import dns from 'node:dns/promises';
import net from 'node:net';
import { PDFParse } from 'pdf-parse';
import { config } from './config.js';
import { siteFetch } from './http.js';

const MAX_BYTES = 12 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

export class UrlError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400; }
}

// ---- A site that keeps its text from CIVIC ---------------------------------------------------
// The reader is told which site, and what to do: paste the article's text. The page has these
// sentences in its own languages; the server's are the English ones, with the site's name.
export const siteName = (url) => url.hostname.replace(/^www\./, '');
export const SITE_SENTENCES = {
  url_refused: (site) => `${site} does not let CIVIC read its pages from here. If you can open the article, copy its text and paste it here.`,
  url_silent: (site) => `${site} does not let CIVIC read its pages from here. If you can open the article, copy its text and paste it here.`,
  url_paywall: (site) => `${site} keeps this article behind its paywall, so CIVIC cannot read it here. If you subscribe, copy the article's text and paste it here.`,
  url_shell: (site) => `${site} builds this page in the browser, so no readable text reached CIVIC. Copy the article's text and paste it here.`,
};
const siteError = (code, site) => { const e = new UrlError(code, SITE_SENTENCES[code](site)); e.site = site; return e; };

// A site that never answers the connection attempt is remembered until the service restarts, so
// the next reader gets the sentence at once instead of the connect timeout; each such answer
// re-checks the site in the background with one attempt, and a site that answers is forgotten.
const silentHosts = new Map(); // host → { at, cause, rechecking }
const SILENT_CAUSES = /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EHOSTUNREACH|ENETUNREACH/;
export function silentSites() { return [...silentHosts.entries()].map(([host, v]) => ({ host, at: v.at, cause: v.cause })); }
export function forgetSilent(host) { silentHosts.delete(host); }
function rememberSilent(host, cause) { silentHosts.set(host, { at: new Date().toISOString(), cause, rechecking: false }); }
function recheckSilent(host) {
  const entry = silentHosts.get(host);
  if (!entry || entry.rechecking) return;
  entry.rechecking = true;
  siteFetch(`https://${host}/`, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': UA } })
    .then(() => silentHosts.delete(host), () => { entry.rechecking = false; });
}

/** The prose a site shows at its wall. Ordinary article prose does not say these things. */
const WALL_PHRASES = /\b(to continue reading|already a subscriber|subscribers only|for subscribers only|unlock this article|sign in to (?:read|continue)|log in to (?:read|continue))\b/i;

/** True when the whole of `s` is one http(s) address and nothing else. */
export function isSingleUrl(s) {
  const t = String(s || '').trim();
  if (!t || /\s/.test(t)) return false;
  try { const u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::' || s === '::1' || s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd') ||
    s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.');
}

async function assertPublic(urlString) {
  const url = new URL(urlString);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlError('url_not_web', 'Only web addresses beginning http:// or https:// can be read.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host }];
  else {
    try { addresses = await dns.lookup(host, { all: true }); }
    catch { throw new UrlError('url_unreachable', `No server was found at ${url.hostname}.`); }
  }
  if (!config.allowPrivateUrls && addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UrlError('url_private', 'That address points inside a private network, so it is not read.');
  }
  return url;
}

async function get(urlString, { accept, signal } = {}) {
  let url = await assertPublic(urlString);
  // No time limit of ours: a large document over a slow link takes as long as it takes. The reader
  // can stop the run, and that is the only thing that stops the download.
  const composite = signal;
  let res;
  for (let hop = 0; ; hop++) {
    if (hop > 5) throw new UrlError('url_redirects', 'That address redirects too many times.');
    try {
      res = await siteFetch(url, {
        redirect: 'manual',
        signal: composite,
        headers: { 'user-agent': UA, accept: accept || 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8', 'accept-language': 'en,*;q=0.5' },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      // Plain words for the reader; the cause (a code such as ECONNREFUSED or UND_ERR_CONNECT_TIMEOUT)
      // goes to the failure record for the operator. A site that never answered the connection is
      // remembered as silent.
      const cause = err?.cause?.code || err?.cause?.message || err?.message || 'no answer';
      const site = siteName(url);
      if (SILENT_CAUSES.test(String(cause))) { rememberSilent(url.hostname, String(cause)); const e = siteError('url_silent', site); e.detail = String(cause); throw e; }
      const e = new UrlError('url_unreachable', 'That address could not be reached.');
      e.detail = cause;
      throw e;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublic(new URL(res.headers.get('location'), url).toString()); // every hop is checked
      continue;
    }
    break;
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) { const e = siteError('url_refused', siteName(url)); e.detail = `status ${res.status}`; throw e; }
  if (res.status === 402) { const e = siteError('url_paywall', siteName(url)); e.detail = 'status 402'; throw e; }
  if (!res.ok) throw new UrlError('url_status', `That page answered ${res.status}.`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new UrlError('url_too_big', 'That file is too large to read.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new UrlError('url_too_big', 'That file is too large to read.');
  return { buf, res, url };
}

// ---- HTML to text ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', times: '×', middot: '·', eacute: 'é', deg: '°' };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&([a-z]+[0-9]?);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}
function safeChar(code) {
  try { return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; } catch { return ''; }
}

/** A page's own statement of who wrote it, when, and where, from its meta tags and JSON-LD. */
export function pageIdentity(html) {
  const s = String(html);
  const meta = (names) => {
    for (const n of names) {
      const re1 = new RegExp(`<meta[^>]+(?:name|property|itemprop)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property|itemprop)=["']${n}["']`, 'i');
      const m = s.match(re1) || s.match(re2);
      if (m?.[1]?.trim()) return decodeEntities(m[1]).trim();
    }
    return '';
  };
  const ld = [];
  for (const m of s.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const v = JSON.parse(m[1]); ld.push(...(Array.isArray(v) ? v : [v])); } catch { /* not JSON */ }
  }
  const fromLd = (key) => {
    for (const node of ld) {
      const items = Array.isArray(node?.['@graph']) ? node['@graph'] : [node];
      for (const it of items) {
        const v = it?.[key];
        if (!v) continue;
        if (typeof v === 'string') return v;
        if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean).join(', ');
        if (typeof v === 'object' && v.name) return String(v.name);
      }
    }
    return '';
  };
  const isFalse = (v) => v === false || /^false$/i.test(String(v ?? ''));
  const notFree = ld.some((node) => {
    const items = Array.isArray(node?.['@graph']) ? node['@graph'] : [node];
    return items.some((it) => isFalse(it?.isAccessibleForFree) || [].concat(it?.hasPart || []).some((part) => isFalse(part?.isAccessibleForFree)));
  }) || /^locked$/i.test(meta(['article:content_tier']));
  return {
    author: meta(['author', 'article:author', 'parsely-author', 'dc.creator', 'byl']) || fromLd('author'),
    published: (meta(['article:published_time', 'datePublished', 'date', 'pubdate', 'parsely-pub-date', 'dc.date']) || fromLd('datePublished')).slice(0, 60),
    site: meta(['og:site_name', 'application-name']),
    notFree,
  };
}

export function htmlToText(html) {
  let s = String(html);
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const identity = pageIdentity(s);

  // Everything that is not the page's prose.
  s = s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|form|select|button)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Prefer the article body when the page marks one.
  const body = s.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    || s;

  const text = decodeEntities(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|section|li|tr|h[1-6]|blockquote|pre|figcaption)>/gi, '\n\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title: decodeEntities(title), text, ...identity };
}

// ---- YouTube --------------------------------------------------------------------------------

export function youtubeId(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return null;
  if (u.pathname === '/watch') return u.searchParams.get('v');
  const m = u.pathname.match(/^\/(?:embed|v|shorts|live)\/([^/?#]+)/);
  return m ? m[1] : null;
}

function captionTracksFrom(html) {
  const m = html.match(/"captionTracks":(\[.*?\])/s);
  if (!m) return [];
  try { return JSON.parse(m[1].replace(/\\u0026/g, '&')); } catch { return []; }
}

/** Caption cues, from YouTube's JSON or its older XML. */
export function captionLines(payload) {
  try {
    const json = JSON.parse(payload);
    const lines = (json.events || [])
      .map((e) => (e.segs || []).map((seg) => seg.utf8).join(''))
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (lines.length) return lines;
  } catch { /* not JSON: fall through to the XML form */ }
  return [...String(payload).matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => decodeEntities(m[1]).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Cues are fragments. Join them so a claim is never split across two cues. */
export function joinCaptionLines(lines) {
  let out = '';
  for (const line of lines) {
    if (!out) { out = line; continue; }
    out += /[.!?"')\]]$/.test(out) ? '\n' : ' ';
    out += line;
  }
  return out;
}

/** The video's own caption track, joined into readable lines. No summary, no invention. */
export async function youtubeTranscript(url, { signal } = {}) {
  const id = youtubeId(url);
  if (!id) throw new UrlError('url_not_youtube', 'That is not a YouTube video address.');
  const { buf } = await get(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=en`, { signal });
  const html = buf.toString('utf8');
  const title = decodeEntities(html.match(/<meta name="title" content="([^"]*)"/)?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/ - YouTube$/, '').trim();

  const unjson = (v) => { try { return JSON.parse(`"${v}"`); } catch { return v; } };
  const author = unjson(html.match(/"author":"((?:[^"\\]|\\.)*)"/)?.[1] || '') || decodeEntities(html.match(/<link itemprop="name" content="([^"]*)"/)?.[1] || '');
  const published = html.match(/"publishDate":"([^"]+)"/)?.[1] || html.match(/"uploadDate":"([^"]+)"/)?.[1] || html.match(/<meta itemprop="datePublished" content="([^"]*)"/)?.[1] || '';

  const tracks = captionTracksFrom(html);
  if (!tracks.length) {
    throw new UrlError('url_no_transcript',
      'That video has no caption track that YouTube will hand over, so there is no transcript to test. Paste the transcript text instead.');
  }
  const pick = tracks.find((tr) => /^en/i.test(tr.languageCode || '') && tr.kind !== 'asr')
    || tracks.find((tr) => /^en/i.test(tr.languageCode || ''))
    || tracks[0];

  const { buf: capBuf } = await get(`${pick.baseUrl}&fmt=json3`, { accept: 'application/json', signal });
  const lines = captionLines(capBuf.toString('utf8'));
  if (!lines.length) throw new UrlError('url_no_transcript', 'That video\'s caption track came back empty.');
  const out = joinCaptionLines(lines);
  const auto = pick.kind === 'asr';
  return {
    kind: 'youtube',
    title: title || `YouTube video ${id}`,
    author,
    published: published.slice(0, 60),
    site: 'YouTube',
    text: out.trim(),
    note: auto ? 'automatic_captions' : null,
    language: pick.languageCode || null,
  };
}

// ---- the one entry point --------------------------------------------------------------------

/** An address as a person types it becomes a full one. A bare host is assumed to be https. */
export function normalizeUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/^<|>$/g, '');
  if (!trimmed) throw new UrlError('url_empty', 'No address was given.');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try { return new URL(withScheme); } catch { throw new UrlError('url_not_web', 'That is not a web address.'); }
}

/** A link from a Google app is a token, not the article's address: only Google can resolve it, and
 *  it answers no server (the operator's link of 18 September: 71 s, then nothing). The reader is
 *  told at once. `google.com/url?q=…` carries its destination in the open and is unwrapped instead. */
export const APP_LINK_MESSAGE = 'This is a Google app link, and it does not carry the article\'s own address. Open the article, copy the address from the address bar and paste it here, or paste the article\'s text.';
export function unwrapRedirect(url) {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'google.com' || url.pathname !== '/url') return null;
  const target = url.searchParams.get('q') || url.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) return null;
  try { return new URL(target); } catch { return null; }
}
export function appLink(url) {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'google.com' && (url.pathname === '/goto' || (url.pathname === '/url' && !unwrapRedirect(url)))) return true;
  return host === 'news.google.com' && /^\/(articles|read|rss\/articles)\//.test(url.pathname);
}

export async function readUrl(rawUrl, { signal } = {}) {
  let url = normalizeUrl(rawUrl);
  if (appLink(url)) throw new UrlError('url_app_link', APP_LINK_MESSAGE);
  url = unwrapRedirect(url) || url;
  if (silentHosts.has(url.hostname)) { recheckSilent(url.hostname); throw siteError('url_silent', siteName(url)); }

  if (youtubeId(url.toString())) {
    const t = await youtubeTranscript(url.toString(), { signal });
    return { ...t, url: url.toString() };
  }

  const { buf, res, url: finalUrl } = await get(url.toString(), { signal });
  const type = (res.headers.get('content-type') || '').toLowerCase();

  if (type.includes('application/pdf') || finalUrl.pathname.toLowerCase().endsWith('.pdf')) {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const out = await parser.getText();
      return { kind: 'pdf', title: finalUrl.pathname.split('/').pop() || finalUrl.hostname, text: String(out?.text || '').trim(), url: finalUrl.toString(), note: null };
    } finally { await parser.destroy?.(); }
  }

  if (type.includes('html') || type.includes('xml') || !type) {
    const { title, text, author, published, site, notFree } = htmlToText(buf.toString('utf8'));
    const name = site || siteName(finalUrl);
    if (!text) throw siteError('url_shell', name);
    // The site says the article is not free (the schema.org flag Google News reads), or its prose
    // says so at the wall: nothing is tested, whatever the site sent (the operator's rule).
    if (notFree || WALL_PHRASES.test(text)) throw siteError('url_paywall', name);
    // A page with no paragraph of prose is a shell built by scripts, not an article.
    const longest = Math.max(0, ...text.split(/\n\n+/).map((p) => p.trim().length));
    if (longest < 200) throw siteError('url_shell', name);
    return { kind: 'page', title: title || finalUrl.hostname, author, published, site: name, text, url: finalUrl.toString(), note: null };
  }

  if (type.startsWith('text/') || type.includes('json')) {
    return { kind: 'text', title: finalUrl.pathname.split('/').pop() || finalUrl.hostname, text: buf.toString('utf8').trim(), url: finalUrl.toString(), note: null };
  }

  throw new UrlError('url_not_text', `That address returned ${type || 'an unknown kind of file'}, which has no text to test.`);
}
