// The prompt leak guard. Reads the prompts actually installed on this machine, then searches every
// file git tracks for any line of them. A single matching line is a failure: the prompts are the
// operator's intellectual property and no part of them, including section names, may ever be
// committed. Run by `npm run verify`, and on its own with `npm run leak-check`.
//
// This exists because example templates and a development mock once carried real lines of the
// prompts into the repository. A description of a prompt is allowed here; a line of one is not.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = ['extract', 'evaluate', 'challenge'];
const MIN_LEN = 25;  // shorter runs are ordinary English, not a fingerprint of the prompt
const WINDOW = 5;    // consecutive words per fragment

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

export function leakChecks() {
  const results = [];
  const files = trackedFiles();
  if (!files) return [{ name: 'prompt leak: no git checkout here, nothing to scan', ok: true, detail: '' }];

  // Whole lines are not enough: a truncated quote is still a quote. Every run of five consecutive
  // words from the prompt becomes a needle, so any fragment long enough to be a fingerprint is found.
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
  if (!needles.size) {
    return [{ name: 'prompt leak: no prompts installed here, so nothing to compare', ok: true, detail: '' }];
  }

  // One pass over the tracked files, then a second pass only if something matched.
  const bodies = [];
  for (const rel of files) {
    let body;
    try { body = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (body.includes('\0')) continue;
    bodies.push([rel, body.replace(/\s+/g, ' ')]);
  }
  const corpus = bodies.map(([, b]) => b).join('\n\u0000\n');
  const hits = [];
  for (const [frag, name] of needles) {
    if (!corpus.includes(frag)) continue;
    const where = bodies.filter(([, b]) => b.includes(frag)).map(([rel]) => rel);
    hits.push(`${where.join(', ')} carries ${name} prompt text: "${frag.slice(0, 70)}"`);
  }
  results.push({
    name: `no committed file contains any fragment of the prompts (${needles.size} fragments checked against ${bodies.length} tracked files)`,
    ok: hits.length === 0,
    detail: hits.slice(0, 8).join(' | '),
  });
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = leakChecks();
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ← ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? '\nFAILED. Prompt text is in a committed file. Remove it before pushing.' : '\nClean. No prompt text is in any committed file.');
  process.exit(failed ? 1 : 0);
}
