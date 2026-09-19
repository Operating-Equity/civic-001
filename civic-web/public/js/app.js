// CIVIC main page. One state machine: idle → extracting → evaluating → done.
//
// Two rules this file exists to keep:
//   1. Nothing runs that the reader did not submit. There is no sample, no seeded text, no
//      preloaded result. The page is empty until a document is given to it.
//   2. Nothing the model returns is summarised, trimmed or hidden. The entry is rendered whole,
//      and the reasoning summary, the search trail, the cited sources and the raw text are all
//      on the card. When the verdict cannot be read from the model's own Conclusion, the card
//      says so instead of guessing.
import { t, setLocale, initLocale, LOCALES, currentLocale, fmtNumber, fmtSeconds, fmtUsd } from './i18n.js';
import * as api from './api.js';
import { $, $$, el, renderMarkdown, setBar, toast, easeChars, easeTime, bump, copyText } from './render.js';

const MAX_CLAIMS = 10; // the automatic run (the operator's number); anything beyond is the reader's explicit choice
const IN_FLIGHT = 4; // claims in flight at once: the operator's choice of 18 September (the arithmetic is in server/config.js)
const GLYPH = { true: '✓', false: '✕', unverified: '?', unread: '–' };

/** A connection failure in the reader's language, from the operating system's code; the server's own words otherwise. */
function netWords(code, why) {
  const key = `net.${code || 'connection'}`;
  const words = t(key);
  return words === key ? (why || t('net.connection')) : words;
}

const state = {
  phase: 'idle',
  server: null,        // /api/health payload, or null when no server answers
  session: null,       // { email } once a code has been accepted, when a sign-in is required
  accounting: true,    // operator view: the estimated cost per claim
  source: '',
  warnings: [],   // anything that could have cost a claim, shown at the top of the run
  claims: [],
  claimsRaw: '',
  beyond: [],          // { n, text, selected, tested }
  cards: [],           // claims that have cards, in card order: the first ten, then chosen extras
  results: [],
  extraction: null,
  echo: null,
  batch: { start: 0, size: 0, done: 0 },
  counts: { true: 0, false: 0, unverified: 0 },
  unread: 0,
  cost: 0,
  unpriced: false,
  abort: null,
  timers: [],
  extractStartedAt: 0,
  extractChars: 0,
  found: 0,
  extractWait: null,   // while the extraction waits for the connection to OpenAI: { code, why, since }
  extractCut: false,   // the connection carrying the extraction was cut; it is being opened again
  runId: '',           // this run's name; every job of the run is named after it
  extractJob: '',      // the extraction's job at the server (server/jobs.js)
  jobs: new Set(),     // every job of this run the server may still hold: cancelled on reset, on leaving
  evalStartedAt: 0,
  gate: null,          // the key's minute figures, from the server, once OpenAI has given them
  status: { step1: null, step2: null },
};

const ui = {};
function cacheElements() {
  Object.assign(ui, {
    source: $('#source-text'), sourceFile: $('#source-file'), sourceMeta: $('#source-meta'),
    optEcho: $('#opt-echo'), run: $('#btn-run'),
    runSection: $('#run'), runWarnings: $('#run-warnings'),
    step1: $('#step-extract'), step1Status: $('#step1-status'), bar1: $('#bar-extract'),
    step1Thinking: $('#step1-thinking'), step1ThinkingSummary: $('#step1-thinking-summary'), step1ThinkingBody: $('#step1-thinking-body'),
    step2: $('#step-eval'), step2Title: $('#step2-title'), step2Status: $('#step2-status'), step2Gate: $('#step2-gate'), bar2: $('#bar-eval'),
    echo: $('#echo'), echoImg: $('#echo-img'), echoShimmer: $('#echo-shimmer'),
    intake: $('#intake'), intakeSummary: $('#intake-summary'), intakeSummaryText: $('#intake-summary-text'), showText: $('#btn-show-text'),
    scoreSourceTitle: $('#score-source-title'), scoreSourceSub: $('#score-source-sub'), scorePhase: $('#score-phase'), claimsFrom: $('#claims-from'),
    claims: $('#claims'), claimsSub: $('#claims-sub'), claimsList: $('#claims-list'),
    beyond: $('#claims-beyond'), beyondTitle: $('#claims-beyond-title'), beyondList: $('#claims-beyond-list'), beyondHint: $('#claims-beyond-hint'),
    selectAll: $('#btn-select-all'), testSelected: $('#btn-test-selected'),
    claimsRaw: $('#claims-raw'), claimsRawSummary: $('#claims-raw-summary'), claimsRawBody: $('#claims-raw-body'),
    scoreboard: $('#scoreboard'), scoreTrue: $('#score-true'), scoreFalse: $('#score-false'), scoreUnv: $('#score-unverified'),
    scoreUnread: $('#score-unread'), scoreUnreadWrap: $('#score-unread-wrap'),
    scoreInternal: $('#score-internal'), scoreCost: $('#score-cost'), report: $('#btn-report'),
    buildStamp: $('#build-stamp'),
    results: $('#results'), resetTop: $('#btn-reset-top'), reset: $('#btn-reset'),
    langSelect: $('#lang-select'), signin: $('#btn-signin'), signup: $('#btn-signup'), signout: $('#btn-signout'), who: $('#nav-who'),
    signinDialog: $('#signin-dialog'), signinForm: $('#signin-form'), signinEmail: $('#signin-email'), signinCode: $('#signin-code'),
    signinNote: $('#signin-note'), signinSubmit: $('#signin-submit'), signinCancel: $('#signin-cancel'),
    cardTpl: $('#tpl-card'),
  });
}

// ---------- boot ----------------------------------------------------------------------------

async function boot() {
  cacheElements();
  for (const l of LOCALES) ui.langSelect.append(el('option', { value: l.code, text: l.name }));
  initLocale();
  ui.langSelect.value = currentLocale();
  ui.langSelect.addEventListener('change', () => setLocale(ui.langSelect.value));
  document.addEventListener('civic:locale', refreshDynamicText);

  wireIntake();
  wireSignIn();
  ui.signup.addEventListener('click', () => toast(t('nav.soon')));
  ui.resetTop.addEventListener('click', resetAll);
  ui.reset.addEventListener('click', resetAll);
  ui.selectAll.addEventListener('click', toggleSelectAll);
  // Parked for now (the operator's rule of 18 September, cost control until there is revenue
  // against it): choosing claims beyond the first ten works as before, and the button that would
  // test them says so instead; the report button appears after the first batch and says so too.
  ui.testSelected.addEventListener('click', () => toast(t('claims.later')));
  ui.report.addEventListener('click', () => toast(t('report.soon')));
  // Leaving the page is the one way, besides Start a new test, that a run is stopped: the server
  // keeps working through a cut connection, so it has to be told when nobody will come back.
  window.addEventListener('pagehide', () => { if (state.jobs.size) api.cancel([...state.jobs], { beacon: true }); });

  // The launcher opens the page at a one-off address so a browser holding an older copy of the page
  // cannot serve it back instead of asking the server. Tidy that marker out of the address bar.
  if (new URLSearchParams(location.search).has('fresh')) {
    try { history.replaceState(null, '', location.pathname); } catch { /* not important */ }
  }

  try {
    state.server = await api.health();
    if (ui.buildStamp && state.server?.build) ui.buildStamp.textContent = `build ${state.server.build}`;
    state.accounting = Boolean(state.server.accounting);
    state.session = state.server.access?.session || null;
  } catch {
    state.server = null;
  }
  renderNav();
}

// ---------- sign-in by code -------------------------------------------------------------------

// No accounts yet: a code from the operator's list opens the door, and the email address typed
// beside it is kept with the sign-in. The dialog opens from the Sign in button, and from any
// action the server refuses for want of a sign-in; that action then proceeds on its own.
let pendingSignIn = null;   // { resolve, reject } while a refused action waits on the dialog

