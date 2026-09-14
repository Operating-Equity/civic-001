// CIVIC main-page server. Serves the page, keeps the prompts, and proxies the reader's own
// OpenAI key to OpenAI. Nothing under server/ is ever served as a static file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { config, publicConfig, atCeiling } from './config.js';
import { promptStatus, hasPrompt } from './prompts.js';
import { ApiError, keyFromRequest, describeError } from './openai.js';
import { openStream } from './stream.js';
import { fileToText, normalise, ACCEPTED_SOURCE_EXT } from './documents.js';
import { runExtraction } from './extract.js';
import { runEvaluation } from './evaluate.js';
import { runIllustration } from './illustrate.js';
import { runChallenge, ACCEPTED_CHALLENGE_EXT } from './challenge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

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

// Big enough to carry a whole document; the real ceiling is config.maxSourceChars.
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
  res.json({ ok: true, ...publicConfig(promptStatus()), acceptedSourceExt: ACCEPTED_SOURCE_EXT, acceptedChallengeExt: ACCEPTED_CHALLENGE_EXT });
});

app.post('/api/parse', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'no_file', 'No file received.');
  const parsed = await fileToText(req.file);
  if (!parsed.text) throw new ApiError(422, 'empty_document', 'No readable text was found in that file.');
  // The whole document is returned even when it is over the limit, so the reader can see all of
  // it and decide how to split it. /api/extract is where the refusal happens.
  res.json({ name: req.file.originalname, ...parsed });
}));

app.post('/api/extract', wrap(async (req, res) => {
  const apiKey = keyFromRequest(req);
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
  const apiKey = keyFromRequest(req);
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
  const apiKey = keyFromRequest(req);
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
  const apiKey = keyFromRequest(req);
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

app.use(express.static(publicDir, { extensions: ['html'], maxAge: '1h' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ---- Errors --------------------------------------------------------------------------------

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: { code: err.code, message: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message } });
  }
  const safe = err instanceof ApiError ? err : describeError(err);
  if (!(err instanceof ApiError)) console.error('[civic]', safe.status, safe.code);
  res.status(safe.status || 500).json({ error: { code: safe.code, message: safe.message } });
});

const server = app.listen(config.port, () => {
  const status = promptStatus();
  console.log(`CIVIC main page on http://localhost:${config.port}`);
  console.log(`prompts installed: extract=${status.extract} evaluate=${status.evaluate} challenge=${status.challenge}` + (config.challengeEnabled ? '' : ' (challenge API step withheld)'));
  const ceiling = atCeiling();
  console.log(ceiling.all
    ? `every determination setting is at the API ceiling: ${config.evalModels[0]} · effort ${config.evalEffort} · mode ${config.evalMode} · verbosity ${config.evalVerbosity} · search context ${config.evalSearchContext} · no caps · no fallback`
    : `BELOW CEILING: ${Object.entries(ceiling.checks).filter(([, ok]) => !ok).map(([k]) => k).join(', ')}  (set by the environment)`);
  if (config.openaiBaseUrl) console.log(`OpenAI base URL override: ${config.openaiBaseUrl}`);
});
// Long reasoning runs can take many minutes; do not let Node cut the stream.
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;
server.keepAliveTimeout = 75 * 1000;
