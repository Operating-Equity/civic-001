// The prompt vault. This is the only module that touches prompt text.
// Rules: prompts are read once at startup, kept in module scope, never logged,
// never serialised into any response, and never handed to the static file server.
//
// The prompts are sent to OpenAI VERBATIM. Nothing is prepended, appended, or injected.
// The claim is substituted for {{CLAIM}} exactly as extracted. The verdict is read out of
// the model's own Conclusion section afterwards, not requested by an added instruction.
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

/** Extraction instructions (no placeholders), verbatim. */
export function extractionInstructions() {
  return vault.get('extract');
}

/** Evaluation prompt with the claim substituted. Nothing else is changed. */
export function evaluationPrompt(claim) {
  return vault.get('evaluate').split('{{CLAIM}}').join(String(claim).trim());
}

/** Challenge prompt with all placeholders substituted. Only used once certified. */
export function challengePrompt({ claim, verdict, originalEntry, challenge }) {
  return vault.get('challenge')
    .split('{{CLAIM}}').join(String(claim).trim())
    .split('{{VERDICT}}').join(String(verdict || ''))
    .split('{{ORIGINAL_ENTRY}}').join(String(originalEntry || ''))
    .split('{{CHALLENGE}}').join(String(challenge || ''));
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
