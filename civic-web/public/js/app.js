// CIVIC main page. One state machine: idle → extracting → evaluating → done.
//
// Two rules this file exists to keep:
//   1. Nothing runs that the reader did not submit. There is no sample, no seeded text, no
//      preloaded result. The page is empty until a document is given to it.
//   2. Nothing the model returns is summarised or trimmed. The entry is rendered whole, with the
//      sources it cites. The work behind it (the thinking summary, the search trail, the raw text,
//      the listing as written) is on the operator's page alone (1 November; public/js/op.js). When
//      the verdict cannot be read from the model's own Conclusion, the card says so instead of
//      guessing.
import { t, fill, setLocale, initLocale, LOCALES, currentLocale, fmtNumber, fmtSeconds, fmtClock, fmtUsd, numberWord } from './i18n.js';
import * as api from './api.js';
import { $, $$, el, renderMarkdown, renderMath, setBar, toast, easeChars, easeTime, bump, copyText } from './render.js';
import { field } from './field.js';   // the mathematics behind the glass follows the run's phase

const MAX_CLAIMS = 10; // the most one request carries (the page sends one claim per request, so this bounds nothing it does); how many run without a press is the server's figure (autoFirst)
const IN_FLIGHT = 10; // claims in flight at once when no server answers; the server's own figure wins (see inFlight below)
// What a claim's research did, counted from each step's plain word (server/view.js): searches, and pages read.
const workOf = (trail) => {
  let searches = 0;
  let pages = 0;
  for (const s of trail || []) { if (s?.verb === 'open' || s?.verb === 'read' || s?.verb === 'transcript') pages++; else if (s?.verb) searches++; }
  return { searches, pages };
};
const searchCount = (trail) => workOf(trail).searches;
const GLYPH = { true: '✓', false: '✕', unverified: '?', unread: '–' };
// Additions to this page, put here before it starts when the page names them (see the end of this file). Without them
// each does nothing, which is all there is on most pages.
const ext = {
  start() {}, reset() {}, again: () => false, choices: () => null, runsFor: () => [], paint() {}, tools: () => ({ block: false, hint: [] }),
  title: () => '', ask: () => ({}), event: () => false, cardLine: () => '', stepLine: () => '', listingLine: () => '', listingDone() {}, cardDone() {},
  retrying() {}, logParts() {}, foot() {}, named: () => [], mark: () => [], warning: () => '', failureLink: () => '', score() {},
  shown() {}, signOut() {}, detail() {}, listingThinking() {}, noteParts() {},
};

const state = {
  phase: 'idle',
  server: null,        // /api/health payload, or null when no server answers
  session: null,       // { email } once a code has been accepted, when a sign-in is required
  source: '',
  warnings: [],   // anything that could have cost a claim, shown at the top of the run
  claims: [],
  claimsRaw: '',
  beyond: [],          // { n, text, selected, tested }
  cards: [],           // claims that have cards, in card order: the first ten, then chosen extras
  results: [],
  extraction: null,
  echo: null,
  video: null,         // a YouTube source: { id, embeddable, thumbnails } for the picture's box
  copies: null,        // a refused link's copies found elsewhere: { list, publisher, site }, under the box
  copiesAbort: null,   // the search for them while it runs
  parsing: false,      // a file being read into the box (/api/parse)
  batch: { start: 0, size: 0, done: 0 },
  counts: { true: 0, false: 0, unverified: 0 },
  unread: 0,
  abort: null,
  timers: [],
  extractStartedAt: 0,
  extractChars: 0,
  found: 0,
  extractWait: null,   // while the extraction waits for the connection to OpenAI: { code, why, since }
  extractQueued: null, // while the extraction waits its turn at the gate (the key's minute, another reader's turn): { waitMs, at }
  extractCut: false,   // the connection carrying the extraction was cut; it is being opened again
  runId: '',           // this run's name; every job of the run is named after it
  extractJob: '',      // the extraction's job at the server (server/jobs.js)
  jobs: new Set(),     // every job of this run the server may still hold: cancelled on reset, on leaving
  evalStartedAt: 0,
  pricing: null,       // this run's prices, from the server: { tier, freeFacts, priceCents, currency, note }; null = nothing priced
  creditStop: null,    // a claim the reader's credit or monthly limit could not cover: { code, balanceCents, priceCents, limitCents }; no more start
  status: { step1: null, step2: null },
  // The second pass (server/rank.js, 16 October): this run's claims are ranked before they are shown (rankRun); while
  // that runs, `ranking` is { at, claims }; the summary arrives as it is written; once done, `rankedRun` says what the
  // list shows: the headline, the claims it rests on most, and how many more wait behind "Show the other claims".
  rankRun: false, ranking: null, rankedRun: null, summaryText: '', showRest: false,
  streamed: 0,         // the claims shown as the listing streams; one that waits behind "Show the other claims" comes with the finished list
};

const ui = {};
function cacheElements() {
  Object.assign(ui, {
    source: $('#source-text'), sourceFile: $('#source-file'), sourceMeta: $('#source-meta'),
    copies: $('#copies'), copiesStatus: $('#copies-status'), copiesTitle: $('#copies-title'), copiesList: $('#copies-list'),
    optEcho: $('#opt-echo'), run: $('#btn-run'),
    runSection: $('#run'), runWarnings: $('#run-warnings'),
    step1: $('#step-extract'), step1Status: $('#step1-status'), bar1: $('#bar-extract'),
    step2: $('#step-eval'), step2Title: $('#step2-title'), step2Status: $('#step2-status'), bar2: $('#bar-eval'),
    echo: $('#echo'), echoImg: $('#echo-img'), echoShimmer: $('#echo-shimmer'), echoFrame: $('#echo .echo-frame'), rail: $('.rail'),
    intakeLede: $('.intake-lede'), intakeSlow: $('.intake-slow'),
    intake: $('#intake'), intakeSummary: $('#intake-summary'), intakeSummaryText: $('#intake-summary-text'), showText: $('#btn-show-text'),
    scoreSourceTitle: $('#score-source-title'), scoreSourceSub: $('#score-source-sub'), scorePhase: $('#score-phase'), claimsFrom: $('#claims-from'),
    claims: $('#claims'), claimsSub: $('#claims-sub'), claimsList: $('#claims-list'),
    beyond: $('#claims-beyond'), beyondTitle: $('#claims-beyond-title'), beyondList: $('#claims-beyond-list'), beyondHint: $('#claims-beyond-hint'),
    showRest: $('#btn-show-rest'), setAside: $('#claims-set-aside'), summary: $('#summary'), summaryBody: $('#summary-body'),
    selectAll: $('#btn-select-all'), testSelected: $('#btn-test-selected'),
    scoreboard: $('#scoreboard'), scoreTrue: $('#score-true'), scoreFalse: $('#score-false'), scoreUnv: $('#score-unverified'),
    scoreUnread: $('#score-unread'), scoreUnreadWrap: $('#score-unread-wrap'),
    report: $('#btn-report'),
    buildStamp: $('#build-stamp'),
    results: $('#results'), resetTop: $('#btn-reset-top'), reset: $('#btn-reset'),
    langSelect: $('#lang-select'), signin: $('#btn-signin'), signup: $('#btn-signup'), signout: $('#btn-signout'),
    navBalance: $('#nav-balance'), navAccount: $('#nav-account'), balanceLine: $('#balance-line'), priceLine: $('#price-line'),
    accountBox: $('#account-box'), accountLede: $('#account-box-lede'), tabSignup: $('#tab-signup'), tabSignin: $('#tab-signin'),
    formSignup: $('#form-signup'), signupEmail: $('#signup-email'), signupPassword: $('#signup-password'), signupPasswordHint: $('#signup-password-hint'),
    signupAgree: $('#signup-agree'), signupAgreeText: $('#signup-agree-text'), signupNote: $('#signup-note'), signupSubmit: $('#signup-submit'),
    formSignin: $('#form-signin'), signinEmail: $('#signin-email'), signinPassword: $('#signin-password'), signinNote: $('#signin-note'), signinSubmit: $('#signin-submit'),
    cardTpl: $('#tpl-card'),
  });
}

/** Claims at a time: the server's figure, or the constant when no server answered. */
function paceNow() {
  return Math.max(1, Number(state.server?.inFlight) || IN_FLIGHT);
}

/** Claims that run without a press: the server's figure (CIVIC_AUTO_TEST_FIRST); 0 = the reader chooses every one. */
function autoFirst() {
  const v = Number(state.server?.autoTestFirst);
  return Number.isInteger(v) && v >= 0 ? v : MAX_CLAIMS;
}

/**
 * The two intake sentences follow the server's CIVIC_AUTO_TEST_FIRST: with nothing running by itself
 * they say the reader chooses; otherwise that testing starts. They name no figure (the operator's rule
 * of 2 October: a count on the page is development language), so a change of the pace or of the
 * number that runs by itself never puts a stale number on the page. The key is set on the element as
 * well as the text, so a change of language keeps it (i18n.js reads data-i18n). Until the server has
 * answered, the call at boot (pending) says the reader chooses, which is true in every configuration.
 */
function setRunWording({ pending = false } = {}) {
  const auto = pending ? 0 : autoFirst();
  const say = (node, key) => {
    if (!node) return;
    node.dataset.i18n = key;
    delete node.dataset.i18nParams;
    node.textContent = t(key);
  };
  say(ui.intakeLede, auto > 0 ? 'intake.lede' : 'intake.ledeChoose');
  say(ui.intakeSlow, auto > 0 ? 'intake.slow' : 'intake.slowChoose');
  if (ui.step2Title && state.phase !== 'evaluating' && !state.batch?.size) ui.step2Title.textContent = auto > 0 ? t('step2.title', { n: auto }) : t('step2.choose');
}

// ---------- boot ----------------------------------------------------------------------------

async function boot() {
  cacheElements();
  for (const l of LOCALES) ui.langSelect.append(el('option', { value: l.code, text: l.name }));
  initLocale();
  setRunWording({ pending: true });   // before anything is painted, so the sentences never show a placeholder, and no figure until the server gives one
  ui.langSelect.value = currentLocale();
  ui.langSelect.addEventListener('change', () => setLocale(ui.langSelect.value));
  document.addEventListener('civic:locale', refreshDynamicText);

  wireIntake();
  wireAccount();
  // The text kept across a load that followed a sign-in, a sign-out (followAccount) or a new version (followBuild), put
  // back once, with what is known of its origin when a link or a file brought it in.
  try {
    const kept = sessionStorage.getItem(KEEP);
    const origin = sessionStorage.getItem(KEEP_ORIGIN);
    sessionStorage.removeItem(KEEP);
    sessionStorage.removeItem(KEEP_ORIGIN);
    if (kept !== null) {
      ui.source.value = kept;
      let from = null;
      try { from = origin ? JSON.parse(origin) : null; } catch { /* the text alone is kept */ }
      if (from?.meta) Object.assign(state, { sourceMeta: from.meta, sourceLink: from.link || null, video: from.video || null, loadedText: kept });
      updateSourceMeta();
      if (from?.line) ui.sourceMeta.textContent = from.line;
    }
  } catch { /* nothing kept */ }
  ui.resetTop.addEventListener('click', resetAll);
  ui.reset.addEventListener('click', resetAll);
  ui.selectAll.addEventListener('click', toggleSelectAll);
  ui.showRest.addEventListener('click', toggleRest);
  // The reader's choice runs (unparked 1 October, with CIVIC_AUTO_TEST_FIRST: what runs without a
  // press is the operator's setting, and the rest is the reader's). The report button still says
  // reports come later.
  ui.testSelected.addEventListener('click', testSelected);
  ext.start();
  ui.report.addEventListener('click', () => toast(t('report.soon')));
  // Leaving the page is the one way, besides Start a new test, that a run is stopped: the server
  // keeps working through a cut connection, so it has to be told when nobody will come back.
  window.addEventListener('pagehide', () => { if (state.jobs.size) api.cancel([...state.jobs], { beacon: true }); });
  // Coming back to the page (from another tab or app, the screen unlocked, or from the browser's back-forward cache): a
  // new version of FactEngine is looked for (followBuild).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') followBuild(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) followBuild(); });

  // The launcher opens the page at a one-off address so a browser holding an older copy of the page
  // cannot serve it back instead of asking the server. Tidy that marker out of the address bar.
  if (new URLSearchParams(location.search).has('fresh')) {
    try { history.replaceState(null, '', location.pathname); } catch { /* not important */ }
  }

  try {
    state.server = await api.health();
    if (ui.buildStamp && state.server?.build) ui.buildStamp.textContent = `build ${state.server.build}`;
    state.session = state.server.access?.session || null;
    pageBuild = OWN_BUILD || state.server?.build || null;
    if (noteBuild(state.server, { atLoad: true })) return;
  } catch {
    state.server = null;
  }
  setRunWording();           // again, now with the server's own figures
  renderNav();
}

