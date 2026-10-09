// The prompt vault. This is the only module that touches prompt text.
// Rules: prompts are read once at startup, kept in module scope, never logged,
// never serialised into any response, and never handed to the static file server.
//
// The prompts are sent to OpenAI VERBATIM. Nothing is prepended, appended, or injected.
// The claim is substituted for {{CLAIM}} exactly as extracted. The verdict is read out of
// the model's own Conclusion section afterwards, not requested by an added instruction.
//
// The chat prompt (8 October, in place of the challenge's) is the operator's text for the conversation under a
// fact-check (server/chat.js). It has three slots, and nothing else of it changes: {{INSPECTOR}}, the name the
// fact-check gave its inspector, so the model knows who it is; {{LETTER}}, that name's letter, so the operator's own
// words say how the model refers to itself ("Inspector {{LETTER}}"); and {{QUESTION}}, the reader's message, once.
// Everything above the line that holds {{QUESTION}} is the instructions, the same on every reply; that line and
// everything below it is the reader's message, with the reader's words in the slot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.join(here, 'prompts');
const NAMES = ['extract', 'evaluate', 'chat'];

function readSource(name) {
  const upper = name.toUpperCase();
  const inline = process.env[`CIVIC_PROMPT_${upper}`];
  if (inline && inline.trim()) return { text: inline, from: 'env' };

  const viaPath = process.env[`CIVIC_PROMPT_${upper}_FILE`];
  if (viaPath && fs.existsSync(viaPath)) return { text: fs.readFileSync(viaPath, 'utf8'), from: 'env-file' };

  const local = path.join(vaultDir, `${name}.txt`);
  if (fs.existsSync(local)) return { text: fs.readFileSync(local, 'utf8'), from: 'vault-file' };

  return null;
}

const vault = new Map();
for (const name of NAMES) {
  const src = readSource(name);
  if (src && src.text.trim()) vault.set(name, src.text.replace(/\r\n/g, '\n'));
}

if (vault.has('evaluate') && !vault.get('evaluate').includes('{{CLAIM}}')) {
  // Fail loudly at startup rather than silently testing nothing.
  console.error('[prompts] evaluate prompt is missing the {{CLAIM}} placeholder. Refusing to start.');
  process.exit(1);
}

/** Boolean status only — safe to send to the browser. */
export function promptStatus() {
  return Object.fromEntries(NAMES.map((n) => [n, vault.has(n)]));
}

export function hasPrompt(name) {
  return vault.has(name);
}

/**
 * A version mark for each installed prompt: the first eight hex digits of its SHA-256, and its
 * length. Neither says anything about the text; both say whether the prompt that is running is
 * the one that was meant to be, which is the question after a prompt is replaced.
 */
export function promptVersions() {
  const out = {};
  for (const name of NAMES) {
    if (!vault.has(name)) continue;
    const text = vault.get(name);
    out[name] = { version: crypto.createHash('sha256').update(text).digest('hex').slice(0, 8), chars: text.length };
  }
  return out;
}

/**
 * Where the extraction prompt takes the source. A prompt whose last line is written entirely in
 * square brackets marks that line as the place for the source: the prompt, with the source in
 * that place and nothing else changed, is sent as the only message. A prompt without such a line
 * is sent as the instructions, with the source as the only message.
 */
function sourceSlot(text) {
  const end = text.replace(/\s+$/, '').length;
  const start = text.lastIndexOf('\n', end - 1) + 1;
  return /^\[[^\[\]]+\]$/.test(text.slice(start, end)) ? { start, end } : null;
}

/** 'inserted' when the source goes inside the prompt; 'message' when it is sent beside it. */
export function extractionShape() {
  const prompt = vault.get('extract');
  return prompt && sourceSlot(prompt) ? 'inserted' : 'message';
}

/** The extraction request's prompt and source, arranged as the prompt itself asks. Verbatim either way. */
export function extractionRequest(source) {
  const prompt = vault.get('extract');
  const slot = sourceSlot(prompt);
  if (!slot) return { shape: 'message', instructions: prompt, message: source };
  return { shape: 'inserted', instructions: null, message: prompt.slice(0, slot.start) + source + prompt.slice(slot.end) };
}

/** Evaluation prompt with the claim substituted. Nothing else is changed. */
export function evaluationPrompt(claim) {
  return vault.get('evaluate').split('{{CLAIM}}').join(String(claim).trim());
}

// ---- the chat prompt ------------------------------------------------------------------------------------------------
const QUESTION = '{{QUESTION}}';

/** The chat prompt as two parts, split at the line that holds {{QUESTION}}, or why it cannot be used. */
const CHAT = (() => {
  const text = vault.get('chat');
  if (!text) return { ready: false, reason: 'missing' };
  const count = text.split(QUESTION).length - 1;
  if (count !== 1) return { ready: false, reason: count ? 'question_twice' : 'no_question', count };
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes(QUESTION));
  return { ready: true, reason: null, control: lines.slice(0, at).join('\n'), message: lines.slice(at).join('\n'),
    slots: { inspector: text.includes('{{INSPECTOR}}'), letter: text.includes('{{LETTER}}') } };
})();

