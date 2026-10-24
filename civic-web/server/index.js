// FactEngine main-page server. Serves the page, keeps the prompts, and sends every model request on
// the operator's key (no reader ever holds one). Nothing under server/ is ever served as a static file.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { config, publicConfig, requestShape } from './config.js';
import { promptStatus, hasPrompt, promptVersions } from './prompts.js';
import { ApiError, operatorKey, describeError } from './openai.js';
import { readerView, readerError } from './view.js';
import { listingKey, onOwnProvider, onDeepSeek, listingHost, listingProviderName } from './listing.js';
import { openStream } from './stream.js';
import * as jobs from './jobs.js';
import { fileToText, normalise, ACCEPTED_SOURCE_EXT } from './documents.js';
import { readUrl, UrlError, isSingleUrl, normalizeUrl, unwrapRedirect, youtubeId, siteName } from './fetchurl.js';
import { findCopies, searchOn, readerOn, readerCopy } from './copies.js';
import { sourceMeta, sourceBlock } from './source.js';
import { runExtraction } from './extract.js';
import { runEvaluation } from './evaluate.js';
import { trialOf, trialState } from './trial.js';
import { rankFor, rankState } from './rank.js';
import * as deepseekProvider from './deepseek.js';
import * as geminiProvider from './gemini.js';
import { runIllustration } from './illustrate.js';
import { selftest } from './selftest.js';
import { whereTheShellSetsIt } from './key.js';
import { record as recordFailure } from './diagnostics.js';
import { buildStamp } from './build.js';
import { takeOverPort } from './port.js';
import { gate, required as signinRequired, isOperator, sessionOf } from './access.js';
import * as accounts from './accounts.js';
import * as credit from './credit.js';
import { mountAccountRoutes } from './account-routes.js';
import { dbOn, migrate } from './db.js';
import { registry } from './tools/index.js';
import { mountGateway } from './tools/gateway.js';
import * as economics from './economics.js';
import * as assets from './assets.js';
import { loadTells, finder, tellReport, setTellReport } from './tells.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const nodeModules = path.join(here, '..', 'node_modules');

// The version stamp covers the page and the server alike (see build.js). The page is served with
// no caching and its assets under /b/<stamp>/, so an updated FactEngine cannot be hidden behind a
// browser's copy of yesterday's JavaScript. This mattered: the page and its code were once served
// with an hour of caching and no version in their addresses, so a reader who had visited before
// kept running the old code after an update and saw a fixed fault again.
const BUILD = buildStamp();

// The page itself is never cached, and the addresses of its stylesheet and its entry script carry
// the stamp, so a new version is fetched the moment it exists (server/assets.js, stampAddresses). A
// version in a query string would not have done this: the inner imports would have kept their old
// addresses, and a browser holding yesterday's copy of one of them would go on running it.
//
// What the server sends of the page (server/assets.js, 20 October): every script, style sheet and page
// without its comments, the page in the operator's form or a reader's, and the vendor files the pages
// load. All of it is read here, before the door opens: a file that cannot be read stops the start,
// naming it.
let pageFiles;
let tells;
try {
  pageFiles = assets.prepare({ publicDir, build: BUILD, nodeModules });
  tells = loadTells();   // the operator's tell words (server/tells.js); a list that cannot be read stops the start
} catch (err) {
  console.error(`\nSTOPPED: ${err?.message || err}, so this FactEngine did not start.\n`);
  process.exit(1);
}
const vendorFiles = pageFiles.vendor;
// The tell words (server/tells.js): what a reader receives is read against the operator's list here, and what is found
// is named on /check and in the host's log by its fingerprint, never by the word. A finding does not stop the start.
if (tells) {
  setTellReport({ installed: tells.installed, words: tells.anywhere.length + tells.served.length,
    ...assets.tellCheck({ publicDir, build: BUILD, find: finder([...tells.anywhere, ...tells.served]) }) });
}

// Whose page it is: the operator's form for the operator, and for everyone on an open door (CIVIC_ACCOUNTS=off), as
// before; a reader's for anyone else. A session that cannot be read gets a reader's page.
async function operatorHere(req) {
  if (!signinRequired()) return true;
  try {
    return isOperator(await sessionOf(req));
  } catch (err) {
    console.error('[accounts] a session could not be read for a page:', err?.message || err);
    return false;
  }
}
async function sendIndex(req, res, next) {
  try {
    const page = assets.indexPage({ publicDir, build: BUILD, operator: await operatorHere(req) });
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(page);
  } catch (err) {
    next(err);
  }
}
const notFound = (res) => res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// Routes match their case exactly. Express matches them regardless of case unless told otherwise,
// and the door (server/access.js) once compared the path in lower case: /API/extract reached the
// handler and never met the gate. Now it is nobody's route.
app.set('case sensitive routing', true);

// Security headers. Scripts, styles and fonts are all our own files (fonts are self-hosted). The echo's picture comes as
// a data: address (server/illustrate.js); were it to come back by the image service's own address, that host goes back
// into img-src with it.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
      "img-src 'self' data: blob: https://*.ytimg.com; " +
      "frame-src https://www.youtube-nocookie.com; " + // the player of a video under test, and its thumbnail above
      "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

