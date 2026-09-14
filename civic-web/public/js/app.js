// CIVIC main page. One state machine: idle → extracting → (review) → evaluating → done.
import { t, setLocale, initLocale, LOCALES, currentLocale, fmtNumber, fmtCompact, fmtSeconds } from './i18n.js';
import * as api from './api.js';
import * as demo from './demo.js';
import { $, $$, el, renderMarkdown, setBar, toast, easeChars, easeTime, bump } from './render.js';

const MAX_CLAIMS = 20;
const GLYPH = { true: '✓', false: '✕', unverified: '?' };

const state = {
  phase: 'idle',
  demo: false,
  key: '',
  server: null,       // /api/health payload, or null when no server answers (static preview)
  source: '',
  claims: [],
  tested: [],
  beyond: [],
  results: [],
  counts: { true: 0, false: 0, unverified: 0 },
  tokens: 0,
  completed: 0,
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
    keystrip: $('#keystrip'), keyForm: $('#key-form'), keyInput: $('#key-input'), keyRemember: $('#key-remember'), keyHint: $('#key-hint'),
    keyOpen: $('#btn-key-open'), keyChange: $('#btn-key-change'), keyRemove: $('#btn-key-remove'), keyCancel: $('#btn-key-cancel'), keyToggle: $('#btn-key-toggle'),
    source: $('#source-text'), sourceFile: $('#source-file'), sourceMeta: $('#source-meta'),
    optReview: $('#opt-review'), optEcho: $('#opt-echo'), run: $('#btn-run'), sample: $('#btn-sample'),
    runSection: $('#run'), demoNote: $('#demo-note'),
    step1: $('#step-extract'), step1Status: $('#step1-status'), bar1: $('#bar-extract'),
    step2: $('#step-eval'), step2Title: $('#step2-title'), step2Status: $('#step2-status'), bar2: $('#bar-eval'),
    echo: $('#echo'), echoImg: $('#echo-img'), echoShimmer: $('#echo-shimmer'),
    claims: $('#claims'), claimsSub: $('#claims-sub'), claimsList: $('#claims-list'), beyond: $('#claims-beyond'), beyondTitle: $('#claims-beyond-title'), beyondList: $('#claims-beyond-list'),
    confirmWrap: $('#claims-confirm'), confirm: $('#btn-confirm'),
    scoreboard: $('#scoreboard'), scoreTrue: $('#score-true'), scoreFalse: $('#score-false'), scoreUnv: $('#score-unverified'), scoreTested: $('#score-tested'), scoreTokens: $('#score-tokens'),
    results: $('#results'), resetTop: $('#btn-reset-top'), reset: $('#btn-reset'),
    langSelect: $('#lang-select'), signin: $('#btn-signin'), signup: $('#btn-signup'),
    cardTpl: $('#tpl-card'),
  });
}

// ---------- boot ----------------------------------------------------------------------------

const demoRequested = () =>
  new URLSearchParams(location.search).get('demo') === '1' || location.hash === '#demo' || Boolean(document.querySelector('meta[name="civic-mode"][content="demo"]'));

async function boot() {
  cacheElements();
  for (const l of LOCALES) ui.langSelect.append(el('option', { value: l.code, text: l.name }));
  initLocale();
  ui.langSelect.value = currentLocale();
  ui.langSelect.addEventListener('change', () => setLocale(ui.langSelect.value));
  document.addEventListener('civic:locale', refreshDynamicText);

  wireKeyStrip();
  wireIntake();
  ui.signin.addEventListener('click', () => toast(t('nav.soon')));
  ui.signup.addEventListener('click', () => toast(t('nav.soon')));
  ui.resetTop.addEventListener('click', resetAll);
  ui.reset.addEventListener('click', resetAll);
  ui.confirm.addEventListener('click', () => { if (state.phase === 'review') startEvaluation(); });

  try {
    state.server = await api.health();
  } catch {
    state.server = null; // static preview or server down; the sample run still works
  }

  if (demoRequested()) {
    ui.source.value = demo.SAMPLE_TEXT;
    updateSourceMeta();
    setTimeout(() => startRun({ demoMode: true }), 500);
  }
}

// ---------- key strip -----------------------------------------------------------------------

