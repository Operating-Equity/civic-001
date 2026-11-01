// The operator's tools on their page (31 October, night: "I don't plan on giving away any information"): the grid of
// models and levels, the costs, the key's-minute line, the per-entry scoreboard, the zero-credibility mark, the model's
// name and level on a card, a standby model's answer, what FactEngine works around on its way (a claim's turn, a wait,
// a retry, a cut connection; a reader's page says only the work going on), the inspector's name and the class it is
// written in, the work behind each output (a card's thinking summary, its research steps and its entry as written; the
// listing's thinking and the listing as written: 1 November, the boxes that show how the system runs underneath), and the
// operator's own words for all of them. Served to the operator's account alone (server/assets.js
// OPERATOR_ONLY) and named only on their page (index.html, the operator's part); public/js/app.js loads it before the
// page starts and puts it in the hooks it keeps (`ext`), which do nothing on anyone else's page. The script everyone
// downloads names none of this.

const TRIAL_KEY = 'fe.trial';   // where this browser remembers the operator's ticked models and levels

/** The operator's tools, made over the page's own state and helpers (`ctx`, from public/js/app.js). */
export function install(ctx) {
  const { state, fill, el, $, fmtNumber, fmtSeconds, fmtUsd, buildCard, listing, pricingNow, renderBeyondTools } = ctx;
  const byId = (id) => document.getElementById(id);

  // The operator's words: on their page alone (index.html, #op-words), in English, filled in as the locales' are.
  const word = (key, params = {}) => {
    const text = byId('op-words')?.dataset[key];
    return text ? fill(text, params) : '';
  };

  // What the operator's tools keep of a run: its cost, the key's minute, each entry's tally, and the claims' entries.
  const run = { cost: 0, unpriced: false, gate: null, tally: new Map() };
  const rows = new WeakMap();   // a claim's row → { ran: Set of entries run on, last: its last card }
  let choice = { ticked: [] };   // the ticked entries, remembered in this browser

  // ---- the operator's trial: every model at every level, each ticked entry a card of its own (25 October) ----

  function loadChoice() {
    // A choice from before 25 October (one model, side by side) is not carried over: nothing is ticked until the operator ticks.
    try { const v = JSON.parse(localStorage.getItem(TRIAL_KEY) || '{}'); return { ticked: Array.isArray(v.ticked) ? v.ticked.map(String) : [] }; }
    catch { return { ticked: [] }; }
  }
  function saveChoice() {
    try { localStorage.setItem(TRIAL_KEY, JSON.stringify(choice)); } catch { /* a private window: the ticks last the page */ }
  }

  /** The trial the server offers this page (the operator's alone), or null. */
  const trialOffer = () => (byId('trial-bar') ? state.server?.trial || null : null);
  const trialEntries = () => trialOffer()?.entries || [];
  const entryKey = (e) => `${e.model}|${e.effort}`;

  /** What the next claims run on: null with no trial offered, else the ticked entries that can run, in the grid's order. */
  function choices() {
    if (!trialOffer()) return null;
    const ticked = new Set(choice.ticked);
    return trialEntries().filter((e) => e.ready && ticked.has(entryKey(e))).map((e) => ({ model: e.model, effort: e.effort, label: e.label }));
  }

  /**
   * The ticked entries a claim has not run on yet (27 October): a claim tested again runs only on the models and levels it
   * has not run on, so a second press never repeats a model on a claim.
   */
  const newRuns = (b, entries) => entries.filter((e) => !rows.get(b)?.ran.has(entryKey(e)));

  /** A claim's card for an entry: the claim's own row card for the first entry, a card of its own under it for each other,
   *  each headed with its entry ("GPT-6 Astra · high"). */
  function entryCard(b, label, after) {
    const card = after ? buildCard(b, b.n) : b.node;
    $('.card-claim', card).prepend(el('span', { class: 'card-entry mono', text: label }), el('br'));
    if (!after) return card;
    card.classList.add('is-entry');
    after.closest('li').after(el('li', { class: 'is-entry' }, [card]));
    return card;
  }

  /** A claim's runs on what it has not run on, each with its card: the first on the claim's own card, the others under it. */
  function runsFor(b, entries) {
    const todo = newRuns(b, entries);
    if (!todo.length) return [];
    const row = rows.get(b) || { ran: new Set(), last: null };
    rows.set(b, row);
    let last = b.tested ? row.last : null;
    const out = todo.map((e) => {
      row.ran.add(entryKey(e));
      last = entryCard(b, e.label, last);
      return { run: { ...ctx.claimOf(b), ask: { model: e.model, effort: e.effort }, tag: e.label }, node: last };
    });
    row.last = last;
    return out;
  }

  /** The grid: one row per model, a tick box per level; a model that cannot run is shown, its boxes off, its reason below. */
  function paint() {
    const bar = byId('trial-bar'), grid = byId('trial-grid'), why = byId('trial-why');
    if (!bar) return;
    const offer = trialOffer();
    const open = state.beyond.some((b) => !b.tested || Boolean(offer));
    bar.hidden = !offer || !open;
    if (bar.hidden) return;
    const busy = listing();   // the ticks change while cards run: the next claim runs on what is ticked then
    const ticked = new Set(choice.ticked);
    const shape = offer.models.map((m) => `${m.id}:${m.ready}:${m.efforts.join(',')}`).join('|');
    if (grid.dataset.shape !== shape) {
      grid.dataset.shape = shape;
      grid.replaceChildren(...offer.models.filter((m) => m.efforts.length).map((m) => el('div', { class: 'trial-row' }, [
        el('span', { class: 'trial-name', text: m.label }),
        ...m.efforts.map((e) => el('label', { class: 'trial-tick' }, [el('input', { type: 'checkbox', 'data-entry': `${m.id}|${e}`, disabled: !m.ready }), el('span', { text: e })])),
      ])));
    }
    for (const box of grid.querySelectorAll('input[data-entry]')) {
      const entry = trialEntries().find((e) => entryKey(e) === box.dataset.entry);
      box.checked = Boolean(entry?.ready) && ticked.has(box.dataset.entry);
      box.disabled = busy || !entry?.ready;
    }
    const whys = [...new Set(offer.models.filter((m) => !m.ready && m.why).map((m) => m.why))];
    why.hidden = !whys.length;
    why.textContent = whys.join(' ');
  }

  /** The claims' tools: whether the button waits (nothing ticked, or all ticked already run) and the hint's words. */
  function tools(open) {
    const offer = Boolean(trialOffer());
    const runs = choices();
    const untick = offer && !runs.length;
    // The determinations a press would start: none when every ticked entry has run on the claims chosen.
    const starts = offer && !untick ? open.filter((b) => b.selected).reduce((n, b) => n + newRuns(b, runs).length, 0) : null;
    const allRan = open.some((b) => b.selected) && starts === 0;
    const hint = [];
    if (untick) hint.push(word('tickOne'));
    else if (allRan) hint.push(word('allRan'));
    else {
      if (starts) hint.push(word('newRuns', { n: starts }));
      const avg = averageCost();
      if (!pricingNow() && state.server?.accounting && avg !== null) hint.push(word('avgCost', { usd: fmtUsd(avg) }));
    }
    return { block: untick || allRan, hint };
  }

  // ---- the costs, the key's minute, the per-entry scoreboard ----

  function addCost(cost) {
    if (!cost) return;
    run.cost += cost.usd || 0;
    if (cost.priced === false) run.unpriced = true;
  }

  function averageCost() {
    const done = state.results.filter((r) => r.status === 'done' && r.cost?.priced);
    if (!done.length) return null;
    return done.reduce((s, r) => s + (r.cost.usd || 0), 0) / done.length;
  }

  /** The key's minute figures, in OpenAI's own numbers, once the gate has them. */
  function gateLine() {
    const node = byId('step2-gate');
    if (!node) return;
    const g = run.gate;
    if (!g) { node.hidden = true; node.textContent = ''; return; }
    node.hidden = false;
    node.textContent = word('gate', { limit: fmtNumber(g.limit), cost: fmtNumber(g.cost), atOnce: g.atOnce, every: Math.max(1, Math.round(g.everyMs / 1000)) });
  }

  function tally(i, outcome) {
    const label = state.cards[i]?.tag;
    if (!label || !byId('score-entries')) return;
    const r = state.results[i];
    const t0 = run.tally.get(label) || { true: 0, false: 0, unverified: 0, unread: 0, failed: 0, ms: 0, timed: 0, usd: 0, unpriced: false };
    t0[outcome] = (t0[outcome] || 0) + 1;
    if (Number.isFinite(r.ms)) { t0.ms += r.ms; t0.timed++; }
    if (r.cost?.priced) t0.usd += r.cost.usd || 0; else if (outcome !== 'failed') t0.unpriced = true;
    run.tally.set(label, t0);
  }

  /** The scoreboard's cost, and with more than one entry in the run, one line per entry so the models compare at a glance. */
  function score() {
    const internal = byId('score-internal');
    if (internal) {
      internal.hidden = !state.server?.accounting;
      byId('score-cost').textContent = fmtUsd(run.cost) + (run.unpriced ? '+' : '');
    }
    const lines = byId('score-entries');
    if (!lines) return;
    const order = [...new Set(state.cards.map((c) => c.tag).filter(Boolean))];
    const none = { true: 0, false: 0, unverified: 0, unread: 0, failed: 0, ms: 0, timed: 0, usd: 0, unpriced: false };
    const each = order.map((label) => [label, run.tally.get(label) || none]);
    lines.hidden = each.length < 2;
    if (lines.hidden) return;
    lines.replaceChildren(...each.map(([label, x]) => el('div', { class: 'score-entry' }, [
      el('span', { class: 'score-entry-name mono', text: label }),
      el('span', { text: word('entryTally', { t: x.true, f: x.false, u: x.unverified, unread: x.unread, failed: x.failed }) }),
      el('span', { class: 'mono', text: `${x.timed ? fmtSeconds(x.ms / x.timed) : '—'} · ${fmtUsd(x.usd)}${x.unpriced ? '+' : ''}` }),
    ])));
  }

  // ---- the events of a run and its cards ----

  /**
   * An event of the fact-checks, seen twice: first as it arrives (`r` null), when the key's minute is taken whole as the
   * operator's alone; then with its claim's index and result, when a provider's wait or failure names who, and a
   * failure is counted under the claim's entry.
   */
  function event(i, ev, r) {
    if (!r) {
      if (ev.t !== 'gate') return false;
      run.gate = ev;
      gateLine();
      return true;
    }
    if (ev.t === 'retry' || ev.t === 'error') r.who = ev.who || null;
    if (ev.t === 'error') tally(i, 'failed');
    if (ev.t === 'note' && ev.code === 'no_reasoning_summary') r.noSummary = true;
    return false;
  }

  /** A finished claim: the model and level that answered, its cost, what it took from the operator's list. */
  function cardDone(i, ev, r) {
    Object.assign(r, {
      cost: ev.cost || null, model: ev.model || null, requested: ev.requested || null, fellBack: ev.fellBack || null,
      effort: ev.effort || null, mode: ev.mode || null, listed: ev.listed ?? null, keptOut: ev.keptOut ?? null,
      standby: Boolean(ev.standby || ev.fellBack),
    });
    tally(i, r.verdict || 'unread');
    addCost(r.cost);
  }

  /** A claim asked again: the failure counted under its entry gives way to the new attempt's outcome. */
  function retrying(i, r) {
    const t0 = state.cards[i]?.tag && run.tally.get(state.cards[i].tag);
    if (t0 && r.status === 'error' && t0.failed > 0) t0.failed--;
    Object.assign(r, { listed: null, keptOut: null });
  }

  /** The card's work log: what it took from the operator's list of sites kept out of the research. */
  function logParts(r, parts) {
    const said = r.status === 'done' && Number.isFinite(r.listed) ? word(r.keptOut ? 'fromListKept' : 'fromList', { n: r.listed, kept: r.keptOut || 0 }) : '';
    if (said) parts.push(said);
  }

  /** The card's footer: the model's name and level, the standby model's, and the card's cost. */
  function foot(r, card) {
    const modelNode = $('.card-model', card);
    if (r.model) modelNode.textContent = word('modelLine', { model: r.model, effort: [r.effort, r.mode].filter(Boolean).join(' / ') });
    // A standby model's answer, marked as such on the operator's page, so a downgrade never passes them unnoticed.
    modelNode.classList.toggle('is-fallback', Boolean(r.standby));
    modelNode.title = r.fellBack?.used ? word('modelFallback', { used: r.fellBack.used, requested: r.fellBack.requested }) : '';
    const costNode = $('.card-cost', card);
    if (!costNode) return;
    if (state.server?.accounting && r.status === 'done' && r.cost) {
      costNode.textContent = r.cost.priced ? word('cardCost', { usd: fmtUsd(r.cost.usd) }) : word('cardCostUnknown');
      costNode.hidden = false;
    } else costNode.hidden = true;
  }

  /** The inspector by the name the entry gives. */
  const named = (name) => [`${word('inspector')}: `, el('b', { text: name })];

  /** The operator's mark on a source or a step of a site on their list (server/sites.js): "zero credibility". */
  function mark(item) {
    const text = item?.listed ? word('listed') : '';
    return text ? [el('span', { class: 'card-mark mono', text })] : [];
  }

  // ---- what FactEngine works around on its way, said on the operator's page alone (31 October, night: a reader's page
  // says only the work going on) ----

  // A connection failure in words, from the operating system's code (server/openai.js sends both).
  const NET = {
    EHOSTUNREACH: 'no route to host', ENETUNREACH: 'the network is unreachable', ENETDOWN: 'the network is down', EHOSTDOWN: 'the host is down',
    ECONNREFUSED: 'the connection was refused', ENOTFOUND: 'the name could not be resolved', EAI_AGAIN: 'the name could not be resolved',
    ETIMEDOUT: 'the connection timed out', UND_ERR_CONNECT_TIMEOUT: 'the connection timed out', ECONNRESET: 'the connection was reset',
    ECONNABORTED: 'the connection was aborted', EPIPE: 'the connection was closed while sending', UND_ERR_SOCKET: 'the connection was cut during the reply',
    cut: 'the connection was cut during the reply', connection: 'the connection failed',
  };
  const netWords = (code, why) => NET[code || 'connection'] || why || NET.connection;
  const secondsTo = (at) => Math.max(0, Math.ceil(((at || 0) - Date.now()) / 1000));

  /**
   * A card's line while FactEngine works around something (its turn, a wait, a retry, a cut connection); '' otherwise. A
   * provider's own words for its wait go on a line of their own under the bar, so a long reason never squeezes the line.
   */
  function cardLine(r, card) {
    const providerWait = r.phase === 'retry' && r.retryReason === 'rate_limit' && r.who;
    const why = $('.card-why', card);
    if (why) {
      why.textContent = providerWait ? r.retryWhy || '' : '';
      why.hidden = !(providerWait && r.retryWhy);
    }
    if (r.phase === 'queued') { const s = secondsTo(r.queuedUntil); return word('cardQueued') + (s > 0 ? ` · ${s} s` : ''); }
    if (providerWait) return word('cardWaitingProvider', { who: r.who, time: fmtSeconds(Math.max(0, (r.retryUntil || 0) - Date.now())), clock: ctx.fmtClock(r.retryUntil || Date.now()) });
    if (r.phase === 'retry' && r.retryReason === 'rate_limit') return word('cardWaitingLimit', { s: secondsTo(r.retryUntil) });
    if (r.phase === 'retry' && r.retryReason === 'connection') return word('cardWaitingConnection', { why: netWords(r.retryCode, r.retryWhy), time: fmtSeconds(Date.now() - (r.retrySince || Date.now())) });
    if (r.phase === 'retry') return word('cardRetry', { n: r.retryAttempt || 1 });
    if (r.phase === 'reconnecting') return word('cardReconnecting');
    return '';
  }

  /** Step 2's line while claims are held back: a missing connection, a provider's wait, their turn; '' otherwise. */
  function stepLine({ elapsed }) {
    const retrying = (r) => r.phase === 'retry' && r.status !== 'done' && r.status !== 'error';
    const working = state.results.filter((r) => r.status === 'running' && r.phase !== 'queued' && r.phase !== 'retry').length;
    const at = { running: working, done: state.batch.done, total: state.batch.size, time: elapsed };
    const unreachable = state.results.filter((r) => retrying(r) && r.retryReason === 'connection');
    if (unreachable.length) return word('stepUnreachable', { ...at, n: unreachable.length, why: netWords(unreachable[0].retryCode, unreachable[0].retryWhy) });
    const provider = state.results.filter((r) => retrying(r) && r.retryReason === 'rate_limit' && r.who);
    if (provider.length) return word('stepWaitingProvider', { ...at, n: provider.length, who: provider[0].who });
    const held = state.results.filter((r) => r.phase === 'queued' || (retrying(r) && r.retryReason !== 'connection')).length;
    return held ? word('stepThrottled', { ...at, n: held }) : '';
  }

  /** The listing's line while it is held back: its connection cut and opened again, a missing connection, its turn. */
  function listingLine({ cut, wait, queued }) {
    if (cut) return word('listingReconnecting');
    if (wait) return word('listingUnreachable', { why: netWords(wait.code, wait.why), time: fmtSeconds(Date.now() - wait.since) });
    if (queued && !state.found) return word('listingQueued', { time: fmtSeconds(Date.now() - queued.at) });
    return '';
  }

  /** Step 2's title with several entries: the claims chosen on each model and level ticked, or the cards of each. */
  function title({ size, claims }) {
    const models = state.batch.tags?.size || 1;
    return models > 1 ? word(size === claims * models ? 'step2Models' : 'step2Mixed', { n: claims, m: models, total: size }) : '';
  }

  /** A warning of the run's the operator alone receives: the model that answered was not the one asked. */
  const warning = (w) => (w.code === 'model_fallback' ? word('modelFallback', { used: w.used, requested: w.requested }) : '');

  /** The operator's class for the inspector's name (server/names.js), highlighted in the entry (31 October, evening). */
  function shown(entry) {
    const hl = String(state.server?.hl || '').toLowerCase();
    if (hl) for (const node of entry.querySelectorAll('span[class]')) if (node.className.toLowerCase().split(/\s+/).includes(hl)) node.classList.add('hl');
  }

  /** The grid's ticks: each model and level is an entry the operator ticks, any number at once, remembered in this browser. */
  function start() {
    const grid = byId('trial-grid');
    if (!grid) return;
    grid.addEventListener('change', (e) => {
      const box = e.target.closest('input[data-entry]');
      if (!box) return;
      const ticked = new Set(choice.ticked);
      if (box.checked) ticked.add(box.dataset.entry); else ticked.delete(box.dataset.entry);
      choice.ticked = [...ticked];
      saveChoice(); renderBeyondTools();
    });
  }

  // ---- the work behind the outputs (1 November): the boxes that show how the system runs underneath, the operator's ----

  /** The steps' box title: a form for one step and a form for more. */
  const trailTitle = (n) => (n === 1 ? word('detailsTrailOne', { n }) : word('detailsTrailOther', { n }));
  /** A research step as the operator reads it: the tool by its own name, what it asked or where it went, and its error. */
  const stepKind = (s) => (s.kind ? (s.kind === 'tool' ? s.name || 'tool' : s.kind) : s.verb || 'search');
  const stepWhat = (s) => (s.query ? `“${s.query}”` : s.url || s.pattern || s.kind || '') + (s.kind === 'tool' && s.error ? ` · ${s.error}` : '');

  /** A finished card's work: its thinking summary, its research steps, and its entry as it was written. */
  function detail(r, card) {
    const reasoning = $('.card-reasoning', card);
    if (reasoning) {
      reasoning.hidden = !r.reasoning;
      if (r.reasoning) {
        $('.raw-summary', reasoning).textContent = word('detailsReasoning');
        $('.reasoning-body', reasoning).textContent = r.reasoning;
      }
    }
    const trail = $('.card-trail', card);
    if (trail) {
      const steps = (r.trail || []).filter((s) => s.kind || s.query || s.url);
      trail.hidden = !steps.length;
      if (steps.length) {
        $('.raw-summary', trail).textContent = trailTitle(steps.length);
        $('.trail-list', trail).replaceChildren(...steps.map((s) =>
          el('li', {}, [el('span', { class: 'trail-kind mono', text: stepKind(s) }), el('span', { text: stepWhat(s) }), ...mark(s)])));
      }
    }
    const raw = $('.card-raw', card);
    if (raw) {
      $('.raw-summary', raw).textContent = word('detailsRaw', { n: fmtNumber(String(r.text || '').length) });
      $('.raw-entry', raw).textContent = r.text || '';
    }
  }

  /** The note a card gives when its work has no thinking summary to show. */
  function noteParts(r, parts) { if (r.noSummary) parts.push(word('noteNoSummary')); }

  /** The listing's thinking, shown as it arrives under step 1. Nothing is summarised by us. */
  function listingThinking(text) {
    const box = byId('step1-thinking');
    if (!box) return;
    box.hidden = !text;
    if (!text) return;
    byId('step1-thinking-summary').textContent = word('step1ThinkingTitle');
    const body = byId('step1-thinking-body');
    body.textContent = text;
    body.scrollTop = body.scrollHeight;
  }

  /** The listing as the model wrote it, with its thinking and its steps, under the claims. */
  function listingDone(ev) {
    addCost(ev.cost);
    const box = byId('claims-raw');
    if (!box) return;
    const raw = ev?.raw || '';
    box.hidden = !raw;
    if (!raw) return;
    byId('claims-raw-summary').textContent = word('claimsRaw');
    const parts = [];
    if (ev.reasoning) parts.push(`${word('detailsReasoning')}\n\n${ev.reasoning}`);
    const trail = ev.trail || [];
    if (trail.length) parts.push(`${trailTitle(trail.length)}\n\n${trail.map((s) => `  ${stepKind(s)}: ${s.query || s.url || s.pattern || ''}${s.error ? ` · ${s.error}` : ''}`).join('\n')}`);
    parts.push(raw);
    byId('claims-raw-body').textContent = parts.join(`\n\n${'─'.repeat(40)}\n\n`);
  }

  function reset() {
    Object.assign(run, { cost: 0, unpriced: false, gate: null, tally: new Map() });
    gateLine();
    for (const id of ['step1-thinking', 'claims-raw']) {
      const box = byId(id);
      if (box) { box.hidden = true; box.open = false; }
    }
    const thinking = byId('step1-thinking-body');
    if (thinking) thinking.textContent = '';
  }

  /** Signed out: no trial is offered and no cost is shown until the page is the operator's again. */
  function signOut() { if (state.server) Object.assign(state.server, { trial: null, accounting: false }); }

  choice = loadChoice();
  return {
    start, reset, again: () => Boolean(trialOffer()), choices, runsFor, paint, tools, title, ask: (claim) => claim.ask || {},
    event, cardLine, stepLine, listingLine, listingDone, cardDone, retrying, logParts, foot, named, mark,
    warning, failureLink: () => word('checkLink'), score, shown, signOut, detail, noteParts, listingThinking,
  };
}