// The door (server/access.js), before any body is read: a request without a session is refused on its headers alone, so
// nobody without an account can make this instance read 64 MB. The account's own doors take a small body of their own.
app.use('/api/account', express.json({ limit: '16kb' }));
app.use('/api/operator', express.json({ limit: '16kb' }));
app.use('/api', gate);

// Big enough to carry a whole document; no limit of ours applies unless CIVIC_MAX_SOURCE_CHARS is set.
app.use(express.json({ limit: '64mb' }));

// Vendor scripts for the browser, read-only from node_modules: the files the pages load and no others (server/assets.js),
// each as shipped, licence notices and all. KaTeX typesets the formulas the model writes, and its fonts come from here
// too. Anything else under /vendor, a source map included, is not found.
app.use('/vendor', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = vendorFiles.get(req.path);
  if (!file) return notFound(res);
  res.sendFile(file, { maxAge: '7d', immutable: true }, (err) => { if (err && !res.headersSent) next(err); });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },   // one source file at a time, read to text
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// What a determination's row remembers of the claim it was asked about (server/economics.js): its SHA-256, never its text.
const fingerprintOf = (claim) => crypto.createHash('sha256').update(String(claim)).digest('hex');

// FactEngine's tools for the model (server/tools): the gateway answers a provider's servers, OpenAI's with the pass
// (CIVIC_TOOLS_PASS) and Fireworks' through a listing's own door (tools/doors.js), so it sits outside the sign-in
// gate; with neither a pass set nor a door open, it answers no one.
mountGateway(app, { registry, pass: config.toolsPass, version: BUILD });

// Whose work a job is: the account that started it, or nobody's on an open door (CIVIC_ACCOUNTS=off). A page attaches
// to, stops and lets go of its own jobs and no others.
const ownerOf = (req) => (req.account?.user ? `u:${req.account.user.id}` : null);
// Who sees the whole of the work: the operator, and anyone on an open door. Everyone else sees their run through the
// reader's view (server/view.js): every output, under the operator's names, and never what it costs FactEngine.
const seesAll = (req) => !signinRequired() || isOperator(req.account);
const viewFor = (req) => (seesAll(req) ? null : readerView());
// With accounts on, the books must be readable for anything to be held or run: a wait, never a free test.
const booksWait = () => Object.assign(new ApiError(503, 'books_wait', 'FactEngine is waiting for its records. It will go on by itself.'), { expected: true });
// Requests for one determination's id that arrive together: the second waits for the first's opening, then joins its job.
const opening = new Map();

// ---- API ---------------------------------------------------------------------------------

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

app.get('/api/health', wrap(async (req, res) => {
  const session = signinRequired() ? req.account || null : null;
  const balanceCents = session ? await credit.balanceOf(session.user.id).catch(() => null) : null;
  // What the page shows of the prices (server/economics.js): the tier, the free count, the price and
  // the operator's note. Never a cost. Null when pricing is off, or when it cannot be read just now.
  const pricing = await economics.publicState().catch((err) => { console.error('[economics] the price could not be read:', err.message); return null; });
  const all = !signinRequired() || isOperator(session);
  const access = {
    required: signinRequired(),
    session: session ? { email: session.user.email, operator: isOperator(session), balanceCents, monthlyLimitCents: session.user.monthlyLimitCents } : null,
    grantCents: config.signupGrantCents, minChars: config.passwordMinChars, currency: config.currency,
  };
  const active = jobs.active();   // runs in flight right now, whatever their connections are doing; an update waits for zero
  // Anyone but the operator is told what the page needs and nothing of how the work is done (server/view.js).
  if (!all) {
    const p = promptStatus();
    res.json({
      ok: true, build: BUILD, active, ...pick(publicConfig(p), ['maxClaims', 'autoTestFirst', 'inFlight', 'heartbeatMs', 'findCopies']), readUrl: true,
      prompts: { extract: Boolean(p.extract), evaluate: Boolean(p.evaluate) }, access, accounting: false, pricing, trial: null,
    });
    return;
  }
  res.json({
    ok: true, build: BUILD, ...publicConfig(promptStatus()), readUrl: true, acceptedSourceExt: ACCEPTED_SOURCE_EXT,
    active, access,
    accounting: config.accounting,   // FactEngine's own costs: the operator's alone
    pricing,
    // The operator's trial (server/trial.js): the models they may choose on the page, and whether it can run. Nobody else's.
    trial: trialState(),
  });
}));

// Accounts: sign up, sign in, sign out, a reset link, the operator's link, the account's page and the operator's tools
// (server/account-routes.js).
mountAccountRoutes(app, { wrap });