function wireKeyStrip() {
  refreshKeyStrip();
  ui.keyOpen.addEventListener('click', () => openKeyForm());
  ui.keyChange.addEventListener('click', () => openKeyForm());
  ui.keyCancel.addEventListener('click', () => closeKeyForm());
  ui.keyToggle.addEventListener('click', () => {
    const show = ui.keyInput.type === 'password';
    ui.keyInput.type = show ? 'text' : 'password';
    ui.keyToggle.textContent = t(show ? 'key.hide' : 'key.show');
  });
  ui.keyRemove.addEventListener('click', () => {
    api.keyStore.clear();
    refreshKeyStrip();
    toast(t('key.removed'));
  });
  ui.keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = ui.keyInput.value.trim();
    if (!api.keyStore.looksValid(key)) { toast(t('key.invalid'), { error: true }); ui.keyInput.focus(); return; }
    api.keyStore.set(key, ui.keyRemember.checked);
    ui.keyInput.value = '';
    closeKeyForm();
    refreshKeyStrip();
    toast(t('key.saved'));
  });
}

function refreshKeyStrip() {
  const key = api.keyStore.get();
  const active = Boolean(key);
  for (const n of $$('.key-state-missing', ui.keystrip)) n.hidden = active;
  for (const n of $$('.key-state-active', ui.keystrip)) n.hidden = !active;
  if (active) ui.keyHint.textContent = `sk-…${key.slice(-4)}`;
}

function openKeyForm({ attention = false } = {}) {
  ui.keyForm.hidden = false;
  ui.keystrip.classList.toggle('is-attention', attention);
  if (attention) setTimeout(() => ui.keystrip.classList.remove('is-attention'), 1200);
  ui.keystrip.scrollIntoView({ behavior: 'smooth', block: 'center' });
  ui.keyInput.focus();
}
function closeKeyForm() { ui.keyForm.hidden = true; ui.keystrip.classList.remove('is-attention'); }

function requireKey() {
  const key = api.keyStore.get();
  if (key) return key;
  toast(t('key.needed'));
  openKeyForm({ attention: true });
  return null;
}

// ---------- intake --------------------------------------------------------------------------

function wireIntake() {
  ui.source.addEventListener('input', updateSourceMeta);
  ui.sourceFile.addEventListener('change', async () => {
    const file = ui.sourceFile.files?.[0];
    if (!file) return;
    ui.sourceMeta.textContent = t('intake.reading', { name: file.name });
    try {
      if (!state.server) throw new api.ApiError(0, 'no_server', t('errors.server'));
      const parsed = await api.parseFile(file);
      ui.source.value = parsed.text;
      ui.sourceMeta.textContent = t('intake.loaded', { name: parsed.name, chars: parsed.chars });
      if (parsed.truncated) toast(t('intake.truncated', { n: parsed.chars }));
    } catch (err) {
      updateSourceMeta();
      toast(t('errors.file', { message: err.message }), { error: true });
    } finally {
      ui.sourceFile.value = '';
    }
  });
  ui.run.addEventListener('click', () => startRun({ demoMode: false }));
  ui.sample.addEventListener('click', () => startRun({ demoMode: true }));
}

function updateSourceMeta() {
  const n = ui.source.value.trim().length;
  ui.sourceMeta.textContent = n ? t('intake.chars', { n }) : '';
}

// ---------- the run -------------------------------------------------------------------------

async function startRun({ demoMode }) {
  if (state.phase !== 'idle' && state.phase !== 'done') resetRunState();
  const text = demoMode ? demo.SAMPLE_TEXT : ui.source.value.trim();
  if (!demoMode) {
    if (text.length < 20) { toast(t('intake.empty'), { error: true }); ui.source.focus(); return; }
    if (!state.server) { toast(t('errors.server'), { error: true }); return; }
    if (!state.server.prompts?.extract || !state.server.prompts?.evaluate) { toast(t('errors.prompt'), { error: true }); return; }
    const key = requireKey();
    if (!key) return;
    state.key = key;
  } else {
    ui.source.value = text;
    updateSourceMeta();
  }

  resetRunState();
  state.demo = demoMode;
  state.source = text;
  state.phase = 'extracting';
  state.abort = new AbortController();

  ui.runSection.hidden = false;
  ui.demoNote.hidden = !demoMode;
  ui.run.disabled = true;
  ui.sample.disabled = true;
  ui.runSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (ui.optEcho.checked) startEcho(text);
  await runExtraction(text);
}

