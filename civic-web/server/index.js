// CIVIC main-page server. Serves the page, keeps the prompts, and proxies the reader's own
// OpenAI key to OpenAI. Nothing under server/ is ever served as a static file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { config, publicConfig, requestShape } from './config.js';
import { promptStatus, hasPrompt } from './prompts.js';
import { ApiError, operatorKey, describeError } from './openai.js';
import { openStream } from './stream.js';
import { fileToText, normalise, ACCEPTED_SOURCE_EXT } from './documents.js';
import { readUrl, UrlError } from './fetchurl.js';
import { runExtraction } from './extract.js';
import { runEvaluation } from './evaluate.js';
import { runIllustration } from './illustrate.js';
import { runChallenge, ACCEPTED_CHALLENGE_EXT } from './challenge.js';
import { selftest } from './selftest.js';
import { whereTheShellSetsIt } from './key.js';
import { record as recordFailure } from './diagnostics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

// A stamp over every file that makes up the page. It changes whenever the front end changes, so an
// updated CIVIC cannot be hidden behind a browser's copy of yesterday's JavaScript. This mattered:
// the page and its code were once served with an hour of caching and no version in their addresses,
// so a reader who had visited before kept running the old code after an update and saw a fixed
// fault again. The stamp is shown on the page and in /api/health, so it is always clear which
// version is actually loaded.
function buildStamp() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'assets') walk(full); }
      else if (/\.(js|css|html)$/.test(entry.name)) files.push(full);
    }
  })(publicDir);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(path.relative(publicDir, f)).update(fs.readFileSync(f));
  return hash.digest('hex').slice(0, 12);
}
const BUILD = buildStamp();

// The page itself is never cached, and the addresses of its stylesheet and its entry script carry
// the stamp, so a new version is fetched the moment it exists.
// Every front-end file is served under /b/<stamp>/. Because a module's own imports resolve against
// its address, one versioned entry point carries the whole graph: js/api.js, js/render.js, the
// locales and the stylesheet all arrive at new addresses the moment anything changes. A version in
// a query string would not have done this — the inner imports would have kept their old addresses,
// and a browser holding yesterday's copy of one of them would go on running it.
const INDEX_HTML = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/(href=")(css\/[^"]+\.css")/g, `$1/b/${BUILD}/$2`)
  .replace(/(src=")(js\/app\.js")/g, `$1/b/${BUILD}/$2`);
function sendIndex(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(INDEX_HTML);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security headers. Scripts, styles and fonts are all our own files (fonts are self-hosted).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
      "img-src 'self' data: blob: https://oaidalleapiprodscus.blob.core.windows.net; " +
      "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

// Big enough to carry a whole document; no limit of ours applies unless CIVIC_MAX_SOURCE_CHARS is set.
app.use(express.json({ limit: '64mb' }));

// Vendor scripts for the browser (served read-only from node_modules).
const nodeModules = path.join(here, '..', 'node_modules');
app.use('/vendor/marked', express.static(path.join(nodeModules, 'marked', 'lib'), { immutable: true, maxAge: '7d' }));
app.use('/vendor/dompurify', express.static(path.join(nodeModules, 'dompurify', 'dist'), { immutable: true, maxAge: '7d' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: config.challengeMaxFiles + 1 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- API ---------------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, build: BUILD, ...publicConfig(promptStatus()), readUrl: true, acceptedSourceExt: ACCEPTED_SOURCE_EXT, acceptedChallengeExt: ACCEPTED_CHALLENGE_EXT });
});

// Is CIVIC able to work right now? Answered in plain language at /check, so a fault is never
// something a reader has to catch as a message disappears.
app.get('/api/selftest', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await selftest({ apiKey: operatorKey({ optional: true }), build: BUILD }));
}));

// The page reports its own failures here, so /check can show them afterwards.
app.post('/api/report', (req, res) => {
  const entry = recordFailure({
    where: `page:${req.body?.where || 'unknown'}`,
    code: req.body?.code,
    message: req.body?.message,
    detail: req.body?.detail,
    status: req.body?.status,
  });
  res.json({ recorded: entry.at });
});

app.post('/api/parse', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'no_file', 'No file received.');
  const parsed = await fileToText(req.file);
  if (!parsed.text) throw new ApiError(422, 'empty_document', 'No readable text was found in that file.');
  // The whole document is returned even when it is over the limit, so the reader can see all of
  // it and decide how to split it. /api/extract is where the refusal happens.
  res.json({ name: req.file.originalname, ...parsed });
}));

