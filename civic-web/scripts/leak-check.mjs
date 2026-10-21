// The prompt leak guard. Reads the prompts actually installed on this machine, then searches every
// file git tracks for any line of them. A single matching line is a failure: the prompts are the
// operator's intellectual property and no part of them, including section names, may ever be
// committed. Run by `npm run verify`, and on its own with `npm run leak-check`.
//
// This exists because example templates and a development mock once carried real lines of the
// prompts into the repository. A description of a prompt is allowed here; a line of one is not.
//
// Since 20 October it also reads the operator's tell words (server/tells.js): the `anywhere` ones must not be in any
// tracked file either. And it looks further when asked:
//   --history       every file and commit message the repository has held, on every branch and pull request, for the
//                   prompts' fragments and the `anywhere` words (run it where the prompts are installed);
//   --served        what a reader receives (server/assets.js), for every tell word and the prompts' fragments;
//   --fingerprints  each tell word's fingerprint, by its place in the list, and never the word.
// Whatever is found is named by where it is and by a fingerprint, never by its text.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTells, finder, fingerprint } from '../server/tells.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = ['extract', 'evaluate', 'rank'];   // rank: the second pass's prompt (16 October), when installed
const MIN_LEN = 25;  // shorter runs are ordinary English, not a fingerprint of the prompt
const WINDOW = 5;    // consecutive words per fragment

const fragmentPrint = (frag) => `#${crypto.createHash('sha256').update(frag).digest('hex').slice(0, 8)}`;

function installedPrompt(name) {
  const inline = process.env[`CIVIC_PROMPT_${name.toUpperCase()}`];
  if (inline) return inline;
  const viaPath = process.env[`CIVIC_PROMPT_${name.toUpperCase()}_FILE`];
  for (const f of [viaPath, path.join(root, 'server', 'prompts', `${name}.txt`)]) {
    if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return null;
}

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return null; } // not a git checkout (a deployed server, say): nothing to leak into
}

/**
 * The prompts' fragments, each a needle: whole lines are not enough, since a truncated quote is still a quote, so every
 * run of five consecutive words long enough to be a fingerprint is one. A map from the fragment to its prompt's name.
 */
export function promptNeedles() {
  const needles = new Map();
  for (const name of NAMES) {
    const text = installedPrompt(name);
    if (!text) continue;
    for (const raw of text.split('\n')) {
      const line = raw.trim().replace(/\s+/g, ' ');
      if (line.length < MIN_LEN) continue;
      const words = line.split(' ');
      for (let i = 0; i + WINDOW <= words.length; i++) {
        const frag = words.slice(i, i + WINDOW).join(' ');
        if (frag.length >= MIN_LEN && !needles.has(frag)) needles.set(frag, name);
      }
      if (words.length < WINDOW && line.length >= MIN_LEN && !needles.has(line)) needles.set(line, name);
    }
  }
  return needles;
}

/** Where each needle is found among the texts: [label, flattened text] pairs, one pass of each needle over all of them. */
function findNeedles(texts, needles) {
  const corpus = texts.map(([, t]) => t).join('\n\u0000\n');
  const starts = [];
  let at = 0;
  for (const [, t] of texts) { starts.push(at); at += t.length + 3; }
  const hits = [];
  for (const [frag, name] of needles) {
    for (let i = corpus.indexOf(frag); i >= 0; i = corpus.indexOf(frag, i + 1)) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
      hits.push({ label: texts[lo][0], what: `${name} prompt text (fragment ${fragmentPrint(frag)})` });
    }
  }
  return hits;
}

const gather = (hits) => {
  const by = new Map();
  for (const h of hits) { if (!by.has(h.what)) by.set(h.what, new Set()); by.get(h.what).add(h.label); }
  return [...by].map(([what, where]) => `${[...where].join(', ')} carries ${what}`);
};