function wireSignIn() {
  api.onSignInRequired(requireSignIn);
  ui.signin.addEventListener('click', () => { if (state.server?.access?.required) openSignIn(); else toast(t('signin.open')); });
  ui.signout.addEventListener('click', signOut);
  ui.signinForm.addEventListener('submit', submitSignIn);
  ui.signinCancel.addEventListener('click', () => ui.signinDialog.close());
  ui.signinDialog.addEventListener('close', () => {
    const p = pendingSignIn;
    pendingSignIn = null;
    if (!p) return;
    const e = new Error('sign-in abandoned'); e.name = 'AbortError'; p.reject(e);
    // The action that needed the sign-in is abandoned with it: a run in progress stops, the text stays.
    if (state.phase === 'extracting' || state.phase === 'evaluating') {
      const text = ui.source.value;
      resetAll();
      ui.source.value = text;
      updateSourceMeta();
    }
  });
}

function openSignIn() {
  ui.signinNote.hidden = true;
  ui.signinCode.value = '';
  if (!ui.signinDialog.open) ui.signinDialog.showModal();
  (ui.signinEmail.value ? ui.signinCode : ui.signinEmail).focus();
}

/** Called by the API client on a refusal for want of a sign-in; resolves once the reader has one. */
function requireSignIn() {
  return new Promise((resolve, reject) => {
    pendingSignIn = { resolve, reject };
    openSignIn();
  });
}

async function submitSignIn(event) {
  event.preventDefault();
  const email = ui.signinEmail.value.trim();
  const code = ui.signinCode.value.trim();
  if (!code) { ui.signinCode.focus(); return; }
  ui.signinSubmit.disabled = true;
  try {
    const out = await api.signin({ email, code });
    state.session = out.session || { email };
    renderNav();
    const p = pendingSignIn;
    pendingSignIn = null;
    ui.signinDialog.close();
    p?.resolve();
  } catch (err) {
    ui.signinNote.textContent = err?.code === 'code_not_listed' ? t('signin.notListed') : (err?.message || t('errors.server'));
    ui.signinNote.hidden = false;
    ui.signinCode.select();
  } finally {
    ui.signinSubmit.disabled = false;
  }
}

async function signOut() {
  try { await api.signout(); } catch { /* the cookie is gone either way */ }
  state.session = null;
  renderNav();
}

/** The nav says who is signed in, when a sign-in is required; otherwise it is as it always was. */
function renderNav() {
  const required = Boolean(state.server?.access?.required);
  const signedIn = required && Boolean(state.session);
  ui.signin.hidden = signedIn;
  ui.signout.hidden = !signedIn;
  ui.who.hidden = !signedIn;
  ui.who.textContent = signedIn ? (state.session.email || t('signin.signedIn')) : '';
}

// ---------- access -------------------------------------------------------------------------

// A reader signs in with a code and is asked for nothing else.

// ---------- intake --------------------------------------------------------------------------

function wireIntake() {
  ui.source.addEventListener('input', updateSourceMeta);
  ui.showText.addEventListener('click', () => {
    const open = ui.intake.classList.toggle('is-open');
    ui.showText.textContent = t(open ? 'intake.hideText' : 'intake.showText');
  });
  ui.sourceFile.addEventListener('change', async () => {
    const file = ui.sourceFile.files?.[0];
    if (!file) return;
    ui.sourceMeta.textContent = t('intake.reading', { name: file.name });
    try {
      if (!state.server) throw new api.ApiError(0, 'no_server', t('errors.server'));
      const parsed = await api.parseFile(file);
      ui.source.value = parsed.text;
      state.sourceMeta = { kind: 'file', name: parsed.name };
      state.loadedText = parsed.text;
      ui.sourceMeta.textContent = t('intake.loaded', { name: parsed.name, chars: parsed.chars });
      if (parsed.truncated) toast(t('intake.truncated', { n: parsed.chars }), { ms: 7000 });
    } catch (err) {
      updateSourceMeta();
      toast(t('errors.file', { message: err.message }), { error: true });
    } finally {
      ui.sourceFile.value = '';
    }
  });
  ui.run.addEventListener('click', startRun);
}

function updateSourceMeta() {
  const n = ui.source.value.trim().length;
  ui.sourceMeta.textContent = n ? t('intake.chars', { n }) : '';
  // Text typed or pasted over what a link or a file brought in is no longer that link or file.
  if (state.loadedText && ui.source.value !== state.loadedText) { state.sourceMeta = { kind: 'text' }; state.loadedText = ''; }
}

// ---------- what the source is ---------------------------------------------------------------

/** The source's identity for people: a title and a line under it. Nothing here is guessed. */
function describeSource() {
  const m = state.sourceMeta || { kind: 'text' };
  const chars = t('intake.chars', { n: (state.source || ui.source.value).trim().length });
  if (m.kind === 'link') {
    return { title: m.title || m.url, sub: [m.author, m.published, m.site].filter(Boolean).join(' · ') || m.url };
  }
  if (m.kind === 'file') return { title: m.name, sub: `${t('source.file')} · ${chars}` };
  return { title: t('source.pasted'), sub: chars };
}

/** Says, in the run header, in the closed intake and above the claims, what is being tested. */
function renderSource() {
  const { title, sub } = describeSource();
  ui.scoreSourceTitle.textContent = title;
  ui.scoreSourceSub.textContent = sub;
  ui.intakeSummaryText.replaceChildren(document.createTextNode(`${t('intake.testing')} `), el('b', { text: title }), document.createTextNode(sub ? ` · ${sub}` : ''));
  ui.claimsFrom.textContent = t('claims.from', { source: sub ? `${title} · ${sub}` : title });
  ui.claimsFrom.hidden = false;
}

function collapseIntake() {
  ui.intake.classList.add('is-collapsed');
  ui.intake.classList.remove('is-open');
  ui.intakeSummary.hidden = false;
  ui.showText.textContent = t('intake.showText');
  ui.source.readOnly = true;
}

function expandIntake() {
  ui.intake.classList.remove('is-collapsed', 'is-open');
  ui.intakeSummary.hidden = true;
  ui.source.readOnly = false;
}

// ---------- links ---------------------------------------------------------------------------

/** Fetches a web address through the server and puts its own words in the box. */
async function readLinkIntoBox(url) {
  const host = (() => { try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ''); } catch { return url; } })();
  ui.run.disabled = true;
  // The reading is visible while it lasts: the host and the seconds, ticking under the box.
  const started = Date.now();
  const showReading = () => { ui.sourceMeta.textContent = t('intake.readingUrlTime', { host, time: fmtSeconds(Date.now() - started) }); };
  showReading();
  const tick = setInterval(showReading, 1000);
  state.timers.push(tick);
  const controller = new AbortController();
  state.urlAbort = controller;
  try {
    const got = await api.readUrl(url, { signal: controller.signal });
    ui.source.value = got.text;
    state.sourceLink = { url: got.url, title: got.title || host, kind: got.kind };
    state.sourceMeta = { kind: 'link', url: got.url, title: got.title || host, author: got.author || '', published: got.published || '', site: got.site || host };
    state.loadedText = got.text;
    ui.sourceMeta.textContent = t('intake.readUrl', { title: got.title || host, n: fmtNumber(got.chars) });
    if (got.note === 'automatic_captions') toast(t('intake.autoCaptions'), { ms: 7000 });
    return true;
  } catch (err) {
    const code = err?.code || '';
    const known = ['url_no_transcript', 'url_forbidden', 'url_private', 'url_timeout', 'url_unreachable',
      'url_not_web', 'url_too_big', 'url_no_text', 'url_not_text', 'url_status', 'url_redirects', 'url_empty'];
    // A site that keeps its text from CIVIC is named, in the reader's language, with what to do.
    const site = err?.site || host;
    const own = {
      url_refused: () => t('errors.siteRefused', { site }),
      url_silent: () => t('errors.siteRefused', { site }),
      url_paywall: () => t('errors.sitePaywall', { site }),
      url_shell: () => t('errors.siteShell', { site }),
    }[code];
    const sentence = own ? own() : known.includes(code) ? err.message : t('errors.url', { message: err?.message || code });
    ui.sourceMeta.textContent = sentence; // stays under the box until the box changes; the toast passes
    toast(sentence, { error: true, ms: 9000 });
    return false;
  } finally {
    clearInterval(tick);
    state.urlAbort = null;
    ui.run.disabled = false;
  }
}