/** Safe to report: whether the chat prompt can be used, why not, and which of its slots it uses. Never its text. */
export function chatPromptStatus() { return { ready: CHAT.ready, reason: CHAT.reason, slots: CHAT.slots || null }; }

const fillName = (s, { inspector, letter }) => s.split('{{INSPECTOR}}').join(String(inspector)).split('{{LETTER}}').join(String(letter));

/** The chat prompt's instructions (above its question line), the name and the letter in their slots. Nothing else changes. */
export function chatInstructions({ inspector, letter }) { return fillName(CHAT.control, { inspector, letter }); }

/** The chat prompt's message (its question line and what follows), the name and the letter in their slots, then the reader's words once. */
export function chatMessage({ inspector, letter, question }) { return fillName(CHAT.message, { inspector, letter }).split(QUESTION).join(String(question)); }

// ---- a conversation's reply, held to the prompts ---------------------------------------------------------------------
// The leak check's rule (scripts/leak-check.mjs): any run of five consecutive words of a prompt, 25 characters or more,
// is a fingerprint of it. Read here word by word, without Markdown's marks and in lower case, so a reply that repeats a
// prompt in bold, in capitals or across a line break is found all the same.
const WINDOW = 5;
const MIN_CHARS = 25;
const GAP = '[…]';
const wordOf = (w) => w.replace(/[*_`~]/g, '').toLowerCase();

function windowsOf(text) {
  const out = new Set();
  const words = String(text ?? '').split(/\s+/).map(wordOf).filter(Boolean);
  for (let i = 0; i + WINDOW <= words.length; i++) {
    const w = words.slice(i, i + WINDOW).join(' ');
    if (w.length >= MIN_CHARS) out.add(w);
  }
  return out;
}

let fingerprints = null;   // every prompt's runs of five words, made once: the prompts are read once
function promptFingerprints() {
  if (!fingerprints) {
    fingerprints = new Set();
    for (const name of NAMES) { const t = vault.get(name); if (t) for (const w of windowsOf(t)) fingerprints.add(w); }
  }
  return fingerprints;
}

/**
 * A reply of the conversation, with every run of five words that repeats a prompt held back: each stretch of such words
 * becomes one marked gap. Words the reader has already been shown (`shown`: the source, the claim, the fact-check's
 * answer, the conversation so far) are no secret and stay. Returns the text and how many gaps it has.
 */
export function holdBackPromptText(text, { shown = [] } = {}) {
  const raw = String(text ?? '');
  const prints = promptFingerprints();
  if (!raw || !prints.size) return { text: raw, held: 0 };
  const seen = new Set();
  for (const s of shown) for (const w of windowsOf(s)) seen.add(w);
  const tokens = [];
  for (const m of raw.matchAll(/\S+/g)) tokens.push({ start: m.index, end: m.index + m[0].length, w: wordOf(m[0]) });
  const words = tokens.map((t, k) => (t.w ? k : -1)).filter((k) => k >= 0);
  const marked = new Array(tokens.length).fill(false);
  for (let j = 0; j + WINDOW <= words.length; j++) {
    const w = words.slice(j, j + WINDOW).map((k) => tokens[k].w).join(' ');
    if (w.length >= MIN_CHARS && prints.has(w) && !seen.has(w)) for (let q = j; q < j + WINDOW; q++) marked[words[q]] = true;
  }
  let out = '';
  let last = 0;
  let held = 0;
  for (let k = 0; k < tokens.length; k++) {
    if (!marked[k]) continue;
    let e = k;
    while (e + 1 < tokens.length && marked[e + 1]) e++;
    out += raw.slice(last, tokens[k].start) + GAP;
    last = tokens[e].end;
    held++;
    k = e;
  }
  return { text: out + raw.slice(last), held };
}

/**
 * Removes prompt text from anything on its way out of this machine.
 *
 * An API can echo part of a request back inside an error message. That message is shown to the
 * reader, so without this a single unlucky 400 could put the prompt on the screen. Any run of five
 * consecutive words from a prompt is replaced.
 */
export function redactPrompts(text) {
  let out = String(text ?? '');
  if (!out) return out;
  for (const name of NAMES) {
    const prompt = vault.get(name);
    if (!prompt) continue;
    for (const line of prompt.split('\n')) {
      const words = line.trim().replace(/\s+/g, ' ').split(' ');
      for (let i = 0; i + 5 <= words.length; i++) {
        const frag = words.slice(i, i + 5).join(' ');
        if (frag.length >= 25 && out.includes(frag)) out = out.split(frag).join('[redacted prompt text]');
      }
    }
  }
  return out;
}

// Guard: make absolutely sure the process never prints prompt text by accident.
for (const name of NAMES) {
  const text = vault.get(name);
  if (!text) continue;
  const needle = text.slice(0, 40);
  const origError = console.error;
  console.error = (...args) => {
    const safe = args.map((a) => (typeof a === 'string' && a.includes(needle) ? '[redacted prompt text]' : a));
    origError(...safe);
  };
}