// Is FactEngine able to work right now? Answered in plain language at /check, so a fault is never
// something a reader has to catch as a message disappears.
app.get('/api/selftest', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // The check page is the operator's (5 October: once anyone can make an account, the key's source, the minute budget
  // and FactEngine's costs are nobody else's business). On an open door (CIVIC_ACCOUNTS=off) it is everyone's, as before.
  const operator = !signinRequired() || isOperator(req.account);
  if (!operator) throw Object.assign(new ApiError(403, 'operator_only', 'That is for the operator\'s account.'), { expected: true });
  // The measurement (server/economics.js) is the operator's alone: the price and what it came from, the
  // tier clock, the guard, and the money per tier, per user and per window.
  const economy = operator && economics.enabled() ? await economics.report().catch((err) => ({ error: err.message })) : null;
  res.json({ ...await selftest({ apiKey: operatorKey({ optional: true }), build: BUILD, operator }), access: { required: signinRequired(), operator, store: dbOn() ? 'postgres' : 'memory' }, economics: economy });
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

// Reading a link. The reader pastes a web address instead of text, and FactEngine fetches the page, the
// PDF or the video's caption track and hands back its words. Nothing is summarised or shortened:
// the source's own text comes back and appears in the box, so the reader sees what will be tested.
// A link, read in this order (the operator's words of 19 October: "If the server-side or service used can be set to
// 'reader' on failure and it works, that's what I care about"; "keep the current fallback as the third fallback. I want
// maximum user convenience and minimal failure to return results"):
//   1. FactEngine's own reader (server/fetchurl.js);
//   2. when that fails on a public web page, the search service's reader asked for the same address (server/copies.js):
//      refused, silent, built by scripts, unreachable, redirected too often, any other status, almost no text, or a
//      paywall. A page judged a paywall comes back marked, so it goes into the box and the reader decides whether it is
//      the whole article (the operator's answer of 21 October, after an ms.now column was judged one and never asked
//      for: "Yes, marked for the reader"; their rule of 19 September for a marked page). Never an address that is not a
//      public web page, never a file too large or not text, never YouTube's own (its transcript has its own doors);
//   3. FactEngine's own failure, as before, so the page goes on to its copies or its sentence.
const READER_AFTER = new Set(['url_refused', 'url_silent', 'url_shell', 'url_unreachable', 'url_redirects', 'url_status', 'url_no_text', 'url_paywall']);
const isYoutube = (u) => { try { return Boolean(u && youtubeId(u)); } catch { return false; } };
const askedPage = (raw) => { try { const u = normalizeUrl(raw); return (unwrapRedirect(u) || u).toString(); } catch { return ''; } };
// One line in the host's log for each link read (the operator's answer of 21 October): its site, and what each way of
// reading it did, so a link that failed can be explained afterwards. Never the address's path, nor any of its text.
const siteOf = (raw) => { try { return siteName(new URL(askedPage(raw) || raw)); } catch { return 'an address that is not a web address'; } };
const readLine = (raw, steps) => console.log(`[read] ${siteOf(raw)}: ${steps.join(' → ')}`);
const readerSaid = (r) => (r?.ok ? `the search service's reader read it (${[r.from, `${r.chars} characters`].filter(Boolean).join(', ')})`
  : `the search service's reader could not (${r?.why || 'no answer'})`);
app.post('/api/read-url', wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) throw new ApiError(400, 'url_empty', 'No address was given.');
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let address = null;   // the page the first read was about, for the reader, when it read one with almost no text
  try {
    const out = await readUrl(url, { signal: ac.signal });
    if (!out.text || out.text.length < 20) { address = out.url || null; throw new ApiError(422, 'url_no_text', 'That address has almost no readable text.'); }
    readLine(url, [`FactEngine's reader read it (${out.text.length} characters${out.wall ? ', marked' : ''})`]);
    res.json({ ...out, chars: out.text.length });
  } catch (err) {
    if (ac.signal.aborted) return; // the page has gone (reloaded, or stopped): nothing failed
    const steps = [`FactEngine's reader: ${err?.code || 'failed'}${err?.detail ? ` (${err.detail})` : ''}`];
    // The failures only a page's own address carries (`url` on the error, set by server/fetchurl.js) are the reader's;
    // a private or non-web address never carries one, so it is never handed on.
    const at = err?.url || address;
    if (READER_AFTER.has(err?.code) && at && readerOn() && !isYoutube(at) && !isYoutube(askedPage(url))) {
      let said = null;
      const copy = await readerCopy(at, { signal: ac.signal, explain: (r) => { said = r; } }).catch((e) => {
        if (!ac.signal.aborted) recordFailure({ where: 'server:reader', code: 'reader_failed', message: 'The search service\'s reader could not be asked.', detail: e?.message || null });
        said = { ok: false, why: e?.message || 'could not be asked' };
        return null;
      });
      if (ac.signal.aborted) return;
      steps.push(readerSaid(said));
      if (copy) {
        const page = err?.code === 'url_paywall' ? { ...copy, wall: true } : copy;
        readLine(url, page.wall ? [...steps.slice(0, -1), `${steps.at(-1)}, marked`] : steps);
        res.json({ ...page, chars: page.text.length });
        return;
      }
    } else {
      steps.push(`not handed on (${!READER_AFTER.has(err?.code) ? 'not a failure the search service\'s reader is asked for' : !readerOn() ? 'the search service\'s reader is off' : !at ? 'not a public web page' : 'a YouTube address'})`);
    }
    readLine(url, steps);
    if (err instanceof UrlError) { const e = new ApiError(err.status || 400, err.code, err.message); e.detail = err.detail || null; e.site = err.site || null; throw e; }
    throw err;
  }
}));