// ---------- the run -------------------------------------------------------------------------

async function startRun() {
  if (!state.server) { toast(t('errors.server'), { error: true }); return; }

  // A web address in the box is read first, and its text replaces the address, so the reader sees
  // exactly what will be tested before a single claim is extracted.
  if (api.looksLikeUrl(ui.source.value)) {
    const got = await readLinkIntoBox(ui.source.value.trim());
    if (!got) return;
  }

  const text = ui.source.value.trim();
  if (text.length < 20) { toast(t('intake.empty'), { error: true }); ui.source.focus(); return; }
  if (!state.server.prompts?.extract || !state.server.prompts?.evaluate) { toast(t('errors.prompt'), { error: true }); return; }

  resetRunState();
  state.accounting = Boolean(state.server?.accounting);
  state.source = text;
  state.phase = 'extracting';
  state.abort = new AbortController();
  state.runId = api.newJobId('run');
  state.extractJob = `${state.runId}-x`;
  state.jobs.add(state.extractJob);

  // The page becomes the run: the intake closes to a line, and the run header, with what is being
  // tested and the way out, is on screen from the first second.
  collapseIntake();
  renderSource();
  ui.scoreboard.hidden = false;
  ui.scorePhase.hidden = false;
  ui.scorePhase.textContent = t('score.extracting');
  ui.runSection.hidden = false;
  ui.run.disabled = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (ui.optEcho.checked) startEcho(text);
  await runExtraction(text);
}

function newResult() {
  return {
    status: 'pending', phase: 'pending', text: '', reasoning: '', chars: 0, startedAt: 0,
    verdict: null, verdictSource: 'none', confidence: null, inspector: null,
    usage: null, cost: null, ms: null, trail: [], sources: [], incomplete: null, renderAt: 0,
    jobId: null, cutFrom: null,   // the claim's job at the server, and what the row said before its connection was cut
  };
}

function resetRunState() {
  state.failure = null;
  state.extractReasoning = '';
  state.extractSearches = 0;
  if (ui.step1Thinking) { ui.step1Thinking.hidden = true; ui.step1ThinkingBody.textContent = ''; ui.step1Thinking.open = false; }
  ui.bar1.classList.remove('is-waiting');
  cancelJobs();
  state.abort?.abort();
  for (const id of state.timers) clearInterval(id);
  state.timers = [];
  Object.assign(state, {
    phase: 'idle', warnings: [], claims: [], claimsRaw: '', beyond: [], cards: [], results: [], extraction: null, echo: null,
    batch: { start: 0, size: 0, done: 0 }, counts: { true: 0, false: 0, unverified: 0 }, unread: 0,
    cost: 0, unpriced: false,
    extractStartedAt: 0, extractChars: 0, found: 0, extractWait: null, extractCut: false, runId: '', extractJob: '', evalStartedAt: 0, gate: null, status: { step1: null, step2: null },
  });
  ui.runWarnings.replaceChildren();
  ui.runWarnings.hidden = true;
  ui.claimsList.replaceChildren();
  ui.beyondList.replaceChildren();
  ui.claims.hidden = true;
  ui.beyond.hidden = true;
  ui.claimsRaw.hidden = true;
  ui.claimsRaw.open = false;
  ui.scoreboard.hidden = true;
  ui.report.hidden = true;
  ui.echo.hidden = true;
  ui.echoImg.hidden = true;
  ui.echoImg.removeAttribute('src');
  ui.echoShimmer.hidden = false;
  setStep(ui.step1, 'idle'); setBar(ui.bar1, 0);
  setStep(ui.step2, 'idle'); setBar(ui.bar2, 0);
  setStatus('step1', null); setStatus('step2', null);
  renderGateLine();
  ui.step2Title.textContent = t('step2.title', { n: MAX_CLAIMS });
  renderScoreboard();
}

function resetAll() {
  resetRunState();
  ui.runSection.hidden = true;
  ui.run.disabled = false;
  expandIntake();
  ui.source.value = '';
  state.sourceMeta = { kind: 'text' };
  state.loadedText = '';
  ui.claimsFrom.hidden = true;
  updateSourceMeta();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  ui.source.focus();
}

function setStep(stepEl, stateName) { stepEl.dataset.state = stateName; }

function setStatus(which, key, params = {}) {
  state.status[which] = key ? { key, params } : null;
  const node = which === 'step1' ? ui.step1Status : ui.step2Status;
  node.textContent = key ? t(key, params) : '';
}

/** A downgrade or a dropped character is never silent: it goes at the top of the run, in red. */
function addWarning(ev) {
  const id = `${ev.code}:${ev.used || ''}:${ev.omitted || ''}`;
  if (state.warnings.some((w) => w.id === id)) return;
  state.warnings.push({ id, ...ev });
  renderWarnings();
}

