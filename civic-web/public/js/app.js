// CIVIC main page. One state machine: idle → extracting → evaluating → done.
//
// Two rules this file exists to keep:
//   1. Nothing runs that the reader did not submit. There is no sample, no seeded text, no
//      preloaded result. The page is empty until a document is given to it.
//   2. Nothing the model returns is summarised, trimmed or hidden. The entry is rendered whole,
//      and the reasoning summary, the search trail, the cited sources and the raw text are all
//      on the card. When the verdict cannot be read from the model's own Conclusion, the card
//      says so instead of guessing.
import { t, setLocale, initLocale, LOCALES, currentLocale, fmtNumber, fmtCompact, fmtSeconds, fmtUsd } from './i18n.js';
import * as api from './api.js';
import { $, $$, el, renderMarkdown, setBar, toast, easeChars, easeTime, bump, download, copyText } from './render.js';

const MAX_CLAIMS = 20; // the automatic run; anything beyond is the reader's explicit choice
const GLYPH = { true: '✓', false: '✕', unverified: '?', unread: '–' };

const state = {
  phase: 'idle',
  server: null,        // /api/health payload, or null when no server answers
  accounting: true,    // operator view: tokens and estimated cost per claim
  source: '',
  warnings: [],   // anything that could have cost a claim, shown at the top of the run
  claims: [],
  claimsRaw: '',
  beyond: [],          // { n, text, selected, tested }
  cards: [],           // claims that have cards, in card order: the first 20, then chosen extras
  results: [],
  extraction: null,
  echo: null,
  batch: { start: 0, size: 0, done: 0 },
  counts: { true: 0, false: 0, unverified: 0 },
  unread: 0,
  tokens: 0,
  cost: 0,
  unpriced: false,
  abort: null,
  timers: [],
  extractStartedAt: 0,
  extractChars: 0,
  found: 0,
  evalStartedAt: 0,
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
    step2: $('#step-eval'), step2Title: $('#step2-title'), step2Status: $('#step2-status'), bar2: $('#bar-eval'),
    echo: $('#echo'), echoImg: $('#echo-img'), echoShimmer: $('#echo-shimmer'), echoCap: $('#echo-cap'),
    intake: $('#intake'), intakeSummary: $('#intake-summary'), intakeSummaryText: $('#intake-summary-text'), showText: $('#btn-show-text'),
    scoreSourceTitle: $('#score-source-title'), scoreSourceSub: $('#score-source-sub'), scorePhase: $('#score-phase'), claimsFrom: $('#claims-from'),
    claims: $('#claims'), claimsSub: $('#claims-sub'), claimsList: $('#claims-list'),
    beyond: $('#claims-beyond'), beyondTitle: $('#claims-beyond-title'), beyondList: $('#claims-beyond-list'), beyondHint: $('#claims-beyond-hint'),
    selectAll: $('#btn-select-all'), testSelected: $('#btn-test-selected'),
    claimsRaw: $('#claims-raw'), claimsRawSummary: $('#claims-raw-summary'), claimsRawBody: $('#claims-raw-body'),
    scoreboard: $('#scoreboard'), scoreTrue: $('#score-true'), scoreFalse: $('#score-false'), scoreUnv: $('#score-unverified'),
    scoreTested: $('#score-tested'), scoreTokens: $('#score-tokens'), scoreUnread: $('#score-unread'), scoreUnreadWrap: $('#score-unread-wrap'),
    scoreInternal: $('#score-internal'), scoreCost: $('#score-cost'), export: $('#btn-export'),
    buildStamp: $('#build-stamp'),
    results: $('#results'), resetTop: $('#btn-reset-top'), reset: $('#btn-reset'),
    langSelect: $('#lang-select'), signin: $('#btn-signin'), signup: $('#btn-signup'),
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
  ui.signin.addEventListener('click', () => toast(t('nav.soon')));
  ui.signup.addEventListener('click', () => toast(t('nav.soon')));
  ui.resetTop.addEventListener('click', resetAll);
  ui.reset.addEventListener('click', resetAll);
  ui.selectAll.addEventListener('click', toggleSelectAll);
  ui.testSelected.addEventListener('click', testSelected);
  ui.export.addEventListener('click', exportRun);

  // The launcher opens the page at a one-off address so a browser holding an older copy of the page
  // cannot serve it back instead of asking the server. Tidy that marker out of the address bar.
  if (new URLSearchParams(location.search).has('fresh')) {
    try { history.replaceState(null, '', location.pathname); } catch { /* not important */ }
  }

  try {
    state.server = await api.health();
    if (ui.buildStamp && state.server?.build) ui.buildStamp.textContent = `build ${state.server.build}`;
    state.accounting = Boolean(state.server.accounting);
  } catch {
    state.server = null;
  }
}