// ---------- the account (5 October) -------------------------------------------------------------------

// Sign-up and sign-in (the operator: "We need to establish a sign-up and sign-on process first"). A reader
// creates an account, or signs in, in a box on the page itself: a real form, never laid over anything, so a touch
// screen reaches every field and a password manager offers to fill it. Any action the server refuses for want of a
// sign-in opens the box, and goes on by itself once the reader has an account.
let pendingSignIn = null;   // { promise, resolve, reject } while refused actions wait on the box: one box, however many asked

const required = () => Boolean(state.server?.access?.required);
const grantCents = () => Number(state.server?.access?.grantCents) || 0;
const minChars = () => Number(state.server?.access?.minChars) || 8;

function wireAccount() {
  api.onSignInRequired(requireSignIn);
  ui.signin.addEventListener('click', () => openAccountBox('signin'));
  ui.signup.addEventListener('click', () => openAccountBox('signup'));
  ui.signout.addEventListener('click', signOut);
  ui.tabSignup.addEventListener('click', () => showAccountTab('signup'));
  ui.tabSignin.addEventListener('click', () => showAccountTab('signin'));
  ui.formSignup.addEventListener('submit', submitSignup);
  ui.formSignin.addEventListener('submit', submitSignin);
  for (const b of document.querySelectorAll('.show-password')) b.addEventListener('click', () => togglePassword(b));
  for (const b of document.querySelectorAll('.account-later')) b.addEventListener('click', () => closeAccountBox({ abandon: true }));
  document.addEventListener('civic:locale', renderAccountWords);
  renderAccountWords();
}

/** The agreement, with its two links (opened in a new tab: leaving the page would stop a run), and the box's words. */
function renderAccountWords() {
  const link = (href, key) => el('a', { href, target: '_blank', rel: 'noopener', text: t(key) });
  const parts = t('account.agree').split(/(\{terms\}|\{privacy\})/);
  ui.signupAgreeText.replaceChildren(...parts.map((part) => (part === '{terms}' ? link('terms', 'account.terms') : part === '{privacy}' ? link('privacy', 'account.privacy') : document.createTextNode(part))));
  ui.signupPasswordHint.textContent = t('account.passwordHint', { n: minChars() });
  ui.signupPassword.minLength = minChars();
  if (!ui.accountBox.hidden) ui.accountLede.textContent = t(ui.accountBox.dataset.reason === 'run' ? 'account.ledeRun' : 'account.lede', { amount: fmtMoney(grantCents()) });
}

function showAccountTab(tab) {
  const signup = tab !== 'signin';
  ui.formSignup.hidden = !signup;
  ui.formSignin.hidden = signup;
  ui.tabSignup.setAttribute('aria-selected', String(signup));
  ui.tabSignin.setAttribute('aria-selected', String(!signup));
  ui.tabSignup.classList.toggle('is-on', signup);
  ui.tabSignin.classList.toggle('is-on', !signup);
  ui.signupNote.hidden = true;
  ui.signinNote.hidden = true;
}

/** Opens the box on one of its two forms. After a refused action the keyboard is not raised by the page (a touch screen
    raises it only for a tap), so the box is brought into view and the field waits for the reader's tap. */
function openAccountBox(tab, { reason = '' } = {}) {
  if (!required()) { toast(t('account.open')); return; }
  ui.accountBox.dataset.reason = reason;
  showAccountTab(tab);
  ui.accountBox.hidden = false;
  renderAccountWords();
  ui.accountBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const first = tab === 'signin' ? (ui.signinEmail.value ? ui.signinPassword : ui.signinEmail) : ui.signupEmail;
  try { first.focus({ preventScroll: true }); } catch { /* not important */ }
}

function closeAccountBox({ abandon = false } = {}) {
  ui.accountBox.hidden = true;
  const p = pendingSignIn;
  pendingSignIn = null;
  if (!p || !abandon) return;
  const e = new Error('sign-in abandoned'); e.name = 'AbortError'; p.reject(e);
  // The action that needed the account is abandoned with it: a run in progress stops, the text stays.
  if (state.phase === 'extracting' || state.phase === 'evaluating') {
    if (pageStale) { reloadPage({ keepText: true }); return; }
    const text = ui.source.value;
    resetAll();
    ui.source.value = text;
    updateSourceMeta();
  }
}

/**
 * Called by the API client on a refusal for want of a sign-in, and by Test the facts before it asks the server;
 * resolves once the reader has an account. Two actions refused at once (the extraction and the picture start together)
 * wait on the same promise and the same box, and both go on after one sign-in.
 */
function requireSignIn() {
  if (pendingSignIn) return pendingSignIn.promise;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  pendingSignIn = { promise, resolve, reject };
  openAccountBox(ui.signinEmail.value ? 'signin' : 'signup', { reason: 'run' });
  return promise;
}

/** A refusal said in the reader's language, from its code and figures. */
function accountWords(err) {
  const minutes = Math.max(1, Math.ceil((Number(err?.waitSeconds) || 60) / 60));
  switch (err?.code) {
    case 'email_invalid': return t('account.err.email');
    case 'password_short': return t('account.err.short', { n: minChars() });
    case 'password_long': return t('account.err.long');
    case 'terms_required': return t('account.err.terms');
    case 'email_taken': return t('account.err.taken');
    case 'wrong_password': return t('account.err.wrong');
    case 'tries_wait': return t('account.err.wait', { m: minutes });
    case 'signups_wait': return t('account.err.signupsWait', { m: minutes });
    case 'account_closed': return t('account.err.closed');
    default: return err instanceof TypeError ? t('errors.server') : (err?.message || t('errors.server'));
  }
}

function noteOn(node, text) { node.textContent = text; node.hidden = !text; }

/** Before a form goes, a password shown in clear goes back to dots (a password manager saves it then). */
function hidePasswords(form) {
  for (const input of form.querySelectorAll('input[data-shown="1"]')) { input.type = 'password'; input.dataset.shown = '0'; }
  for (const b of form.querySelectorAll('.show-password')) b.textContent = t('account.show');
}

function togglePassword(button) {
  const input = document.getElementById(button.dataset.for);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  input.dataset.shown = show ? '1' : '0';
  button.textContent = t(show ? 'account.hide' : 'account.show');
}

async function submitSignup(event) {
  event.preventDefault();
  const email = ui.signupEmail.value.trim();
  const password = ui.signupPassword.value;
  if (!email) { noteOn(ui.signupNote, t('account.err.email')); ui.signupEmail.focus(); return; }
  if ([...password].length < minChars()) { noteOn(ui.signupNote, t('account.err.short', { n: minChars() })); ui.signupPassword.focus(); return; }
  if (!ui.signupAgree.checked) { noteOn(ui.signupNote, t('account.err.terms')); return; }
  hidePasswords(ui.formSignup);
  ui.signupSubmit.disabled = true;
  try {
    const out = await api.signup({ email, password, agree: true });
    ui.signinEmail.value = email;
    await signedIn(out.session);
  } catch (err) {
    noteOn(ui.signupNote, accountWords(err));
    if (err?.code === 'email_taken') { ui.signinEmail.value = email; }
  } finally {
    ui.signupSubmit.disabled = false;
  }
}

async function submitSignin(event) {
  event.preventDefault();
  const email = ui.signinEmail.value.trim();
  const password = ui.signinPassword.value;
  if (!email) { noteOn(ui.signinNote, t('account.err.email')); ui.signinEmail.focus(); return; }
  if (!password) { ui.signinPassword.focus(); return; }
  hidePasswords(ui.formSignin);
  ui.signinSubmit.disabled = true;
  try {
    const out = await api.signin({ email, password });
    await signedIn(out.session);
  } catch (err) {
    noteOn(ui.signinNote, accountWords(err));
    ui.signinPassword.select();
  } finally {
    ui.signinSubmit.disabled = false;
  }
}

/** The reader has an account: the box closes, the nav says so, and whatever waited on it goes on. */
async function signedIn(session) {
  state.session = session || null;
  ui.signupPassword.value = '';
  ui.signinPassword.value = '';
  try {
    const h = await api.health();
    state.server = h;
    state.session = h.access?.session || state.session;
  } catch { /* the session stands; the line is read again later */ }
  renderNav();
  renderBeyondTools();
  const p = pendingSignIn;
  pendingSignIn = null;
  ui.accountBox.hidden = true;
  if (followAccount({ now: !p })) return;   // an action waiting on the account goes on; the page follows it later
  p?.resolve();
}

async function signOut() {
  try { await api.signout(); } catch { /* the cookie is gone either way */ }
  state.session = null;
  ext.signOut();
  if (followAccount({ now: true })) return;
  renderNav();
  renderBeyondTools();
}

// The page's parts follow the account (server/assets.js): the operator's page carries the operator's parts, anyone
// else's does not. A sign-in or a sign-out that changes which page this account should have loads the page again: at
// once when nothing is running, else at the next Start a new test, so no run and no result is lost to it. The text in
// the box is kept across the load, with what is known of its origin. A page loads itself again otherwise only for a new
// version of FactEngine (followBuild, below).
const KEEP = 'fe.keep';
const KEEP_ORIGIN = 'fe.keep.origin';   // the kept text's link or file, while the text is still what it brought in
const RELOADED = 'fe.reloaded';         // the build a page was loaded again for (followBuild)
let pageStale = false;
const quiet = () => state.phase === 'idle' && !state.jobs.size && !state.urlAbort && !state.copiesAbort;
function reloadPage({ keepText, forBuild = null }) {
  try {
    if (keepText && ui.source.value) {
      sessionStorage.setItem(KEEP, ui.source.value);
      if (state.loadedText && ui.source.value === state.loadedText) {
        sessionStorage.setItem(KEEP_ORIGIN, JSON.stringify({ meta: state.sourceMeta, link: state.sourceLink || null, video: state.video || null, line: ui.sourceMeta.textContent }));
      } else sessionStorage.removeItem(KEEP_ORIGIN);
    } else {
      sessionStorage.removeItem(KEEP);
      sessionStorage.removeItem(KEEP_ORIGIN);
    }
    if (forBuild) sessionStorage.setItem(RELOADED, forBuild);
    else sessionStorage.removeItem(RELOADED);
  } catch { /* the text is not kept; the page still loads */ }
  location.reload();
}

