// The page's own files as they are served (20 October): without their comments, which are written for whoever maintains
// FactEngine, and, for anyone but the operator, without the operator's parts of the page. Every other character is as
// written, so a script runs exactly as it was tested; a licence notice stays. A script is read by a JavaScript parser,
// which finds each comment where it really is (never inside a string, a template or a pattern); a style sheet and a page
// by a small reader of their own syntax. Each file is read once and kept until it changes on disk; one that cannot be
// read stops the start, naming it, and is never sent as written.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';

// A comment that is a licence notice is kept where it is (the fonts' attribution, css/fonts.css).
const NOTICE = /^\s*!|@license|@preserve|copyright|licen[cs]e/i;

// The classic scripts among the page's files: the worker js/field.js starts without type: 'module'. Every other script
// is a module.
export const CLASSIC = new Set(['js/field-worker.js']);
// The operator's files: the check page and its script, by their names under public/, in any spelling.
export const OPERATOR_ONLY = new Set(['check.html', 'js/check.js']);

const KINDS = { '.js': 'js', '.mjs': 'js', '.css': 'css', '.html': 'html' };
/** What a file is by its name: js, css or html; null for anything else (a font, a picture). */
export const kindOf = (name) => KINDS[path.extname(name).toLowerCase()] || null;

const lineOf = (src, at) => src.slice(0, at).split('\n').length;

/**
 * The text without the given comments: each one, and the whole of a line it stands alone on. Beside code, a comment goes
 * with the spaces before it; one that held a line break leaves one, so a statement that ended at that break still ends
 * there; one between two words leaves a space, so they stay two.
 */
function cut(src, comments) {
  let out = '';
  let at = 0;
  for (const c of comments) {
    let s = c.start;
    let e = c.end;
    const lineStart = src.lastIndexOf('\n', s - 1) + 1;
    const nl = src.indexOf('\n', e);
    const lineEnd = nl < 0 ? src.length : nl;
    const alone = lineStart >= at && /^[ \t]*$/.test(src.slice(lineStart, s)) && /^[ \t\r]*$/.test(src.slice(e, lineEnd));
    let between = '';
    if (alone) {
      s = lineStart;
      e = nl < 0 ? src.length : nl + 1;
    } else {
      while (s > at && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
      const next = src[e] ?? '';
      if (c.multiline) between = '\n';
      else if (c.block && s > lineStart && !/[\s;,)}\]]/.test(next)) between = ' ';
    }
    out += src.slice(at, s) + between;
    at = e;
  }
  return out + src.slice(at);
}

/** A script without its comments. `script` for a classic script; a module otherwise. */
export function stripScript(src, { script = false, where = 'a script' } = {}) {
  const comments = [];
  try {
    acorn.parse(src, {
      ecmaVersion: 'latest', sourceType: script ? 'script' : 'module', allowHashBang: true,
      onComment: (block, text, start, end) => {
        if (!NOTICE.test(text)) comments.push({ start, end, block, multiline: block && /[\n\r\u2028\u2029]/.test(text) });
      },
    });
  } catch (err) {
    throw new Error(`${where} could not be read as a ${script ? 'script' : 'module'}: ${err.message}`);
  }
  return cut(src, comments);
}

/** A style sheet without its comments; strings and unquoted url() values are passed over whole. */
export function stripStyle(src, { where = 'a style sheet' } = {}) {
  const comments = [];
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote || ch === '\n') quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; continue; }
    if ((ch === 'u' || ch === 'U') && /^url\(\s*[^\s"')]/i.test(src.slice(i, i + 6))) {
      const close = src.indexOf(')', i);
      i = close < 0 ? src.length : close;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new Error(`${where} has a comment that never closes (line ${lineOf(src, i)})`);
      if (!NOTICE.test(src.slice(i + 2, close))) comments.push({ start: i, end: close + 2, block: true, multiline: false });
      i = close + 1;
    }
  }
  return cut(src, comments);
}

