// The prompt vault. This is the only module that touches prompt text.
// Rules: prompts are read once at startup, kept in module scope, never logged,
// never serialised into any response, and never handed to the static file server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.join(here, 'prompts');
const NAMES = ['extract', 'evaluate', 'challenge'];

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

/** Extraction instructions (no placeholders). */
export function extractionInstructions() {
  return vault.get('extract');
}

/** Evaluation prompt with the claim substituted. */
export function evaluationPrompt(claim) {
  const template = vault.get('evaluate');
  return template.split('{{CLAIM}}').join(sanitizeClaim(claim));
}

/** Challenge prompt with all placeholders substituted. Only used once certified. */
export function challengePrompt({ claim, verdict, originalEntry, challenge }) {
  const template = vault.get('challenge');
  return template
    .split('{{CLAIM}}').join(sanitizeClaim(claim))
    .split('{{VERDICT}}').join(String(verdict || ''))
    .split('{{ORIGINAL_ENTRY}}').join(String(originalEntry || ''))
    .split('{{CHALLENGE}}').join(String(challenge || ''));
}

function sanitizeClaim(claim) {
  return String(claim).replace(/\s+/g, ' ').trim();
}

// Small developer-side addition so the verdict is machine-readable without altering the
// author's prompt. The tag line is stripped before the entry is shown to the reader.
export const VERDICT_TAG_INSTRUCTION =
  'Follow the user\'s instructions exactly and in full. After the final numbered section, ' +
  'add one last line on its own, exactly in this form and in English regardless of the language ' +
  'of the rest of your answer: "VERDICT: True" or "VERDICT: False" or "VERDICT: Unverified". ' +
  'Use "Unverified" whenever your conclusion is Uncertain, unknown, or cannot be established.';

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