export function leakChecks({ tells = loadTells() } = {}) {
  const results = [];
  const files = trackedFiles();
  if (!files) return [{ name: 'prompt leak: no git checkout here, nothing to scan', ok: true, detail: '' }];
  const bodies = [];
  for (const rel of files) {
    let body;
    try { body = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (body.includes('\0')) continue;
    bodies.push([rel, body.replace(/\s+/g, ' ')]);
  }

  const needles = promptNeedles();
  if (!needles.size) results.push({ name: 'prompt leak: no prompts installed here, so nothing to compare', ok: true, detail: '' });
  else {
    // Never the text itself: a report read in a terminal, a log or a chat would carry it on. Its fingerprint says which.
    const hits = gather(findNeedles(bodies, needles));
    results.push({
      name: `no committed file contains any fragment of the prompts (${needles.size} fragments checked against ${bodies.length} tracked files)`,
      ok: hits.length === 0,
      detail: hits.slice(0, 8).join(' | '),
    });
  }
  if (tells?.anywhere.length) {
    const find = finder(tells.anywhere);
    const hits = [];
    for (const [rel, body] of bodies) for (const fp of find(body)) hits.push({ label: rel, what: `a tell word (${fp})` });
    const lines = gather(hits);
    results.push({
      name: `no committed file carries a tell word that must appear nowhere (${tells.anywhere.length} words against ${bodies.length} tracked files)`,
      ok: lines.length === 0,
      detail: lines.slice(0, 8).join(' | '),
    });
  }
  return results;
}

/**
 * What a reader receives (server/assets.js: every file of the page but the operator's, and the reader's form of the
 * page), read for every tell word and every fragment of the prompts.
 */
export async function servedChecks({ tells = loadTells() } = {}) {
  const words = tells ? [...tells.anywhere, ...tells.served] : [];
  const needles = promptNeedles();
  if (!words.length && !needles.size) return [{ name: 'served: no tell words and no prompts here, so nothing to look for', ok: false, detail: 'Set CIVIC_TELL_WORDS (or CIVIC_TELL_WORDS_FILE) or install the prompts, then run it again.' }];
  const assets = await import('../server/assets.js');
  const { buildStamp } = await import('../server/build.js');
  const pairs = assets.readerTexts({ publicDir: path.join(root, 'public'), build: buildStamp() }).map(([label, text]) => [label, text.replace(/\s+/g, ' ')]);
  const hits = [];
  if (words.length) {
    const find = finder(words);
    for (const [label, text] of pairs) for (const fp of find(text)) hits.push({ label, what: `a tell word (${fp})` });
  }
  if (needles.size) hits.push(...findNeedles(pairs, needles));
  const lines = gather(hits);
  return [{
    name: `what a reader receives (${pairs.length} files) carries no tell word${needles.size ? ' and no fragment of the prompts' : ''} (${words.length} words${needles.size ? `, ${needles.size} fragments` : ''})`,
    ok: lines.length === 0,
    detail: lines.slice(0, 12).join(' | '),
  }];
}

/**
 * Every file and commit message the repository has held, on every branch and pull request: origin's are fetched into a
 * namespace of this check's own (refs/leak-check/), read once, and the namespace removed. Read for the prompts'
 * fragments and the `anywhere` words; each finding names the commits that hold it and the path, never the text.
 * `cwd` and `fetch` are for the guard, which proves it on a repository of its own making.
 */
export function historyChecks({ tells = loadTells(), cwd = root, fetch = true, needles = promptNeedles() } = {}) {
  const git = (args, opts = {}) => execFileSync('git', args, { cwd, maxBuffer: 2 ** 31 - 1, ...opts });
  try { git(['rev-parse', '--git-dir'], { stdio: 'ignore' }); } catch {
    return [{ name: 'history: this folder is not a git checkout, so its history cannot be read', ok: false, detail: 'Run it in a clone of the repository, with the prompts installed.' }];
  }
  const words = tells?.anywhere || [];
  if (!needles.size && !words.length) return [{ name: 'history: no prompts installed here and no tell words set, so nothing to look for', ok: false, detail: 'Install the prompts (server/prompts/, or CIVIC_PROMPT_*_FILE) or set CIVIC_TELL_WORDS, then run it again.' }];
  let reach = 'every branch and pull request';
  try {
    if (fetch) {
      try {
        git(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/*:refs/leak-check/heads/*', '+refs/pull/*/head:refs/leak-check/pull/*'], { stdio: 'ignore' });
      } catch { reach = 'the branches this copy already holds (origin could not be asked)'; }
    } else reach = 'the branches this copy holds';
    const paths = new Map();
    for (const line of git(['rev-list', '--objects', '--all'], { encoding: 'utf8' }).split('\n')) {
      const sp = line.indexOf(' ');
      if (sp > 0 && !paths.has(line.slice(0, sp))) paths.set(line.slice(0, sp), line.slice(sp + 1));
    }
    const out = git(['cat-file', '--batch-all-objects', '--unordered', '--batch']);
    const texts = [];
    let files = 0;
    let messages = 0;
    for (let i = 0; i < out.length;) {
      const nl = out.indexOf(10, i);
      const [sha, type, size] = out.subarray(i, nl).toString('utf8').split(' ');
      const body = out.subarray(nl + 1, nl + 1 + Number(size));
      i = nl + 1 + Number(size) + 1;
      if ((type !== 'blob' && type !== 'commit') || body.includes(0)) continue;
      let text = body.toString('utf8');
      if (type === 'commit') {
        const blank = text.indexOf('\n\n');
        text = blank >= 0 ? text.slice(blank + 2) : '';
        messages++;
        texts.push([`the message of commit ${sha.slice(0, 7)}`, text.replace(/\s+/g, ' '), sha, type]);
      } else {
        files++;
        texts.push([paths.has(sha) ? `${paths.get(sha)} (file ${sha.slice(0, 7)})` : `file ${sha.slice(0, 7)} (no branch reaches it)`, text.replace(/\s+/g, ' '), sha, type]);
      }
    }
    const results = [];
    // The commits that hold a file: three at most, enough to find it.
    const holders = (sha) => {
      try { return git(['log', '--all', '--format=%h', '-n', '3', `--find-object=${sha}`], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
    };
    const where = (label, sha, type) => (type === 'blob' ? `${label}, in commits ${holders(sha).join(', ') || '(none)'}` : label);
    const shaOf = new Map(texts.map(([label, , sha, type]) => [label, [sha, type]]));
    if (needles.size) {
      const hits = findNeedles(texts.map(([label, t]) => [label, t]), needles).map((h) => ({ ...h, label: where(h.label, ...shaOf.get(h.label)) }));
      const lines = gather(hits);
      results.push({ name: `history: no file or commit message on ${reach} (${files} files, ${messages} messages) carries a fragment of the prompts (${needles.size} fragments)`, ok: lines.length === 0, detail: lines.slice(0, 20).join(' | ') });
    }
    if (words.length) {
      const find = finder(words);
      const hits = [];
      for (const [label, text, sha, type] of texts) for (const fp of find(text)) hits.push({ label: where(label, sha, type), what: `a tell word (${fp})` });
      const lines = gather(hits);
      results.push({ name: `history: no file or commit message on ${reach} (${files} files, ${messages} messages) carries a tell word that must appear nowhere (${words.length} words)`, ok: lines.length === 0, detail: lines.slice(0, 20).join(' | ') });
    }
    return results;
  } finally {
    try {
      const refs = git(['for-each-ref', '--format=%(refname)', 'refs/leak-check/'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      if (refs.length) git(['update-ref', '--stdin'], { input: refs.map((r) => `delete ${r}\n`).join('') });
    } catch { /* the refs stay; they hold nothing origin does not already serve */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  let tells;
  try { tells = loadTells(); } catch (err) { console.log(`FAIL  ${err.message}`); process.exit(1); }
  if (args.has('--fingerprints')) {
    if (!tells) console.log('No tell words are set (CIVIC_TELL_WORDS or CIVIC_TELL_WORDS_FILE).');
    else for (const [list, words] of [['anywhere', tells.anywhere], ['served', tells.served]]) words.forEach((w, i) => console.log(`${list} ${i + 1}: ${fingerprint(w)}`));
    process.exit(0);
  }
  const results = [...leakChecks({ tells }), ...(args.has('--served') ? await servedChecks({ tells }) : []), ...(args.has('--history') ? historyChecks({ tells }) : [])];
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ← ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? '\nFAILED. Something that must not be there is, or could not be looked for: see above. Nothing found is printed but by its fingerprint.' : '\nClean. No prompt text and no tell word is where it must not be.');
  process.exit(failed ? 1 : 0);
}