// A link a site refused, looked for elsewhere: the same article republished, and other reports of the
// same story, for the reader to pick from (server/copies.js). Asked by the page only when the search
// service is set (/api/health findCopies); the search's own failures are notes on /check, and the reader
// then has today's sentence and nothing else.
app.post('/api/find-copies', wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!searchOn()) throw new ApiError(409, 'search_off', 'No search service is set.');
  if (!isSingleUrl(url)) throw new ApiError(400, 'url_empty', 'No address was given.');
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    // The third way of reading a link, in the host's log beside the first two (readLine): its site and what came of it.
    // The search's own words (`notes`) go to the log alone; the page has its copies.
    const { notes, ...found } = await findCopies(url, { signal: ac.signal });
    console.log(`[copies] ${siteOf(url)}: ${found.copies.length} found${notes?.length ? ` (${notes.join('; ')})` : ''}`);
    res.json(found);
  } catch (err) {
    if (ac.signal.aborted) return; // the page has gone, or the reader moved on: nothing failed
    if (err instanceof UrlError) throw new ApiError(err.status || 400, err.code, err.message);
    throw err;
  }
}));

// /check's Try a link (21 October, the operator's alone: /api/operator/ is theirs at the door): every way FactEngine
// reads one address, each told in a few words, without starting a run and without any of the text. The search service's
// reader and its search are asked once each whatever FactEngine's own reader managed, so what each would do is seen.
app.post('/api/operator/try-link', wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!isSingleUrl(url)) throw new ApiError(400, 'url_empty', 'No address was given.');
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const out = { site: siteOf(url), own: null, reader: null, copies: null };
  let at = null;
  try {
    const got = await readUrl(url, { signal: ac.signal });
    out.own = { ok: Boolean(got.text && got.text.length >= 20), chars: got.text?.length || 0, wall: Boolean(got.wall), kind: got.kind || 'page' };
    at = got.kind === 'youtube' ? null : got.url || null;
  } catch (err) {
    if (ac.signal.aborted) return;
    out.own = { ok: false, code: err?.code || 'failed', detail: err?.detail || null };
    at = err?.url || null;
  }
  if (!readerOn()) out.reader = { ok: false, why: 'the search service\'s reader is off' };
  else if (!at || isYoutube(at) || isYoutube(askedPage(url))) out.reader = { ok: false, why: 'not asked: not a public web page' };
  else {
    await readerCopy(at, { signal: ac.signal, explain: (r) => { out.reader = r; } }).catch((e) => { out.reader = { ok: false, why: e?.message || 'could not be asked' }; });
    if (ac.signal.aborted) return;
  }
  if (!searchOn()) out.copies = { found: 0, notes: ['no search service is set'] };
  else {
    try {
      const { copies, notes } = await findCopies(url, { signal: ac.signal });
      out.copies = { found: copies.length, notes: notes || [] };
    } catch (err) {
      if (ac.signal.aborted) return;
      out.copies = { found: 0, notes: [err?.message || 'the search failed'] };
    }
  }
  readLine(url, [`tried from /check: FactEngine's reader ${out.own.ok ? 'read it' : out.own.code}`, readerSaid(out.reader), `${out.copies.found} copies`]);
  res.json(out);
}));

// Extraction and determination are jobs (server/jobs.js): the request names one, and the reply is
// a stream of its events. A request for a job already running or finished attaches to it from the
// event the page says it has, so a cut connection costs nothing but the wait to open a new one.
// Only a request the server refuses (no key, no prompt, nothing to test) answers with an error.
app.post('/api/extract', wrap(async (req, res) => {
  const id = jobs.idFrom(req.body?.jobId);
  const owner = ownerOf(req);
  const known = jobs.get(id, owner);
  if (known) { known.attach(openStream(req, res), req.body?.cursor); return; }

  // The listing's provider's key: OpenAI's, or DeepSeek's or Fireworks' when the listing is there (server/listing.js).
  const apiKey = listingKey();
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

  const meta = sourceMeta(req.body?.source);
  const text = source.text;
  // The run's row (server/economics.js): its tier and its window's price are fixed here and hold for
  // the document. The page is told them first of all, so the rows can show Free and the price.
  // On an open door, bookkeeping never stops a run: a row that cannot be made is said in the log, and the run goes on. With
  // accounts, the run's row is what its claims are held against, so it is a wait until the books can be written.
  const user = req.account?.user || null;
  const run = await economics.openRun({ id, owner, email: user?.email || null, userId: user?.id ?? null, chars: text.length })
    .catch((err) => {
      if (err?.expected) throw err;
      if (signinRequired()) { console.error('[economics] the run could not be recorded:', err.message); throw booksWait(); }
      console.error('[economics] the run could not be recorded:', err.message);
      return null;
    });
  const ctx = { runId: id, owner };
  // The row was awaited: a second request for this job meanwhile (a page coming back at once) joins it.
  const meanwhile = jobs.get(id, owner);
  if (meanwhile) { meanwhile.attach(openStream(req, res), req.body?.cursor); return; }
  // The second pass (server/rank.js): the claims ranked, the top quarter shown, for the operator's runs while CIVIC_RANK is
  // `operator` (their choice of 16 October), for everyone's once it is `on`.
  const rank = rankFor({ operator: seesAll(req) });
  jobs.start(id, 'extraction', async ({ send, signal }) => {
    if (run) send({ t: 'pricing', tier: run.tier, freeFacts: run.freeAllowed, priceCents: run.priceCents, currency: config.currency, note: config.pricingNote || null });
    try {
      const result = await runExtraction({ apiKey, text, meta, send, signal, sourceWarning, ctx, rank });
      economics.finishRun(id, { claimsTotal: result?.total ?? null, status: result ? 'done' : 'cancelled' });
    } catch (err) {
      economics.finishRun(id, { status: 'failed' });
      const safe = describeError(err);
      // The provider's own words (a rejected key, a balance used up) are for /check; the page gets the code
      // and FactEngine's own sentence for it, naming no provider and no key.
      recordFailure({ where: 'server:listing', code: safe.code, message: safe.message, status: safe.status, detail: safe.detail || null });
      send({ t: 'error', code: safe.code, message: safe.message, status: safe.status });
    }
  }, { owner, view: viewFor(req) }).attach(openStream(req, res), 0);
}));