function resetRunState() {
  state.abort?.abort();
  for (const id of state.timers) clearInterval(id);
  state.timers = [];
  Object.assign(state, {
    phase: 'idle', claims: [], tested: [], beyond: [], results: [], counts: { true: 0, false: 0, unverified: 0 }, tokens: 0, completed: 0,
    extractStartedAt: 0, extractChars: 0, found: 0, evalStartedAt: 0, status: { step1: null, step2: null },
  });
  ui.claimsList.replaceChildren();
  ui.beyondList.replaceChildren();
  ui.results.replaceChildren();
  ui.claims.hidden = true;
  ui.beyond.hidden = true;
  ui.confirmWrap.hidden = true;
  ui.scoreboard.hidden = true;
  ui.echo.hidden = true;
  ui.echoImg.hidden = true;
  ui.echoImg.removeAttribute('src');
  ui.echoShimmer.hidden = false;
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
  ui.sample.disabled = false;
  ui.source.value = '';
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
      case 'claim': addClaim(ev.n, ev.text); break;
      case 'progress': state.extractChars = ev.chars; state.found = Math.max(state.found, ev.found || 0); setStatus('step1', 'step1.found', { n: state.found }); break;
      case 'retry': setStatus('step1', 'step1.retry'); break;
      case 'done': finished = true; finishExtraction(ev); break;
      case 'error': finished = true; failRun(ev); break;
      default: break;
    }
  };
  try {
    if (state.demo) await demo.demoExtract({ text, onEvent, signal: state.abort.signal });
    else await api.extract({ text, key: state.key, signal: state.abort.signal, onEvent });
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
  const byTime = easeTime(elapsed, 14000, 0.45);
  const byClaims = easeChars(state.found, 10, 0.5);
  setBar(ui.bar1, Math.min(0.94, Math.max(byTime, 0.08 + byClaims + byTime * 0.5)));
}

function addClaim(n, text) {
  ui.claims.hidden = false;
  state.claims[n - 1] = text;
  const li = el('li', { text });
  if (n <= MAX_CLAIMS) {
    ui.claimsList.append(li);
    ui.claimsSub.textContent = t('claims.all', { n });
  } else {
    ui.beyond.hidden = false;
    ui.beyondList.append(li);
    ui.beyondTitle.textContent = t('claims.beyond', { limit: MAX_CLAIMS, n: n - MAX_CLAIMS });
    ui.claimsSub.textContent = t('claims.testing', { n: MAX_CLAIMS });
  }
}

function finishExtraction(ev) {
  const all = (ev.claims || []).map((c) => c.text).filter(Boolean);
  state.claims = all;
  state.tested = all.slice(0, MAX_CLAIMS);
  state.beyond = all.slice(MAX_CLAIMS);
  // Re-render from the authoritative list so the DOM matches exactly.
  ui.claimsList.replaceChildren(...state.tested.map((text) => el('li', { text })));
  ui.beyondList.replaceChildren(...state.beyond.map((text) => el('li', { text })));
  ui.claims.hidden = all.length === 0;
  ui.beyond.hidden = state.beyond.length === 0;
  renderClaimsHeadings();

  setStep(ui.step1, 'done');
  setBar(ui.bar1, 1, { done: true });
  setStatus('step1', all.length ? 'step1.done' : 'step1.none', { n: all.length, time: fmtSeconds(ev.ms || Date.now() - state.extractStartedAt) });

  if (!all.length) {
    state.phase = 'done';
    setStatus('step2', null);
    ui.run.disabled = false; ui.sample.disabled = false;
    return;
  }
  ui.step2Title.textContent = t('step2.title', { n: state.tested.length });
  if (ui.optReview.checked) {
    state.phase = 'review';
    ui.confirmWrap.hidden = false;
    ui.confirm.textContent = t('claims.confirm', { n: state.tested.length });
    ui.confirm.focus();
  } else {
    startEvaluation();
  }
}

function renderClaimsHeadings() {
  if (!state.claims.length) return;
  ui.claimsSub.textContent = state.beyond.length ? t('claims.testing', { n: state.tested.length }) : t('claims.all', { n: state.tested.length });
  ui.beyondTitle.textContent = t('claims.beyond', { limit: MAX_CLAIMS, n: state.beyond.length });
  if (state.phase === 'review') ui.confirm.textContent = t('claims.confirm', { n: state.tested.length });
}

// ---------- step 2: evaluation ----------------------------------------------------------------

