// The tell words (20 October): words that must never reach a reader, the operator's, kept where the prompts are kept:
// CIVIC_TELL_WORDS (JSON) or CIVIC_TELL_WORDS_FILE (a secret file holding it), never this repository. Two lists:
//
// {"anywhere": ["…"], "served": ["…"]}
//
// An `anywhere` word must appear nowhere: in the repository, its history, or what is sent to a reader. A `served` word
// may stand in the server's own code (a model's id, a service's name) and must never be sent to a reader. A plain list
// is `anywhere`. A word is found whatever its capitals and whole, never inside a longer word. A list that cannot be read
// stops the start, or the leak check, naming the key and never a word of it; a word found is named only by its
// fingerprint (the first 8 hex of the SHA-256 of the word in lower case), so no log, report or transcript carries it.
import crypto from 'node:crypto';
import fs from 'node:fs';

const fail = (why) => { throw new Error(`CIVIC_TELL_WORDS: ${why}`); };

/** A word's fingerprint, as findings name it. */
export const fingerprint = (word) => `#${crypto.createHash('sha256').update(String(word).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 8)}`;

function wordsOf(key, value) {
  if (!Array.isArray(value)) fail(`${key} must be a list of words`);
  const out = value.map((s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''));
  if (out.some((s) => !s)) fail(`${key} must hold no empty word`);
  return [...new Set(out)];
}

/** The lists in force, and the list's own fingerprint; null when none is set. */
export function loadTells(env = process.env) {
  let raw = String(env.CIVIC_TELL_WORDS || '').trim();
  const file = String(env.CIVIC_TELL_WORDS_FILE || '').trim();
  if (!raw && file) {
    try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { fail('the file could not be read'); }
  }
  if (!raw) return null;
  let set;
  try { set = JSON.parse(raw); } catch { fail('the list is not JSON'); }
  if (Array.isArray(set)) set = { anywhere: set };
  if (!set || typeof set !== 'object') fail('must be a list, or an object of anywhere and served');
  for (const key of Object.keys(set)) if (key !== 'anywhere' && key !== 'served') fail(`${key} is not a list FactEngine reads (anywhere, served)`);
  const anywhere = set.anywhere === undefined ? [] : wordsOf('anywhere', set.anywhere);
  const served = set.served === undefined ? [] : wordsOf('served', set.served);
  if (!anywhere.length && !served.length) fail('holds no word');
  return { anywhere, served, installed: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8) };
}

const EDGE0 = '(?<![\\p{L}\\p{N}_])';
const EDGE1 = '(?![\\p{L}\\p{N}_])';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');

/** A finder for these words: given a text, the fingerprints of the words in it, each once. One pass over the text. */
export function finder(words) {
  if (!words.length) return () => [];
  const byText = new Map(words.map((w) => [w.toLowerCase(), fingerprint(w)]));
  const re = new RegExp(`${EDGE0}(?:${[...words].sort((a, b) => b.length - a.length).map(escape).join('|')})${EDGE1}`, 'giu');
  return (text) => {
    const found = new Set();
    for (const m of String(text).matchAll(re)) found.add(byText.get(m[0].replace(/\s+/g, ' ').toLowerCase()) || fingerprint(m[0]));
    return [...found];
  };
}

// What the server found of the list in what a reader receives (server/index.js, at start-up), for /check; null when no
// list is set.
let report = null;
export const tellReport = () => report;
export function setTellReport(r) { report = r; }