// Reading a link. The reader pastes a web address instead of text, and CIVIC fetches the page, the
// PDF or the video's caption track and hands back its words. Nothing is summarised or shortened:
// the source's own text comes back and appears in the box, so the reader sees what will be tested.
app.post('/api/read-url', wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) throw new ApiError(400, 'url_empty', 'No address was given.');
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const out = await readUrl(url, { signal: ac.signal });
    if (!out.text || out.text.length < 20) throw new ApiError(422, 'url_no_text', 'That address has almost no readable text.');
    res.json({ ...out, chars: out.text.length });
  } catch (err) {
    if (err instanceof UrlError) throw new ApiError(err.status || 400, err.code, err.message);
    throw err;
  }
}));

app.post('/api/extract', wrap(async (req, res) => {
  const apiKey = operatorKey();
  if (!hasPrompt('extract')) throw new ApiError(503, 'prompt_missing', 'The extraction prompt is not installed on this server.');
  const source = normalise(req.body?.text);
  if (source.chars < 20) throw new ApiError(400, 'too_short', 'Paste or upload more text; there is nothing to test yet.');

  // A document that does not fit is refused outright. Reading part of it and saying nothing would
  // drop claims the reader believes were tested.
  if (source.truncated && !config.allowSourceTruncation) {
    throw new ApiError(413, 'source_too_long',
      `This document is ${source.originalChars.toLocaleString()} characters; the limit for one run is ${config.maxSourceChars.toLocaleString()}. ` +
      `${source.omitted.toLocaleString()} characters would go unread, and any claim in them would never be tested. ` +
      'Split the document and run the parts, raise CIVIC_MAX_SOURCE_CHARS, or set CIVIC_ALLOW_SOURCE_TRUNCATION=true to accept the loss.');
  }
  const sourceWarning = source.truncated
    ? { code: 'source_truncated', omitted: source.omitted, read: source.chars, original: source.originalChars }
    : null;

  const stream = openStream(req, res);
  try {
    await runExtraction({ apiKey, text: source.text, send: stream.send, signal: stream.signal, sourceWarning });
  } catch (err) {
    const safe = describeError(err);
    stream.send({ t: 'error', code: safe.code, message: safe.message, status: safe.status });
  } finally {
    stream.close();
  }
}));

app.post('/api/evaluate', wrap(async (req, res) => {
  const apiKey = operatorKey();
  if (!hasPrompt('evaluate')) throw new ApiError(503, 'prompt_missing', 'The evaluation prompt is not installed on this server.');
  const claims = Array.isArray(req.body?.claims) ? req.body.claims.map((c) => String(c || '').trim()).filter(Boolean) : [];
  if (!claims.length) throw new ApiError(400, 'no_claims', 'No claims to test.');
  if (claims.length > config.maxClaims) throw new ApiError(400, 'too_many_claims', `At most ${config.maxClaims} claims can be tested in one run.`);

  const stream = openStream(req, res);
  try {
    await runEvaluation({ apiKey, claims, send: stream.send, signal: stream.signal });
  } catch (err) {
    const safe = describeError(err);
    stream.send({ t: 'error', code: safe.code, message: safe.message, status: safe.status });
  } finally {
    stream.close();
  }
}));

app.post('/api/illustrate', wrap(async (req, res) => {
  const apiKey = operatorKey();
  if (!config.illustrateEnabled) return res.json({ skipped: true });
  const text = String(req.body?.text || '').trim();
  if (text.length < 20) throw new ApiError(400, 'too_short', 'Nothing to illustrate.');
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const image = await runIllustration({ apiKey, text, signal: ac.signal });
    res.json(image || { skipped: true });
  } catch (err) {
    // The echo is optional; never let it break the run.
    const safe = describeError(err);
    res.json({ skipped: true, code: safe.code, message: safe.message });
  }
}));

app.post('/api/challenge', upload.array('files', config.challengeMaxFiles), wrap(async (req, res) => {
  const apiKey = operatorKey();
  const result = await runChallenge({
    apiKey,
    claim: req.body?.claim,
    verdict: req.body?.verdict,
    originalEntry: req.body?.originalEntry,
    message: req.body?.message,
    files: req.files || [],
  });
  res.json(result);
}));

// ---- Static site ---------------------------------------------------------------------------