/** Puts a failure where it can be read for as long as it is wanted, with a way to see more. */
function showFailure(message, err) {
  state.failure = { message, code: err?.code || '', detail: err?.message || '' };
  renderWarnings();
  ui.runSection.hidden = false;
  ui.runWarnings.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Twenty claims run at the same time. The status line says so, and says when a rate limit is
    turning them back into a queue, which is the only thing that makes a run take twenty times as
    long as one claim. */
function updateEvalStatus() {
  if (state.phase !== 'evaluating' || !state.batch.size) return;
  const running = state.results.filter((r) => r.status === 'running').length;
  // A claim waiting for the connection to OpenAI is neither working nor held by the key's minute.
  const unreachable = state.results.filter((r) => r.status === 'running' && r.phase === 'retry' && r.retryReason === 'connection');
  // A claim held at the gate has not started; one waiting to go again has, but is not working.
  const throttled = state.results.filter((r) => r.phase === 'queued' || (r.status === 'running' && r.phase === 'retry' && r.retryReason !== 'connection')).length;
  const working = state.results.filter((r) => r.status === 'running' && r.phase !== 'queued' && r.phase !== 'retry').length;
  const elapsed = fmtSeconds(Date.now() - state.evalStartedAt);
  if (unreachable.length) {
    const w = unreachable[0];
    setStatus('step2', 'step2.unreachable', { running: working, n: unreachable.length, why: netWords(w.retryCode, w.retryWhy), done: state.batch.done, total: state.batch.size, time: elapsed });
  } else if (throttled) {
    setStatus('step2', 'step2.throttled', { running: working, n: throttled, done: state.batch.done, total: state.batch.size, time: elapsed });
  } else if (running) {
    setStatus('step2', 'step2.running', { running, done: state.batch.done, total: state.batch.size, time: elapsed });
  } else {
    setStatus('step2', 'step2.progress', { done: state.batch.done, total: state.batch.size });
  }
}

/** The key's minute figures, in OpenAI's own numbers, once the gate has them: how many
    determinations start at once and how often one more can. */
function renderGateLine() {
  const g = state.gate;
  if (!ui.step2Gate) return;
  if (!g) { ui.step2Gate.hidden = true; ui.step2Gate.textContent = ''; return; }
  ui.step2Gate.hidden = false;
  ui.step2Gate.textContent = t('step2.gate', { limit: fmtNumber(g.limit), cost: fmtNumber(g.cost), atOnce: g.atOnce, every: Math.max(1, Math.round(g.everyMs / 1000)) });
}

function renderWarnings() {
  ui.runWarnings.hidden = state.warnings.length === 0 && !state.failure;
  const rows = [];
  if (state.failure) {
    const li = el('li', { class: 'run-failure' });
    li.append(el('strong', { text: state.failure.message }));
    if (state.failure.detail && state.failure.detail !== state.failure.message) {
      li.append(el('span', { class: 'run-failure-detail', text: ` ${state.failure.detail}` }));
    }
    const link = el('a', { text: t('errors.checkLink'), class: 'run-failure-link' });
    link.href = 'check';
    li.append(document.createTextNode(' '), link);
    rows.push(li);
  }
  rows.push(...state.warnings.map((w) => {
    let text;
    if (w.code === 'source_truncated') text = t('warn.sourceTruncated', { n: fmtNumber(w.omitted), read: fmtNumber(w.read) });
    else if (w.code === 'model_fallback') text = t('warn.modelFallback', { used: w.used, requested: w.requested });
    else text = w.code;
    return el('li', { text });
  }));
  ui.runWarnings.replaceChildren(...rows);
}

function addCost(cost) {
  if (!cost) return;
  state.cost += cost.usd || 0;
  if (cost.priced === false) state.unpriced = true;
}

// ---------- the run's jobs at the server ------------------------------------------------------

// The work is the server's (server/jobs.js). A cut connection is opened again by api.js and the
// job goes on meanwhile; these two are the only ways a job ends before its time or is let go of.
function cancelJobs() {
  if (!state.jobs.size) return;
  api.cancel([...state.jobs]);
  state.jobs.clear();
}
function releaseJob(id) {
  if (!id || !state.jobs.has(id)) return;
  state.jobs.delete(id);
  api.release([id]);
}

// ---------- step 1: extraction ----------------------------------------------------------------

async function runExtraction(text) {
  state.extractStartedAt = Date.now();
  setStep(ui.step1, 'running');
  setStatus('step1', 'step1.reading', { n: text.length });
  setStatus('step2', 'step2.waiting');
  const tick = setInterval(updateExtractBar, 200);
  state.timers.push(tick);

  let finished = false;
  const onEvent = (ev) => {
    switch (ev.t) {
      case 'claim': addClaim(ev.n, ev); break;
      case 'progress': state.extractChars = ev.chars; state.found = Math.max(state.found, ev.found || 0); break;
      case 'reasoning':
        state.extractReasoning += ev.text || '';
        renderExtractThinking();
        break;
      case 'trail':
        state.extractSearches = ev.searches || (state.extractSearches + 1);
        break;
      case 'start': state.extractWait = null; break;   // the connection was made; the model is reading
      case 'retry':
        // A connection failure is a wait for the connection, shown as such until the next go begins.
        state.extractWait = ev.reason === 'connection' ? { code: ev.code, why: ev.why, since: ev.since || Date.now() } : null;
        if (!state.extractWait) setStatus('step1', 'step1.retry');
        break;
      case 'phase':
        if (ev.phase === 'queued') setStatus('step1', 'step1.queued');
        if (ev.phase === 'incomplete') toast(t('step1.incomplete'), { error: true, ms: 9000 });
        break;
      case 'warning': addWarning(ev); break;
      case 'done': finished = true; finishExtraction(ev); break;
      case 'error': finished = true; failRun(ev); break;
      default: break;
    }
  };
  const job = state.extractJob;
  try {
    await api.extract({
      jobId: job, text, source: state.sourceMeta, signal: state.abort.signal, onEvent,
      onCut: () => { state.extractCut = true; },
      onAttached: () => { state.extractCut = false; },
    });
    if (!finished && state.phase === 'extracting') failRun({ code: 'stream_ended', message: 'The connection closed before extraction finished.' });
  } catch (err) {
    if (err?.name !== 'AbortError') failRun(err);
  } finally {
    clearInterval(tick);
    releaseJob(job);   // the job is over, whatever ended it; the server can let go of its record
  }
}

function updateExtractBar() {
  if (state.phase !== 'extracting') return;
  const elapsed = Date.now() - state.extractStartedAt;

  // The connection to CIVIC was cut: the extraction goes on at the server, and the page is opening
  // a new connection to it; the line says so until it has.
  if (state.extractCut) {
    ui.bar1.classList.add('is-waiting');
    setStatus('step1', 'step1.reconnecting');
    return;
  }
  // The connection to OpenAI cannot be made: the line says so, why, and for how long, until it can.
  if (state.extractWait) {
    ui.bar1.classList.add('is-waiting');
    setStatus('step1', 'step1.unreachable', { why: netWords(state.extractWait.code, state.extractWait.why), time: fmtSeconds(Date.now() - state.extractWait.since) });
    return;
  }

  // At high reasoning effort the model thinks for minutes before it writes anything. A bar tuned to
  // seconds reaches its ceiling and sits there, which reads as a dead page. So until the first claim
  // arrives the bar is openly a waiting bar, and the status line counts the time and the searches,
  // which is the truth: the model is working and has not produced a claim yet.
  if (!state.found) {
    ui.bar1.classList.add('is-waiting');
    setBar(ui.bar1, 0.06 + easeTime(elapsed, 90000, 0.2));
    setStatus('step1', state.extractSearches ? 'step1.thinkingSearched' : 'step1.thinking',
      { time: fmtSeconds(elapsed), n: state.extractSearches });
    return;
  }
  ui.bar1.classList.remove('is-waiting');
  const byTime = easeTime(elapsed, 45000, 0.45);
  const byClaims = easeChars(state.found, 10, 0.5);
  setBar(ui.bar1, Math.min(0.94, Math.max(byTime, 0.08 + byClaims + byTime * 0.5)));
  setStatus('step1', 'step1.foundTimed', { n: state.found, time: fmtSeconds(elapsed) });
}

/** The model's own account of its reading, shown as it arrives. Nothing is summarised by us. */
function renderExtractThinking() {
  const text = state.extractReasoning.trim();
  ui.step1Thinking.hidden = !text;
  if (!text) return;
  ui.step1ThinkingSummary.textContent = t('step1.thinkingTitle');
  ui.step1ThinkingBody.textContent = text;
  ui.step1ThinkingBody.scrollTop = ui.step1ThinkingBody.scrollHeight;
}

// A claim is the text that is tested and, when the model wrote further labelled lines beside it
// (who said it and when, what the source does not say), those lines, verbatim.
// The Claim line is the row's title; the further lines are shown under it; the whole entry, as the
// extractor wrote it, is what is tested, so the who and the when travel with every claim.
function claimOf(c) { return { text: c.text, more: c.more || '', entry: c.entry || c.text }; }
function claimNode(c) {
  return el('div', {}, [el('span', { class: 'claim-text', text: c.text }), c.more ? el('div', { class: 'claim-more', text: c.more }) : null]);
}

function addClaim(n, c) {
  const claim = claimOf(c);
  ui.claims.hidden = false;
  state.claims[n - 1] = claim;
  if (n <= MAX_CLAIMS) {
    ui.claimsList.append(el('li', {}, [claimNode(claim)]));
    ui.claimsSub.textContent = t('claims.all', { n });
  } else {
    ui.beyond.hidden = false;
    ui.beyondList.append(el('li', {}, [claimNode(claim)]));
    ui.beyondTitle.textContent = t('claims.more', { n: n - MAX_CLAIMS });
    ui.claimsSub.textContent = t('claims.testing', { n: MAX_CLAIMS });
  }
}

function finishExtraction(ev) {
  state.extraction = ev;
  state.claimsRaw = ev.raw || '';
  const all = (ev.claims || []).filter((c) => c.text).map(claimOf);
  state.claims = all;
  const first = all.slice(0, MAX_CLAIMS);
  state.beyond = all.slice(MAX_CLAIMS).map((c, k) => ({ n: MAX_CLAIMS + k + 1, ...c, selected: false, tested: false }));
  ui.claimsList.replaceChildren(...first.map((c, k) => el('li', {}, [buildCard(c, k + 1)])));
  ui.claims.hidden = all.length === 0 && !state.claimsRaw;
  renderClaimsHeadings();
  buildBeyondRows();
  renderClaimsRaw();
  addCost(ev.cost);

  setStep(ui.step1, 'done');
  setBar(ui.bar1, 1, { done: true });
  setStatus('step1', all.length ? 'step1.done' : 'step1.none', { n: all.length, time: fmtSeconds(ev.ms || Date.now() - state.extractStartedAt) });

  if (!all.length) {
    state.phase = 'done';
    setStatus('step2', null);
    ui.run.disabled = false;
    return;
  }
  runBatch(first, [...ui.claimsList.querySelectorAll('.card')]); // the first ten (or fewer) always run, in their rows
}

function renderClaimsHeadings() {
  if (!state.claims.length) return;
  const first = Math.min(state.claims.length, MAX_CLAIMS);
  ui.claimsSub.textContent = state.beyond.length ? t('claims.testing', { n: first }) : t('claims.all', { n: first });
}

function renderClaimsRaw() {
  if (!state.claimsRaw) { ui.claimsRaw.hidden = true; return; }
  ui.claimsRaw.hidden = false;
  ui.claimsRawSummary.textContent = t('claims.raw');
  const reasoning = state.extraction?.reasoning;
  const trail = state.extraction?.trail || [];
  const parts = [];
  if (reasoning) parts.push(`${t('card.details.reasoning')}\n\n${reasoning}`);
  if (trail.length) parts.push(`${t('card.details.trail', { n: trail.length })}\n\n${trail.map((s) => `  ${s.kind}: ${s.query || s.url || s.pattern || ''}`).join('\n')}`);
  parts.push(state.claimsRaw);
  ui.claimsRawBody.textContent = parts.join(`\n\n${'─'.repeat(40)}\n\n`);
}

// ---------- claims beyond the first ten: the reader chooses ------------------------------------

function buildBeyondRows() {
  const items = state.beyond;
  ui.beyond.hidden = items.length === 0;
  if (!items.length) return;
  ui.beyondTitle.textContent = t('claims.more', { n: items.length });
  ui.beyondList.replaceChildren(...items.map((item) => {
    const card = buildCard(item, item.n);
    const box = el('input', { type: 'checkbox', class: 'card-check', 'aria-label': item.text });
    box.addEventListener('change', () => { item.selected = box.checked; renderBeyondTools(); });
    $('.card-head', card).prepend(box);
    item.node = card;
    item.box = box;
    return el('li', {}, [card]);
  }));
  syncBeyondRows();
}

/** The checkboxes follow the state; a tested row is a row like any other. */
function syncBeyondRows() {
  const busy = state.phase === 'evaluating' || state.phase === 'extracting';
  for (const item of state.beyond) {
    if (!item.box) continue;
    item.box.checked = item.selected;
    item.box.disabled = item.tested || busy;
    item.box.hidden = item.tested;
    item.node.classList.toggle('has-check', !item.tested);
  }
  renderBeyondTools();
}

function renderBeyondTools() {
  const open = state.beyond.filter((b) => !b.tested);
  const selected = open.filter((b) => b.selected).length;
  const allSelected = open.length > 0 && selected === open.length;
  const busy = state.phase === 'evaluating' || state.phase === 'extracting';
  ui.selectAll.hidden = open.length === 0;
  ui.selectAll.disabled = busy;
  ui.selectAll.textContent = t(allSelected ? 'claims.clearAll' : 'claims.selectAll');
  ui.testSelected.hidden = open.length === 0;
  ui.testSelected.disabled = selected === 0 || busy;   // it counts the choice; testing them is parked (see boot)
  ui.testSelected.textContent = t('claims.testSelected', { n: selected });
  let hint = '';
  if (busy) hint = t('claims.afterFirst');
  else if (state.accounting && averageCost() !== null) hint = t('claims.avgCost', { usd: fmtUsd(averageCost()) });
  ui.beyondHint.textContent = hint;
}

function toggleSelectAll() {
  const open = state.beyond.filter((b) => !b.tested);
  const allSelected = open.length > 0 && open.every((b) => b.selected);
  for (const b of open) b.selected = !allSelected;
  syncBeyondRows();
}

async function testSelected() {
  if (state.phase === 'evaluating' || state.phase === 'extracting') return;
  const chosen = state.beyond.filter((b) => !b.tested && b.selected);
  if (!chosen.length) return;
  for (const b of chosen) { b.tested = true; b.selected = false; }
  syncBeyondRows();
  // The server tests at most ten per request; larger selections run in consecutive batches.
  for (let i = 0; i < chosen.length; i += MAX_CLAIMS) {
    const chunk = chosen.slice(i, i + MAX_CLAIMS);
    await runBatch(chunk.map(claimOf), chunk.map((b) => b.node));
    if (state.phase !== 'done') break; // a failure or reset stops the queue
  }
}

function averageCost() {
  const done = state.results.filter((r) => r.status === 'done' && r.cost?.priced);
  if (!done.length) return null;
  return done.reduce((s, r) => s + (r.cost.usd || 0), 0) / done.length;
}

// ---------- step 2: one batch of determinations ---------------------------------------------------

async function runBatch(claims, nodes) {
  const start = state.cards.length;
  state.cards.push(...claims);
  for (const _ of claims) state.results.push(newResult());
  nodes.forEach((node, k) => { node.dataset.index = String(start + k); node.dataset.state = 'pending'; });
  state.batch = { start, size: claims.length, done: 0 };
  state.phase = 'evaluating';
  state.evalStartedAt = Date.now();

  ui.step2Title.textContent = start === 0 ? t('step2.title', { n: claims.length }) : t('step2.more', { n: claims.length });
  setStep(ui.step2, 'running');
  setBar(ui.bar2, 0);
  setStatus('step2', 'step2.progress', { done: 0, total: claims.length });
  const evalTick = setInterval(updateEvalStatus, 500);
  state.timers.push(evalTick);
  ui.scoreboard.hidden = false;
  ui.scorePhase.hidden = true;
  ui.run.disabled = true;
  renderScoreboard();
  syncBeyondRows();
  for (let k = 0; k < claims.length; k++) renderCardStatus(start + k);

  const tick = setInterval(updateEvalBars, 250);
  state.timers.push(tick);
  // One request per claim, IN_FLIGHT of them at once (the operator's rule; the server's gate goes
  // on pacing OpenAI across requests). A response then lasts one claim, never a batch, well inside
  // what a host allows, and a cut costs one claim's attempt, which is requested again.
  const signal = state.abort.signal;
  const queue = claims.map((_, k) => start + k);
  const settled = () => { state.batch.done++; updateEvalStatus(); renderScoreboard(); };
  const worker = async () => {
    while (queue.length && !signal.aborted && state.phase === 'evaluating') {
      await runClaim(queue.shift(), signal, { keepGoing: () => state.phase === 'evaluating', onSettled: settled });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, claims.length) }, worker));
    if (state.phase === 'evaluating') finishBatch({ ms: Date.now() - state.evalStartedAt });
  } finally {
    clearInterval(tick);
  }
}

