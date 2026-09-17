// CIVIC main-page server. Serves the page, keeps the prompts, and proxies the reader's own
// OpenAI key to OpenAI. Nothing under server/ is ever served as a static file.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { config, publicConfig, requestShape } from './config.js';
import { promptStatus, hasPrompt, promptVersions } from './prompts.js';
import { ApiError, operatorKey, describeError } from './openai.js';
import { openStream, activeStreams } from './stream.js';
import { fileToText, normalise, ACCEPTED_SOURCE_EXT } from './documents.js';
import { readUrl, UrlError } from './fetchurl.js';
import { sourceMeta, sourceBlock } from './source.js';
import { runExtraction } from './extract.js';
import { runEvaluation } from './evaluate.js';
import { runIllustration } from './illustrate.js';
import { runChallenge, ACCEPTED_CHALLENGE_EXT } from './challenge.js';
import { selftest } from './selftest.js';
import { whereTheShellSetsIt } from './key.js';
import { record as recordFailure } from './diagnostics.js';
import { buildStamp } from './build.js';
import { takeOverPort } from './port.js';
import { gate, sessionOf, required as signinRequired, codes as accessCodes, normalise as normaliseCode, issue, setCookie, clearCookie, recordSignin, recentSignins } from './access.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

// The version stamp covers the page and the server alike (see build.js). The page is served with
// no caching and its assets under /b/<stamp>/, so an updated CIVIC cannot be hidden behind a
// browser's copy of yesterday's JavaScript. This mattered: the page and its code were once served
// with an hour of caching and no version in their addresses, so a reader who had visited before
// kept running the old code after an update and saw a fixed fault again.
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

// The door (server/access.js): with CIVIC_ACCESS_CODES set, every API route but the health line
// and the sign-in itself needs the cookie a listed code earns.
app.use(gate);

// ---- API ---------------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  const session = sessionOf(req);
  res.json({
    ok: true, build: BUILD, ...publicConfig(promptStatus()), readUrl: true, acceptedSourceExt: ACCEPTED_SOURCE_EXT, acceptedChallengeExt: ACCEPTED_CHALLENGE_EXT,
    active: activeStreams(),                                            // runs in flight right now; an update waits for zero
    access: { required: signinRequired(), session: session ? { email: session.email } : null },
  });
});

// Sign-in by code. The code is the only thing checked; the email is kept with the sign-in.
app.post('/api/signin', (req, res) => {
  const email = String(req.body?.email || '').trim().slice(0, 254);
  const code = normaliseCode(req.body?.code);
  if (!signinRequired()) return res.json({ ok: true, required: false, session: { email } });
  if (!accessCodes().includes(code)) throw new ApiError(401, 'code_not_listed', 'That code is not on the list.');
  setCookie(req, res, issue(email, code));
  recordSignin(email, code);
  res.json({ ok: true, required: true, session: { email } });
});
app.post('/api/signout', (req, res) => { clearCookie(req, res); res.json({ ok: true }); });