// Elements whose text is not markup: a "<!--" inside them is not a comment.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** A comment's edit in a page: the whole line when it stands alone on it; else the comment alone, the text around it
 * untouched (a page's spaces are part of what it says). */
function pageEdit(src, start, end) {
  const lineStart = src.lastIndexOf('\n', start - 1) + 1;
  const nl = src.indexOf('\n', end);
  const lineEnd = nl < 0 ? src.length : nl;
  if (/^[ \t]*$/.test(src.slice(lineStart, start)) && /^[ \t\r]*$/.test(src.slice(end, lineEnd))) {
    return { start: lineStart, end: nl < 0 ? src.length : nl + 1, text: '' };
  }
  return { start, end, text: '' };
}

/**
 * A page without its comments. A comment alone on its line takes the line with it; one beside text goes alone. Tags are
 * read with their quoted values, so a "<!--" inside a value is not a comment; a style block's comments go as a style
 * sheet's do; the text of a title or a text area is left as it is. A script written inside a page, or a comment or a tag
 * that never closes, stops the reading: the page is never sent half read.
 */
export function stripPage(src, { where = 'a page' } = {}) {
  const edits = [];
  const TAG = /<(\/?)([A-Za-z][\w-]*)/y;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      // "<!-->" and "<!--->" are comments that close at once.
      const close = src.startsWith('>', lt + 4) ? lt + 2 : src.startsWith('->', lt + 4) ? lt + 3 : src.indexOf('-->', lt + 4);
      if (close < 0) throw new Error(`${where} has a comment that never closes (line ${lineOf(src, lt)})`);
      const end = close + 3;
      if (!NOTICE.test(src.slice(lt + 4, close))) edits.push(pageEdit(src, lt, end));
      i = end;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(src);
    if (!m) { i = lt + 1; continue; }
    let j = TAG.lastIndex;
    let quote = null;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) { if (ch === quote) quote = null; } else if (ch === '"' || ch === '\'') quote = ch; else if (ch === '>') break;
    }
    if (j >= src.length) throw new Error(`${where} has a tag that never closes (line ${lineOf(src, lt)})`);
    i = j + 1;
    const name = m[2].toLowerCase();
    if (m[1] || !RAW_TEXT.has(name)) continue;
    const endTag = new RegExp(`</${name}\\s*>`, 'gi');
    endTag.lastIndex = i;
    const em = endTag.exec(src);
    if (!em) throw new Error(`${where} has a <${name}> that never closes (line ${lineOf(src, lt)})`);
    const inner = src.slice(i, em.index);
    if (name === 'script' && inner.trim()) throw new Error(`${where} has a script written inside it (line ${lineOf(src, lt)}); the page's scripts are files of their own`);
    if (name === 'style') edits.push({ start: i, end: em.index, text: stripStyle(inner, { where: `${where}'s style block` }) });
    i = em.index + em[0].length;
  }
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += src.slice(at, Math.max(e.start, at)) + e.text;
    at = Math.max(at, e.end);
  }
  return out + src.slice(at);
}

/**
 * A page without the operator's parts: each begins with a line "<!--op-->" and ends with a line "<!--/op-->", both alone
 * on their lines, and goes with them. A mark beside anything else, one inside another part, or a part that never ends
 * stops the reading, naming the line.
 */
export function withoutOperatorParts(src, { where = 'a page' } = {}) {
  const out = [];
  let open = 0;
  src.split('\n').forEach((line, k) => {
    const opens = line.includes('<!--op-->');
    const closes = line.includes('<!--/op-->');
    if (!opens && !closes) { if (!open) out.push(line); return; }
    const t = line.trim();
    if (t !== '<!--op-->' && t !== '<!--/op-->') throw new Error(`${where}, line ${k + 1}: the operator's mark must stand alone on its line`);
    if (opens) {
      if (open) throw new Error(`${where}, line ${k + 1}: an operator's part begins inside the one begun on line ${open}`);
      open = k + 1;
    } else {
      if (!open) throw new Error(`${where}, line ${k + 1}: an operator's part ends that never began`);
      open = 0;
    }
  });
  if (open) throw new Error(`${where}, line ${open}: an operator's part never ends`);
  return out.join('\n');
}