// ---------- key strip -----------------------------------------------------------------------

// There is no key strip, no key form and no stored key. CIVIC runs on the operator's key, held by
// the server. A reader's key is never accepted, because a prompt run on someone else's key is a
// prompt handed to them, and that is the one thing this product must never do.

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
  ui.sourceMeta.textContent = t('intake.readingUrl', { host });
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
    ui.sourceMeta.textContent = '';
    const code = err?.code || '';
    const known = ['url_no_transcript', 'url_forbidden', 'url_private', 'url_timeout', 'url_unreachable',
      'url_not_web', 'url_too_big', 'url_no_text', 'url_not_text', 'url_status', 'url_redirects', 'url_empty'];
    toast(known.includes(code) ? err.message : t('errors.url', { message: err?.message || code }), { error: true, ms: 9000 });
    return false;
  } finally {
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
  };
}

function resetRunState() {
  state.failure = null;
  state.extractReasoning = '';
  state.extractSearches = 0;
  if (ui.step1Thinking) { ui.step1Thinking.hidden = true; ui.step1ThinkingBody.textContent = ''; ui.step1Thinking.open = false; }
  ui.bar1.classList.remove('is-waiting');
  state.abort?.abort();
  for (const id of state.timers) clearInterval(id);
  state.timers = [];
  Object.assign(state, {
    phase: 'idle', warnings: [], claims: [], claimsRaw: '', beyond: [], cards: [], results: [], extraction: null, echo: null,
    batch: { start: 0, size: 0, done: 0 }, counts: { true: 0, false: 0, unverified: 0 }, unread: 0,
    tokens: 0, cost: 0, unpriced: false,
    extractStartedAt: 0, extractChars: 0, found: 0, evalStartedAt: 0, status: { step1: null, step2: null },
  });
  ui.runWarnings.replaceChildren();
  ui.runWarnings.hidden = true;
  ui.claimsList.replaceChildren();
  ui.beyondList.replaceChildren();
  ui.results.replaceChildren();
  ui.claims.hidden = true;
  ui.beyond.hidden = true;
  ui.claimsRaw.hidden = true;
  ui.claimsRaw.open = false;
  ui.scoreboard.hidden = true;
  ui.export.hidden = true;
  ui.echo.hidden = true;
  ui.echoImg.hidden = true;
  ui.echoImg.removeAttribute('src');
  ui.echoShimmer.hidden = false;
  ui.echoCap.hidden = true;
  setStep(ui.step1, 'idle'); setBar(ui.bar1, 0);
  setStep(ui.step2, 'idle'); setBar(ui.bar2, 0);
  setStatus('step1', null); setStatus('step2', null);
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
  const throttled = state.results.filter((r) => r.status === 'running' && r.phase === 'retry' && r.retryStatus === 429).length;
  const elapsed = fmtSeconds(Date.now() - state.evalStartedAt);
  if (throttled) {
    setStatus('step2', 'step2.throttled', { n: throttled, done: state.batch.done, total: state.batch.size, time: elapsed });
  } else if (running) {
    setStatus('step2', 'step2.running', { running, done: state.batch.done, total: state.batch.size, time: elapsed });
  } else {
    setStatus('step2', 'step2.progress', { done: state.batch.done, total: state.batch.size });
  }
}

