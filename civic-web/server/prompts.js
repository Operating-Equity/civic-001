// The prompt vault. This is the only module that touches prompt text.
// Rules: prompts are read once at startup, kept in module scope, never logged,
// never serialised into any response, and never handed to the static file server.
//
// The prompts are sent to OpenAI VERBATIM. Nothing is prepended, appended, or injected.
// The claim is substituted for {{CLAIM}} exactly as extracted. The verdict is read out of
// the model's own Conclusion section afterwards, not requested by an added instruction.
// The ranking prompt (`rank`, the second pass of 16 October, server/rank.js) has two slots, {{TITLE}} and {{CLAIMS}},
// filled the same way, and is optional: without it, or with its slots wrong, the claims are listed unranked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.join(here, 'prompts');
const NAMES = ['extract', 'evaluate', 'rank'];

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
 * Where the extraction prompt takes the source: its last line written entirely in square brackets, wherever that line
 * stands (24 October: a prompt may close its slot with a line after it). The prompt, with the source in that line's
 * place and nothing else changed, the lines after it included, is sent as the only message. A prompt without such a
 * line is sent as the instructions, with the source as the only message.
 */
export function sourceSlot(text) {
  let slot = null;
  for (const m of String(text ?? '').matchAll(/^\[[^\[\]\n]+\](?=[ \t]*$)/gm)) slot = { start: m.index, end: m.index + m[0].length };
  return slot;
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

const count = (text, slot) => text.split(slot).length - 1;

/**
 * Why the ranking prompt cannot be used, or null when it can. It must hold {{CLAIMS}} exactly once, where the numbered
 * claims go, and {{TITLE}} at most once, where the headline goes. A prompt that does not is never sent: the claims are
 * listed unranked, and /check says why. The server still starts (the ranking is optional; the other two prompts are not).
 */
export function rankingProblem() {
  const prompt = vault.get('rank');
  if (!prompt) return 'The ranking prompt is not installed (CIVIC_PROMPT_RANK_FILE, or server/prompts/rank.txt).';
  if (count(prompt, '{{CLAIMS}}') !== 1) return `The ranking prompt must hold {{CLAIMS}} exactly once, where the numbered claims go; it holds it ${count(prompt, '{{CLAIMS}}')} times.`;
  if (count(prompt, '{{TITLE}}') > 1) return `The ranking prompt may hold {{TITLE}} once at most, where the headline goes; it holds it ${count(prompt, '{{TITLE}}')} times.`;
  return null;
}

/**
 * The ranking prompt with its two slots filled: the headline as published (or the words saying none was given) and the
 * numbered claims. Both are filled in one pass, so a headline that happens to contain a slot's name stays as written.
 * Nothing else is changed.
 */
export function rankingPrompt({ title, claims }) {
  return vault.get('rank').replace(/\{\{(TITLE|CLAIMS)\}\}/g, (_, slot) => (slot === 'TITLE' ? String(title) : String(claims)));
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