/**
 * One claim, as one job at the server, on its own stream. The stream ends with the claim's result
 * (`done`, or an error of its own). A cut connection (the browser's network, a relay on the way)
 * is opened again by api.js against the same job, which went on meanwhile, and only what the row
 * has not yet received arrives; the row says it is going again until it has. A deploy ends the
 * server the job was on: the next connection finds no such job and the claim starts over there.
 * A refusal of the request itself (no key, no prompt) ends the run, as it always did.
 */
async function runClaim(i, signal, { keepGoing = () => true, onSettled = () => {} } = {}) {
  const claim = state.cards[i];
  const r = state.results[i];
  for (;;) {
    r.jobId = api.newJobId(`${state.runId || 'run'}-c${i}`);
    state.jobs.add(r.jobId);
    const job = r.jobId;
    let settled = false;
    let runFailure = null;
    const onEvent = (ev) => {
      if (ev.t === 'batch-start' || ev.t === 'batch-progress' || ev.t === 'complete') return;
      if (ev.t === 'error' && ev.i === undefined) { runFailure = ev; return; }
      if (ev.t === 'done' || (ev.t === 'error' && ev.i !== undefined)) settled = true;
      handleEvalEvent(ev, () => i);
    };
    try {
      await api.evaluate({
        jobId: job, claims: [claim.entry || claim.text], text: state.source, source: state.sourceMeta, signal, onEvent,
        // Whatever the row was saying (queued at the gate, inspecting, writing), it says the connection
        // was cut until a new one is open, then goes back to what it was saying.
        onCut: () => { if (!settled && r.phase !== 'reconnecting') { r.cutFrom = r.phase; r.phase = 'reconnecting'; renderCardStatus(i); } },
        onAttached: () => { if (r.phase === 'reconnecting') { r.phase = r.cutFrom || 'pending'; r.cutFrom = null; renderCardStatus(i); } },
      });
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) return;
      if (err instanceof api.ApiError) { failRun(err); return; }   // the server refused the request itself
    } finally {
      releaseJob(job);
    }
    if (signal.aborted || !keepGoing()) return;
    if (runFailure) { failRun(runFailure); return; }
    if (settled) { onSettled(); return; }
    // The job ended without a result for the claim (the server it was on went away): the claim
    // goes again as a new job, a second on, and only its attempt is lost.
    r.phase = 'reconnecting';
    renderCardStatus(i);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function handleEvalEvent(ev, mapIndex) {
  if (ev.t === 'error' && ev.i === undefined) { failRun(ev); return; }
  if (ev.t === 'warning') { addWarning(ev); return; }
  if (ev.t === 'gate') { state.gate = ev; renderGateLine(); return; }
  if (ev.t === 'batch-start') return;
  if (ev.t === 'batch-progress') {
    state.batch.done = Math.max(state.batch.done, ev.completed);
    updateEvalStatus();
    renderScoreboard();
    return;
  }
  if (ev.t === 'complete') { finishBatch(ev); return; }
  const i = mapIndex(ev.i);
  const r = state.results[i];
  if (!r) return;
  switch (ev.t) {
    case 'start':
      r.status = 'running'; r.phase = 'starting'; r.startedAt = Date.now(); r.text = ''; r.reasoning = ''; r.chars = 0;
      r.trail = []; r.sources = [];
      setCardState(i, 'running'); renderCardStatus(i);
      break;
    case 'phase':
      if (ev.phase === 'incomplete') { r.incomplete = ev.reason || 'incomplete'; }
      else if (ev.phase === 'queued') { r.phase = 'queued'; r.queuedUntil = ev.waitMs ? Date.now() + ev.waitMs : 0; r.queuePosition = ev.position || 0; renderCardStatus(i); updateEvalStatus(); }
      else if (r.phase !== 'writing') { r.phase = ev.phase; renderCardStatus(i); }
      break;
    case 'reasoning':
      r.reasoning += ev.text;
      if (r.phase !== 'writing') { r.phase = 'reasoning'; renderCardStatus(i); }
      break;
    case 'delta':
      r.text += ev.text; r.chars = r.text.length;
      if (r.phase !== 'writing') { r.phase = 'writing'; renderCardStatus(i); }
      scheduleEntryRender(i);
      break;
    case 'trail': r.trail.push(ev.step); renderCardStatus(i); break;
    case 'source': r.sources.push(ev.source); break;
    case 'note': if (ev.code === 'no_reasoning_summary') r.noSummary = true; break;
    case 'retry':
      r.phase = 'retry'; r.retryAttempt = ev.attempt; r.retryStatus = ev.status ?? null;
      r.retryReason = ev.reason || null; r.retryUntil = Date.now() + (ev.waitMs || 0);
      r.retryCode = ev.code || null; r.retryWhy = ev.why || null; r.retrySince = ev.since || Date.now();
      renderCardStatus(i); updateEvalStatus();
      break;
    case 'done': finalizeCard(i, ev); break;
    case 'error': r.status = 'error'; r.phase = 'error'; r.error = ev.message; r.errorCode = ev.code || null; setCardState(i, 'error'); renderCardStatus(i); renderCardError(i); break;
    default: break;
  }
}

function finishBatch(ev) {
  state.phase = 'done';
  setStep(ui.step2, 'done');
  setBar(ui.bar2, 1, { done: true });
  setStatus('step2', 'step2.done', { total: state.batch.size, time: fmtSeconds(ev.ms || Date.now() - state.evalStartedAt) });
  ui.run.disabled = false;
  if (state.batch.start === 0) ui.report.hidden = false;   // the first ten are tested: the report can be asked for
  renderScoreboard();
  syncBeyondRows();
}

function failRun(err) {
  const code = err?.code || '';
  let message;
  if (code === 'source_too_long') message = `${t('errors.sourceTooLong')} ${err?.message || ''}`;
  else if (err?.status === 401 || code === 'invalid_key' || code === 'missing_key') message = t('errors.key');
  else if (code === 'key_not_sendable') message = t('errors.keyUnusable');
  else if (code === 'no_operator_key') message = t('errors.noKey');
  else if (err?.status === 429) message = t('errors.rate');
  else if (code === 'prompt_missing') message = t('errors.prompt');
  else if (code === 'code_used_up') message = err.message;   // the server's own sentence: how many runs the code had, how many it allows
  else if (err instanceof TypeError) message = t('errors.server');
  else message = t('errors.generic', { message: err?.message || code || '' });
  toast(message, { error: true, ms: 9000 });
  // A message that disappears is no use. The failure also stays on the page until the next run,
  // and is reported to the server so /check can show it afterwards.
  showFailure(message, err);
  api.reportFailure({ where: state.phase || 'run', code, status: err?.status, message: err?.message || message, detail: err?.detail })
    .catch(() => { /* reporting a failure must never cause one */ });
  if (state.phase === 'extracting') { setStep(ui.step1, 'idle'); setStatus('step1', null); setBar(ui.bar1, 0); }
  if (state.phase === 'evaluating') { setStatus('step2', 'step2.stopped'); }
  state.phase = 'done';
  ui.run.disabled = false;
  syncBeyondRows();
}

function updateEvalBars() {
  if (state.phase !== 'evaluating') return;
  let running = 0;
  const now = Date.now();
  const { start, size } = state.batch;
  for (let i = start; i < start + size; i++) {
    const r = state.results[i];
    if (!r) continue;
    if (r.phase === 'queued') { renderCardStatus(i); continue; }
    if (r.status !== 'running') continue;
    if (r.phase === 'retry') renderCardStatus(i);
    const elapsed = now - r.startedAt;
    let f;
    if (r.phase === 'starting') f = easeTime(elapsed, 4000, 0.08);
    else if (r.phase === 'writing') f = 0.48 + easeChars(r.chars, 4500, 0.47);
    else f = 0.08 + easeTime(elapsed, 90000, 0.4);
    f = Math.min(0.96, f);
    running += f;
    setBar(cardOf(i).querySelector('.bar'), f);
  }
  setBar(ui.bar2, Math.min(0.99, (state.batch.done + running) / (size || 1)));
}

// ---------- cards ---------------------------------------------------------------------------

function cardOf(i) { return document.querySelector(`.card[data-index="${i}"]`); }

function buildCard(claim, n) {
  const node = ui.cardTpl.content.firstElementChild.cloneNode(true);
  $('.card-n', node).textContent = String(n).padStart(2, '0');
  $('.card-claim', node).textContent = claim.text;
  if (claim.more) $('.card-claim', node).append(el('span', { class: 'card-more', text: claim.more }));
  $('.card-status', node).textContent = t('card.pending');
  // The row's place in the run is known only once its batch starts; everything reads it then.
  const idx = () => Number(node.dataset.index);
  $('.btn-challenge', node).textContent = t('card.challenge');
  $('.btn-challenge', node).addEventListener('click', () => toggleChallenge(idx()));
  $('.btn-retry', node).textContent = t('card.retryBtn');
  $('.btn-retry', node).addEventListener('click', () => retryClaim(idx()));
  const copy = $('.btn-copy', node);
  copy.textContent = t('card.copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(state.results[idx()]?.text || '');
    toast(t(ok ? 'card.copied' : 'card.copyFailed'), { error: !ok });
  });
  // The row opens and closes in place. Closed, it is the claim, the verdict and the conclusion
  // behind it; open, it is everything the run produced. Controls inside never toggle it.
  const head = $('.card-head', node);
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', 'false');
  const toggle = (e) => { if (e.target.closest('button, a, input, label, textarea')) return; toggleCard(node); };
  head.addEventListener('click', toggle);
  $('.card-brief', node).addEventListener('click', toggle);
  // An open row closes on a click or tap anywhere in its length (the operator's ask of 18
  // September: at the end of a long entry the way back up is far), and the next row comes into
  // view, since that is where the reader goes next. Controls, links, the fold-out summaries and
  // a text selection in progress are left alone.
  node.addEventListener('click', (e) => {
    if (!node.classList.contains('is-open')) return;
    if (e.target.closest('button, a, input, label, textarea, select, summary')) return;
    if (head.contains(e.target) || $('.card-brief', node).contains(e.target)) return;   // the head has its own toggle
    if (window.getSelection?.()?.toString()) return;
    toggleCard(node);
    const li = node.closest('li');
    const next = li?.nextElementSibling?.querySelector('.card') || null;
    (next || node).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  head.addEventListener('keydown', (e) => { if (e.target === head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleCard(node); } });
  wireChallengeForm(node, idx);
  return node;
}

function toggleCard(node) {
  const open = node.classList.toggle('is-open');
  $('.card-head', node).setAttribute('aria-expanded', String(open));
}

/** The closed row's line: the Conclusion section behind the verdict, in the model's own words. */
function renderBrief(i) {
  const r = state.results[i];
  const brief = $('.card-brief', cardOf(i));
  const text = r.conclusion || (r.verdict ? '' : t('card.noteUnread'));
  brief.textContent = text;
  brief.hidden = !text;
}

function setCardState(i, stateName) {
  const card = cardOf(i);
  card.dataset.state = stateName;
  if (stateName === 'running') $('.entry', card).hidden = false;
}

function renderCardStatus(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const map = { pending: 'card.pending', starting: 'card.starting', reasoning: 'card.reasoning', searching: 'card.searching', writing: 'card.writing', reconnecting: 'card.reconnecting', error: 'card.error' };
  let text;
  if (r.phase === 'queued') {
    const s = r.queuedUntil ? Math.max(0, Math.ceil((r.queuedUntil - Date.now()) / 1000)) : 0;
    text = t('card.queued') + (s > 0 ? ` · ${s} s` : '');
  } else if (r.phase === 'retry' && r.retryReason === 'rate_limit') text = t('card.waitingLimit', { s: Math.max(0, Math.ceil(((r.retryUntil || 0) - Date.now()) / 1000)) });
  else if (r.phase === 'retry' && r.retryReason === 'connection') text = t('card.waitingConnection', { why: netWords(r.retryCode, r.retryWhy), time: fmtSeconds(Date.now() - (r.retrySince || Date.now())) });
  else if (r.phase === 'retry') text = t('card.retry', { n: r.retryAttempt || 1 });
  else if (r.phase === 'searching' && r.trail.length) text = t('card.searchingN', { n: r.trail.length });
  else text = t(map[r.phase] || 'card.pending');
  $('.card-status', card).textContent = text;
}

function scheduleEntryRender(i) {
  const r = state.results[i];
  const now = Date.now();
  if (now - r.renderAt < 140) { if (!r.renderTimer) r.renderTimer = setTimeout(() => { r.renderTimer = null; renderEntry(i); }, 150); return; }
  renderEntry(i);
}

function renderEntry(i) {
  const r = state.results[i];
  r.renderAt = Date.now();
  const entry = $('.entry', cardOf(i));
  entry.innerHTML = renderMarkdown(r.text); // the complete text, never a slice of it
  entry.hidden = false;
}

function finalizeCard(i, ev) {
  const r = state.results[i];
  if (r.renderTimer) { clearTimeout(r.renderTimer); r.renderTimer = null; }
  Object.assign(r, {
    status: 'done', phase: 'done',
    text: ev.text || r.text,
    reasoning: ev.reasoning || r.reasoning || '',
    verdict: ev.verdict || null, verdictSource: ev.verdictSource || 'none',
    confidence: ev.confidence ?? null, inspector: ev.inspector || null, conclusion: ev.conclusion || null,
    cost: ev.cost || null, ms: ev.ms ?? null,
    model: ev.model || null, requested: ev.requested || null, fellBack: ev.fellBack || null, effort: ev.effort || null, mode: ev.mode || null,
    trail: ev.trail?.length ? ev.trail : r.trail, sources: ev.sources?.length ? ev.sources : r.sources,
    incomplete: ev.incomplete || r.incomplete || null,
  });
  const card = cardOf(i);
  card.classList.remove('verdict-true', 'verdict-false', 'verdict-unverified', 'verdict-unread');
  card.classList.add(`verdict-${r.verdict || 'unread'}`);
  card.dataset.state = 'done';
  renderEntry(i);
  renderBrief(i);
  renderBadge(i);
  renderCardDetail(i);
  renderCardNote(i);
  renderCardFoot(i);

  if (r.verdict) state.counts[r.verdict] = (state.counts[r.verdict] || 0) + 1;
  else state.unread++;
  addCost(r.cost);
  renderScoreboard(r.verdict);
}

function renderBadge(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const badge = $('.badge', card);
  const kind = r.verdict || 'unread';
  $('.badge-glyph', badge).textContent = GLYPH[kind] || '';
  $('.badge-text', badge).textContent = r.verdict ? t(`score.${r.verdict}`) : t('card.verdictUnread');
  badge.hidden = false;
  let conf = $('.conf', card);
  if (r.confidence !== null && r.confidence !== undefined) {
    if (!conf) { conf = el('span', { class: 'hint conf' }); $('.card-verdict', card).prepend(conf); }
    conf.textContent = t('card.confidence', { n: r.confidence });
  } else if (conf) conf.remove();
}

/** Anything the run produced that is not the entry itself: reasoning, searches, sources, raw text. */
function renderCardDetail(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const detail = $('.card-detail', card);
  detail.hidden = false;

  const reasoning = $('.card-reasoning', card);
  if (r.reasoning) {
    reasoning.hidden = false;
    $('.raw-summary', reasoning).textContent = t('card.details.reasoning');
    $('.reasoning-body', reasoning).textContent = r.reasoning;
  } else reasoning.hidden = true;

  const trail = $('.card-trail', card);
  if (r.trail?.length) {
    trail.hidden = false;
    $('.raw-summary', trail).textContent = t('card.details.trail', { n: r.trail.length });
    $('.trail-list', trail).replaceChildren(...r.trail.map((s) => {
      const what = s.query ? `“${s.query}”` : s.url || s.pattern || s.kind;
      return el('li', {}, [el('span', { class: 'trail-kind mono', text: s.kind || 'search' }), el('span', { text: what })]);
    }));
  } else trail.hidden = true;

  const sources = $('.card-sources', card);
  if (r.sources?.length) {
    sources.hidden = false;
    $('.raw-summary', sources).textContent = t('card.details.sources', { n: r.sources.length });
    $('.sources-list', sources).replaceChildren(...r.sources.map((s) =>
      el('li', {}, [el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title || s.url })])));
  } else sources.hidden = true;

  const raw = $('.card-raw', card);
  $('.raw-summary', raw).textContent = t('card.details.raw', { n: fmtNumber(r.text.length) });
  $('.raw-entry', raw).textContent = r.text;
}