async function startEvaluation() {
  state.phase = 'evaluating';
  state.evalStartedAt = Date.now();
  ui.confirmWrap.hidden = true;
  state.results = state.tested.map(() => ({ status: 'pending', phase: 'pending', text: '', chars: 0, startedAt: 0, verdict: null, confidence: null, inspector: null, usage: null, renderAt: 0 }));
  state.counts = { true: 0, false: 0, unverified: 0 };
  state.tokens = 0;
  state.completed = 0;

  setStep(ui.step2, 'running');
  setStatus('step2', 'step2.progress', { done: 0, total: state.tested.length });
  ui.scoreboard.hidden = false;
  renderScoreboard();
  ui.results.replaceChildren(...state.tested.map((claim, i) => buildCard(claim, i)));
  ui.results.firstElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const tick = setInterval(updateEvalBars, 250);
  state.timers.push(tick);

  const onEvent = (ev) => handleEvalEvent(ev, (i) => i);
  try {
    if (state.demo) await demo.demoEvaluate({ claims: state.tested, onEvent, signal: state.abort.signal });
    else await api.evaluate({ claims: state.tested, key: state.key, signal: state.abort.signal, onEvent });
    if (state.phase === 'evaluating') finishEvaluation({ ms: Date.now() - state.evalStartedAt });
  } catch (err) {
    if (err?.name !== 'AbortError') failRun(err);
  } finally {
    clearInterval(tick);
  }
}

function handleEvalEvent(ev, mapIndex) {
  if (ev.t === 'error' && ev.i === undefined) { failRun(ev); return; }
  if (ev.t === 'batch-start' || ev.t === 'batch-progress') {
    if (ev.t === 'batch-progress') { state.completed = Math.max(state.completed, ev.completed); setStatus('step2', 'step2.progress', { done: state.completed, total: state.tested.length }); renderScoreboard(); }
    return;
  }
  if (ev.t === 'complete') { finishEvaluation(ev); return; }
  const i = mapIndex(ev.i);
  const r = state.results[i];
  if (!r) return;
  switch (ev.t) {
    case 'start': r.status = 'running'; r.phase = 'starting'; r.startedAt = Date.now(); r.text = ''; r.chars = 0; setCardState(i, 'running'); renderCardStatus(i); break;
    case 'phase': if (ev.phase === 'incomplete') { r.incomplete = true; } else if (r.phase !== 'writing') { r.phase = ev.phase; renderCardStatus(i); } break;
    case 'delta': r.text += ev.text; r.chars = r.text.length; if (r.phase !== 'writing') { r.phase = 'writing'; renderCardStatus(i); } scheduleEntryRender(i); break;
    case 'retry': r.phase = 'retry'; r.retryAttempt = ev.attempt; renderCardStatus(i); break;
    case 'done': finalizeCard(i, ev); break;
    case 'error': r.status = 'error'; r.phase = 'error'; r.error = ev.message; setCardState(i, 'error'); renderCardStatus(i); renderCardError(i); break;
    default: break;
  }
}

function finishEvaluation(ev) {
  state.phase = 'done';
  setStep(ui.step2, 'done');
  setBar(ui.bar2, 1, { done: true });
  setStatus('step2', 'step2.done', { total: state.tested.length, time: fmtSeconds(ev.ms || Date.now() - state.evalStartedAt) });
  ui.run.disabled = false; ui.sample.disabled = false;
  renderScoreboard();
}

function failRun(err) {
  const code = err?.code || '';
  let message;
  if (err?.status === 401 || code === 'invalid_key' || code === 'missing_key') { message = t('errors.key'); openKeyForm({ attention: true }); }
  else if (err?.status === 429) message = t('errors.rate');
  else if (code === 'prompt_missing') message = t('errors.prompt');
  else if (err instanceof TypeError) message = t('errors.server');
  else message = t('errors.generic', { message: err?.message || code || '' });
  toast(message, { error: true, ms: 7000 });
  if (state.phase === 'extracting') { setStep(ui.step1, 'idle'); setStatus('step1', null); setBar(ui.bar1, 0); }
  if (state.phase === 'evaluating') { setStatus('step2', 'step2.stopped'); }
  state.phase = 'done';
  ui.run.disabled = false; ui.sample.disabled = false;
}