// A page follows a new version of FactEngine by itself (the operator's answer of 24 October, night: "By itself"): a page
// left open across a release otherwise kept its old code and its old trial entries, and an old copy drew each claim's
// fields under it. The page is the build its script was loaded as (/b/<build>/js/app.js, server/assets.js). It reads the
// health line again when the reader comes back to it and at Start a new test, never on a timer; a server of another
// build is a new version, loaded at once when nothing is on the page, else at the next Start a new test, so no run and
// no result is lost to it. A page loaded again for a build that still finds another (a release under way served it the
// old page) waits for the reader: a load never follows a load by itself.
const OWN_BUILD = (() => { try { return new URL(import.meta.url).pathname.match(/^\/b\/([^/]+)\/js\/app\.js$/)?.[1] || null; } catch { return null; } })();
const RELOADED_FOR = (() => { try { const b = sessionStorage.getItem(RELOADED); sessionStorage.removeItem(RELOADED); return b; } catch { return null; } })();
let pageBuild = OWN_BUILD;
let newBuild = null;   // the server's build, once it is not this page's
// Nothing on the page a load would lose: no run and no result, no copies to choose from, no file being read, and the
// account box closed.
const calm = () => quiet() && !state.copies && !state.parsing && ui.accountBox.hidden;
function noteBuild(h, { atLoad = false } = {}) {
  if (!h?.build || !pageBuild || h.build === pageBuild) return false;
  newBuild = h.build;
  if ((atLoad && RELOADED_FOR === h.build) || !calm()) return false;
  reloadPage({ keepText: true, forBuild: h.build });
  return true;
}
let looking = null;
function followBuild() {
  looking ??= api.health().then((h) => noteBuild(h), () => false).finally(() => { looking = null; });
  return looking;
}
function followAccount({ now }) {
  const fuller = Boolean(document.getElementById('ext-script'));   // the page of the operator's account, its additions named
  pageStale = (!required() || Boolean(state.session?.operator)) !== fuller;
  if (!pageStale || !now || !quiet()) return false;
  reloadPage({ keepText: true });
  return true;
}

/** The balance after a hold, a charge or a release: the nav and the line under the claims say it. */
function setBalance(cents) {
  if (!state.session || !Number.isFinite(cents)) return;
  state.session.balanceCents = cents;
  renderNav();
  renderBeyondTools();
}

let balanceTimer = null;
/** The balance read again from the server (after a batch, a refusal): once, shortly, however many asked. */
function refreshBalance() {
  if (!state.session) return;
  clearTimeout(balanceTimer);
  balanceTimer = setTimeout(async () => {
    try { const out = await api.account(); setBalance(out?.account?.balanceCents); } catch { /* the next one will */ }
  }, 400);
}

/** The nav: Sign in and Sign up signed out; the balance, Account and Sign out signed in. With the door open, none. */
function renderNav() {
  const signedInNow = required() && Boolean(state.session);
  ui.signin.hidden = !required() || signedInNow;
  ui.signup.hidden = !required() || signedInNow;
  ui.signout.hidden = !signedInNow;
  ui.navAccount.hidden = !signedInNow;
  const bal = state.session?.balanceCents;
  ui.navBalance.hidden = !signedInNow || !Number.isFinite(bal);
  ui.navBalance.textContent = Number.isFinite(bal) ? fmtMoney(bal, state.server?.access?.currency) : '';
  ui.navBalance.title = t('account.balanceTitle');
}

// ---------- access -------------------------------------------------------------------------

// A reader signs in with a code and is asked for nothing else.

// ---------- intake --------------------------------------------------------------------------

function wireIntake() {
  ui.source.addEventListener('input', updateSourceMeta);
  ui.source.addEventListener('input', hideCopies);   // a list found for a link no longer in the box is stale
  wireGlow(ui.source);
  ui.showText.addEventListener('click', () => {
    const open = ui.intake.classList.toggle('is-open');
    ui.showText.textContent = t(open ? 'intake.hideText' : 'intake.showText');
  });
  ui.sourceFile.addEventListener('change', async () => {
    const file = ui.sourceFile.files?.[0];
    if (!file) return;
    ui.sourceMeta.textContent = t('intake.reading', { name: file.name });
    state.parsing = true;
    try {
      if (!state.server) throw new api.ApiError(0, 'no_server', t('errors.server'));
      const parsed = await api.parseFile(file);
      ui.source.value = parsed.text;
      state.sourceMeta = { kind: 'file', name: parsed.name };
      state.video = null;
      state.loadedText = parsed.text;
      ui.sourceMeta.textContent = t('intake.loaded', { name: parsed.name, chars: parsed.chars });
      if (parsed.truncated) toast(t('intake.truncated', { n: parsed.chars }), { ms: 7000 });
    } catch (err) {
      updateSourceMeta();
      toast(t('errors.file', { message: err.message }), { error: true });
    } finally {
      state.parsing = false;
      ui.sourceFile.value = '';
    }
  });
  ui.run.addEventListener('click', startRun);
}

/**
 * The text box lights up as it is typed in (31 October: "As you are typing in the box the box dynamically brightens";
 * 1 November, after Apple's Liquid Glass, where the glass lights up where it is touched): each keystroke or paste lifts
 * the light by a fifth, where the cursor is, and a pause lets it settle back to rest. The light is three CSS variables
 * (--glow, 0 to 1, and its place, --gx and --gy; css/civic.css holds every figure of it, the settle time among them),
 * written at most once a frame and only while it moves, so typing is never slowed. Placing it lays out the text before
 * the cursor once more, out of sight; where that took longer than a frame of the display twice in a row, text that long
 * is lit from the box's bright corner instead. With the system's reduced motion, it steps instead of easing.
 */
const GLOW_STEP = 0.2;
// The box's style, copied onto a hidden twin, so the twin lays out the text as the box does and gives the cursor's place;
// its width is the box's own text width, a scroll bar's taken off.
const TWIN_STYLE = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
  'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'tabSize', 'direction', 'wordBreak', 'overflowWrap'];
function wireGlow(box) {
  let glow = 0;        // as painted
  let peak = 0;        // where the last keystroke left it
  let lastAt = 0;
  let frame = 0;
  let stepBack = 0;
  let placed = false;  // the light's place is wanted at the next frame
  let settleMs = 0;
  let frameMs = 1000 / 60;  // a frame of the display: the shortest interval seen between the light's frames
  let lastFrame = 0;
  let slow = 0;             // placings in a row that took longer than a frame
  let tooLong = Infinity;   // text before the cursor at least this long is lit from the corner
  const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const paint = (g) => { glow = g; box.style.setProperty('--glow', g.toFixed(3)); };
  const corner = () => {   // the box's bright top-left corner (css/civic.css)
    box.style.removeProperty('--gx');
    box.style.removeProperty('--gy');
  };
  /** The cursor's place inside the box, as the box shows it now; the box's bright corner when it cannot be read. */
  const place = () => {
    const at = box.selectionEnd ?? box.value.length;
    if (at >= tooLong) return corner();
    const began = performance.now();
    try {
      const cs = getComputedStyle(box);
      const twin = document.createElement('div');
      for (const k of TWIN_STYLE) twin.style[k] = cs[k];
      const across = box.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
      Object.assign(twin.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-99999px', whiteSpace: 'pre-wrap', overflow: 'hidden',
        boxSizing: 'content-box', width: `${Math.max(0, across)}px`, height: 'auto', border: '0' });
      twin.textContent = box.value.slice(0, at);
      const mark = document.createElement('span');
      mark.textContent = box.value.slice(at, at + 1) || '.';
      twin.append(mark);
      document.body.append(twin);
      const x = mark.offsetLeft + mark.offsetWidth / 2;
      const y = mark.offsetTop + mark.offsetHeight / 2 - box.scrollTop;
      twin.remove();
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('no place');
      box.style.setProperty('--gx', `${Math.round(Math.max(0, Math.min(x, box.clientWidth)))}px`);
      box.style.setProperty('--gy', `${Math.round(Math.max(0, Math.min(y, box.clientHeight)))}px`);
    } catch {
      corner();
    }
    slow = performance.now() - began > frameMs ? slow + 1 : 0;
    if (slow > 1) { tooLong = at; slow = 0; }
  };
  const settle = (now) => {
    frame = 0;
    if (lastFrame) frameMs = Math.min(frameMs, now - lastFrame);
    lastFrame = now;
    if (placed) { placed = false; place(); }
    const t = Math.min(1, (now - lastAt) / settleMs);
    paint(t >= 1 ? 0 : peak * (1 - t * t * (3 - 2 * t)));   // eased: it holds a moment, then lets go
    if (glow > 0) frame = requestAnimationFrame(settle);
    else lastFrame = 0;
  };
  box.addEventListener('input', () => {
    settleMs = Number.parseFloat(getComputedStyle(box).getPropertyValue('--type-settle')) || 1000;
    if (calm()) {
      place();
      paint(1);
      clearTimeout(stepBack);
      stepBack = setTimeout(() => paint(0), settleMs);
      return;
    }
    peak = Math.min(1, glow + GLOW_STEP);
    lastAt = performance.now();
    placed = true;
    paint(peak);
    if (!frame) frame = requestAnimationFrame(settle);
  });
}

function updateSourceMeta() {
  const n = ui.source.value.trim().length;
  ui.sourceMeta.textContent = n ? t('intake.chars', { n }) : '';
  // Text typed or pasted over what a link or a file brought in is no longer that link or file.
  if (state.loadedText && ui.source.value !== state.loadedText) { state.sourceMeta = { kind: 'text' }; state.loadedText = ''; state.video = null; }
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

/** Fetches a web address through the server and puts its own words in the box. A `copy` is a page the
 *  search found for a link a site refused (offerCopies): when CIVIC's reader cannot read it either, the
 *  search service's own text of that page goes into the box, and the source says so. A search's text
 *  can be a fragment of the page (seen live on 1 October: 845 characters of a Washington Post article),
 *  so that text waits for the reader, as a marked article does (release G): the run starts only when
 *  they press the button, and the list stays for choosing another. */
async function readLinkIntoBox(url, { copy = null } = {}) {
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
    state.video = got.kind === 'youtube' && got.video ? got.video : null;
    // A page FactEngine's server could not read comes through the search service's reader (`via: 'search'`); its
    // attribution then says so, as a copy's does.
    state.sourceMeta = { kind: 'link', url: got.url, title: got.title || host, author: got.author || '', published: got.published || '', site: got.site || host, ...(got.via === 'search' ? { via: 'search' } : {}) };
    state.loadedText = got.text;
    if (got.wall) {
      // The site marks the article as for subscribers and sent this text, or the search service holds a copy of a page
      // the site marks so (21 October): it is in the box, and the reader decides whether it is the whole article; the run
      // waits for the next press.
      const sentence = t(got.via === 'search' ? 'intake.markedWallCopy' : 'intake.markedWall', { site: got.site || host, button: t('intake.run') });
      ui.sourceMeta.textContent = sentence;
      toast(sentence, { ms: 12000 });
      return false;
    }
    ui.sourceMeta.textContent = t('intake.readUrl', { title: got.title || host, n: fmtNumber(got.chars) });
    if (got.note === 'automatic_captions') toast(t('intake.autoCaptions'), { ms: 7000 });
    return true;
  } catch (err) {
    const code = err?.code || '';
    if (copy && !controller.signal.aborted && String(copy.text || '').trim().length >= 20) {
      // The copy's own site turned CIVIC away too: the search service's text of that page is used.
      ui.source.value = copy.text;
      state.sourceLink = { url: copy.url, title: copy.title || host, kind: 'page' };
      state.video = null;
      state.sourceMeta = { kind: 'link', url: copy.url, title: copy.title || host, author: copy.author || '', published: copy.published || '', site: copy.site || host, via: 'search' };
      state.loadedText = copy.text;
      const sentence = t('intake.copyCheck', { site: copy.site || host, n: fmtNumber(copy.text.length), button: t('intake.run') });
      ui.sourceMeta.textContent = sentence; // under the box, just above the list it refers to; no pop-up to cover the list
      return false;
    }
    const known = ['url_no_transcript', 'url_forbidden', 'url_private', 'url_timeout', 'url_unreachable',
      'url_not_web', 'url_too_big', 'url_no_text', 'url_not_text', 'url_status', 'url_redirects', 'url_empty'];
    // A site that keeps its text from CIVIC is named, in the reader's language, with what to do.
    const site = err?.site || host;
    const own = {
      url_refused: () => t('errors.siteRefused', { site }),
      url_silent: () => t('errors.siteRefused', { site }),
      url_paywall: () => t('errors.sitePaywall', { site }),
      url_shell: () => t('errors.siteShell', { site }),
      url_video_wall: () => t('errors.videoWall'),
    }[code];
    const sentence = own ? own() : known.includes(code) ? err.message : t('errors.url', { message: err?.message || code });
    ui.sourceMeta.textContent = sentence; // stays under the box until the box changes; the toast passes
    // A site that keeps its text from CIVIC: the same article is often published elsewhere, so the server's
    // search service looks for it, when the operator has set one; the reader picks from what it finds. The
    // toast then waits: it would cover the list, and it is shown only if nothing is found.
    if (!copy && SITE_CODES.has(code) && state.server?.findCopies) offerCopies(url, site, sentence);
    else toast(sentence, { error: true, ms: 9000 });
    return false;
  } finally {
    clearInterval(tick);
    state.urlAbort = null;
    ui.run.disabled = false;
  }
}