app.post('/api/evaluate', wrap(async (req, res) => {
  const id = jobs.idFrom(req.body?.jobId);
  const owner = ownerOf(req);
  const known = jobs.get(id, owner);
  if (known) { known.attach(openStream(req, res), req.body?.cursor); return; }

  // The operator's trial (server/trial.js): a model of their choosing, on their own runs alone. Anyone else's choice of
  // model is ignored, and their request is the readers' determination, as always.
  const trial = trialOf(req.body, { operator: seesAll(req) });
  const apiKey = trial?.provider === 'deepseek' ? deepseekProvider.key() : trial?.provider === 'gemini' ? geminiProvider.key() : operatorKey();
  if (!hasPrompt('evaluate')) throw new ApiError(503, 'prompt_missing', 'The evaluation prompt is not installed on this server.');
  const claims = Array.isArray(req.body?.claims) ? req.body.claims.map((c) => String(c || '').trim()).filter(Boolean) : [];
  if (!claims.length) throw new ApiError(400, 'no_claims', 'No claims to test.');
  if (claims.length > config.maxClaims) throw new ApiError(400, 'too_many_claims', `At most ${config.maxClaims} claims can be tested in one run.`);
  // The source the claims came from goes ahead of the prompt in every determination, exactly as
  // the extractor received it, so "the speech" has a speaker and a date when a claim is tested.
  const source = req.body?.text ? normalise(req.body.text) : null;
  const document = source && source.chars >= 20 ? sourceBlock(source.text, sourceMeta(req.body?.source)) : '';

  // Each claim's row (server/economics.js): the server decides, never the page, whether it is one of
  // the document's free ones or priced at the run's price, and the page is told before the model is
  // asked. The page names its run and the claim's number. With accounts on, a request without them, or naming a run of
  // another account's, is refused (run_required): no test is free by leaving the run out. With accounts off (a laptop,
  // the guard's older checks) it is measured as a determination of no run, priced at nothing.
  const runId = typeof req.body?.runId === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(req.body.runId.trim()) ? req.body.runId.trim() : null;
  const n = Number.isInteger(req.body?.n) && req.body.n > 0 ? req.body.n : null;
  const detIds = claims.map((_, i) => (claims.length === 1 ? id : `${id}#${i + 1}`));
  // Two requests for this id at once (a page coming straight back): the second waits for the first to open the claim,
  // then joins its job, so one claim is never opened, held and started twice.
  if (opening.has(id)) {
    await opening.get(id).catch(() => {});
    const joined = jobs.get(id, owner);
    if (joined) { joined.attach(openStream(req, res), req.body?.cursor); return; }
  }
  let opened;
  opening.set(id, new Promise((resolve) => { opened = resolve; }));
  const quotes = [];
  const user = req.account?.user || null;
  try {
    for (let i = 0; i < claims.length; i++) {
      quotes.push(await economics.openDetermination({
        id: detIds[i], runId, n: claims.length === 1 ? n : null, chars: claims[i].length,
        userId: user?.id ?? null, owner, limitCents: user?.monthlyLimitCents ?? null, requireRun: signinRequired(),
        fingerprint: fingerprintOf(claims[i]),   // a delivered claim's free second go is for the same claim, never another
        trial: Boolean(trial),                    // the operator's trial: never charged, never in the readers' measurements
      }).catch((err) => {
        if (err?.expected) throw err;   // a refusal the reader must see: the credit, the limit, a run that is not theirs
        console.error('[economics] the determination could not be recorded:', err.message);
        if (signinRequired()) throw booksWait();
        return null;
      }));
    }
  } catch (err) {
    // Nothing of a refused request stays held: the claims it had opened are closed, their holds released.
    await economics.closeOpen(quotes.map((q, i) => (q ? { id: detIds[i], attempt: q.attempt } : null)).filter(Boolean), 'refused');
    throw err;
  } finally {
    opening.delete(id);
    opened();
  }
  const attempts = quotes.map((q, i) => (q ? { id: detIds[i], attempt: q.attempt } : null)).filter(Boolean);
  const ctx = { runId, owner, determinationIds: detIds, jobId: id };
  // The rows were awaited: a second request for this job meanwhile joins it rather than starting it twice.
  const meanwhile = jobs.get(id, owner);
  if (meanwhile) { meanwhile.attach(openStream(req, res), req.body?.cursor); return; }   // not reached while `opening` holds the id; kept as the safe answer
  jobs.start(id, 'determination', async ({ send, signal }) => {
    quotes.forEach((q, i) => { if (q) send({ t: 'quote', i, free: q.free, priceCents: q.priceCents, currency: config.currency, ...(Number.isInteger(q.balanceCents) ? { balanceCents: q.balanceCents } : {}) }); });
    // The books close with the claim's own end: done books its revenue at list and charges its hold; an error books
    // nothing and releases it. Each attempt closes its own, never a later one's. The claim is booked BEFORE the page is
    // told of its end, and the events keep their order behind it: a request the page makes on hearing of the end (the
    // same claim asked for again, its result lost) must find the claim booked, never still running, or it would be taken
    // for a new attempt and charged (found by the guard on 14 October, a race of milliseconds).
    let order = Promise.resolve();
    const inOrder = (fn) => { order = order.then(fn).catch((err) => console.error('[economics] an event could not be passed on:', err?.message || err)); };
    const sendAndBook = (ev) => inOrder(async () => {
      const q = ev.i !== undefined ? quotes[ev.i] : null;
      if (ev.t === 'done' && ev.i !== undefined) await economics.book(detIds[ev.i], { attempt: q?.attempt ?? null, status: 'done', verdict: ev.verdict || null, model: ev.model || null });
      else if (ev.t === 'error' && ev.i !== undefined) await economics.book(detIds[ev.i], { attempt: q?.attempt ?? null, status: 'failed', failure: ev.code || 'error' });
      send(ev);
    });
    try {
      await runEvaluation({ apiKey, claims, document, send: sendAndBook, signal, ctx, trial });
    } catch (err) {
      const safe = describeError(err);
      inOrder(() => send({ t: 'error', code: safe.code, message: safe.message, status: safe.status }));
    } finally {
      await order;   // every event out, every claim's end booked, before the job ends
      // A claim the request ended without a result for (the page stopped the run, the request failed): failed, nothing booked, its hold released.
      await economics.closeOpen(attempts, signal.aborted ? 'cancelled' : 'ended');
    }
  }, { owner, view: viewFor(req) }).attach(openStream(req, res), 0);
}));