function renderCardNote(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const note = $('.card-note', card);
  const parts = [];
  if (!r.verdict) parts.push(t('card.noteUnread'));
  if (r.incomplete) parts.push(t('card.noteIncomplete', { reason: r.incomplete }));
  if (r.noSummary) parts.push(t('card.noteNoSummary'));
  note.textContent = parts.join(' ');
  note.hidden = parts.length === 0;
}

function renderCardFoot(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const foot = $('.card-foot', card);
  foot.hidden = false;
  const insp = $('.card-inspector', card);
  insp.replaceChildren();
  if (r.inspector) insp.append(`${t('card.inspector')}: `, el('b', { text: r.inspector }));
  // Which model actually answered, always: a downgrade must never pass unnoticed.
  const modelNode = $('.card-model', card);
  if (r.model) {
    modelNode.textContent = t('card.modelLine', { model: r.model, effort: [r.effort, r.mode].filter(Boolean).join(' / ') });
    modelNode.classList.toggle('is-fallback', Boolean(r.fellBack));
    modelNode.title = r.fellBack ? t('warn.modelFallback', { used: r.fellBack.used, requested: r.fellBack.requested }) : '';
  } else modelNode.textContent = '';
  const costNode = $('.card-cost', card);
  if (state.accounting && r.status === 'done') {
    const parts = [];
    if (r.cost) parts.push(r.cost.priced ? t('card.cost', { usd: fmtUsd(r.cost.usd) }) : t('card.costUnknown'));
    if (r.trail?.length) parts.push(t('card.searches', { n: r.trail.length }));
    if (r.ms) parts.push(fmtSeconds(r.ms));
    costNode.textContent = parts.join(' · ');
    costNode.hidden = false;
  } else costNode.hidden = true;
  $('.btn-copy', card).textContent = t('card.copy');
  $('.btn-copy', card).hidden = r.status !== 'done';
  $('.btn-challenge', card).textContent = t('card.challenge');
  $('.btn-retry', card).hidden = r.status !== 'error';
}

