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
import { siteFetch, SITE_SILENCE_MS } from './http.js';

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

// A site that stays silent (no answer to the connection attempt, or no answer to the request once
// connected; both found in the platform's ten seconds, http.js) is remembered until the service
// restarts, so the next reader gets the sentence at once instead of the wait; each such answer
// re-checks the site in the background with one attempt, and a site that answers is forgotten.
const silentHosts = new Map(); // host → { at, cause, rechecking }
const SILENT_CAUSES = /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|EHOSTUNREACH|ENETUNREACH/;
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

/** One request to a site. Plain words for the reader when it fails; the cause (a code such as
 *  ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT or UND_ERR_HEADERS_TIMEOUT, with the syscall and address when
 *  the operating system reported it) goes to the failure record for the operator. A site that stayed
 *  silent, to the connection or to the request, is remembered as silent. */
async function siteRequest(url, init, signal) {
  try {
    return await siteFetch(url, { ...init, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    const cause = [err?.cause?.code || err?.cause?.message || err?.message || 'no answer', err?.cause?.syscall, err?.cause?.address].filter(Boolean).join(' ');
    const site = siteName(url);
    if (SILENT_CAUSES.test(String(cause))) { rememberSilent(url.hostname, String(cause)); const e = siteError('url_silent', site); e.detail = `${cause} (silence limit ${SITE_SILENCE_MS} ms)`; throw e; }
    const e = new UrlError('url_unreachable', 'That address could not be reached.');
    e.detail = cause;
    throw e;
  }
}

/** A JSON request to a site (the player API), under the same rules as a page read. */
async function postJson(urlString, body, { headers = {}, signal } = {}) {
  const url = await assertPublic(urlString);
  assertNotSilent(url);
  return siteRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) }, signal);
}