app.get('/', sendIndex);
app.get('/index.html', sendIndex);
app.get('/check', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(publicDir, 'check.html')); });

// The stamped copy. These addresses change whenever the files do, so they are safe to keep forever.
app.use(`/b/${BUILD}`, express.static(publicDir, { index: false, immutable: true, maxAge: '365d' }));
// An address from an older stamp is not this build's; send the reader to the current page.
app.get(/^\/b\/[0-9a-f]{6,}\//, (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.redirect(302, '/'); });
app.use(express.static(publicDir, {
  index: false,
  extensions: ['html'],
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // Code is revalidated on every load; fonts and pictures never change, so they are kept.
    if (/\.(js|css|html)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  },
}));
app.get(/^\/(?!api\/).*/, sendIndex);

// ---- Errors --------------------------------------------------------------------------------

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: { code: err.code, message: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message } });
  }
  const safe = err instanceof ApiError ? err : describeError(err);
  recordFailure({ where: `server:${req.method} ${req.path}`, code: safe.code, message: safe.message, status: safe.status });
  if (!(err instanceof ApiError)) console.error('[civic]', safe.status, safe.code);
  res.status(safe.status || 500).json({ error: { code: safe.code, message: safe.message } });
});

// The banner waits a tick. Binding can report success and then fail, and a window that says CIVIC
// is running above a line saying it did not start is worse than saying nothing at all.
let startFailed = false;
const server = app.listen(config.port, () => setImmediate(() => {
  if (startFailed || !server.listening) return;
  const status = promptStatus();
  console.log(`CIVIC main page on http://localhost:${config.port}`);
  if (config.key?.conflict) {
    console.log('');
    console.log('NOTE: two different OpenAI keys were found, and CIVIC used the one in its own');
    console.log('      settings file, which is the rule. The other is set in this computer\'s');
    console.log('      environment and is being ignored. To remove it:  unset OPENAI_API_KEY');
    for (const at of whereTheShellSetsIt()) console.log(`      It is also set in ${at.file}, line ${at.line}.`);
    console.log('');
  }
  if (config.serverKey && !config.key?.usable) {
    const o = config.key?.offending;
    console.log('');
    console.log('STOP: the OpenAI key CIVIC has cannot be sent in a request at all, so every test');
    console.log(`      will fail. It came from ${config.key?.source}.`);
    if (o) console.log(`      Character ${o.index} of the key is ${JSON.stringify(o.char)}, which a request cannot carry.`);
    console.log('      A key copied from somewhere that shortened it for display ends this way.');
    console.log(`      Open http://localhost:${config.port}/check for what to do about it.`);
    console.log('');
  }
  console.log(`prompts installed: extract=${status.extract} evaluate=${status.evaluate} challenge=${status.challenge}` + (config.challengeEnabled ? '' : ' (challenge API step withheld)'));
  const shape = requestShape();
  console.log(`extraction requests carry: model ${shape.extract.model} · reasoning.effort ${shape.extract.effort}${shape.extract.summary ? ` · reasoning.summary ${shape.extract.summary}` : ''} · web_search · the prompt verbatim · the document whole · nothing else${shape.extract.fallback ? '  (FALLBACK LIST SET)' : ''}`);
  console.log(`determination requests carry: model ${shape.evaluate.model} · reasoning.effort ${shape.evaluate.effort}${shape.evaluate.summary ? ` · reasoning.summary ${shape.evaluate.summary}` : ''} · web_search · the prompt verbatim · nothing else${shape.evaluate.fallback ? '  (FALLBACK LIST SET)' : ''}`);
  if (config.openaiBaseUrl) console.log(`OpenAI base URL override: ${config.openaiBaseUrl}`);
}));
// Long reasoning runs can take many minutes; do not let Node cut the stream.
server.on('error', (err) => {
  startFailed = true;
  if (err?.code === 'EADDRINUSE') {
    console.error([
      '',
      `STOPPED: something is already using port ${config.port}, so this CIVIC did not start.`,
      'That is almost always an older CIVIC window still open. Close every CIVIC window,',
      'then start it again. Until you do, the page in your browser is served by the older one,',
      'which is why an update can look as though it did not take effect.',
      '',
    ].join('\n'));
    process.exit(1);
  }
  console.error('[civic] server error', err?.code || err?.message || err);
  process.exit(1);
});

server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;
server.keepAliveTimeout = 75 * 1000;