function renderWarnings() {
  ui.runWarnings.hidden = state.warnings.length === 0 && !state.failure;
  const rows = [];
  if (state.failure) {
    const li = el('li', { className: 'run-failure' });
    li.append(el('strong', { text: state.failure.message }));
    if (state.failure.detail && state.failure.detail !== state.failure.message) {
      li.append(el('span', { className: 'run-failure-detail', text: ` ${state.failure.detail}` }));
    }
    const link = el('a', { text: t('errors.checkLink'), className: 'run-failure-link' });
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
      case 'retry': setStatus('step1', 'step1.retry'); break;
      case 'warning': addWarning(ev); break;
      case 'phase': if (ev.phase === 'incomplete') toast(t('step1.incomplete'), { error: true, ms: 9000 }); break;
      case 'done': finished = true; finishExtraction(ev); break;
      case 'error': finished = true; failRun(ev); break;
      default: break;
    }
  };
  try {
    await api.extract({ text, source: state.sourceMeta, signal: state.abort.signal, onEvent });
    if (!finished && state.phase === 'extracting') failRun({ code: 'stream_ended', message: 'The connection closed before extraction finished.' });
  } catch (err) {
    if (err?.name !== 'AbortError') failRun(err);
  } finally {
    clearInterval(tick);
  }
}