async function get(urlString, { accept, signal } = {}) {
  let url = await assertPublic(urlString);
  // No time limit of ours: a large document over a slow link takes as long as it takes. The reader
  // can stop the run, and that is the only thing that stops the download.
  const composite = signal;
  let res;
  for (let hop = 0; ; hop++) {
    if (hop > 5) throw new UrlError('url_redirects', 'That address redirects too many times.');
    if (signal?.aborted) throw new Error('aborted');
    res = await siteRequest(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: accept || 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8', 'accept-language': 'en,*;q=0.5' },
    }, composite);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublic(new URL(res.headers.get('location'), url).toString()); // every hop is checked
      assertNotSilent(url);
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

/** YouTube's player has several doors, one for each kind of client, and it guards them unevenly: since
 *  2026 the web player hands caption tracks only to a client that presents a proof-of-origin token (a
 *  real browser), and for some videos it asks a data-centre address to sign in at one door while another
 *  door opens. These are the doors, asked in the operator's order until one answers with captions. None
 *  involves a key of the operator's: the web key and the visitor id come from the watch page itself. */
const YOUTUBE_CLIENTS = {
  ANDROID: { id: '3', context: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34 }, ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip' },
  TVHTML5: { id: '7', context: { clientName: 'TVHTML5', clientVersion: '7.20250312.16.00' }, ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version' },
  WEB_EMBEDDED_PLAYER: { id: '56', context: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250310.01.00' }, ua: UA, thirdParty: { embedUrl: 'https://www.youtube.com/' } },
  ANDROID_VR: { id: '28', context: { clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' }, ua: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip' },
  IOS: { id: '5', context: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' }, ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)' },
};
const VIDEO_WALL = 'YouTube would not show this video\'s captions to CIVIC\'s server without a sign-in, as it does for some videos. Open the video on YouTube, choose Show transcript under the description, copy the text and paste it here.';
const NO_CAPTIONS = 'That video has no caption track that YouTube will hand over, so there is no transcript to test. Paste the transcript text instead.';

/** One door: the player API's answer for a video as that client asks it. `{ player }` when the door
 *  opened with caption tracks; `{ player, note }` when it opened and the video has none; `{ note }`
 *  when it stayed shut, the note saying how (for the failure record). */
async function askDoor(base, id, key, visitor, name, signal) {
  const door = YOUTUBE_CLIENTS[name];
  if (!door) return { note: `${name} is not a door` };
  const url = `${base}/youtubei/v1/player?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  const headers = { 'user-agent': door.ua, 'x-youtube-client-name': door.id, 'x-youtube-client-version': door.context.clientVersion };
  if (visitor) headers['x-goog-visitor-id'] = visitor;
  const body = { context: { client: { ...door.context, hl: 'en', gl: 'US', ...(visitor ? { visitorData: visitor } : {}) } }, videoId: id, contentCheckOk: true, racyCheckOk: true };
  if (door.thirdParty) body.context.thirdParty = door.thirdParty;
  const res = await postJson(url, body, { headers, signal });
  const text = await res.text();
  if (!res.ok) return { note: `${name} answered ${res.status}` };
  let player;
  try { player = JSON.parse(text); } catch { return { note: `${name} answered no JSON` }; }
  const status = player?.playabilityStatus || {};
  if (status.status && status.status !== 'OK') return { note: `${name} ${[status.status, status.reason].filter(Boolean).join(': ')}` };
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return { player, note: `${name} opened, no captions` };
  return { player };
}

/** The shapes hosted transcript services answer in: one piece of text, or a list of pieces each
 *  carrying its own. Nothing is summarised or invented; the words come back as they were sent. */
export function transcriptLines(data) {
  const pick = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v.text ?? v.utf8 ?? v.snippet ?? v.content ?? '') : '');
  const clean = (arr) => arr.map((x) => String(pick(x)).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (typeof data === 'string') return clean([data]);
  if (Array.isArray(data)) return clean(data);
  if (!data || typeof data !== 'object') return [];
  const body = data.data && typeof data.data === 'object' ? data.data : data;
  for (const key of ['text', 'transcript', 'fullText', 'full_text', 'content']) {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return v.trim().split(/\n+/).map((x) => x.trim()).filter(Boolean);
  }
  for (const key of ['segments', 'transcript', 'content', 'snippets', 'lines', 'results', 'items', 'data']) {
    const v = body[key];
    if (Array.isArray(v)) { const lines = clean(v); if (lines.length) return lines; }
  }
  return [];
}

/** The key, carried the way the service asks for it. Most want it raw in a header of their own; one
 *  that wants `Authorization: Bearer <key>` names the header and the prefix, and the space between
 *  them is added here rather than hidden in a setting's trailing blank. */
function transcriptHeaders() {
  const prefix = String(config.transcriptPrefix || '').trim();
  const key = String(config.transcriptKey || '').trim();
  const headers = { accept: 'application/json' };
  headers[String(config.transcriptHeader || 'x-api-key').toLowerCase()] = prefix ? `${prefix} ${key}` : key;
  return headers;
}

/** What a service said went wrong, in its own words: its code and its sentence, whichever it gave.
 *  This is for the operator's failure record, so it never carries the key. */
function serviceReason(body) {
  if (!body || typeof body !== 'object') return '';
  const code = typeof body.error === 'string' ? body.error : (body.error?.error || '');
  const said = typeof body.message === 'string' ? body.message : (body.error?.message || '');
  return [code, said].filter(Boolean).join(': ').slice(0, 90);
}

/** One question to the service. Its answer is the words, a job, or a reason. */
async function askOnce(address, signal) {
  const res = await siteRequest(await assertPublic(address), { headers: transcriptHeaders() }, signal);
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { /* not JSON */ }
  if (!res.ok) {
    // Services name the reason in the body. The reason is the operator's to see; the key never is.
    const reason = serviceReason(data);
    return { note: `the transcript service answered ${res.status}${reason ? ` (${reason})` : ''}` };
  }
  if (!data) return { note: 'the transcript service answered no JSON' };
  return { data };
}

/** The last door: a transcript service the operator has set. Silent when none is set. When the service
 *  answers with a job instead of the words, because it is making the transcript itself, the job is
 *  followed to its end; nothing here sets a time limit, and the reader stopping the run is what stops
 *  it, as everywhere else in the reader. The key is never in a note. */
async function askTranscriptService(id, videoUrl, signal) {
  const template = String(config.transcriptUrl || '').trim();
  if (!template || !String(config.transcriptKey || '').trim()) return { note: 'no transcript service is set' };
  const address = template.replace(/\{id\}/g, encodeURIComponent(id)).replace(/\{url\}/g, encodeURIComponent(videoUrl));

  const answer = await askOnce(address, signal);
  if (answer.note) return answer;

  const first = transcriptLines(answer.data);
  if (first.length) return { text: joinCaptionLines(first) };

  // A job: the service is making the transcript. Its result is read where the operator said it is.
  const jobId = answer.data?.jobId || answer.data?.job_id;
  if (!jobId) return { note: 'the transcript service returned no words' };
  const jobTemplate = String(config.transcriptJobUrl || '').trim();
  if (!jobTemplate) return { note: 'the transcript service is making the transcript, and no address was set to read the result' };
  const jobAddress = jobTemplate.replace(/\{jobId\}/g, encodeURIComponent(jobId));
  for (;;) {
    if (signal?.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, 2000));
    const job = await askOnce(jobAddress, signal);
    if (job.note) return job;
    const status = String(job.data?.status || '').toLowerCase();
    if (status === 'failed' || status === 'error') {
      const said = serviceReason(job.data);
      return { note: `the transcript service could not make the transcript${said ? ` (${said})` : ''}` };
    }
    const lines = transcriptLines(job.data);
    if (lines.length) return { text: joinCaptionLines(lines) };
    if (status === 'completed' || status === 'done') return { note: 'the transcript service finished with no words' };
  }
}

/** The video's own caption track, joined into readable lines. No summary, no invention. */
export async function youtubeTranscript(url, { signal } = {}) {
  const id = youtubeId(url);
  if (!id) throw new UrlError('url_not_youtube', 'That is not a YouTube video address.');
  const base = String(config.youtubeBase || 'https://www.youtube.com').replace(/\/$/, '');
  // The watch page: the title, author and date, and the page's own key for the player API.
  const { buf } = await get(`${base}/watch?v=${encodeURIComponent(id)}&hl=en`, { signal });
  const html = buf.toString('utf8');
  const title = decodeEntities(html.match(/<meta name="title" content="([^"]*)"/)?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/ - YouTube$/, '').trim();

  const unjson = (v) => { try { return JSON.parse(`"${v}"`); } catch { return v; } };
  const author = unjson(html.match(/"author":"((?:[^"\\]|\\.)*)"/)?.[1] || '') || decodeEntities(html.match(/<link itemprop="name" content="([^"]*)"/)?.[1] || '');
  const published = html.match(/"publishDate":"([^"]+)"/)?.[1] || html.match(/"uploadDate":"([^"]+)"/)?.[1] || html.match(/<meta itemprop="datePublished" content="([^"]*)"/)?.[1] || '';
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || '';
  const visitor = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || '';

  // Every door in turn, until one opens with captions. A door that opened on a video without captions
  // settles that the video has none; doors that all stayed shut are YouTube's wall for this address.
  const notes = [];
  let player = null;
  let opened = false;
  for (const name of config.youtubeClients) {
    const answer = await askDoor(base, id, key, visitor, name, signal);
    if (answer.player && !answer.note) { player = answer.player; break; }
    if (answer.player) opened = true;
    notes.push(answer.note);
  }
  if (!player) {
    // Every door of YouTube's own player is shut. The last door is a service the operator has set, if
    // any; when YouTube itself said the video has no captions, there is nothing for it to fetch.
    if (!opened) {
      let bought;
      try {
        bought = await askTranscriptService(id, `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        bought = { note: 'the transcript service could not be reached' };
      }
      if (bought.text) {
        return {
          kind: 'youtube',
          title: title || `YouTube video ${id}`,
          author,
          published: published.slice(0, 60),
          site: 'YouTube',
          text: bought.text.trim(),
          note: null,
          language: null,
          video: { id, embeddable: true, lengthSeconds: null, thumbnails: [] },
        };
      }
      notes.push(bought.note);
    }
    const e = opened ? new UrlError('url_no_transcript', NO_CAPTIONS) : new UrlError('url_video_wall', VIDEO_WALL);
    e.detail = notes.join(' · ');
    throw e;
  }
  const status = player.playabilityStatus || {};
  const details = player.videoDetails || {};
  const tracks = player.captions.playerCaptionsTracklistRenderer.captionTracks;
  const pick = tracks.find((tr) => /^en/i.test(tr.languageCode || '') && tr.kind !== 'asr')
    || tracks.find((tr) => /^en/i.test(tr.languageCode || ''))
    || tracks[0];

  const trackUrl = new URL(pick.baseUrl, base);
  trackUrl.searchParams.set('fmt', 'json3');
  const { buf: capBuf } = await get(trackUrl.toString(), { accept: 'application/json', signal });
  const lines = captionLines(capBuf.toString('utf8'));
  if (!lines.length) { const e = new UrlError('url_video_wall', VIDEO_WALL); e.detail = 'the caption track came back empty'; throw e; }
  const out = joinCaptionLines(lines);
  const auto = pick.kind === 'asr';
  const thumbnails = (details.thumbnail?.thumbnails || []).filter((t) => t && t.url).map((t) => ({ url: t.url, width: t.width || 0, height: t.height || 0 }));
  return {
    kind: 'youtube',
    title: details.title || title || `YouTube video ${id}`,
    author: details.author || author,
    published: published.slice(0, 60),
    site: 'YouTube',
    text: out.trim(),
    note: auto ? 'automatic_captions' : null,
    language: pick.languageCode || null,
    // For the page: the player when the owner allows embedding, else a thumbnail, in the picture's box.
    video: { id, embeddable: status.playableInEmbed !== false, lengthSeconds: Number(details.lengthSeconds) || null, thumbnails },
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

/** `google.com/url?q=…` carries its destination in the open, and Google answers a plain client with a
 *  notice page rather than a redirect, so the destination is read directly. No link is refused by its
 *  shape: every other link, a Google app link included, is tried like any other and read where it
 *  leads (Google resolves its own links for any client, as it does for a browser). */
export function unwrapRedirect(url) {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'google.com' || url.pathname !== '/url') return null;
  const target = url.searchParams.get('q') || url.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) return null;
  try { return new URL(target); } catch { return null; }
}

/** The address a page's markup sends the browser to (`<meta http-equiv="refresh" content="N;url=…">`),
 *  or null when the page has no such instruction. */
export function metaRefresh(html) {
  const head = String(html || '').slice(0, 64 * 1024);
  const tags = head.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/http-equiv\s*=\s*["']?\s*refresh\b/i.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = content ? (content[1] ?? content[2] ?? content[3] ?? '') : '';
    // The instruction is a number of seconds, then ";" or ",", then an optional "url=", then the address,
    // quoted or not. A number alone (a page that reloads itself) is no address.
    const target = value.match(/^\s*\d+\s*[;,]\s*(?:url\s*=\s*)?['"]?\s*([^'"]+?)\s*['"]?\s*$/i);
    if (target && target[1].trim()) return decodeEntities(target[1].trim());
  }
  return null;
}

/** A site remembered as silent answers at once, and is re-checked in the background. */
function assertNotSilent(url) {
  if (silentHosts.has(url.hostname)) { recheckSilent(url.hostname); throw siteError('url_silent', siteName(url)); }
}


export async function readUrl(rawUrl, { signal } = {}) {
  let url = normalizeUrl(rawUrl);
  url = unwrapRedirect(url) || url;
  assertNotSilent(url);

  if (youtubeId(url.toString())) {
    const t = await youtubeTranscript(url.toString(), { signal });
    return { ...t, url: url.toString() };
  }

  for (let hops = 0; ; hops++) {
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
      const html = buf.toString('utf8');
      const { title, text, author, published, site, notFree } = htmlToText(html);
      const name = site || siteName(finalUrl);
      const longest = Math.max(0, ...text.split(/\n\n+/).map((p) => p.trim().length));
      // A page with no paragraph of prose whose markup sends the browser elsewhere is a redirect
      // written in HTML, and is followed like one, within the same limit of hops.
      const onward = longest < 200 ? metaRefresh(html) : null;
      if (onward) {
        let next = null;
        try { next = new URL(onward, finalUrl); } catch { next = null; }
        if (next && /^https?:$/.test(next.protocol)) {
          if (hops >= 5) throw new UrlError('url_redirects', 'That address redirects too many times.');
          url = next;
          assertNotSilent(url);
          continue;
        }
      }
      // The site marks the article as not free (the schema.org flag Google News reads), or its prose
      // says so at the wall. When no paragraph of prose came, the wall kept the text: the paywall
      // sentence. When prose came, the text is returned marked (`wall`), and the reader decides whether
      // it is the whole article (the operator's rule of 19 September). Without a wall, a page with no
      // paragraph of prose is a shell built by scripts, not an article.
      const wall = notFree || WALL_PHRASES.test(text);
      if (!text || longest < 200) throw siteError(wall ? 'url_paywall' : 'url_shell', name);
      return { kind: 'page', title: title || finalUrl.hostname, author, published, site: name, text, url: finalUrl.toString(), note: null, wall };
    }

    if (type.startsWith('text/') || type.includes('json')) {
      return { kind: 'text', title: finalUrl.pathname.split('/').pop() || finalUrl.hostname, text: buf.toString('utf8').trim(), url: finalUrl.toString(), note: null };
    }

    throw new UrlError('url_not_text', `That address returned ${type || 'an unknown kind of file'}, which has no text to test.`);
  }
}