function updateEvalBars() {
  if (state.phase !== 'evaluating') return;
  let running = 0;
  const now = Date.now();
  state.results.forEach((r, i) => {
    if (r.status !== 'running') return;
    const elapsed = now - r.startedAt;
    let f;
    if (r.phase === 'starting') f = easeTime(elapsed, 4000, 0.08);
    else if (r.phase === 'writing') f = 0.48 + easeChars(r.chars, 4500, 0.47);
    else f = 0.08 + easeTime(elapsed, 90000, 0.4);
    f = Math.min(0.96, f);
    running += f;
    setBar(cardOf(i).querySelector('.bar'), f);
  });
  const total = state.tested.length || 1;
  setBar(ui.bar2, Math.min(0.99, (state.completed + running) / total));
}

// ---------- cards ---------------------------------------------------------------------------

function cardOf(i) { return ui.results.children[i]; }

function buildCard(claim, i) {
  const node = ui.cardTpl.content.firstElementChild.cloneNode(true);
  node.dataset.index = String(i);
  $('.card-n', node).textContent = String(i + 1).padStart(2, '0');
  $('.card-claim', node).textContent = claim;
  $('.card-status', node).textContent = t('card.pending');
  $('.btn-challenge', node).textContent = t('card.challenge');
  $('.btn-challenge', node).addEventListener('click', () => toggleChallenge(i));
  $('.btn-retry', node).textContent = t('card.retryBtn');
  $('.btn-retry', node).addEventListener('click', () => retryClaim(i));
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
  const key = r.phase === 'retry' ? 'card.retry' : map[r.phase] || 'card.pending';
  $('.card-status', card).textContent = t(key, { n: r.retryAttempt || 1 });
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
  entry.innerHTML = renderMarkdown(r.text);
  entry.hidden = false;
}

function finalizeCard(i, ev) {
  const r = state.results[i];
  if (r.renderTimer) { clearTimeout(r.renderTimer); r.renderTimer = null; }
  Object.assign(r, { status: 'done', phase: 'done', text: ev.text || r.text, verdict: ev.verdict || 'unverified', confidence: ev.confidence ?? null, inspector: ev.inspector || null, usage: ev.usage || null });
  const card = cardOf(i);
  card.classList.remove('verdict-true', 'verdict-false', 'verdict-unverified');
  card.classList.add(`verdict-${r.verdict}`);
  card.dataset.state = 'done';
  renderEntry(i);
  renderBadge(i);
  renderCardFoot(i);
  if (r.incomplete) toast(t('card.incomplete'));

  state.counts[r.verdict] = (state.counts[r.verdict] || 0) + 1;
  if (r.usage) state.tokens += (r.usage.input || 0) + (r.usage.output || 0);
  renderScoreboard(r.verdict);
}

function renderBadge(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const badge = $('.badge', card);
  if (!r.verdict) { badge.hidden = true; return; }
  $('.badge-glyph', badge).textContent = GLYPH[r.verdict] || '';
  $('.badge-text', badge).textContent = t(`score.${r.verdict}`);
  badge.hidden = false;
  let conf = $('.conf', card);
  if (r.confidence !== null && r.confidence !== undefined) {
    if (!conf) { conf = el('span', { class: 'hint conf' }); $('.card-verdict', card).prepend(conf); }
    conf.textContent = t('card.confidence', { n: r.confidence });
  } else if (conf) conf.remove();
}

function renderCardFoot(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const foot = $('.card-foot', card);
  foot.hidden = false;
  const insp = $('.card-inspector', card);
  insp.replaceChildren();
  if (r.inspector) insp.append(`${t('card.inspector')}: `, el('b', { text: r.inspector }));
  $('.card-tokens', card).textContent = r.usage ? t('card.tokens', { n: fmtCompact((r.usage.input || 0) + (r.usage.output || 0)) }) : '';
  $('.btn-challenge', card).textContent = t('card.challenge');
  $('.btn-retry', card).hidden = r.status !== 'error';
}

function renderCardError(i) {
  const r = state.results[i];
  const card = cardOf(i);
  let msg = $('.card-error', card);
  if (!msg) { msg = el('p', { class: 'card-error' }); $('.card-head', card).after(msg); }
  msg.textContent = `${t('card.error')} ${r.error || ''}`.trim();
  const foot = $('.card-foot', card);
  foot.hidden = false;
  $('.btn-challenge', card).hidden = true;
  $('.btn-retry', card).hidden = false;
  $('.btn-retry', card).textContent = t('card.retryBtn');
  state.completed = Math.min(state.tested.length, state.completed);
}