// ---------- a refused link, found elsewhere ------------------------------------------------

const SITE_CODES = new Set(['url_refused', 'url_silent', 'url_paywall', 'url_shell']);

/** Asks the server's search service for the article a site refused: the same article republished
 *  elsewhere, and other reports of the same story. While it looks, the seconds tick under the box;
 *  what it finds is listed for the reader to pick from. Nothing found, or the search failing, leaves
 *  the site's sentence under the box as it is (the search's own failure is on /check, for the operator). */
async function offerCopies(url, site, sentence = '') {
  hideCopies();
  const controller = new AbortController();
  state.copiesAbort = controller;
  const started = Date.now();
  const showLooking = () => { ui.copiesStatus.textContent = t('copies.looking', { time: fmtSeconds(Date.now() - started) }); };
  ui.copies.hidden = false;
  showLooking();
  const tick = setInterval(showLooking, 1000);
  state.timers.push(tick);
  try {
    const got = await api.findCopies(url, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const list = Array.isArray(got?.copies) ? got.copies : [];
    if (!list.length) { hideCopies(); if (sentence) toast(sentence, { error: true, ms: 9000 }); return; }
    state.copies = { list, publisher: got.publisher || site, site };
    renderCopies();
  } catch {
    if (!controller.signal.aborted) { hideCopies(); if (sentence) toast(sentence, { error: true, ms: 9000 }); }
  } finally {
    clearInterval(tick);
    if (state.copiesAbort === controller) state.copiesAbort = null;
  }
}

/** The list under the box: each copy's headline (a link to the page itself), its site and date, and
 *  whether it says it is the refused paper's own article; the reader picks by the headline. */
function renderCopies() {
  if (!state.copies) return;
  const { list, publisher, site } = state.copies;
  ui.copiesStatus.textContent = '';
  ui.copiesTitle.textContent = t('copies.title', { site });
  ui.copiesList.replaceChildren(...list.map((c) => {
    const when = c.published ? fmtDay(c.published) : '';
    const meta = el('span', { class: 'copy-meta' }, [[c.site, when].filter(Boolean).join(' · ')]);
    if (c.credited) meta.append(el('span', { class: 'copy-credit', text: ` · ${t('copies.republished', { publisher })}` }));
    return el('li', { class: 'copy' }, [
      el('a', { class: 'copy-title', href: c.url, target: '_blank', rel: 'noopener noreferrer', text: c.title || c.site }),
      meta,
      el('button', { type: 'button', class: 'btn btn-outline btn-small copy-test', text: t('copies.test'), onclick: () => useCopy(c) }),
    ]);
  }));
  ui.copies.hidden = false;
}

/** A day as the reader's language writes it ("30 Sept 2026"); the date the page carries, not a guess. */
function fmtDay(ymd) {
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(ymd);
  try { return d.toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return String(ymd).slice(0, 10); }
}

/** The reader picked a copy: it is read like any link (CIVIC's own reader first, the search's text of
 *  that page when its site turns CIVIC away too), and the run starts on it, as the reader asked. */
async function useCopy(copy) {
  const buttons = [...ui.copiesList.querySelectorAll('.copy-test')];
  for (const b of buttons) b.disabled = true;
  ui.source.value = copy.url;
  const ok = await readLinkIntoBox(copy.url, { copy });
  if (ok) { await startRun(); return; }
  for (const b of buttons) b.disabled = false; // the list stays: the copy's text waits in the box, or another can be chosen
}

function hideCopies() {
  state.copiesAbort?.abort();
  state.copiesAbort = null;
  state.copies = null;
  if (!ui.copies) return;
  ui.copies.hidden = true;
  ui.copiesStatus.textContent = '';
  ui.copiesTitle.textContent = '';
  ui.copiesList.replaceChildren();
}

// ---------- the run -------------------------------------------------------------------------

async function startRun() {
  if (!state.server) { toast(t('errors.server'), { error: true }); return; }
  hideCopies();
  // An account comes before anything runs (the operator's answer of 5 October): the box opens here, and the run goes
  // on by itself once the reader has one. Abandoning the box abandons the run.
  if (required() && !state.session) {
    if (ui.source.value.trim().length < 20 && !api.looksLikeUrl(ui.source.value)) { toast(t('intake.empty'), { error: true }); ui.source.focus(); return; }
    try { await requireSignIn(); } catch { return; }
  }

  // A web address in the box is read first, and its text replaces the address, so the reader sees
  // exactly what will be tested before a single claim is extracted.
  if (api.looksLikeUrl(ui.source.value)) {
    const got = await readLinkIntoBox(ui.source.value.trim());
    if (!got) return;
  }

  const text = ui.source.value.trim();
  if (text.length < 20) { toast(t('intake.empty'), { error: true }); ui.source.focus(); return; }
  if (!state.server.ready) { toast(t('errors.prompt'), { error: true }); return; }

  resetRunState();
  state.source = text;
  state.phase = 'extracting';
  field.setPhase('extracting');
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

  // A video source takes the picture's place with its player; otherwise the picture, when asked for.
  if (state.video) showVideo(state.video);
  // The visual echo is off on the operator's word of 19 October: "Just comment it out for now until I decide whether
  // and when to ask for it back." Its code left this file on 31 October (night); it is in the history to bring back.
  await runExtraction(text);
}

function newResult() {
  return {
    status: 'pending', phase: 'pending', text: '', reasoning: '', chars: 0, startedAt: 0,
    verdict: null, verdictSource: 'none', confidence: null, inspector: null, inspectorMark: null,
    ms: null, trail: [], sources: [], incomplete: null,
    jobId: null, cutFrom: null,   // the claim's job at the server, and what the row said before its connection was cut
    free: null, priceCents: null, // what the server said this one costs: one of the document's free ones, or the price
  };
}

function resetRunState() {
  state.failure = null;
  state.creditStop = null;
  state.extractReasoning = '';
  state.extractSearches = 0;
  ui.bar1.classList.remove('is-waiting');
  cancelJobs();
  state.abort?.abort();
  for (const id of state.timers) clearInterval(id);
  state.timers = [];
  Object.assign(state, {
    phase: 'idle', warnings: [], claims: [], claimsRaw: '', beyond: [], cards: [], results: [], extraction: null, echo: null,
    batch: { start: 0, size: 0, done: 0 }, counts: { true: 0, false: 0, unverified: 0 }, unread: 0,
    extractStartedAt: 0, extractChars: 0, found: 0, extractWait: null, extractQueued: null, extractCut: false, bar1At: 0, runId: '', extractJob: '', evalStartedAt: 0, pricing: null, status: { step1: null, step2: null },
    rankRun: false, ranking: null, rankedRun: null, summaryText: '', showRest: false, streamed: 0,
  });
  hideSummary();
  ui.showRest.hidden = true;
  ui.setAside.hidden = true;
  ui.runWarnings.replaceChildren();
  ui.runWarnings.hidden = true;
  ui.claimsList.replaceChildren();
  ui.beyondList.replaceChildren();
  ui.claims.hidden = true;
  ui.beyond.hidden = true;
  ui.scoreboard.hidden = true;
  ui.report.hidden = true;
  ui.echo.hidden = true;
  ui.echoImg.hidden = true;
  ui.echoImg.removeAttribute('src');
  ui.echoShimmer.hidden = false;
  ui.rail.classList.remove('rail--video');
  for (const n of ui.echoFrame.querySelectorAll('.echo-video')) n.remove();
  setStep(ui.step1, 'idle'); setBar(ui.bar1, 0);
  setStep(ui.step2, 'idle'); setBar(ui.bar2, 0);
  setStatus('step1', null); setStatus('step2', null);
  ext.reset();
  ui.step2Title.textContent = autoFirst() > 0 ? t('step2.title', { n: autoFirst() }) : t('step2.choose');
  renderScoreboard();
}

function resetAll() {
  // The page this account should have (followAccount), or a new version of FactEngine (followBuild).
  if (pageStale || newBuild) { reloadPage({ keepText: false, forBuild: newBuild }); return; }
  resetRunState();
  field.setPhase('idle');
  hideCopies();
  state.video = null;
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
  followBuild();   // a new version since the reader came back, looked for with nothing on the page
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

/** The claims run as many at a time as the server says; the status line says how many are running and how many are done. */
function updateEvalStatus() {
  if (state.phase !== 'evaluating' || !state.batch.size) return;
  const running = state.results.filter((r) => r.status === 'running').length;
  const elapsed = fmtSeconds(Date.now() - state.evalStartedAt);
  // The line says the work going on, never what FactEngine works around on its way (31 October, night: "it does not help
  // you or the service to show that it is struggling"); the hooks may say what holds claims back.
  const said = ext.stepLine({ elapsed });
  if (said) ui.step2Status.textContent = said;
  else if (running) setStatus('step2', 'step2.running', { running, done: state.batch.done, total: state.batch.size, time: elapsed });
  else setStatus('step2', 'step2.progress', { done: state.batch.done, total: state.batch.size });
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
    const words = ext.failureLink();
    if (words) {
      const link = el('a', { text: words, class: 'run-failure-link' });
      link.href = 'check';
      li.append(document.createTextNode(' '), link);
    }
    rows.push(li);
  }
  rows.push(...state.warnings.map((w) => {
    let text;
    if (w.code === 'source_truncated') text = t('warn.sourceTruncated', { n: fmtNumber(w.omitted), read: fmtNumber(w.read) });
    else text = ext.warning(w) || w.code;
    return el('li', { text });
  }));
  ui.runWarnings.replaceChildren(...rows);
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
      // A ranked run's claims are counted as they come and shown once, in their order, when the ranking is done; a claim
      // that waits behind "Show the other claims" (a Supporting one, server/extract.js) comes with the finished list.
      case 'claim': if (!state.rankRun && ev.top !== false) addClaim(++state.streamed, ev); break;
      case 'progress': state.extractChars = ev.chars; state.found = Math.max(state.found, ev.found || 0); break;
      case 'reasoning':
        // The listing's thinking (the operator's alone: a reader's page receives none of it).
        state.extractReasoning += ev.text || '';
        ext.listingThinking(state.extractReasoning.trim());
        break;
      case 'trail':
        state.extractSearches = ev.searches || (state.extractSearches + 1);
        break;
      case 'start':   // the request went: the model is reading. A go after a cut one sends its claims again from the first,
        // so what the cut go listed is cleared, never shown twice.
        state.extractWait = null; state.extractQueued = null; if (ev.rank) state.rankRun = true;
        if (state.streamed) clearStreamedClaims();
        break;
      case 'retry':
        // A connection failure is a wait for the connection, kept for the hooks until the next go begins.
        state.extractWait = ev.reason === 'connection' ? { code: ev.code, why: ev.why, since: ev.since || Date.now() } : null;
        break;
      case 'phase':
        if (ev.phase === 'queued') state.extractQueued = { waitMs: ev.waitMs || 0, at: Date.now() };
        if (ev.phase === 'incomplete') toast(t('step1.incomplete'), { error: true, ms: 9000 });
        if (ev.phase === 'ranking') { state.ranking = { at: state.ranking?.at || Date.now(), claims: ev.claims || state.found }; state.extractWait = null; showSummary(); }
        break;
      case 'summary':   // the second pass's summary, in whole lines, as it is written; a go that starts again starts it again
        state.summaryText = ev.reset ? '' : state.summaryText + (ev.delta || '');
        renderSummary();
        break;
      case 'rank-retry':   // the ranking waits, as the listing does; a missing connection is said as such
        state.extractWait = ev.reason === 'connection' ? { code: ev.code, why: ev.why, since: ev.since || Date.now() } : null;
        break;
      case 'warning': addWarning(ev); break;
      case 'pricing': state.pricing = ev; renderBeyondTools(); break;   // this run's tier, free count and price, from the server
      case 'done': finished = true; finishExtraction(ev); break;
      case 'error': finished = true; failRun(ev); break;
      default: break;
    }
  };
  let job = state.extractJob;
  try {
    await api.extract({
      jobId: job, text, source: state.sourceMeta, signal: state.abort.signal, onEvent,
      onCut: () => { state.extractCut = true; },
      onAttached: (ev) => {
        // The server kept the work under an id of its own: from here the page names it by that
        // one, so a later connection, a stop and the let-go all reach the real job.
        if (ev?.job && ev.job !== job) { state.jobs.delete(job); job = ev.job; state.extractJob = job; state.jobs.add(job); }
        state.extractCut = false;
      },
    });
    if (!finished && state.phase === 'extracting') failRun({ code: 'stream_ended', message: 'The connection closed before extraction finished.' });
  } catch (err) {
    if (err?.name !== 'AbortError') failRun(err);
  } finally {
    clearInterval(tick);
    releaseJob(job);   // the job is over, whatever ended it; the server can let go of its record
  }
}