// Is CIVIC able to work right now? Answered in plain language at /check, so a fault is never
// something a reader has to catch as a message disappears.
app.get('/api/selftest', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...await selftest({ apiKey: operatorKey({ optional: true }), build: BUILD }), signins: recentSignins(10), access: { required: signinRequired() } });
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
    await runExtraction({ apiKey, text: source.text, meta: sourceMeta(req.body?.source), send: stream.send, signal: stream.signal, sourceWarning });
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
  // The source the claims came from goes ahead of the prompt in every determination, exactly as
  // the extractor received it, so "the speech" has a speaker and a date when a claim is tested.
  const source = req.body?.text ? normalise(req.body.text) : null;
  const document = source && source.chars >= 20 ? sourceBlock(source.text, sourceMeta(req.body?.source)) : '';

  const stream = openStream(req, res);
  try {
    await runEvaluation({ apiKey, claims, document, send: stream.send, signal: stream.signal });
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

const server = http.createServer(app);

function banner() {
  const status = promptStatus();
  console.log(`CIVIC build ${BUILD} is running on http://localhost:${config.port}`);
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
  const v = promptVersions();
  const mark = (n) => (status[n] ? `${n} ${v[n].version} (${v[n].chars} chars)` : `${n} MISSING`);
  console.log(`prompts installed: ${mark('extract')} · ${mark('evaluate')} · challenge=${status.challenge}` + (config.challengeEnabled ? '' : ' (challenge API step withheld)'));
  const shape = requestShape();
  const placing = shape.extract.source === 'inserted' ? 'the prompt verbatim with the source in place of its final bracketed line, as the only message' : 'the prompt verbatim as instructions · the document whole as the only message';
  console.log(`extraction requests carry: model ${shape.extract.model} · reasoning.effort ${shape.extract.effort}${shape.extract.summary ? ` · reasoning.summary ${shape.extract.summary}` : ''} · web_search · ${placing} · nothing else${shape.extract.fallback ? '  (FALLBACK LIST SET)' : ''}`);
  console.log(`determination requests carry: model ${shape.evaluate.model} · reasoning.effort ${shape.evaluate.effort}${shape.evaluate.summary ? ` · reasoning.summary ${shape.evaluate.summary}` : ''} · web_search · the source as a message ahead of the prompt · the prompt verbatim with the claim's whole entry in its slot · nothing else${shape.evaluate.fallback ? '  (FALLBACK LIST SET)' : ''}`);
  if (config.openaiBaseUrl) console.log(`OpenAI base URL override: ${config.openaiBaseUrl}`);
}

// The launcher asks for the browser, and it is opened from here, once this CIVIC is actually
// answering. It used to be opened by the launcher on a timer, so when this CIVIC failed to start
// the browser opened on whatever was already on the port: the older CIVIC, with the older fault,
// which looked exactly like an update that had not taken.
function openBrowser() {
  if (process.env.CIVIC_OPEN_BROWSER !== '1') return;
  const url = `http://localhost:${config.port}/?fresh=${Date.now()}`;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* no way to open a browser here; the address is printed above */ }
}

server.on('listening', () => { banner(); openBrowser(); });

// The port is CIVIC's. If an older CIVIC still holds it, it is closed and the port taken over,
// so an update can never leave yesterday's process answering with today's files underneath it.
// Anything that is not a CIVIC is left alone and named, so the person can close it themselves.
let attempts = 0;
server.on('error', async (err) => {
  try {
    if (err?.code === 'EADDRINUSE' && attempts++ === 0) {
      const found = await takeOverPort(config.port, { appDir: path.join(here, '..') });
      if (found.closed.length) {
        console.log(`Closed an older CIVIC${found.build ? ` (build ${found.build})` : ''} that was still holding port ${config.port}.`);
        server.listen(config.port);
        return;
      }
      const lines = ['', `STOPPED: port ${config.port} is already in use, so this CIVIC did not start.`];
      if (found.unknown) lines.push('CIVIC could not find out by what. Close other programs, then start CIVIC again.');
      for (const f of found.foreign) lines.push(`It is in use by something that is not CIVIC: ${f.command || `process ${f.pid}`}${f.error ? ` (could not be closed: ${f.error})` : ''}.`);
      if (found.foreign.length) lines.push('Close that program, then start CIVIC again.');
      lines.push('');
      console.error(lines.join('\n'));
      process.exit(1);
    }
    if (err?.code === 'EADDRINUSE') {
      console.error(`\nSTOPPED: an older CIVIC holding port ${config.port} would not close. Close every CIVIC window, then start it again.\n`);
      process.exit(1);
    }
    console.error('[civic] server error', err?.code || err?.message || err);
    process.exit(1);
  } catch (inner) {
    console.error('[civic] could not start:', inner?.message || inner);
    process.exit(1);
  }
});

// Long reasoning runs can take many minutes; do not let Node cut the stream.
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;
server.keepAliveTimeout = 75 * 1000;

// A deploy, or the launcher closing an older copy, ends this process with SIGTERM. The listener
// closes at once, so the port is free for the next CIVIC; a stream still open finishes what it can
// within whatever grace the host gives; the process ends when the last connection closes.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
});

server.listen(config.port);
