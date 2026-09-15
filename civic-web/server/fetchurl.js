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

const MAX_BYTES = 12 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

export class UrlError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400; }
}

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
      res = await fetch(url, {
        redirect: 'manual',
        signal: composite,
        headers: { 'user-agent': UA, accept: accept || 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8', 'accept-language': 'en,*;q=0.5' },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new UrlError('url_unreachable', `That address could not be reached: ${err?.message || 'no answer'}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublic(new URL(res.headers.get('location'), url).toString()); // every hop is checked
      continue;
    }
    break;
  }
  if (res.status === 401 || res.status === 403) {
    throw new UrlError('url_forbidden', `That page refused the request (${res.status}). It may require a sign-in.`);
  }
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

export function htmlToText(html) {
  let s = String(html);
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();

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

  return { title: decodeEntities(title), text };
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

export async function readUrl(rawUrl, { signal } = {}) {
  const url = normalizeUrl(rawUrl);

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
    const { title, text } = htmlToText(buf.toString('utf8'));
    if (!text) throw new UrlError('url_no_text', 'That page has no readable text. It may be built entirely by scripts.');
    return { kind: 'page', title: title || finalUrl.hostname, text, url: finalUrl.toString(), note: null };
  }

  if (type.startsWith('text/') || type.includes('json')) {
    return { kind: 'text', title: finalUrl.pathname.split('/').pop() || finalUrl.hostname, text: buf.toString('utf8').trim(), url: finalUrl.toString(), note: null };
  }

  throw new UrlError('url_not_text', `That address returned ${type || 'an unknown kind of file'}, which has no text to test.`);
}
