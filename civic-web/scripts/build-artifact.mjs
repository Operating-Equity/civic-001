// Builds the static front end (HTML, CSS, JS, fonts, images) for a CDN or object store, exactly as the server sends it to
// a reader (server/assets.js): every script, style sheet and page without its comments, the page without the operator's
// parts, the vendor files the page loads, and nothing that is the operator's alone. It still needs the CIVIC server for
// /api; there is no offline or sample mode.
// Output: <outDir>/index.html plus the referenced files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as assets from '../server/assets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const publicDir = path.join(root, 'public');
const outDir = process.argv[2] || path.join(root, 'dist-preview');

const write = (rel, data) => {
  const to = path.join(outDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, data);
};

// The page as a reader receives it, its addresses left relative (a CDN has no build stamp).
const where = 'public/index.html';
const html = assets.stripPage(assets.withoutOperatorParts(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), { where }), { where });
const head = html.match(/<head>([\s\S]*?)<\/head>/i)[1]
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
const body = html.match(/<body>([\s\S]*?)<\/body>/i)[1];
write('index.html', `${head.trim()}\n${body.trim()}\n`);

// Every other file of the page as it is sent; fonts and pictures as they are; the operator's files not at all.
const walk = (dir, rel) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { walk(path.join(dir, d.name), r); continue; }
    if (r === 'index.html' || assets.OPERATOR_ONLY.has(r.toLowerCase())) continue;
    const entry = assets.served(path.join(dir, d.name), r);
    write(r, entry ? entry.bytes : fs.readFileSync(path.join(dir, d.name)));
  }
};
walk(publicDir, '');
for (const [address, file] of assets.vendorFiles({ publicDir, nodeModules: path.join(root, 'node_modules') })) write(`vendor${address}`, fs.readFileSync(file));

console.log(`preview written to ${outDir}`);