// The page says stop (Start a new test, leaving the page): the jobs' model calls are aborted and the
// jobs forgotten. A closed connection never means this; only this route does.
app.post('/api/cancel', (req, res) => { res.json({ cancelled: jobs.cancel(jobs.idList(req.body?.jobIds), ownerOf(req)) }); });
// The page says it has all of a finished job: the job is forgotten. One still working is kept.
app.post('/api/release', (req, res) => { res.json({ released: jobs.release(jobs.idList(req.body?.jobIds), ownerOf(req)) }); });

// The visual echo is off (19 October); while it is, the picture route is the operator's, so nobody else can spend on it.
app.post('/api/illustrate', wrap(async (req, res) => {
  if (!seesAll(req)) throw Object.assign(new ApiError(403, 'operator_only', 'That is for the operator\'s account.'), { expected: true });
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

// ---- Static site ---------------------------------------------------------------------------

app.get('/', sendIndex);

// The page's own files (server/assets.js), however their addresses are spelt: a script, a style sheet or a page without
// its comments; the page in the asker's form; the check page and its script for the operator alone, and "Not found" for
// anyone else before anything is looked up. Under this build's stamp a script or a style sheet is kept forever (the
// stamp changes whenever any of them does); elsewhere it is revalidated by its ETag on every load; the check page and the
// account page are never kept. Fonts and pictures (assets/) are sent as they are, below.
const TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8' };
app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  try {
    const at = assets.pageFileOf(req.path, BUILD);
    if (!at) return next();
    if (at.name.endsWith('.map')) return notFound(res);
    if (at.operatorOnly && !(await operatorHere(req))) return notFound(res);
    if (!at.kind || at.trailing) return next();
    if (at.name === 'index.html') return sendIndex(req, res, next);
    let entry;
    try {
      entry = assets.served(path.join(publicDir, at.rel), at.rel);
    } catch (err) {
      // A file edited while FactEngine runs that cannot be read: said here and on /check, and never sent as written.
      console.error('[page]', err?.message || err);
      recordFailure({ where: 'server:page', code: 'page_unreadable', message: 'A file of the page could not be read.', detail: err?.message || null });
      return res.status(500).set('Cache-Control', 'no-store').type('text/plain').send('This file could not be read.');
    }
    if (!entry) return next();
    res.setHeader('Content-Type', TYPES[entry.kind]);
    res.setHeader('ETag', entry.etag);
    res.setHeader('Cache-Control', at.operatorOnly || at.name === 'account.html' ? 'no-store'
      : at.stamped && entry.kind !== 'html' ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.send(entry.bytes);
  } catch (err) {
    next(err);
  }
});

// Fonts and pictures, as they are: under this build's stamp (the style sheets there name them by their own address) and
// at their own addresses. They never change, so they are kept.
const assetsDir = path.join(publicDir, 'assets');
app.use(`/b/${BUILD}/assets`, express.static(assetsDir, { index: false, redirect: false, immutable: true, maxAge: '365d' }));
app.use('/assets', express.static(assetsDir, { index: false, redirect: false, immutable: true, maxAge: '7d' }));
// An address from an older stamp is not this build's; send the reader to the current page.
app.get(/^\/b\/[0-9a-f]{6,}\//, (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.redirect(302, '/'); });
// The page for any address that is not the API's, in any spelling of "api": /API/anything is
// nobody's route (routes match their case) and must not be the page either, so it is a 404.
app.get(/^\/(?![aA][pP][iI]\/).*/, sendIndex);

// ---- Errors --------------------------------------------------------------------------------

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: { code: err.code, message: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message } });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'That request is too large.' } });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_body', message: 'That request could not be read.' } });
  const safe = err instanceof ApiError ? err : describeError(err);
  // A refusal a reader is expected to meet (a sign-in, a wrong password, the credit, a limit) is not a fault: /check's
  // list is kept for faults. Its figures travel with it, so the page can say them in the reader's language.
  if (!err?.expected) recordFailure({ where: `server:${req.method} ${req.path}`, code: safe.code, message: safe.message, status: safe.status, detail: safe.detail || null });
  if (!(err instanceof ApiError)) console.error('[civic]', safe.status, safe.code);
  // A failure that is not FactEngine's own refusal reaches anyone but the operator as its code alone (server/view.js).
  const body = { code: safe.code, message: safe.message, ...(safe.site ? { site: safe.site } : {}), ...(err?.extra && typeof err.extra === 'object' ? err.extra : {}) };
  const own = err instanceof ApiError && !err.provider;
  res.status(safe.status || 500).json({ error: own || seesAll(req) ? body : { ...readerError({ ...body, status: safe.status }), t: undefined } });
});