async function retryClaim(i) {
  const r = state.results[i];
  if (!r || r.status === 'running') return;
  const card = cardOf(i);
  $('.card-error', card)?.remove();
  $('.btn-retry', card).hidden = true;
  $('.btn-challenge', card).hidden = false;
  $('.card-foot', card).hidden = true;
  Object.assign(r, { status: 'running', phase: 'starting', startedAt: Date.now(), text: '', chars: 0, error: null });
  setCardState(i, 'running');
  renderCardStatus(i);
  if (state.phase === 'done') { state.phase = 'evaluating'; setStep(ui.step2, 'running'); state.completed = Math.max(0, state.completed - 1); const tick = setInterval(updateEvalBars, 250); state.timers.push(tick); }
  const controller = state.abort || new AbortController();
  const onEvent = (ev) => { if (ev.t === 'batch-progress' || ev.t === 'complete' || ev.t === 'batch-start') return; handleEvalEvent(ev, () => i); };
  try {
    if (state.demo) await demo.demoEvaluate({ claims: [state.tested[i]], onEvent, signal: controller.signal });
    else await api.evaluate({ claims: [state.tested[i]], key: state.key, signal: controller.signal, onEvent });
  } catch (err) {
    if (err?.name !== 'AbortError') { r.status = 'error'; r.phase = 'error'; r.error = err.message; setCardState(i, 'error'); renderCardStatus(i); renderCardError(i); }
  } finally {
    if (r.status === 'done') state.completed = Math.min(state.tested.length, state.completed + 1);
    setStatus('step2', 'step2.progress', { done: state.completed, total: state.tested.length });
    if (state.results.every((x) => x.status === 'done' || x.status === 'error')) finishEvaluation({ ms: Date.now() - state.evalStartedAt });
  }
}

// ---------- scoreboard ------------------------------------------------------------------------

function renderScoreboard(bumped) {
  ui.scoreTrue.textContent = fmtNumber(state.counts.true);
  ui.scoreFalse.textContent = fmtNumber(state.counts.false);
  ui.scoreUnv.textContent = fmtNumber(state.counts.unverified);
  const done = state.results.filter((r) => r.status === 'done').length;
  ui.scoreTested.textContent = `${done}/${state.tested.length || MAX_CLAIMS}`;
  ui.scoreTokens.textContent = fmtCompact(state.tokens);
  if (bumped) bump({ true: ui.scoreTrue, false: ui.scoreFalse, unverified: ui.scoreUnv }[bumped]);
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
    list.replaceChildren(...files.map((f, idx) => el('li', {}, [f.name, el('button', { type: 'button', 'aria-label': `${t('key.remove')} ${f.name}`, text: '×', onclick: () => { files.splice(idx, 1); renderFiles(); } })])));
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
      if (state.demo) await demo.demoChallenge({ signal: state.abort?.signal });
      else await api.challenge({ key: state.key, claim: state.tested[i], verdict: r?.verdict, originalEntry: r?.text, message, files });
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
    const r = state.demo ? await demo.demoIllustrate({ signal }) : await api.illustrate({ text, key: state.key, signal });
    if (signal.aborted) return;
    const src = r?.dataUrl || r?.url;
    if (!src) { ui.echo.hidden = true; return; }
    ui.echoImg.onload = () => { ui.echoShimmer.hidden = true; ui.echoImg.hidden = false; };
    ui.echoImg.src = src;
  } catch {
    if (!signal.aborted) ui.echo.hidden = true;
  }
}

// ---------- locale changes: re-render everything that carries state ---------------------------

function refreshDynamicText() {
  ui.langSelect.value = currentLocale();
  refreshKeyStrip();
  ui.keyToggle.textContent = t(ui.keyInput.type === 'password' ? 'key.show' : 'key.hide');
  updateSourceMeta();
  for (const which of ['step1', 'step2']) { const s = state.status[which]; if (s) setStatus(which, s.key, s.params); }
  ui.step2Title.textContent = t('step2.title', { n: state.tested.length || MAX_CLAIMS });
  renderClaimsHeadings();
  renderScoreboard();
  state.results.forEach((r, i) => {
    if (r.status === 'done') { renderBadge(i); renderCardFoot(i); } else { renderCardStatus(i); }
    if (r.status === 'error') { renderCardError(i); }
    const form = $('.challenge', cardOf(i));
    form?.relabel?.();
    $('.btn-challenge', cardOf(i)).textContent = t('card.challenge');
  });
}

boot();