/** The listing's bar never goes back (31 October, night): a listing that goes again keeps the ground it had made. */
function listingBar(f) {
  const was = state.bar1At || 0;
  state.bar1At = Math.min(0.99, f >= was ? f : was + (0.94 - was) * 0.002);
  return state.bar1At;
}

function updateExtractBar() {
  if (state.phase !== 'extracting') return;
  const elapsed = Date.now() - state.extractStartedAt;

  // The line says the work going on, never what FactEngine works around on its way (31 October, night): a cut connection
  // being opened again, a missing one, the listing's turn. The hooks may say so.
  const held = ext.listingLine({ cut: state.extractCut, wait: state.extractWait, queued: state.extractQueued });
  if (held) { ui.bar1.classList.add('is-waiting'); ui.step1Status.textContent = held; return; }

  // The claims are in and are being ranked: the line says so, with the time, until the ranked list is drawn.
  if (state.ranking) {
    ui.bar1.classList.add('is-waiting');
    setBar(ui.bar1, listingBar(0.9 + easeTime(Date.now() - state.ranking.at, 60000, 0.08)));
    setStatus('step1', 'step1.ranking', { time: fmtSeconds(Date.now() - state.ranking.at) });
    return;
  }
  // At high reasoning effort the model thinks for minutes before it writes anything. A bar tuned to
  // seconds reaches its ceiling and sits there, which reads as a dead page. So until the first claim
  // arrives the bar is openly a waiting bar, and the status line counts the time and the searches,
  // which is the truth: the model is working and has not produced a claim yet.
  if (!state.found) {
    ui.bar1.classList.add('is-waiting');
    setBar(ui.bar1, listingBar(0.06 + easeTime(elapsed, 90000, 0.2)));
    setStatus('step1', state.extractSearches ? 'step1.thinkingSearched' : 'step1.thinking',
      { time: fmtSeconds(elapsed), n: state.extractSearches });
    return;
  }
  ui.bar1.classList.remove('is-waiting');
  const byTime = easeTime(elapsed, 45000, 0.45);
  const byClaims = easeChars(state.found, 10, 0.5);
  setBar(ui.bar1, listingBar(Math.min(0.94, Math.max(byTime, 0.08 + byClaims + byTime * 0.5))));
  // No count of claims here (25 October): the list itself says how many can be tested, and nothing else counts them.
  setStatus('step1', 'step1.listing', { time: fmtSeconds(elapsed) });
}

// A claim is the text the listing wrote under its claim label, and only that: it is the row's title
// and it is what is tested. Nothing else the listing wrote with it is shown or sent (the operator, 24
// October: "I don't want the extraction to affect downstream processing in any way"); the listing's
// whole output stays under "Extraction output, verbatim". `top` is false for a claim that waits
// behind "Show the other claims".
function claimOf(c) { return { n: Number.isInteger(c.n) ? c.n : undefined, text: c.text, top: c.top !== false }; }
function claimNode(c) {
  return el('div', {}, [el('span', { class: 'claim-text', text: c.text })]);
}

function addClaim(n, c) {
  const claim = claimOf(c);
  ui.claims.hidden = false;
  state.claims[n - 1] = claim;
  const auto = autoFirst();
  if (n <= auto) {
    ui.claimsList.append(el('li', {}, [claimNode(claim)]));
    ui.claimsSub.textContent = t('claims.all', { n });
  } else {
    ui.beyond.hidden = false;
    ui.beyondList.style.counterReset = `claim ${auto}`;   // the rows go on counting from where the automatic ones stop
    ui.beyondList.append(el('li', {}, [claimNode(claim)]));
    ui.beyondTitle.textContent = t(auto ? 'claims.more' : 'claims.found', { n: n - auto });
    ui.claimsSub.textContent = auto ? t('claims.testing', { n: auto }) : '';
  }
}

/** The claims a cut go of the listing had sent: gone from the page before the next go sends them again. */
function clearStreamedClaims() {
  state.streamed = 0;
  state.claims = [];
  ui.claimsList.replaceChildren();
  ui.beyondList.replaceChildren();
  ui.beyond.hidden = true;
  ui.claimsSub.textContent = '';
}

function finishExtraction(ev) {
  state.extraction = ev;
  state.claimsRaw = ev.raw || '';
  const listed = (ev.claims || []).filter((c) => c.text).map(claimOf);
  const all = ev.ranking?.ok ? rankedClaims(listed, ev.ranking) : splitClaims(listed);
  state.ranking = null;
  if (ev.ranking) { state.summaryText = ev.ranking.summary || ''; if (state.summaryText) showSummary(); else hideSummary(); }
  state.claims = all;
  const auto = autoFirst();
  // What runs without a press comes from what the list shows: on a ranked run, never one of the claims kept back.
  const first = all.filter((c) => c.top !== false).slice(0, auto);
  const running = new Set(first);
  state.beyond = all.filter((c) => !running.has(c)).map((c, k) => ({ n: auto + k + 1, ...c, selected: false, tested: false }));
  ui.claimsList.replaceChildren(...first.map((c, k) => el('li', {}, [tagHeadline(buildCard(c, c.n ?? k + 1), c)])));
  ui.claims.hidden = all.length === 0 && !state.claimsRaw;
  renderClaimsHeadings();
  buildBeyondRows();
  ext.listingDone(ev);   // on the operator's page, the listing as the model wrote it

  setStep(ui.step1, 'done');
  ui.bar1.classList.remove('is-waiting');   // the ranking's waiting stripes, gone with it
  setBar(ui.bar1, 1, { done: true });
  if (state.rankedRun) setStatus('step1', 'step1.listedRanked', { time: fmtSeconds(Date.now() - state.extractStartedAt) });
  else setStatus('step1', all.length ? 'step1.listed' : 'step1.none', { time: fmtSeconds(ev.ms || Date.now() - state.extractStartedAt) });

  if (!first.length) {
    // Nothing found, or nothing runs without a press (CIVIC_AUTO_TEST_FIRST=0): the claims wait for the
    // reader's choice, and the button runs them.
    state.phase = 'done';
    field.setPhase('done');
    setStatus('step2', null);
    ui.scorePhase.hidden = true;   // the extraction is over; the scoreboard stops saying it is extracting
    ui.run.disabled = false;
    syncBeyondRows();
    return;
  }
  runBatch(first, [...ui.claimsList.querySelectorAll('.card')]); // the automatic ones run in their rows
}

/**
 * The list a ranked run shows (server/rank.js): the headline first when it is empirical and was copied word for word,
 * then the claims in their ranked order, the first `keep` of them the ones the document rests on most, then the rest,
 * which wait behind "Show the other claims". Each is numbered by its place in this list, the number the run knows it by.
 */
function rankedClaims(listed, r) {
  const byN = new Map(listed.map((c) => [c.n, c]));
  const items = [];
  if (r.headline?.tested && r.headline.text) items.push({ text: r.headline.text, headline: true, top: true });
  (r.order || []).forEach((n, k) => { const c = byN.get(n); if (c) items.push({ ...c, top: k < r.keep }); });
  state.rankedRun = { keep: r.keep, rest: items.filter((c) => !c.top).length, setAside: (r.notEmpirical || []).length, headline: Boolean(items[0]?.headline) };
  return items.map((c, k) => ({ ...c, n: k + 1 }));
}

/**
 * The list a run of one pass shows (24 October): the claims to show first, then those that wait behind "Show the other
 * claims" (each claim's role, server/extract.js), each numbered by its place in this list, the number the run knows it by.
 * A list that holds none back is the listing's own, as it came.
 */
function splitClaims(listed) {
  const rest = listed.filter((c) => c.top === false);
  if (!rest.length) return listed;
  return [...listed.filter((c) => c.top !== false), ...rest].map((c, k) => ({ ...c, n: k + 1 }));
}

/** The headline's row says it is the headline: the first fact tested, whatever the rest are. */
function tagHeadline(card, claim) {
  if (claim?.headline) $('.card-claim', card).prepend(el('span', { class: 'card-tag', text: t('card.headline') }));
  return card;
}

/** A claim the list shows now: the headline and the top claims always, the rest once the reader asks, a tested one always. */
const shownNow = (b) => b.top !== false || state.showRest || b.tested;

function toggleRest() {
  state.showRest = !state.showRest;
  // The rest folded away again: nothing hidden stays chosen, so the button never counts a claim the reader cannot see.
  if (!state.showRest) for (const b of state.beyond) if (b.top === false && !b.tested) b.selected = false;
  for (const b of state.beyond) { const li = b.node?.closest('li'); if (li && b.top === false) li.hidden = !shownNow(b); }
  syncBeyondRows();
}

function renderRestToggle() {
  const rest = state.beyond.filter((b) => b.top === false && !b.tested).length;
  ui.showRest.hidden = rest === 0;
  ui.showRest.textContent = state.showRest ? t('claims.hideRest') : t('claims.showRest', { n: rest });
  ui.showRest.setAttribute('aria-expanded', state.showRest ? 'true' : 'false');
  const set = state.rankedRun?.setAside || 0;
  ui.setAside.hidden = !set;
  ui.setAside.textContent = set ? t('claims.setAside', { n: set }) : '';
}

