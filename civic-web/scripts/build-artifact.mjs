// Builds a static, sample-data preview of the page (no server, no key) for publishing as a
// claude.ai Artifact or any static host. Output: <outDir>/index.html plus the referenced files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outDir = process.argv[2] || path.join(root, 'dist-preview');

const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)[1]
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
const body = html.match(/<body>([\s\S]*?)<\/body>/i)[1];
const page = `${head.trim()}\n<meta name="civic-mode" content="demo">\n${body.trim()}\n`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), page);

const copy = (rel, from = path.join(root, 'public', rel)) => {
  const to = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};
for (const f of fs.readdirSync(path.join(root, 'public', 'assets', 'fonts'))) copy(`assets/fonts/${f}`);
for (const rel of ['css/civic.css', 'css/fonts.css', 'js/app.js', 'js/api.js', 'js/demo.js', 'js/i18n.js', 'js/render.js']) copy(rel);
for (const f of fs.readdirSync(path.join(root, 'public', 'locales'))) copy(`locales/${f}`);
for (const f of fs.readdirSync(path.join(root, 'public', 'assets'))) if (f !== 'fonts') copy(`assets/${f}`);
copy('vendor/marked/marked.umd.js', path.join(root, 'node_modules', 'marked', 'lib', 'marked.umd.js'));
copy('vendor/dompurify/purify.min.js', path.join(root, 'node_modules', 'dompurify', 'dist', 'purify.min.js'));

console.log(`preview written to ${outDir}`);
