// The version stamp: one hash over everything that runs, the page and the server alike.
//
// It is shown in the page footer, on /check, in /api/health and in the Terminal window, and the
// installer is named after it, so which CIVIC is actually running is never a matter of belief.
// It once covered the front end only, for cache-busting; a change that touched only the server
// then produced a "new" CIVIC with the same stamp as the old one, and nobody could tell them apart.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, keep, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (keep.dir(entry.name)) walk(full, keep, out); }
    else if (keep.file(entry.name)) out.push(full);
  }
}

export function buildStamp() {
  const files = [];
  walk(path.join(root, 'public'), { dir: (n) => n !== 'assets', file: (n) => /\.(js|css|html)$/.test(n) }, files);
  // The prompt vault is never part of the stamp: it is not code, and it is not in the repository.
  walk(path.join(root, 'server'), { dir: (n) => n !== 'prompts', file: (n) => /\.js$/.test(n) }, files);
  files.push(path.join(root, 'package.json'));
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(path.relative(root, f)).update(fs.readFileSync(f));
  return hash.digest('hex').slice(0, 12);
}