function renderCardError(i) {
  const r = state.results[i];
  const card = cardOf(i);
  let msg = $('.card-error', card);
  if (!msg) { msg = el('p', { class: 'card-error' }); $('.card-head', card).after(msg); }
  // Said in words first; the technical reason follows, so it can be reported.
  const why = r.errorCode === 'quota_exhausted' ? `${t('card.quota')} (${r.error || ''})` : (r.error || '');
  msg.replaceChildren(document.createTextNode(`${t('card.error')} ${why}`.trim()),
    el('button', { type: 'button', class: 'btn btn-small btn-text', text: t('card.retryBtn'), onclick: () => retryClaim(i) }));
  $('.card-brief', card).hidden = true;
  const foot = $('.card-foot', card);
  foot.hidden = false;
  $('.btn-challenge', card).hidden = true;
  $('.btn-copy', card).hidden = true;
  $('.btn-retry', card).hidden = false;
  $('.btn-retry', card).textContent = t('card.retryBtn');
}

async function retryClaim(i) {
  const r = state.results[i];
  if (!r || r.status === 'running' || state.phase === 'evaluating') return;
  const card = cardOf(i);
  $('.card-error', card)?.remove();
  $('.card-brief', card).hidden = true;
  $('.btn-retry', card).hidden = true;
  $('.btn-challenge', card).hidden = false;
  $('.card-foot', card).hidden = true;
  Object.assign(r, { status: 'running', phase: 'starting', startedAt: Date.now(), text: '', reasoning: '', chars: 0, error: null, trail: [], sources: [], jobId: null, cutFrom: null });
  setCardState(i, 'running');
  renderCardStatus(i);
  const tick = setInterval(() => {
    if (r.status !== 'running') return;
    if (r.phase === 'retry') renderCardStatus(i);
    const elapsed = Date.now() - r.startedAt;
    const f = r.phase === 'writing' ? 0.48 + easeChars(r.chars, 4500, 0.47) : 0.08 + easeTime(elapsed, 90000, 0.4);
    setBar(card.querySelector('.bar'), Math.min(0.96, f));
  }, 250);
  const controller = state.abort || new AbortController();
  try {
    await runClaim(i, controller.signal);
  } finally {
    clearInterval(tick);
    renderScoreboard();
  }
}