const server = http.createServer(app);

function banner() {
  const status = promptStatus();
  console.log(`FactEngine build ${BUILD} is running on http://localhost:${config.port}`);
  if (config.key?.conflict) {
    console.log('');
    console.log('NOTE: two different OpenAI keys were found, and FactEngine used the one in its own');
    console.log('      settings file, which is the rule. The other is set in this computer\'s');
    console.log('      environment and is being ignored. To remove it:  unset OPENAI_API_KEY');
    for (const at of whereTheShellSetsIt()) console.log(`      It is also set in ${at.file}, line ${at.line}.`);
    console.log('');
  }
  if (config.serverKey && !config.key?.usable) {
    const o = config.key?.offending;
    console.log('');
    console.log('STOP: the OpenAI key FactEngine has cannot be sent in a request at all, so every test');
    console.log(`      will fail. It came from ${config.key?.source}.`);
    if (o) console.log(`      Character ${o.index} of the key is ${JSON.stringify(o.char)}, which a request cannot carry.`);
    console.log('      A key copied from somewhere that shortened it for display ends this way.');
    console.log(`      Open http://localhost:${config.port}/check${signinRequired() ? ', signed in as the operator,' : ''} for what to do about it.`);
    console.log('');
  }
  const v = promptVersions();
  const mark = (n) => (status[n] ? `${n} ${v[n].version} (${v[n].chars} chars)` : `${n} MISSING`);
  console.log(`prompts installed: ${mark('extract')} · ${mark('evaluate')} · ${status.rank ? mark('rank') : 'rank not installed'}`);
  const shape = requestShape();
  const placing = shape.extract.source === 'inserted' ? 'the prompt verbatim with the source in place of its bracketed line, as the only message' : 'the prompt verbatim as instructions · the document whole as the only message, its headline ahead of it';
  // The listing names no tool on any provider (24 October): it reads the document it is given and nothing else. On
  // Fireworks and OpenAI it says store: false.
  const listingTools = `no tools${onDeepSeek() ? '' : ' · store false'}`;
  console.log(`extraction requests ${onOwnProvider() ? `go to ${listingHost()} (${listingProviderName()}) and ` : ''}carry: model ${shape.extract.model} · reasoning.effort ${shape.extract.effort}${shape.extract.mode ? ` · reasoning.mode ${shape.extract.mode}` : ''}${shape.extract.summary ? ` · reasoning.summary ${shape.extract.summary}` : ''} · ${listingTools} · ${placing} · nothing else${shape.extract.fallback ? '  (FALLBACK LIST SET)' : ''}`);
  console.log(`determination requests carry: model ${shape.evaluate.model} · reasoning.effort ${shape.evaluate.effort}${shape.evaluate.mode ? ` · reasoning.mode ${shape.evaluate.mode}` : ''}${shape.evaluate.summary ? ` · reasoning.summary ${shape.evaluate.summary}` : ''} · web_search · the source as a message ahead of the prompt · the prompt verbatim with the claim in its slot · nothing else${shape.evaluate.fallback ? '  (FALLBACK LIST SET)' : ''}`);
  // The operator's trial (server/trial.js): whether it can run, for the host's log. No key, nothing of anyone's.
  const trial = trialState();
  if (trial) {
    const how = (m) => (m.provider === 'gemini' ? `at ${m.efforts.join(' or ')}, with Google's own search and page reading`
      : m.provider === 'openai' ? `at ${m.efforts.join(' or ')}, with OpenAI's web search, as a reader's fact-check`
        : 'with FactEngine\'s search and page reader as the model\'s tools');
    console.log(`[trial] the operator's own determinations may run, chosen on their page: ${trial.models.map((m) => `${m.id} ${m.ready ? `ready, ${how(m)}` : `not ready: ${String(m.why || '').replace(/\.$/, '')}`}`).join('; ')}`);
  }
  // A link FactEngine's server cannot read (server/copies.js): the search service's reader, then the copies, then the
  // sentence to paste. Its address, never its key.
  if (readerOn()) {
    let where = String(config.readerUrl).trim();
    try { const u = new URL(where); where = `${u.host}${u.pathname}`; } catch { /* as set */ }
    console.log(`[read] a link FactEngine's server cannot read is read through the search service's reader (${where}), then looked for elsewhere`);
  } else console.log('[read] a link FactEngine\'s server cannot read goes straight to its copies and the sentence to paste: no reader is set (CIVIC_READER_URL, or a search service at …/search with its key)');
  // The second pass (server/rank.js): for whom, at what effort, how much is shown; or why the claims are listed unranked.
  const rs = rankState();
  console.log(rs.ready
    ? `[rank] the claims are ranked ${rs.mode === 'on' ? 'for every run' : 'for the operator\'s runs (CIVIC_RANK=operator)'} on ${rs.model} at ${rs.effort}: an empirical headline first, then the top ${rs.keepPercent}% of the ranked claims, rounded up`
    : `[rank] the claims are listed unranked: ${rs.why}`);
  // The page's files (server/assets.js): how they are sent.
  console.log(`[page] ${pageFiles.files} scripts, style sheets and pages sent without their comments; the ${pageFiles.vendor.size} vendor files the pages load, and no others; /check and the operator's parts of the page ${signinRequired() ? 'for the operator alone' : 'for everyone (an open door)'}`);
  const tr = tellReport();
  if (!tr) console.log('[page] no tell words are set (CIVIC_TELL_WORDS or CIVIC_TELL_WORDS_FILE)');
  else if (!tr.findings.length) console.log(`[page] tell words (list #${tr.installed}, ${tr.words}): none in what a reader receives (${tr.files} files)`);
  else console.log(`[page] tell words (list #${tr.installed}, ${tr.words}) in what a reader receives: ${tr.findings.map((f) => `${f.fingerprint} in ${f.file}`).join('; ')}`);
  if (config.openaiBaseUrl) console.log(`OpenAI base URL override: ${config.openaiBaseUrl}`);
}