function updateExtractBar() {
  if (state.phase !== 'extracting') return;
  const elapsed = Date.now() - state.extractStartedAt;

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
function claimOf(c) { return { text: c.text, more: c.more || '' }; }
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
  ui.claimsList.replaceChildren(...first.map((c) => el('li', {}, [claimNode(c)])));
  ui.claims.hidden = all.length === 0 && !state.claimsRaw;
  renderClaimsHeadings();
  renderBeyond();
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
  runBatch(first); // the first 20 (or fewer) always run
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

// ---------- claims beyond the first 20: the reader chooses -------------------------------------

function renderBeyond() {
  const items = state.beyond;
  ui.beyond.hidden = items.length === 0;
  if (!items.length) return;
  ui.beyondTitle.textContent = t('claims.more', { n: items.length });
  const busy = state.phase === 'evaluating' || state.phase === 'extracting';
  ui.beyondList.replaceChildren(...items.map((item) => {
    const box = el('input', { type: 'checkbox', 'aria-label': item.text });
    box.checked = item.selected;
    box.disabled = item.tested || busy;
    box.addEventListener('change', () => { item.selected = box.checked; renderBeyondTools(); });
    return el('li', { class: `selectable${item.tested ? ' is-tested' : ''}` }, [
      box,
      claimNode(item),
      item.tested ? el('span', { class: 'tag', text: t('claims.tested') }) : null,
    ]);
  }));
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
  ui.testSelected.disabled = selected === 0 || busy;
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
  renderBeyond();
}

async function testSelected() {
  if (state.phase === 'evaluating' || state.phase === 'extracting') return;
  const chosen = state.beyond.filter((b) => !b.tested && b.selected);
  if (!chosen.length) return;
  for (const b of chosen) { b.tested = true; b.selected = false; }
  renderBeyond();
  // The server tests at most 20 per request; larger selections run in consecutive batches.
  for (let i = 0; i < chosen.length; i += MAX_CLAIMS) {
    const chunk = chosen.slice(i, i + MAX_CLAIMS).map(claimOf);
    await runBatch(chunk);
    if (state.phase !== 'done') break; // a failure or reset stops the queue
  }
}

function averageCost() {
  const done = state.results.filter((r) => r.status === 'done' && r.cost?.priced);
  if (!done.length) return null;
  return done.reduce((s, r) => s + (r.cost.usd || 0), 0) / done.length;
}

// ---------- step 2: one batch of determinations ---------------------------------------------------

async function runBatch(claims) {
  const start = state.cards.length;
  state.cards.push(...claims);
  for (const _ of claims) state.results.push(newResult());
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
  renderBeyondTools();
  const newCards = claims.map((claim, k) => buildCard(claim, start + k));
  ui.results.append(...newCards);
  newCards[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const tick = setInterval(updateEvalBars, 250);
  state.timers.push(tick);
  const onEvent = (ev) => handleEvalEvent(ev, (i) => start + i);
  try {
    await api.evaluate({ claims: claims.map((c) => c.text), signal: state.abort.signal, onEvent });
    if (state.phase === 'evaluating') finishBatch({ ms: Date.now() - state.evalStartedAt });
  } catch (err) {
    if (err?.name !== 'AbortError') failRun(err);
  } finally {
    clearInterval(tick);
  }
}

function handleEvalEvent(ev, mapIndex) {
  if (ev.t === 'error' && ev.i === undefined) { failRun(ev); return; }
  if (ev.t === 'warning') { addWarning(ev); return; }
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
  renderScoreboard();
  renderBeyondTools();
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
  renderBeyondTools();
}

function updateEvalBars() {
  if (state.phase !== 'evaluating') return;
  let running = 0;
  const now = Date.now();
  const { start, size } = state.batch;
  for (let i = start; i < start + size; i++) {
    const r = state.results[i];
    if (!r || r.status !== 'running') continue;
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

function cardOf(i) { return ui.results.children[i]; }

function buildCard(claim, i) {
  const node = ui.cardTpl.content.firstElementChild.cloneNode(true);
  node.dataset.index = String(i);
  $('.card-n', node).textContent = String(i + 1).padStart(2, '0');
  $('.card-claim', node).textContent = claim.text;
  if (claim.more) $('.card-claim', node).append(el('span', { class: 'card-more', text: claim.more }));
  $('.card-status', node).textContent = t('card.pending');
  $('.btn-challenge', node).textContent = t('card.challenge');
  $('.btn-challenge', node).addEventListener('click', () => toggleChallenge(i));
  $('.btn-retry', node).textContent = t('card.retryBtn');
  $('.btn-retry', node).addEventListener('click', () => retryClaim(i));
  const copy = $('.btn-copy', node);
  copy.textContent = t('card.copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(state.results[i]?.text || '');
    toast(t(ok ? 'card.copied' : 'card.copyFailed'), { error: !ok });
  });
  wireChallengeForm(node, i);
  return node;
}

function setCardState(i, stateName) {
  const card = cardOf(i);
  card.dataset.state = stateName;
  if (stateName === 'running') $('.entry', card).hidden = false;
}

function renderCardStatus(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const map = { pending: 'card.pending', starting: 'card.starting', reasoning: 'card.reasoning', searching: 'card.searching', writing: 'card.writing', error: 'card.error' };
  let text;
  if (r.phase === 'retry') text = t('card.retry', { n: r.retryAttempt || 1 });
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
    confidence: ev.confidence ?? null, inspector: ev.inspector || null,
    usage: ev.usage || null, cost: ev.cost || null, ms: ev.ms ?? null,
    model: ev.model || null, requested: ev.requested || null, fellBack: ev.fellBack || null, effort: ev.effort || null, mode: ev.mode || null,
    trail: ev.trail?.length ? ev.trail : r.trail, sources: ev.sources?.length ? ev.sources : r.sources,
    incomplete: ev.incomplete || r.incomplete || null,
  });
  const card = cardOf(i);
  card.classList.remove('verdict-true', 'verdict-false', 'verdict-unverified', 'verdict-unread');
  card.classList.add(`verdict-${r.verdict || 'unread'}`);
  card.dataset.state = 'done';
  renderEntry(i);
  renderBadge(i);
  renderCardDetail(i);
  renderCardNote(i);
  renderCardFoot(i);

  if (r.verdict) state.counts[r.verdict] = (state.counts[r.verdict] || 0) + 1;
  else state.unread++;
  if (r.usage) state.tokens += (r.usage.input || 0) + (r.usage.output || 0);
  addCost(r.cost);
  renderScoreboard(r.verdict);
  ui.export.hidden = false;
  ui.export.textContent = t('run.export');
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
  const tokens = r.usage ? (r.usage.input || 0) + (r.usage.output || 0) : 0;
  $('.card-tokens', card).textContent = r.usage ? t('card.tokens', { n: fmtCompact(tokens) }) : '';
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
  // A cut connection is said in words first; the technical reason follows, so it can be reported.
  const why = r.errorCode === 'connection_dropped' ? `${t('card.dropped')} (${r.error || ''})` : (r.error || '');
  msg.textContent = `${t('card.error')} ${why}`.trim();
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
  $('.btn-retry', card).hidden = true;
  $('.btn-challenge', card).hidden = false;
  $('.card-foot', card).hidden = true;
  Object.assign(r, { status: 'running', phase: 'starting', startedAt: Date.now(), text: '', reasoning: '', chars: 0, error: null, trail: [], sources: [] });
  setCardState(i, 'running');
  renderCardStatus(i);
  const tick = setInterval(() => {
    if (r.status !== 'running') return;
    const elapsed = Date.now() - r.startedAt;
    const f = r.phase === 'writing' ? 0.48 + easeChars(r.chars, 4500, 0.47) : 0.08 + easeTime(elapsed, 90000, 0.4);
    setBar(card.querySelector('.bar'), Math.min(0.96, f));
  }, 250);
  const controller = state.abort || new AbortController();
  const onEvent = (ev) => { if (ev.t === 'batch-progress' || ev.t === 'complete' || ev.t === 'batch-start') return; handleEvalEvent(ev, () => i); };
  try {
    await api.evaluate({ claims: [state.cards[i].text], signal: controller.signal, onEvent });
  } catch (err) {
    if (err?.name !== 'AbortError') { r.status = 'error'; r.phase = 'error'; r.error = err.message; setCardState(i, 'error'); renderCardStatus(i); renderCardError(i); }
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
  const done = state.results.filter((r) => r.status === 'done').length;
  ui.scoreTested.textContent = `${done}/${state.cards.length || Math.min(MAX_CLAIMS, state.claims.length || MAX_CLAIMS)}`;
  ui.scoreUnreadWrap.hidden = state.unread === 0;
  ui.scoreUnread.textContent = fmtNumber(state.unread);
  ui.scoreTokens.textContent = fmtCompact(state.tokens);
  ui.scoreInternal.hidden = !state.accounting;
  ui.scoreCost.textContent = fmtUsd(state.cost) + (state.unpriced ? '+' : '');
  if (bumped) bump({ true: ui.scoreTrue, false: ui.scoreFalse, unverified: ui.scoreUnv }[bumped]);
}

/** The whole run, in full, as one Markdown file: every entry, every source, every number. */
function exportRun() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const lines = [
    `# CIVIC run — ${new Date().toLocaleString()}`,
    '',
    ...(state.warnings.length ? ['> **Warnings:** ' + state.warnings.map((w) => w.code === 'source_truncated' ? `${w.omitted} characters of the source were not read` : `model fell back to ${w.used} from ${w.requested}`).join('; '), ''] : []),
    `Source: ${describeSource().title}${describeSource().sub ? ` · ${describeSource().sub}` : ''}`,
    `Claims extracted: ${state.claims.length}. Tested: ${state.results.filter((r) => r.status === 'done').length}.`,
    `True ${state.counts.true} · False ${state.counts.false} · Unverified ${state.counts.unverified}` + (state.unread ? ` · verdict unread ${state.unread}` : ''),
    state.accounting ? `Tokens ${state.tokens}. Estimated cost ${fmtUsd(state.cost)}${state.unpriced ? '+' : ''}.` : '',
    '',
    '## Source',
    '',
    '```', state.source, '```',
    '',
    '## Extraction output (verbatim)',
    '',
    '```', state.claimsRaw || '(not captured)', '```',
    '',
    '## Determinations',
    '',
  ];
  state.results.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${state.cards[i].text}`, '');
    if (state.cards[i].more) lines.push(state.cards[i].more, '');
    lines.push(`**Verdict:** ${r.verdict ? t(`score.${r.verdict}`) : t('card.verdictUnread')}` + (r.confidence != null ? ` · ${r.confidence}%` : '') + (r.inspector ? ` · ${r.inspector}` : ''), '');
    if (r.model) lines.push(`_Model: ${r.model}${r.effort ? ` (effort ${r.effort})` : ''}${r.fellBack ? ` — FELL BACK from ${r.fellBack.requested}` : ''}_`, '');
    if (r.incomplete) lines.push(`> Output ended early: ${r.incomplete}`, '');
    lines.push(r.text || `(${r.error || 'no output'})`, '');
    if (r.reasoning) lines.push('#### Reasoning summary', '', r.reasoning, '');
    if (r.trail?.length) lines.push('#### Search trail', '', ...r.trail.map((s) => `- ${s.kind}: ${s.query || s.url || s.pattern || ''}`), '');
    if (r.sources?.length) lines.push('#### Sources cited', '', ...r.sources.map((s) => `- [${s.title}](${s.url})`), '');
    if (state.accounting && r.usage) lines.push(`_tokens in ${r.usage.input} / out ${r.usage.output} (reasoning ${r.usage.reasoning}) · ${r.cost?.priced ? fmtUsd(r.cost.usd) : 'price unknown'} · ${fmtSeconds(r.ms || 0)}_`, '');
    lines.push('---', '');
  });
  download(`civic-run-${stamp}.md`, lines.join('\n'), 'text/markdown');
  toast(t('run.exported'));
}

// ---------- challenge -------------------------------------------------------------------------

const MAX_CHALLENGE_FILES = 5;
const MAX_CHALLENGE_BYTES = 20 * 1024 * 1024;

function wireChallengeForm(card, i) {
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
  $('.challenge-cancel', form).addEventListener('click', () => closeChallenge(i, { clear: false }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('.challenge-text', form).value.trim();
    if (!message && !files.length) { toast(t('challenge.empty'), { error: true }); return; }
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
  ui.echoCap.hidden = true;
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
      if (state.accounting) {
        ui.echoCap.textContent = `${r.model || ''} · ${fmtSeconds(r.ms || 0)}`;
        ui.echoCap.hidden = false;
      }
    };
    ui.echoImg.src = src;
  } catch {
    if (!signal.aborted) ui.echo.hidden = true;
  }
}

// ---------- locale changes: re-render everything that carries state ---------------------------

function refreshDynamicText() {
  ui.langSelect.value = currentLocale();
  updateSourceMeta();
  for (const which of ['step1', 'step2']) { const s = state.status[which]; if (s) setStatus(which, s.key, s.params); }
  ui.step2Title.textContent = state.batch.start > 0 ? t('step2.more', { n: state.batch.size }) : t('step2.title', { n: state.batch.size || MAX_CLAIMS });
  renderWarnings();
  renderClaimsHeadings();
  renderBeyond();
  renderClaimsRaw();
  renderScoreboard();
  if (!ui.export.hidden) ui.export.textContent = t('run.export');
  state.results.forEach((r, i) => {
    if (r.status === 'done') { renderBadge(i); renderCardDetail(i); renderCardNote(i); renderCardFoot(i); }
    else renderCardStatus(i);
    if (r.status === 'error') renderCardError(i);
    $('.challenge', cardOf(i))?.relabel?.();
  });
}

boot();