/** The heading over the claims to choose from: on a ranked run, what the list is; otherwise how many were found. */
function renderBeyondTitle() {
  const items = state.beyond;
  if (!items.length) return;
  const r = state.rankedRun;
  if (!r) {
    // A list that holds claims back behind "Show the other claims" says what it shows first, as a ranked list does.
    const auto = autoFirst();
    const rest = items.filter((b) => b.top === false).length;
    ui.beyondTitle.textContent = t(auto ? 'claims.more' : rest ? 'claims.ranked' : 'claims.found', { n: items.length - rest });
    return;
  }
  ui.beyondTitle.textContent = r.headline
    ? (r.keep ? t('claims.rankedHead', { n: r.keep }) : t('claims.headlineOnly'))
    : (r.keep ? t('claims.ranked', { n: r.keep }) : t('claims.noneEmpirical'));
}

// The second pass's summary, beside the picture: what the document reports, written as the model writes it.
function showSummary() {
  ui.summary.hidden = false;
  ui.rail.classList.add('has-summary');
  renderSummary();
}
function hideSummary() {
  ui.summary.hidden = true;
  ui.rail.classList.remove('has-summary');
  ui.summaryBody.replaceChildren();
}
function renderSummary() {
  if (ui.summary.hidden) return;
  const text = state.summaryText.trim();
  ui.summaryBody.dataset.waiting = t('summary.writing');
  ui.summaryBody.innerHTML = text ? renderMarkdown(text) : '';
  if (text) renderMath(ui.summaryBody);
}

function renderClaimsHeadings() {
  if (!state.claims.length) return;
  // The claims that run without a press: those shown first, never one waiting behind "Show the other claims".
  const first = state.claims.filter((c) => c.top !== false).slice(0, autoFirst()).length;
  ui.claimsSub.textContent = first === 0 ? '' : (state.beyond.length ? t('claims.testing', { n: first }) : t('claims.all', { n: first }));
}

// ---------- claims beyond the first ten: the reader chooses ------------------------------------

function buildBeyondRows() {
  const items = state.beyond;
  ui.beyond.hidden = items.length === 0;
  if (!items.length) return;
  const auto = autoFirst();
  ui.beyondList.style.counterReset = `claim ${auto}`;
  renderBeyondTitle();
  ui.beyondList.replaceChildren(...items.map((item) => {
    const card = tagHeadline(buildCard(item, item.n), item);
    const box = el('input', { type: 'checkbox', class: 'card-check', 'aria-label': item.text });
    box.addEventListener('change', () => { item.selected = box.checked; renderBeyondTools(); });
    $('.card-head', card).prepend(box);
    item.node = card;
    item.box = box;
    const li = el('li', {}, [card]);
    if (item.top === false) { li.classList.add('is-rest'); li.hidden = !shownNow(item); }
    return li;
  }));
  syncBeyondRows();
}

/**
 * A claim that can be chosen now. Claims are chosen while others are being tested (26 October, the operator: "once I
 * have done a fact check … I cannot click on the remaining facts … I like to do it one at a time"); only the listing
 * holds them. A claim is tested once, unless the hooks say it can run again (`ext.again`).
 */
const choosable = (b) => !b.tested || ext.again();
const listing = () => state.phase === 'extracting';
/** The checkboxes follow the state; a tested row is a row like any other. */
function syncBeyondRows() {
  for (const item of state.beyond) {
    if (!item.box) continue;
    item.box.checked = item.selected;
    item.box.disabled = !choosable(item) || listing();
    item.box.hidden = !choosable(item);
    item.node.classList.toggle('has-check', choosable(item));
  }
  renderBeyondTools();
}

function renderBeyondTools() {
  const open = state.beyond.filter((b) => choosable(b) && shownNow(b));
  const selected = open.filter((b) => b.selected).length;
  const fresh = open.filter((b) => !b.tested);   // "Select all" chooses the claims not yet tested, never one again
  const allSelected = fresh.length > 0 && fresh.every((b) => b.selected);
  const busy = listing();
  ui.selectAll.hidden = fresh.length === 0;
  ui.selectAll.disabled = busy;
  ui.selectAll.textContent = t(allSelected ? 'claims.clearAll' : 'claims.selectAll');
  // The hooks may hold the button back, and say why under it.
  const { block, hint } = ext.tools(open);
  ui.testSelected.hidden = open.length === 0;
  ui.testSelected.disabled = selected === 0 || busy || block;
  // The button says how many, never what they cost: the price is said once, above the claims (the operator, 6 October).
  ui.testSelected.textContent = t('claims.testSelected', { n: selected });
  renderBalanceLine(selected);
  ui.beyondHint.textContent = hint.join(' ');
  renderPriceLine();
  ext.paint();
  renderRestToggle();
}

/** The price, said once above the claims: "Each fact-check is $1.25.", the document's free ones when it has any, and the operator's note. */
function renderPriceLine() {
  const price = pricingNow();
  ui.priceLine.hidden = !price;
  if (!price) { ui.priceLine.textContent = ''; return; }
  const free = Number(price.freeFacts) || 0;
  ui.priceLine.textContent = [
    t('price.each', { amount: fmtMoney(price.priceCents, price.currency) }),
    free > 0 ? t('price.eachFree', { n: free, w: numberWord(free) }) : '',
    price.note || '',
  ].filter(Boolean).join(' ');
}

/**
 * A selection the reader's balance cannot cover holds the button back with a sentence naming how many it covers (the
 * document's free ones and as many as the balance pays for), never a total; the server refuses it anyway, before any
 * model is asked. And the sentence of a run that stopped for credit or the monthly limit. Otherwise nothing: the
 * balance itself is in the menu bar.
 */
function renderBalanceLine(selected) {
  const price = pricingNow();
  const bal = required() && state.session ? state.session.balanceCents : null;
  ui.balanceLine.classList.remove('is-over');
  if (state.creditStop) {
    const s = state.creditStop;
    ui.balanceLine.hidden = false;
    ui.balanceLine.classList.add('is-over');
    ui.balanceLine.textContent = s.code === 'month_limit'
      ? t('credit.stoppedLimit', { limit: fmtMoney(s.limitCents) })
      : t('credit.stopped', { balance: fmtMoney(s.balanceCents), price: fmtMoney(s.priceCents) });
    return;
  }
  // Runs the hooks choose are never charged, so the balance holds nothing back.
  const covers = Number.isFinite(bal) && price && !ext.choices()?.length ? freeRemaining() + Math.floor(Math.max(0, bal) / price.priceCents) : null;
  if (covers !== null && selected > covers) {
    ui.testSelected.disabled = true;
    ui.balanceLine.hidden = false;
    ui.balanceLine.classList.add('is-over');
    ui.balanceLine.textContent = covers > 0 ? t('credit.over', { n: covers, w: numberWord(covers) }) : t('credit.overNone');
  } else { ui.balanceLine.hidden = true; ui.balanceLine.textContent = ''; }
}

// ---------- prices: what the server said this run's claims cost ---------------------------------------

/** This run's price, when the server set one: { priceCents, freeFacts, currency, note }; null when nothing is priced. */
function pricingNow() {
  const p = state.pricing;
  return p && Number.isInteger(p.priceCents) && p.priceCents > 0 ? p : null;
}

/** Free claims still to be had on this document: the tier's count less the ones already taken (a failed one takes none). */
function freeRemaining() {
  const p = pricingNow();
  if (!p) return 0;
  const taken = state.results.filter((r) => r.free === true && r.status !== 'error').length;
  return Math.max(0, (Number(p.freeFacts) || 0) - taken);
}