/**
 * The page's stylesheets and entry script at the build's addresses (/b/<stamp>/…). Because a module's own imports resolve
 * against its address, one versioned entry point carries the whole graph: js/api.js, js/render.js, the locales and the
 * stylesheet all arrive at new addresses the moment anything changes.
 */
export function stampAddresses(html, build) {
  return html
    .replace(/(href=")(css\/[^"]+\.css")/g, `$1/b/${build}/$2`)
    .replace(/(src=")(js\/app\.js")/g, `$1/b/${build}/$2`);
}

/**
 * The file of the page an address names, read as the static server reads it: decoded, its dots resolved, an address
 * without an extension taken as a page (/terms is terms.html), this build's stamp taken off. Null for an address that
 * names no file under public/ (one that cannot be decoded, climbs out, or names a hidden file). `name` is in lower case,
 * so the operator's files are known on a disk that does not tell capitals apart.
 */
export function pageFileOf(urlPath, build) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  let rel = path.posix.normalize(`./${decoded}`);
  if (rel === '.' || rel === './' || rel.startsWith('../') || rel === '..') return null;
  let stamped = false;
  if (rel.startsWith(`b/${build}/`)) { rel = rel.slice(build.length + 3); stamped = true; }
  const trailing = rel.endsWith('/');
  rel = rel.replace(/\/+$/, '');
  if (!rel || rel.split('/').some((seg) => seg.startsWith('.'))) return null;
  if (!path.posix.extname(rel)) rel += '.html';
  const name = rel.toLowerCase();
  const gateName = name.replace(/^b\/[0-9a-f]{6,}\//, '');
  return { rel, name, kind: kindOf(rel), stamped, trailing, operatorOnly: OPERATOR_ONLY.has(gateName) };
}

const cache = new Map();

/**
 * A file of the page as it is served: its text without comments, as bytes, and an ETag of them; null when it is not a
 * script, a style sheet or a page, or does not exist. Kept until the file changes. `rel` is its name under public/.
 */
export function served(file, rel) {
  const kind = kindOf(file);
  if (!kind) return null;
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  const src = fs.readFileSync(file, 'utf8');
  const where = `public/${rel}`;
  const body = kind === 'css' ? stripStyle(src, { where })
    : kind === 'html' ? stripPage(src, { where })
      : stripScript(src, { script: CLASSIC.has(String(rel).toLowerCase()), where });
  const bytes = Buffer.from(body, 'utf8');
  const etag = `"${crypto.createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`;
  const entry = { kind, mtimeMs: stat.mtimeMs, size: stat.size, body, bytes, etag };
  cache.set(file, entry);
  return entry;
}

let pages = null;

/**
 * The page, as the operator receives it or as anyone else does: without comments, at the build's addresses; the reader's
 * without the operator's parts. Both are made when index.html is first read and again when it changes; a change that
 * cannot be read leaves the last pair in place, said in the log, and never sends the page as written.
 */
export function indexPage({ publicDir, build, operator }) {
  const file = path.join(publicDir, 'index.html');
  const stat = fs.statSync(file);
  if (!pages || pages.mtimeMs !== stat.mtimeMs || pages.size !== stat.size) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      const where = 'public/index.html';
      const reader = withoutOperatorParts(src, { where });
      pages = {
        mtimeMs: stat.mtimeMs, size: stat.size,
        operator: stampAddresses(stripPage(src, { where }), build),
        reader: stampAddresses(stripPage(reader, { where }), build),
      };
    } catch (err) {
      if (!pages) throw err;
      console.error(`[page] ${err.message}; the page as last read is served until it is put right`);
      pages = { ...pages, mtimeMs: stat.mtimeMs, size: stat.size };
    }
  }
  return operator ? pages.operator : pages.reader;
}