// ---------- scoreboard and export ---------------------------------------------------------------

function renderScoreboard(bumped) {
  ui.scoreTrue.textContent = fmtNumber(state.counts.true);
  ui.scoreFalse.textContent = fmtNumber(state.counts.false);
  ui.scoreUnv.textContent = fmtNumber(state.counts.unverified);
  ui.scoreUnreadWrap.hidden = state.unread === 0;
  ui.scoreUnread.textContent = fmtNumber(state.unread);
  ui.scoreInternal.hidden = !state.accounting;
  ui.scoreCost.textContent = fmtUsd(state.cost) + (state.unpriced ? '+' : '');
  if (bumped) bump({ true: ui.scoreTrue, false: ui.scoreFalse, unverified: ui.scoreUnv }[bumped]);
}

// ---------- challenge -------------------------------------------------------------------------

const MAX_CHALLENGE_FILES = 5;
const MAX_CHALLENGE_BYTES = 20 * 1024 * 1024;

function wireChallengeForm(card, idx) {
  const form = $('.challenge', card);
  const files = [];
  const input = $('.challenge-file', form);
  const list = $('.challenge-list', form);
  const count = $('.challenge-count', form);

  const renderFiles = () => {
    list.replaceChildren(...files.map((f, idx) => el('li', {}, [f.name, el('button', { type: 'button', 'aria-label': `${t('challenge.removeFile')} ${f.name}`, text: '×', onclick: () => { files.splice(idx, 1); renderFiles(); } })])));
    count.textContent = t('challenge.attached', { n: files.length, max: MAX_CHALLENGE_FILES });
  };
  const labels = () => {
    $('.challenge-title', form).textContent = t('challenge.title');
    $('.challenge-lede', form).textContent = t('challenge.lede', { n: MAX_CHALLENGE_FILES });
    $('.challenge-text', form).placeholder = t('challenge.placeholder');
    $('.challenge-attach-label', form).textContent = t('challenge.attach');
    $('.challenge-submit', form).textContent = t('challenge.submit');
    $('.challenge-cancel', form).textContent = t('challenge.cancel');
    renderFiles();
  };
  form.relabel = labels;
  labels();

  input.addEventListener('change', () => {
    for (const f of Array.from(input.files || [])) {
      if (files.length >= MAX_CHALLENGE_FILES) { toast(t('challenge.tooMany', { n: MAX_CHALLENGE_FILES }), { error: true }); break; }
      if (f.size > MAX_CHALLENGE_BYTES) { toast(t('challenge.tooLarge', { name: f.name }), { error: true }); continue; }
      files.push(f);
    }
    input.value = '';
    renderFiles();
  });
  $('.challenge-cancel', form).addEventListener('click', () => closeChallenge(idx(), { clear: false }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('.challenge-text', form).value.trim();
    if (!message && !files.length) { toast(t('challenge.empty'), { error: true }); return; }
    const i = idx();
    const r = state.results[i];
    const submit = $('.challenge-submit', form);
    submit.disabled = true;
    try {
      // Every step runs for real; the server withholds only the final call to OpenAI.
      await api.challenge({ claim: state.cards[i].text, verdict: r?.verdict, originalEntry: r?.text, message, files });
      files.length = 0;
      $('.challenge-text', form).value = '';
      closeChallenge(i, { clear: true });
    } catch (err) {
      toast(t('errors.generic', { message: err.message }), { error: true });
    } finally {
      submit.disabled = false;
    }
  });
}

function toggleChallenge(i) {
  const form = $('.challenge', cardOf(i));
  form.hidden = !form.hidden;
  if (!form.hidden) { form.relabel?.(); $('.challenge-text', form).focus(); }
}

function closeChallenge(i, { clear }) {
  const form = $('.challenge', cardOf(i));
  if (clear) { $('.challenge-text', form).value = ''; $('.challenge-list', form).replaceChildren(); }
  form.hidden = true;
}

// ---------- visual echo -----------------------------------------------------------------------

async function startEcho(text) {
  ui.echo.hidden = false;
  ui.echoShimmer.hidden = false;
  ui.echoImg.hidden = true;
  const signal = state.abort.signal;
  try {
    const r = await api.illustrate({ text, signal });
    if (signal.aborted) return;
    const src = r?.dataUrl || r?.url;
    if (!src) { ui.echo.hidden = true; return; }
    state.echo = r;
    addCost(r.cost);
    renderScoreboard();
    ui.echoImg.onload = () => {
      ui.echoShimmer.hidden = true;
      ui.echoImg.hidden = false;
    };
    ui.echoImg.src = src;
  } catch {
    if (!signal.aborted) ui.echo.hidden = true;
  }
}

// ---------- locale changes: re-render everything that carries state ---------------------------

function refreshDynamicText() {
  ui.langSelect.value = currentLocale();
  renderNav();
  updateSourceMeta();
  for (const which of ['step1', 'step2']) { const s = state.status[which]; if (s) setStatus(which, s.key, s.params); }
  renderGateLine();
  ui.step2Title.textContent = state.batch.start > 0 ? t('step2.more', { n: state.batch.size }) : t('step2.title', { n: state.batch.size || MAX_CLAIMS });
  renderWarnings();
  renderClaimsHeadings();
  syncBeyondRows();
  renderClaimsRaw();
  renderScoreboard();
  state.results.forEach((r, i) => {
    if (r.status === 'done') { renderBadge(i); renderCardDetail(i); renderCardNote(i); renderCardFoot(i); }
    else renderCardStatus(i);
    if (r.status === 'error') renderCardError(i);
    $('.challenge', cardOf(i))?.relabel?.();
  });
}

boot();