/** Money in the reader's language and the service's currency. */
function fmtMoney(cents, currency) {
  const amount = (Number(cents) || 0) / 100;
  try { return new Intl.NumberFormat(currentLocale(), { style: 'currency', currency: currency || state.pricing?.currency || 'USD' }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency || ''}`.trim(); }
}

function toggleSelectAll() {
  // What the reader sees, never a hidden claim, and not yet tested: a claim is tested again only by its own tick.
  const open = state.beyond.filter((b) => !b.tested && shownNow(b));
  const allSelected = open.length > 0 && open.every((b) => b.selected);
  for (const b of open) b.selected = !allSelected;
  syncBeyondRows();
}

async function testSelected() {
  if (listing()) return;
  const chosen = state.beyond.filter((b) => choosable(b) && b.selected);
  if (!chosen.length) return;
  // The hooks may choose what the claims run on (`ext.choices`); none chosen of a choice offered runs nothing.
  const chosenRuns = ext.choices();
  if (chosenRuns && !chosenRuns.length) return;
  state.creditStop = null;   // a new choice, perhaps after credit was added: tried again from the start
  // The selection runs at the server's pace (one claim per request, `inFlight` of them at once, the next starting as
  // one ends): thirty chosen claims run ten at a time with no pause between tens. Until 3 October they ran in batches of
  // ten. Chosen while others run (26 October), they join the test under way and start as places free up.
  const runs = [];
  const nodes = [];
  const ran = [];
  const tags = new Set();
  for (const b of chosen) {
    b.selected = false;
    if (!chosenRuns) { runs.push(claimOf(b)); nodes.push(b.node); ran.push(b); continue; }
    // Each run the hooks make of a claim comes with its card; a claim with nothing new to run is left as it is.
    const made = ext.runsFor(b, chosenRuns);
    if (!made.length) continue;
    for (const { run, node } of made) {
      if (run.tag) tags.add(run.tag);
      runs.push(run);
      nodes.push(node);
    }
    ran.push(b);
  }
  for (const b of ran) b.tested = true;
  syncBeyondRows();
  if (!runs.length) return;
  await runBatch(runs, nodes, { claims: ran.map((b) => b.n), tags: [...tags] });
}

// ---------- step 2: one batch of determinations ---------------------------------------------------

/**
 * Claims to test: a test of their own, or, while one is under way, more for it (26 October). The test's cards are one
 * run of indexes from `start`; its queue is shared, and its workers, never more than the server's pace, take from it
 * until it is empty. The last worker to stop closes the test. `claims` names the claims chosen and `tags` what the
 * hooks named their runs, for step 2's title.
 */
async function runBatch(claims, nodes, { claims: chosen = null, tags = [] } = {}) {
  const from = state.cards.length;
  state.cards.push(...claims);
  for (const _ of claims) state.results.push(newResult());
  nodes.forEach((node, k) => { node.dataset.index = String(from + k); node.dataset.state = 'pending'; syncCardHead(node); });
  const adding = state.phase === 'evaluating' && Boolean(state.batch?.queue);
  if (!adding) {
    state.batch = { start: from, size: 0, done: 0, claims: new Set(), tags: new Set(), queue: [], workers: 0, tick: null };
    state.phase = 'evaluating';
    field.setPhase('evaluating');
    state.evalStartedAt = Date.now();
    setStep(ui.step2, 'running');
    setBar(ui.bar2, 0);
    const evalTick = setInterval(updateEvalStatus, 500);
    state.timers.push(evalTick);
    state.batch.tick = setInterval(updateEvalBars, 250);
    state.timers.push(state.batch.tick);
    ui.scoreboard.hidden = false;
    ui.scorePhase.hidden = true;
    ui.run.disabled = true;
  }
  const batch = state.batch;
  const indexes = claims.map((_, k) => from + k);
  batch.size += claims.length;
  for (const id of chosen || indexes) batch.claims.add(id);
  for (const tag of tags) batch.tags.add(tag);
  batch.queue.push(...indexes);

  renderStep2Title();
  setStatus('step2', 'step2.progress', { done: batch.done, total: batch.size });
  updateEvalStatus();
  renderScoreboard();
  syncBeyondRows();
  for (const i of indexes) renderCardStatus(i);
  // One request per claim, and as many at once as the server says (the operator's rule; the server's
  // gate goes on pacing OpenAI across requests). A response then lasts one claim, never a batch, well
  // inside what a host allows, and a cut costs one claim's attempt, which is requested again.
  // The figure is the server's `inFlight` (CIVIC_EVAL_CONCURRENCY), so the operator changes the pace
  // with one setting and no release; IN_FLIGHT stands in only when no server answered. Math.max(1, …)
  // stops a missing or zero value running nothing at all, and no ceiling is invented: a setting of
  // twenty means twenty.
  const inFlight = paceNow();
  const signal = state.abort.signal;
  const settled = () => { batch.done++; updateEvalStatus(); renderScoreboard(); };
  const worker = async () => {
    batch.workers++;
    try {
      while (batch.queue.length && !signal.aborted && state.phase === 'evaluating' && !state.creditStop) {
        await runClaim(batch.queue.shift(), signal, { keepGoing: () => state.phase === 'evaluating', onSettled: settled });
      }
    } finally {
      batch.workers--;
    }
    if (batch.workers > 0 || state.batch !== batch) return;
    // The last worker closes the test. The credit or the monthly limit stopped it: the claims it never started are not
    // run, and not charged.
    while (state.creditStop && batch.queue.length) { markNotRun(batch.queue.shift(), state.creditStop); settled(); }
    clearInterval(batch.tick);
    if (state.phase === 'evaluating') finishBatch({ ms: Date.now() - state.evalStartedAt });
  };
  const more = Math.max(0, Math.min(inFlight - batch.workers, batch.queue.length));
  await Promise.all(Array.from({ length: more }, worker));
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
    let job = r.jobId;
    let settled = false;
    let runFailure = null;
    let booksWait = false;
    const onEvent = (ev) => {
      if (ev.t === 'batch-start' || ev.t === 'batch-progress' || ev.t === 'complete') return;
      if (ev.t === 'error' && ev.i === undefined) { runFailure = ev; return; }
      if (ev.t === 'done' || (ev.t === 'error' && ev.i !== undefined)) settled = true;
      handleEvalEvent(ev, () => i);
    };
    try {
      await api.evaluate({
        jobId: job, claims: [claim.text], text: state.source, source: state.sourceMeta, signal, onEvent,
        extra: ext.ask(claim),   // what the hooks ask of the run; the server reads it from no one else
        runId: state.extractJob, n: Number.isInteger(claim.n) ? claim.n : i + 1,   // the run is its extraction's job at the server, which is what the row is filed under; so the server can say whether this one is free
        // Whatever the row was saying (queued at the gate, inspecting, writing), it says the connection
        // was cut until a new one is open, then goes back to what it was saying.
        onCut: () => { if (!settled && r.phase !== 'reconnecting') { r.cutFrom = r.phase; r.phase = 'reconnecting'; renderCardStatus(i); } },
        onAttached: (ev) => {
          // As for the extraction: the id the server kept is the one the page names from here.
          if (ev?.job && ev.job !== job) { state.jobs.delete(job); job = ev.job; r.jobId = job; state.jobs.add(job); }
          if (r.phase === 'reconnecting') { r.phase = r.cutFrom || 'pending'; r.cutFrom = null; renderCardStatus(i); }
        },
      });
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) return;
      if (err instanceof api.ApiError && (err.code === 'credit_short' || err.code === 'month_limit')) {
        // Not run and not charged: the price was refused before any model was asked. No more claims start.
        state.creditStop = { code: err.code, balanceCents: err.balanceCents ?? null, priceCents: err.priceCents ?? null, limitCents: err.limitCents ?? null };
        if (Number.isFinite(err.balanceCents)) setBalance(err.balanceCents);
        markNotRun(i, state.creditStop);
        onSettled();
        return;
      }
      if (err instanceof api.ApiError && err.code === 'already_tested') { markNotRun(i, { code: 'already_tested' }); onSettled(); return; }
      if (err instanceof api.ApiError && err.code === 'books_wait') { booksWait = true; }   // FactEngine's records will answer: a wait
      else if (err instanceof api.ApiError) { failRun(err); return; }   // the server refused the request itself
    } finally {
      releaseJob(job);
    }
    if (booksWait) { booksWait = false; r.phase = 'reconnecting'; renderCardStatus(i); await new Promise((resolve) => setTimeout(resolve, 2000)); continue; }
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
  if (ext.event(null, ev, null)) return;   // an event the hooks take whole
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
  ext.event(i, ev, r);
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
      // The entry is kept, not drawn: it appears whole when the claim is done (finalizeCard). Its length drives the bar.
      // A reader's stream carries only that length (server/view.js); the entry comes whole with the finished claim.
      if (typeof ev.text === 'string') { r.text += ev.text; r.chars = r.text.length; } else r.chars += Number(ev.n) || 0;
      if (r.phase !== 'writing') { r.phase = 'writing'; renderCardStatus(i); }
      break;
    case 'trail': r.trail.push(ev.step); renderCardStatus(i); break;
    case 'quote': r.free = ev.free ?? null; r.priceCents = ev.priceCents ?? null; if (Number.isFinite(ev.balanceCents)) setBalance(ev.balanceCents); renderBeyondTools(); break;   // free, or the price: the server's word, and the balance after its hold
    case 'source': r.sources.push(ev.source); break;
    case 'retry':
      r.phase = 'retry'; r.retryAttempt = ev.attempt; r.retryStatus = ev.status ?? null;
      // A wait says when it ends, so a wait that arrives late, after a cut, still ends when it was said to.
      r.retryReason = ev.reason || null; r.retryUntil = Number.isFinite(ev.until) ? ev.until : Date.now() + (ev.waitMs || 0);
      r.retryCode = ev.code || null; r.retryWhy = ev.why || null; r.retrySince = ev.since || Date.now();
      renderCardStatus(i); updateEvalStatus();
      break;
    case 'done': finalizeCard(i, ev); break;
    case 'error': r.status = 'error'; r.phase = 'error'; r.error = ev.message; r.errorCode = ev.code || null; setCardState(i, 'error'); renderCardStatus(i); renderCardError(i); renderScoreboard(); break;
    default: break;
  }
}

function finishBatch(ev) {
  state.phase = 'done';
  field.setPhase('done');
  setStep(ui.step2, 'done');
  setBar(ui.bar2, 1, { done: true });
  setStatus('step2', 'step2.done', { total: state.batch.size, time: fmtSeconds(ev.ms || Date.now() - state.evalStartedAt) });
  ui.run.disabled = false;
  if (state.batch.start === 0) ui.report.hidden = false;   // the first ten are tested: the report can be asked for
  renderScoreboard();
  syncBeyondRows();
  refreshBalance();
}

function failRun(err) {
  const code = err?.code || '';
  let message;
  // FactEngine's own fault, told to a reader as one plain sentence (server/view.js, 31 October, night).
  if (code === 'unavailable') message = t(state.phase === 'extracting' ? 'errors.unavailableListing' : 'errors.unavailable');
  else if (code === 'source_too_long') message = `${t('errors.sourceTooLong')} ${err?.message || ''}`;
  else if (code === 'signin_required') message = t('account.cookies');   // signed in, and still refused: the browser kept no cookie
  // A rejected key, or a provider's account that can no longer pay (402): the operator's to look at; the page names neither.
  else if (err?.status === 401 || err?.status === 402 || code === 'invalid_key' || code === 'missing_key' || code === 'balance_exhausted') message = t('errors.key');
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
  field.setPhase('done');
  ui.run.disabled = false;
  syncBeyondRows();
}

/**
 * A running card's bar: by the time it has run, and by its entry's length once it writes. It never goes back (31 October,
 * night): a claim that goes again from its start keeps the ground it had made, and its bar creeps on until the new go
 * passes it.
 */
function cardBar(r, now) {
  const elapsed = now - r.startedAt;
  let f;
  if (r.phase === 'starting') f = easeTime(elapsed, 4000, 0.08);
  else if (r.phase === 'writing') f = 0.48 + easeChars(r.chars, 4500, 0.47);
  else f = 0.08 + easeTime(elapsed, 90000, 0.4);
  const was = r.barAt || 0;
  r.barAt = Math.min(0.96, f >= was ? f : was + (0.96 - was) * 0.002);
  return r.barAt;
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
    // A wait the hooks count down is said again as it goes, whether or not the claim had started (on 18 October Gemini's
    // first refusal sat at "3,366 s" and never moved).
    if (r.phase === 'retry') renderCardStatus(i);
    if (r.status !== 'running') continue;
    const f = cardBar(r, now);
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
  $('.card-status', node).textContent = t('card.pending');
  // The row's place in the run is known only once its batch starts; everything reads it then.
  const idx = () => Number(node.dataset.index);
  $('.btn-retry', node).textContent = t('card.retryBtn');
  $('.btn-retry', node).addEventListener('click', () => retryClaim(idx()));
  const copy = $('.btn-copy', node);
  copy.textContent = t('card.copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(plainText(state.results[idx()]?.text));
    toast(t(ok ? 'card.copied' : 'card.copyFailed'), { error: !ok });
  });
  // The row opens and closes in place, once its claim is finished (25 October, the operator: "none of the empirical
  // statements being tested opens before it is finished"). Closed, it is the claim, the verdict and the conclusion
  // behind it; open, it is everything the run produced. Controls inside never toggle it.
  const head = $('.card-head', node);
  syncCardHead(node);
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
  return node;
}

/** Whether a row's claim is finished: done, or failed. Only then can it open. */
const cardFinished = (node) => node.dataset.state === 'done' || node.dataset.state === 'error';

function toggleCard(node) {
  if (!cardFinished(node) && !node.classList.contains('is-open')) return;
  const open = node.classList.toggle('is-open');
  $('.card-head', node).setAttribute('aria-expanded', String(open));
}

/** A row's head is a button only once its claim is finished; until then it is closed, and nothing of the entry is in it. */
function syncCardHead(node) {
  const head = $('.card-head', node);
  if (cardFinished(node)) {
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.setAttribute('aria-expanded', String(node.classList.contains('is-open')));
    return;
  }
  node.classList.remove('is-open');
  head.removeAttribute('role');
  head.removeAttribute('aria-expanded');
  head.removeAttribute('tabindex');
  const entry = $('.entry', node);
  entry.replaceChildren();
  entry.hidden = true;
}

/** An entry's words where they are shown as plain text (the closed row, a copy): without a span's markup, its words kept. */
const plainText = (text) => String(text || '').replace(/<\/?span\b[^>]*>/gi, '');

/** The closed row's line: the Conclusion section behind the verdict, in the model's own words. */
function renderBrief(i) {
  const r = state.results[i];
  const brief = $('.card-brief', cardOf(i));
  const text = plainText(r.conclusion) || (r.verdict ? '' : t('card.noteUnread'));
  brief.textContent = text;
  brief.hidden = !text;
}

function setCardState(i, stateName) {
  const card = cardOf(i);
  card.dataset.state = stateName;
  syncCardHead(card);
}

// The words of the work a claim is doing.
const CARD_WORDS = { pending: 'card.pending', starting: 'card.starting', reasoning: 'card.reasoning', inspecting: 'card.reasoning', searching: 'card.searching', reading: 'card.reading', writing: 'card.writing', error: 'card.error' };
// The work itself, as against what FactEngine works around on its way (its turn, a wait, a retry, a cut connection).
const WORKING = new Set(['starting', 'reasoning', 'inspecting', 'searching', 'reading', 'writing']);

/**
 * A card's status: the work it is doing, and nothing of what FactEngine works around on its way (31 October, night: "it
 * does not help you or the service to show that it is struggling"). A claim held for its turn says it is starting; one
 * waiting to go again, or reconnecting, goes on saying what it was doing; one that goes again from its start keeps the
 * ground it had made, and its count of searches never goes back. The hooks may say what is really happening.
 */
function renderCardStatus(i) {
  const r = state.results[i];
  const card = cardOf(i);
  // The furthest work shown so far: a new start after a retry does not take the card back to its beginning.
  if (WORKING.has(r.phase) && !(r.phase === 'starting' && r.shown && r.shown !== 'starting')) r.shown = r.phase;
  r.searchesShown = Math.max(r.searchesShown || 0, searchCount(r.trail));
  const said = ext.cardLine(r, card);
  const words = (phase) => (phase === 'searching' && r.searchesShown ? t('card.searchingN', { n: r.searchesShown }) : t(CARD_WORDS[phase] || 'card.pending'));
  let text;
  if (said) text = said;
  else if (WORKING.has(r.phase)) text = words(r.shown || r.phase);
  else if (r.phase === 'queued' || r.phase === 'retry' || r.phase === 'reconnecting') text = r.shown ? words(r.shown) : t('card.begin');
  else text = words(r.phase);
  $('.card-status', card).textContent = text;
}

function renderEntry(i) {
  const r = state.results[i];
  const entry = $('.entry', cardOf(i));
  entry.innerHTML = renderMarkdown(r.text); // the complete text, never a slice of it
  renderMath(entry);                          // and its formulas as mathematics, not as broken prose
  ext.shown(entry);
  entry.hidden = false;
}

function finalizeCard(i, ev) {
  const r = state.results[i];
  Object.assign(r, {
    status: 'done', phase: 'done',
    text: ev.text || r.text,
    reasoning: ev.reasoning || r.reasoning || '',
    verdict: ev.verdict || null, verdictSource: ev.verdictSource || 'none',
    confidence: ev.confidence ?? null, inspector: ev.inspector || null, inspectorMark: ev.inspectorMark || null, conclusion: ev.conclusion || null,
    ms: ev.ms ?? null,
    trail: ev.trail?.length ? ev.trail : r.trail, sources: ev.sources?.length ? ev.sources : r.sources,
    incomplete: ev.incomplete || r.incomplete || null,
  });
  ext.cardDone(i, ev, r);   // what the hooks keep of the finished claim, before its card is drawn
  const card = cardOf(i);
  card.classList.remove('verdict-true', 'verdict-false', 'verdict-unverified', 'verdict-unread');
  card.classList.add(`verdict-${r.verdict || 'unread'}`);
  card.dataset.state = 'done';
  syncCardHead(card);
  renderEntry(i);
  renderBrief(i);
  renderBadge(i);
  renderCardDetail(i);
  renderCardNote(i);
  renderCardFoot(i);

  // Every determination counts, one per card.
  if (r.verdict) state.counts[r.verdict] = (state.counts[r.verdict] || 0) + 1;
  else state.unread++;
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

/**
 * What the entry cites, for every reader: the sources, each a link to the article (1 November: "Sources cited in reading
 * the article should remain"). The work behind the entry (its thinking summary, its research steps, the entry as it was
 * written) is drawn by the operator's page alone (ext.detail, public/js/op.js).
 */
function renderCardDetail(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const detail = $('.card-detail', card);
  const sources = $('.card-sources', card);
  if (r.sources?.length) {
    sources.hidden = false;
    $('.raw-summary', sources).textContent = t('card.details.sources', { n: r.sources.length });
    $('.sources-list', sources).replaceChildren(...r.sources.map((s) =>
      el('li', {}, [el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title || s.url }), ...ext.mark(s)])));
  } else sources.hidden = true;
  ext.detail(r, card);
  detail.hidden = ![...detail.children].some((box) => !box.hidden);
}

function renderCardNote(i) {
  const r = state.results[i];
  const card = cardOf(i);
  const note = $('.card-note', card);
  const parts = [];
  if (!r.verdict) parts.push(t('card.noteUnread'));
  if (r.incomplete) parts.push(t('card.noteIncomplete', { reason: r.incomplete }));
  ext.noteParts(r, parts);   // the operator's notes about the work's own boxes
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
  // The inspector's mark ("Inspector A", server/view.js), or the hooks' words for the name the entry gives.
  if (r.inspectorMark) insp.append(el('b', { text: r.inspectorMark }));
  else if (r.inspector) insp.append(...ext.named(r.inspector));
  // The work log: what the research did, counted, and how long it took.
  const log = $('.card-log', card);
  if (log) {
    const work = workOf(r.trail);
    const parts = [];
    if (work.searches) parts.push(t('card.log.searches', { n: work.searches }));
    if (work.pages) parts.push(t('card.log.pages', { n: work.pages }));
    if (r.sources?.length) parts.push(t('card.log.sources', { n: r.sources.length }));
    ext.logParts(r, parts);
    if (r.status === 'done' && r.ms) parts.push(fmtSeconds(r.ms));
    log.textContent = parts.join(' · ');
    log.hidden = parts.length === 0;
  }
  // The model that answered, by the operator's mark alone (31 October); then whatever the hooks add to the footer.
  const modelNode = $('.card-model', card);
  modelNode.textContent = r.status === 'done' ? t('card.engineLine') : '';
  ext.foot(r, card);
  $('.btn-copy', card).textContent = t('card.copy');
  $('.btn-copy', card).hidden = r.status !== 'done';
  $('.btn-retry', card).hidden = r.status !== 'error';
}

/** A claim that was not run, and not charged: its price was more than the balance or the month's limit allows, or it was tested already. */
function markNotRun(i, why) {
  const r = state.results[i];
  if (!r) return;
  const words = why?.code === 'month_limit' ? t('card.notRunLimit', { limit: fmtMoney(why.limitCents) })
    : why?.code === 'already_tested' ? t('card.alreadyTested')
      : t('card.notRunCredit', { balance: fmtMoney(why?.balanceCents), price: fmtMoney(why?.priceCents) });
  Object.assign(r, { status: 'error', phase: 'error', error: words, errorCode: why?.code || 'credit_short' });
  setCardState(i, 'error');
  renderCardStatus(i);
  renderCardError(i);
}

function renderCardError(i) {
  const r = state.results[i];
  const card = cardOf(i);
  let msg = $('.card-error', card);
  if (!msg) { msg = el('p', { class: 'card-error' }); $('.card-head', card).after(msg); }
  // Said in words first; the technical reason follows, so it can be reported. A claim the credit could not cover says
  // so in its own sentence, which is not a fault.
  const own = r.errorCode === 'credit_short' || r.errorCode === 'month_limit' || r.errorCode === 'already_tested' || r.errorCode === 'unavailable';
  // A failure that names who refused (`who`) is said with the name. FactEngine's own fault reaches a reader as one plain
  // sentence (server/view.js, 31 October, night).
  const why = r.errorCode === 'unavailable' ? t('card.unavailable')
    : r.errorCode === 'quota_exhausted' ? (r.error ? `${t('card.quota')} (${r.error})` : t('card.quota')) : !own && r.who && r.error ? `${r.who}: ${r.error}` : (r.error || '');
  msg.replaceChildren(document.createTextNode(own ? why : `${t('card.error')} ${why}`.trim()),
    el('button', { type: 'button', class: 'btn btn-small btn-text', text: t('card.retryBtn'), onclick: () => retryClaim(i) }));
  $('.card-brief', card).hidden = true;
  const foot = $('.card-foot', card);
  foot.hidden = false;
  $('.btn-copy', card).hidden = true;
  $('.btn-retry', card).hidden = false;
  $('.btn-retry', card).textContent = t('card.retryBtn');
}

async function retryClaim(i) {
  const r = state.results[i];
  if (!r || r.status === 'running') return;   // while others run too (26 October)
  state.creditStop = null;
  const card = cardOf(i);
  $('.card-error', card)?.remove();
  $('.card-brief', card).hidden = true;
  $('.btn-retry', card).hidden = true;
  $('.card-foot', card).hidden = true;
  ext.retrying(i, r);   // before the card is a running one again: what the hooks counted of its failure
  // Asked again: a new go from the start, its words and its bar with it.
  Object.assign(r, { status: 'running', phase: 'starting', startedAt: Date.now(), text: '', reasoning: '', chars: 0, error: null, trail: [], sources: [], jobId: null, cutFrom: null, shown: null, searchesShown: 0, barAt: 0 });
  setCardState(i, 'running');
  renderCardStatus(i);
  const tick = setInterval(() => {
    if (r.status !== 'running') return;
    if (r.phase === 'retry' || r.phase === 'queued') renderCardStatus(i);
    setBar(card.querySelector('.bar'), cardBar(r, Date.now()));
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
  ext.score();
  if (bumped) bump({ true: ui.scoreTrue, false: ui.scoreFalse, unverified: ui.scoreUnv }[bumped]);
}

/** Step 2's title: the claims chosen, or the hooks' own title for the run when they have one. */
function renderStep2Title() {
  const { start, size } = state.batch;
  const claims = state.batch.claims?.size || size;
  ui.step2Title.textContent = ext.title({ start, size, claims })
    || (start > 0 ? t('step2.more', { n: claims }) : t('step2.title', { n: claims }));
}

// ---------- visual echo -----------------------------------------------------------------------

/** The picture's box for a video source: the player, or the thumbnail with a link when the owner allows
 *  no embedding. The box is 16:9, 320 by 180 beside the steps (the operator's choice). */
function showVideo(video) {
  ui.rail.classList.add('rail--video');
  ui.echo.hidden = false;
  ui.echoShimmer.hidden = true;
  ui.echoImg.hidden = true;
  for (const n of ui.echoFrame.querySelectorAll('.echo-video')) n.remove();
  const label = t('echo.video');
  if (video.embeddable !== false) {
    const player = document.createElement('iframe');
    player.className = 'echo-video';
    player.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}?rel=0`;
    player.title = label;
    player.allow = 'accelerometer; encrypted-media; picture-in-picture; fullscreen';
    player.allowFullscreen = true;
    player.referrerPolicy = 'strict-origin-when-cross-origin';
    ui.echoFrame.append(player);
    return;
  }
  const link = document.createElement('a');
  link.className = 'echo-video';
  link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
  link.target = '_blank';
  link.rel = 'noopener';
  const img = document.createElement('img');
  img.alt = label;
  img.src = thumbnailFor(video);
  link.append(img);
  ui.echoFrame.append(link);
}