// Where each package's files are, under node_modules.
const VENDOR_ROOTS = { katex: ['katex', 'dist'], marked: ['marked', 'lib'], dompurify: ['dompurify', 'dist'] };

/**
 * The vendor files the pages load, and no others: every vendor/… address the pages name, and every file a vendor style
 * sheet names (KaTeX's fonts). A map from the address under /vendor ("/katex/katex.min.css") to the file, whose bytes
 * are served as shipped, licence notices and all. A page naming a file that is not installed stops the start.
 */
export function vendorFiles({ publicDir, nodeModules }) {
  const files = new Map();
  const add = (pkg, rel) => {
    const root = VENDOR_ROOTS[pkg];
    if (!root) throw new Error(`a page names vendor/${pkg}/${rel}, and FactEngine serves no package of that name`);
    const file = path.join(nodeModules, ...root, ...rel.split('/'));
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`a page names vendor/${pkg}/${rel}, which is not installed (npm install)`);
    files.set(`/${pkg}/${rel}`, file);
    return file;
  };
  for (const page of fs.readdirSync(publicDir).filter((f) => f.endsWith('.html')).sort()) {
    const html = stripPage(fs.readFileSync(path.join(publicDir, page), 'utf8'), { where: `public/${page}` });
    for (const m of html.matchAll(/(?:href|src)="vendor\/([a-z]+)\/([^"?#]+)"/g)) {
      const file = add(m[1], m[2]);
      if (!file.endsWith('.css')) continue;
      for (const u of fs.readFileSync(file, 'utf8').matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g)) {
        if (/^(?:[a-z][\w+.-]*:|\/|#)/i.test(u[1])) continue;
        add(m[1], path.posix.normalize(path.posix.join(path.posix.dirname(m[2]), u[1].split(/[?#]/)[0])));
      }
    }
  }
  return files;
}

/**
 * What a reader receives of the page's own, as [label, text] pairs: every file of the page but the operator's, as sent,
 * and the reader's form of the page. The vendor files are packages as published, not the operator's to word, and are
 * left out.
 */
export function readerTexts({ publicDir, build }) {
  const out = [];
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (r !== 'assets') walk(path.join(dir, d.name), r); continue; }
      if (r === 'index.html' || OPERATOR_ONLY.has(r.toLowerCase())) continue;
      const entry = served(path.join(dir, d.name), r);
      if (entry) out.push([`public/${r}`, entry.body]);
    }
  };
  walk(publicDir, '');
  out.push(['the page (a reader\'s form)', indexPage({ publicDir, build, operator: false })]);
  return out;
}

/** What a reader receives, read against the tell words (server/tells.js): each finding names the file and the word's
 * fingerprint, never the word. */
export function tellCheck({ publicDir, build, find }) {
  const texts = readerTexts({ publicDir, build });
  const findings = [];
  for (const [file, text] of texts) for (const fp of find(text)) findings.push({ file, fingerprint: fp });
  return { files: texts.length, findings };
}

/**
 * Everything the server will send of the page, read before the door opens: every script, style sheet and page under
 * public/ (assets/ holds fonts and pictures, sent as they are), both forms of the page, and the vendor files. Anything
 * that cannot be read throws, naming the file.
 */
export function prepare({ publicDir, build, nodeModules }) {
  let files = 0;
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (r !== 'assets') walk(path.join(dir, d.name), r); continue; }
      if (served(path.join(dir, d.name), r)) files++;
    }
  };
  walk(publicDir, '');
  indexPage({ publicDir, build, operator: false });
  const vendor = vendorFiles({ publicDir, nodeModules });
  return { files, vendor };
}