// The launcher asks for the browser, and it is opened from here, once this FactEngine is actually
// answering. It used to be opened by the launcher on a timer, so when this FactEngine failed to start
// the browser opened on whatever was already on the port: the older FactEngine, with the older fault,
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

// The port is FactEngine's. If an older FactEngine still holds it, it is closed and the port taken over,
// so an update can never leave yesterday's process answering with today's files underneath it.
// Anything that is not a FactEngine is left alone and named, so the person can close it themselves.
let attempts = 0;
server.on('error', async (err) => {
  try {
    if (err?.code === 'EADDRINUSE' && attempts++ === 0) {
      const found = await takeOverPort(config.port, { appDir: path.join(here, '..') });
      if (found.closed.length) {
        console.log(`Closed an older FactEngine${found.build ? ` (build ${found.build})` : ''} that was still holding port ${config.port}.`);
        server.listen(config.port);
        return;
      }
      const lines = ['', `STOPPED: port ${config.port} is already in use, so this FactEngine did not start.`];
      if (found.unknown) lines.push('FactEngine could not find out by what. Close other programs, then start FactEngine again.');
      for (const f of found.foreign) lines.push(`It is in use by something that is not FactEngine: ${f.command || `process ${f.pid}`}${f.error ? ` (could not be closed: ${f.error})` : ''}.`);
      if (found.foreign.length) lines.push('Close that program, then start FactEngine again.');
      lines.push('');
      console.error(lines.join('\n'));
      process.exit(1);
    }
    if (err?.code === 'EADDRINUSE') {
      console.error(`\nSTOPPED: an older FactEngine holding port ${config.port} would not close. Close every FactEngine window, then start it again.\n`);
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

// A deploy, or the launcher closing an older copy, ends this process with SIGTERM. Its jobs can no
// longer reach anyone (the host has already moved the traffic to the next FactEngine, whose page will
// start them over), so their model calls are stopped rather than paid for to no end; the listener
// closes, so the port is free for the next FactEngine; the process ends when the last connection closes.
process.on('SIGTERM', () => {
  // First the books: every determination this instance still has in flight is failed as `deploy`,
  // its cost kept and nothing booked (server/economics.js), given a few seconds and no more.
  Promise.race([economics.closeAllOpen('deploy'), new Promise((r) => setTimeout(r, 3000))]).catch(() => {}).finally(() => {
    jobs.cancel(jobs.ids());
    server.close(() => process.exit(0));
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
});

// The measurement's home is prepared before the door opens (server/economics.js, server/db.js): a
// schema that cannot be made stops this instance here, with the reason, and the host's health check
// keeps the old one answering.
try {
  // Accounts live in Postgres on Render: in memory, every deploy would delete every account and its credit.
  if (accounts.accountsOn() && !dbOn() && process.env.RENDER) throw new Error('accounts are on and DATABASE_URL is not set, so every account would end with this instance');
  if (dbOn()) await migrate();
  console.log(accounts.bootLine());
  await economics.boot();
} catch (err) {
  console.error(`\nSTOPPED: the database could not be prepared, so this FactEngine did not start: ${err?.message || err}\n`);
  process.exit(1);
}

server.listen(config.port);