/** The smallest listed thumbnail at least as wide as the box, else the largest, else YouTube's own file. */
function thumbnailFor(video) {
  const list = (video.thumbnails || []).filter((x) => x && x.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  const fit = list.find((x) => (x.width || 0) >= 320) || list[list.length - 1];
  return fit?.url || `https://i.ytimg.com/vi/${encodeURIComponent(video.id)}/mqdefault.jpg`;
}

// ---------- locale changes: re-render everything that carries state ---------------------------

function refreshDynamicText() {
  ui.langSelect.value = currentLocale();
  renderCopies();
  setRunWording();
  renderNav();
  updateSourceMeta();
  for (const which of ['step1', 'step2']) { const s = state.status[which]; if (s) setStatus(which, s.key, s.params); }
  if (state.batch.size) renderStep2Title();
  renderWarnings();
  renderClaimsHeadings();
  renderBeyondTitle();
  for (const tag of $$('.card-tag')) tag.textContent = t('card.headline');
  syncBeyondRows();
  renderSummary();
  renderScoreboard();
  state.results.forEach((r, i) => {
    if (r.status === 'done') { renderBadge(i); renderCardDetail(i); renderCardNote(i); renderCardFoot(i); }
    else renderCardStatus(i);
    if (r.status === 'error') renderCardError(i);
  });
}

// The page's additions (on the operator's page, public/js/op.js): their address is named only on the page that has them
// (index.html, the operator's part), and they are in place before the page starts, so nothing of them waits on the order
// the files arrive in. Without them the hooks do nothing.
const more = document.getElementById('ext-script')?.getAttribute('href');
if (more) {
  try {
    const added = await import(new URL(more, document.baseURI).href);
    Object.assign(ext, added.install({ state, fill, el, $, fmtNumber, fmtSeconds, fmtUsd, fmtClock, buildCard, listing, pricingNow, renderBeyondTools, claimOf }));
  } catch (err) { console.error(`An addition to this page did not load: ${err?.message || err}`); }
}
boot();
