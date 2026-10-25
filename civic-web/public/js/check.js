// The self-check page. It asks the server what is wrong and says so in sentences, and it keeps
// saying so: nothing here disappears after a few seconds.
const $ = (sel) => document.querySelector(sel);
const MARKS = { ok: '✓', bad: '✕', warn: '!' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderChecks(checks) {
  const box = $('#items');
  box.textContent = '';
  for (const c of checks) {
    const row = el('div', `check-item ${c.state}`);
    row.append(el('div', 'check-mark', MARKS[c.state] || '·'));
    const body = el('div');
    body.append(el('div', 'check-title', c.title));
    if (c.detail) body.append(el('div', 'check-detail', c.detail));
    if (c.fix) {
      const fix = el('div', 'check-fix');
      fix.append(el('b', null, 'To fix: '), document.createTextNode(c.fix));
      body.append(fix);
    }
    row.append(body);
    box.append(row);
  }
}

/** The gate's figures, in the provider's own numbers: what the key's minute holds and what each request costs. */
function pacingRows(pacing) {
  const rows = [];
  const n = (v) => Number(v).toLocaleString('en-US');
  for (const g of pacing || []) {
    const parts = [];
    if (g.tokens?.limit) parts.push(`${n(g.tokens.limit)} tokens a minute`);
    if (g.requests?.limit) parts.push(`${n(g.requests.limit)} requests a minute`);
    for (const [kind, cost] of Object.entries(g.costs || {})) parts.push(`counted up to ${n(cost)} for one ${kind}`);
    if (g.tokens?.available !== null && g.tokens?.available !== undefined) parts.push(`${n(g.tokens.available)} tokens available now`);
    const air = g.pending ? ` (${g.pending} sent and awaiting ${g.pending === 1 ? 'its' : 'their'} headers, ${n(g.reserved || 0)} tokens reserved for ${g.pending === 1 ? 'it' : 'them'})` : '';
    const byKind = Object.entries(g.waitingByKind || {}).map(([k, c]) => `${c} ${k === 'extraction' ? (c === 1 ? 'listing' : 'listings') : k === 'determination' ? (c === 1 ? 'determination' : 'determinations') : k}`).join(', ');
    const line = g.waiting ? ` (${byKind}${g.owners ? `, from ${g.owners} ${g.owners === 1 ? 'reader' : 'readers'}` : ''})` : '';
    parts.push(`${g.inFlight} in flight${air} · ${g.waiting} waiting${line} · ${g.replies} replies · ${g.refusals} refusals`);
    rows.push([`Pacing, ${g.model}`, parts.join(' · ')]);
  }
  if (!rows.length) rows.push(['Pacing', 'Nothing has been sent since this FactEngine started. The key\'s minute figures arrive with the first reply.']);
  return rows;
}

function renderSettings(s, build, pacing, silent, tools, readers) {
  const rows = [
    ...((s.listingModel && s.listingModel !== s.model) || (s.listingProvider && s.listingProvider !== 'OpenAI')
      ? [['Listing', `${s.listingModel} on ${s.listingProvider}, effort ${s.listingEffort}`], ['Determinations', `${s.model} on OpenAI, effort ${s.effort}`]]
      : [['Model', s.model], ['Reasoning effort', s.effort]]),
    ['Web search', s.listingWebSearch === false ? 'on for the determinations; never on the listing, which reads the document it is given and nothing else' : s.webSearch ? 'on, for both steps' : 'off'],
    ...(s.trialModels && s.trialModels !== 'off' ? [['Your trial', `${s.trialModels}, chosen on the page, for your account alone`]] : []),
    ...(s.rank ? [['Ranking the claims', s.rank]] : []),
    ['Claims one request may carry', `${s.claimsPerRun} (the page sends one claim per request; this bounds nothing it does)`],
    ['Key comes from', s.keySource],
    ['Prompt versions', s.prompts || 'none installed'],
    ['Version', build],
    ...pacingRows(pacing),
    ...(readers !== undefined && readers !== null ? [['Readers now', readers ? `${readers} with work in flight on this instance` : 'none with work in flight on this instance']] : []),
    ...(silent && silent.length ? [['Sites that stayed silent', silent.map((x) => `${x.host} (${x.cause}, since ${x.at.slice(11, 19)} UTC)`).join(' · ') + ' — a site that never answers the connection is remembered until FactEngine restarts, and re-checked whenever it is asked for again']] : []),
    ...(tools ? [['Sources the model can reach for', (tools.sources || []).length ? (tools.sources.map((x) => `${x.name} (${x.verbs.join(', ')})`).join(' · ') + (!tools.reachable ? ' — not in the requests yet: the gateway\'s address and pass are not both set' : tools.requests && !tools.requests.determinations ? ' — named in the listing\'s requests only' : '')) : 'none on']] : []),
  ];
  const table = $('#settings');
  table.textContent = '';
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    tr.append(el('td', null, k), el('td', null, v));
    table.append(tr);
  }
}

/** Money for the operator's page, in the service's currency. */
function money(usd, currency) {
  if (usd === null || usd === undefined) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(usd)); }
  catch { return `${Number(usd).toFixed(2)} ${currency || ''}`; }
}
const cents = (c, currency) => (c === null || c === undefined ? 'none yet' : money(c / 100, currency));

function table(head, rows, className = '') {
  const wrap = el('div', 'check-scroll');   // a wide table scrolls sideways rather than widening the page
  const t = document.createElement('table');
  t.className = `check-settings ${className}`.trim();
  wrap.append(t);
  const tr = document.createElement('tr');
  for (const h of head) tr.append(el('th', null, h));
  t.append(tr);
  for (const row of rows) {
    const r = document.createElement('tr');
    for (const v of row) r.append(el('td', null, v === null || v === undefined ? '—' : String(v)));
    t.append(r);
  }
  return wrap;
}

/**
 * How many determinations the key's minute holds at once: the key's own figure (OpenAI's, from the pacing row of the
 * determinations' model) over what one running determination takes of it, its mean tokens over its mean minutes.
 */
function capacity(d, pacing, model) {
  if (!d?.determinations?.n || !(d.determinations.meanTokens > 0) || !(d.determinations.meanMs > 0)) return null;
  const minutes = d.determinations.meanMs / 60000;
  const perMinute = d.determinations.meanTokens / minutes;
  const limit = (pacing || []).find((g) => g.model === model)?.tokens?.limit || null;
  return { tokens: d.determinations.meanTokens, minutes, perMinute, limit, atOnce: limit ? Math.floor(limit / perMinute) : null };
}

/** The lines of the measurement, as sentences (the page and the text report share them). */
function economicsLines(e, { pacing = null, model = null } = {}) {
  const c = e.currency;
  const n = (v) => Number(v).toLocaleString('en-US');
  const lines = [];
  const p = e.price;
  const measuredWords = p.measuredSample
    ? ` Measured over the last ${p.days} days: ${p.measuredSample} determinations averaging ${money(p.measuredAvgUsd, c)} each` +
      (p.coverage !== null && p.coverage !== undefined ? `; the list price covers that cost and the ${p.markupPercent} % markup ${p.coverage.toFixed(2)} times (1.00 is exactly).` : '.')
    : ` No determination has been measured in the last ${p.days} days yet.`;
  if (p.cents === null || p.cents === undefined) lines.push(`No list price is set (CIVIC_LIST_PRICE_CENTS), so nothing is priced: every fact-check is free to the reader.${measuredWords}`);
  else lines.push(`Each fact-check is ${cents(p.cents, c)} (CIVIC_LIST_PRICE_CENTS), for every window and every reader; a document keeps the price it was listed under.${measuredWords}`);
  const cap = capacity(e.durations, pacing, model);
  if (cap) {
    lines.push(cap.atOnce !== null
      ? `At this key's ${n(cap.limit)} tokens a minute, about ${n(cap.atOnce)} fact-checks can run at once (each uses about ${n(cap.tokens)} tokens over ${Number(cap.minutes.toPrecision(3))} minutes, ${n(Math.round(cap.perMinute))} a minute). Beyond that a fact-check waits its turn at the gate.`
      : `Each fact-check uses about ${n(cap.tokens)} tokens over ${Number(cap.minutes.toPrecision(3))} minutes, ${n(Math.round(cap.perMinute))} a minute. The key's minute figure arrives with this FactEngine's first reply; divided by that, it is how many can run at once.`);
  }
  const t = e.tier;
  lines.push(t.fixed ? `Tier ${t.now} for everyone (CIVIC_TIER_FIXED): ${t.freeFacts} free claim${t.freeFacts === 1 ? '' : 's'} per document.`
    : `Tier ${t.now} now${t.underGuard ? ', held there by the loss guard' : ''}: ${t.freeFacts} free claim${t.freeFacts === 1 ? '' : 's'} per document. The tiers change every ${t.hours} hours in the order ${t.order.join(', ')}, starting ${t.shift} later each day${t.shift ? ' so that every tier meets every time of day' : ''}; the next change is at ${t.nextChangeAt.slice(11, 16)} UTC. A run keeps the tier it started under.`);
  const g = e.guard;
  if (!g.configured) lines.push('The loss guard is off: set CIVIC_TIER_LOSS_GUARD_USD to the loss in one window that should send every new run to tier 1 until it is earned back.');
  else if (g.engaged) lines.push(`The loss guard is engaged since ${g.since.slice(0, 16).replace('T', ' ')} UTC: the window had lost ${money(g.lossUsd, c)} (the guard is ${money(g.thresholdUsd, c)}); ${money(g.earnedUsd, c)} has been earned back since, and the rotation resumes once that covers the loss.`);
  else lines.push(`The loss guard is watching: this window's margin is ${money(g.windowMarginUsd, c)} against a guard of ${money(g.thresholdUsd, c)}${g.released ? `; last released ${g.released.slice(0, 16).replace('T', ' ')} UTC` : ''}.`);
  const d = e.durations;
  const mins = (ms) => (ms >= 90000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
  if (d && (d.determinations.n || d.extractions.n)) {
    lines.push((d.determinations.n ? `A determination takes ${mins(d.determinations.meanMs)} on average over the last ${e.price.days} days (three in four within ${mins(d.determinations.p75Ms)}, ${d.determinations.n} measured)${d.determinations.meanSearches !== null ? `, with ${d.determinations.meanSearches} web searches each` : ''}` : 'No determination measured yet') +
      (d.extractions.n ? `; a listing takes ${mins(d.extractions.meanMs)} on average (three in four within ${mins(d.extractions.p75Ms)}, ${d.extractions.n} measured)` : '; no listing measured yet') +
      (d.rankings?.n ? `; ranking its claims, ${mins(d.rankings.meanMs)} more (three in four within ${mins(d.rankings.p75Ms)}, ${d.rankings.n} measured)` : '') +
      '. The times run from the request to its end, so a wait at the gate is inside them.');
  } else lines.push('No durations measured yet: the first runs put how long a determination and a listing take here.');
  lines.push(`${e.note} The rows live in ${e.store === 'postgres' ? 'Postgres and outlive every deploy' : 'this instance\'s memory and reset when it restarts'}.`);
  return lines;
}

/** The operator's measurement: the price, the tier clock, the guard, and the money per tier, per user and per window. */
function renderEconomics(e, ctx = {}) {
  let box = $('#economics');
  if (!box) { box = el('div', 'check-failures'); box.id = 'economics'; $('#failures').before(box); }
  box.textContent = '';
  if (!e) return;
  box.append(el('h2', null, 'Prices, tiers and what each user costs'));
  if (e.error) { box.append(el('p', 'check-detail', `The measurement could not be read: ${e.error}`)); return; }
  renderTrial(box, e);
  const ul = el('ul');
  for (const line of economicsLines(e, ctx)) ul.append(el('li', null, line));
  box.append(ul);
  const c = e.currency;
  const row = (x) => [x.users, x.runs, x.determinations, x.failed, x.freeGiven, money(x.costUsd, c), money(x.extractUsd, c), money(x.revenueUsd, c), money(x.marginUsd, c), x.marginPerUserUsd === null ? null : money(x.marginPerUserUsd, c), x.coverage === null ? null : x.coverage.toFixed(2)];
  box.append(el('h2', null, 'Per tier'));
  box.append(e.byTier.length
    ? table(['Tier', 'Free per document', 'Users', 'Runs', 'Determinations', 'Failed', 'Free given', 'Cost', 'Listing cost', 'Revenue at list', 'Margin', 'Margin per user', 'Coverage'], e.byTier.map((x) => [x.tier, x.freeFacts, ...row(x)]))
    : el('p', 'check-detail', 'No run has been measured yet.'));
  box.append(el('h2', null, 'Per user'));
  box.append(e.byUser.length
    ? table(['User', 'Users', 'Runs', 'Determinations', 'Failed', 'Free given', 'Cost', 'Listing cost', 'Revenue at list', 'Margin', 'Margin per user', 'Coverage'], e.byUser.map((x) => [x.email || x.owner, ...row(x)]))
    : el('p', 'check-detail', 'Nobody has run a test yet.'));
  box.append(el('h2', null, 'Per window'));
  box.append(e.byWindow.length
    ? table(['Window (UTC)', 'Tier', 'Price', 'Users', 'Runs', 'Determinations', 'Failed', 'Free given', 'Cost', 'Listing cost', 'Revenue at list', 'Margin', 'Margin per user', 'Coverage'], e.byWindow.map((x) => [x.windowStart ? x.windowStart.slice(0, 16).replace('T', ' ') : '—', x.tier, cents(x.priceCents, c), ...row(x)]))
    : el('p', 'check-detail', 'No window has had a run yet.'));
  box.append(el('p', 'check-detail', 'Cost is each determination\'s own ledger line (the provider\'s token counts at the price table, plus its searches); the listing cost is each run\'s extraction, kept apart. Margin is revenue at list less the determinations\' cost. Coverage is revenue against cost plus the markup: 1.00 means the tokens and the markup are both covered. A free determination counts as given; a failed one keeps its cost and books nothing.'));
}

// ---- the models, measured (14 October; everything kept since 23 October) ----------------------------------------------
const msWords = (ms) => (ms === null || ms === undefined ? '—' : ms >= 90000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
const countWords = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));
/** A trial's costs can be fractions of a cent, so they show to the hundredth of a cent. */
const centsWords = (v, c) => { if (v === null || v === undefined) return '—'; try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(v)); } catch { return `${Number(v).toFixed(4)} ${c || ''}`; } };
const modelWords = (x) => `${x.model || '—'}${x.effort ? ` at ${x.effort}` : ''}${x.who === 'readers' ? ' (readers)' : x.provider === 'openai' ? ' (side by side)' : ''}`;
const sinceWords = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }) : '');
/** What the fact-checks took from the operator's list of sites kept out of the research, over those that counted it. */
const listedWords = (x) => (x.listed === null || x.listed === undefined ? '—' : `${countWords(x.listed)} in ${countWords(x.listedOf)}${x.keptOut ? ` (${countWords(x.keptOut)} kept out)` : ''}`);
const pairWords = (p) => (modelWords(p.a) === modelWords(p.b) ? `${modelWords(p.a)}, with itself` : `${modelWords(p.a)} and ${modelWords(p.b)}`);

/**
 * The models, measured (the operator's question of 23 October: "Are you measuring the attributes of the different models,
 * such as how long they take to run, the length of their outputs, cost, and any other"): their own fact-checks per model
 * and effort, beside the readers' model, since the trial began. Narrow tables, so they read on an iPad as they are.
 */
function renderTrial(box, e) {
  if (!Array.isArray(e.trial) || !e.trial.length) return;
  const c = e.currency;
  const rows = e.trial;
  box.append(el('h2', null, `The models, measured, since ${sinceWords(e.trialSince)}`));
  box.append(el('h3', null, 'Speed'));
  box.append(table(['Model', 'In all, mean', 'In all, three in four within', 'Working, mean', 'Before its first word', 'Writing', 'Waiting', 'Timed'],
    rows.map((x) => [modelWords(x), msWords(x.meanMs), msWords(x.p75Ms), msWords(x.workMs), msWords(x.firstWordMs), msWords(x.writeMs), msWords(x.waitMs), `${x.timed} of ${x.n}`]), 'check-models'));
  box.append(el('h3', null, 'Length'));
  box.append(table(['Model', 'Entry, characters', 'Entry, words', 'Tokens read', 'Tokens thought', 'Tokens written', 'Written a second'],
    rows.map((x) => [modelWords(x), countWords(x.entryChars), countWords(x.entryWords), countWords(x.tokensIn), countWords(x.tokensThought), countWords(x.tokensWritten), countWords(x.tokensPerSecond)]), 'check-models'));
  box.append(el('h3', null, 'Work and cost'));
  box.append(table(['Model', 'Searches', 'Pages read', 'Sources cited', 'From your list', 'Cost each', 'Tokens\' part', 'Searches\' part', 'Cost, all'],
    rows.map((x) => [modelWords(x), countWords(x.meanQueries), countWords(x.meanReads), countWords(x.meanSources), listedWords(x), centsWords(x.meanUsd, c), centsWords(x.tokenUsd, c), centsWords(x.searchUsd, c), centsWords(x.totalUsd, c)]), 'check-models'));
  box.append(el('h3', null, 'Outcome'));
  box.append(table(['Model', 'Delivered', 'Failed', 'Stopped early', 'True / False / Unverified', 'Verdict unread', 'Confidence, mean'],
    rows.map((x) => [modelWords(x), x.n, x.failed, x.incomplete, `${x.verdicts.true} / ${x.verdicts.false} / ${x.verdicts.unverified}`, x.unread, x.confidence === null || x.confidence === undefined ? '—' : `${x.confidence}%`]), 'check-models'));
  if (Array.isArray(e.agreement) && e.agreement.length) {
    box.append(el('h3', null, 'Agreement'));
    box.append(table(['Models', 'Claims in common', 'Same verdict', 'Different verdict'], e.agreement.map((p) => [pairWords(p), p.claims, p.same, p.different]), 'check-models'));
  }
  box.append(el('p', 'check-detail', `From every fact-check kept since your trial began: your own on the model you chose on the page, never charged and kept out of the readers' figures below, and the readers' over the same days. Each figure is the mean of the fact-checks that hold it, "—" where none does. The time split and the entry's length are kept from 23 October ("Timed" counts them): working is the time less the waits (the key's minute at the gate, a provider's "wait", a cut connection); before its first word is the searching, reading and thinking, writing is the entry itself. Searches and pages read are counted alike for every model; OpenAI also bills a page opened as a search, so GPT-5.6 Sol's searches' part can count more. DeepSeek cites no sources of its own. From your list counts, in all, the pages of the sites you keep out of the research among what each fact-check cited, opened, read or was told its search consulted, over the fact-checks counted since a list was set ("0 in 12": none in twelve); kept out are those it asked for and did not get. Agreement pairs the models that tested the same claim, in the same words, by their latest verdicts read; a model with itself tested a claim twice.`));
  box.append(el('p', 'check-detail', 'On DeepSeek the model searches through FactEngine\'s search service and reads pages through FactEngine; its cost is DeepSeek\'s tokens at the hour\'s price plus each search\'s own. On Gemini the model searches with Google\'s own search and reads pages itself; its cost is Google\'s tokens (thinking included) plus $14 per 1,000 searches, an upper bound while the month\'s 5,000 free searches last.'));
}

/** The same, as lines for the copied report: one line per model and one per pair. */
function modelsLines(e) {
  if (!Array.isArray(e.trial) || !e.trial.length) return [];
  const c = e.currency;
  return [
    ...e.trial.map((x) => `${modelWords(x)}: ${x.n} delivered, ${x.failed} failed, ${x.incomplete} stopped early; in all ${msWords(x.meanMs)} (three in four within ${msWords(x.p75Ms)}); working ${msWords(x.workMs)}, ${msWords(x.firstWordMs)} before its first word, ${msWords(x.writeMs)} writing, ${msWords(x.waitMs)} waiting (${x.timed} timed); entry ${countWords(x.entryChars)} characters, ${countWords(x.entryWords)} words; tokens ${countWords(x.tokensIn)} read, ${countWords(x.tokensThought)} thought, ${countWords(x.tokensWritten)} written, ${countWords(x.tokensPerSecond)} a second; ${countWords(x.meanQueries)} searches, ${countWords(x.meanReads)} pages read, ${countWords(x.meanSources)} sources${x.listed === null || x.listed === undefined ? '' : `, ${listedWords(x)} from your list`}; ${centsWords(x.meanUsd, c)} each (tokens ${centsWords(x.tokenUsd, c)}, searches ${centsWords(x.searchUsd, c)}), ${centsWords(x.totalUsd, c)} in all; ${x.verdicts.true} true, ${x.verdicts.false} false, ${x.verdicts.unverified} unverified, ${x.unread} unread; confidence ${x.confidence === null || x.confidence === undefined ? '—' : `${x.confidence}%`}`),
    ...(e.agreement || []).map((p) => `${pairWords(p)}: ${p.claims} ${p.claims === 1 ? 'claim' : 'claims'} in common, ${p.same} with the same verdict, ${p.different} with a different one`),
  ];
}

function renderFailures(list) {
  const box = $('#failures');
  box.textContent = '';
  if (!list?.length) return;
  box.append(el('h2', null, 'Recent failures'));
  box.append(el('p', 'check-detail', 'Kept so they can be read after the fact. No key, prompt or document text is recorded.'));
  const ul = el('ul');
  for (const f of list) {
    const li = document.createElement('li');
    const when = el('time', null, new Date(f.at).toLocaleString());
    li.append(when, document.createTextNode(` · ${f.where} · ${f.code || 'no code'} · ${f.message}`));
    ul.append(li);
  }
  box.append(ul);
}

// ---- the accounts (5 October): the operator's table, and what they can do from it -------------------------------------
const amount = (c, currency) => money((Number(c) || 0) / 100, currency);

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let out = null; try { out = await res.json(); } catch { /* none */ }
  if (!res.ok) throw new Error(out?.error?.message || `the server answered ${res.status}`);
  return out;
}

/** Every account, newest first, with its balance, this month's spend and its charged tests; and the operator's tools. */
async function renderAccounts(data) {
  let box = $('#accounts');
  if (!box) { box = el('div', 'check-failures'); box.id = 'accounts'; $('#failures').after(box); }
  box.textContent = '';
  if (!data.access?.required) return;
  let out;
  try {
    const res = await fetch('api/operator/accounts', { cache: 'no-store' });
    if (!res.ok) return;
    out = await res.json();
  } catch { return; }
  const c = out.currency;
  box.append(el('h2', null, 'Accounts'));
  const t = out.totals || {};
  box.append(el('p', 'check-detail', `Credit given: ${amount(t.grantedCents, c)} to ${t.accounts ?? 0} ${t.accounts === 1 ? 'account' : 'accounts'} · spent from credit: ${amount(t.spentCents, c)} · collected: ${amount(t.collectedCents, c)} (payments are not live yet).`));
  if (!out.claimUsed) box.append(el('p', 'check-detail', out.claimSet ? 'The operator\'s one-time link is set and not used yet.' : 'No operator link is set (CIVIC_OPERATOR_CLAIM).'));
  if (!out.accounts.length) { box.append(el('p', 'check-detail', 'Nobody has an account yet.')); return; }
  const wrap = el('div', 'check-scroll');
  const table = el('table', 'check-settings');
  const head = el('tr');
  for (const h of ['Email', 'Made', 'Balance', 'This month', 'Tests charged', 'Status', '']) head.append(el('th', null, h));
  table.append(head);
  for (const a of out.accounts) {
    const tr = el('tr');
    const status = a.deleted ? 'deleted' : a.blocked ? 'closed' : a.operator ? 'operator' : 'open';
    for (const v of [a.email || '(deleted)', new Date(a.createdAt).toLocaleDateString(), amount(a.balanceCents, c), amount(a.monthCents, c), String(a.tests), status]) tr.append(el('td', null, v));
    const tools = el('td');
    if (!a.deleted) {
      const btn = (label, fn) => { const b = el('button', 'btn btn-text btn-small', label); b.type = 'button'; b.addEventListener('click', fn); tools.append(b); return b; };
      btn('Add credit', async () => {
        const raw = prompt(`Credit to add to ${a.email}, in ${c} (a minus sign takes it back):`, '10.00');
        if (raw === null) return;
        const v = Math.round(Number(String(raw).replace(',', '.')) * 100);
        if (!Number.isInteger(v) || v === 0) return;
        const noteText = prompt('A note for the account\'s activity (optional):', '') || '';
        try { await post('api/operator/credit', { userId: a.id, cents: v, note: noteText }); await renderAccounts(data); } catch (err) { alert(err.message); }
      });
      btn('Reset link', async () => {
        try {
          const r = await post('api/operator/reset-link', { userId: a.id });
          const shown = el('p', 'check-detail', `A link for ${r.email}, good once until ${new Date(r.expiresAt).toLocaleString()}: `);
          const input = el('input', 'input');
          input.readOnly = true; input.value = r.link; input.style.marginTop = '.4rem';
          const copy = el('button', 'btn btn-outline btn-small', 'Copy');
          copy.type = 'button';
          copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.link); copy.textContent = 'Copied'; } catch { input.select(); } });
          shown.append(input, copy);
          const row = el('tr');
          const cell = el('td');
          cell.colSpan = 7;
          cell.append(shown);
          row.append(cell);
          tr.after(row);
        } catch (err) { alert(err.message); }
      });
      if (!a.operator) {
        btn(a.blocked ? 'Open' : 'Close', async () => { try { await post('api/operator/block', { userId: a.id, blocked: !a.blocked }); await renderAccounts(data); } catch (err) { alert(err.message); } });
        btn('Delete', async () => {
          if (!confirm(`Delete the account of ${a.email}? Its email and password go, and its sessions end. This cannot be undone.`)) return;
          try { await post('api/operator/delete', { userId: a.id }); await renderAccounts(data); } catch (err) { alert(err.message); }
        });
      }
    }
    tr.append(tools);
    table.append(tr);
  }
  wrap.append(table);
  box.append(wrap);
}

function asText(data) {
  const lines = [
    `FactEngine self-check · ${data.at}`,
    `Version ${data.build}`,
    data.summary,
    '',
    ...data.checks.map((c) => `${MARKS[c.state] || '·'} ${c.title}${c.detail ? ` — ${c.detail}` : ''}${c.fix ? `\n    To fix: ${c.fix}` : ''}`),
    '',
    'Settings',
    ...Object.entries(data.settings).map(([k, v]) => `  ${k}: ${v}`),
    ...pacingRows(data.pacing).map(([k, v]) => `  ${k}: ${v}`),
  ];
  if (data.economics && !data.economics.error) {
    lines.push('', 'Prices, tiers and what each user costs');
    for (const line of economicsLines(data.economics, { pacing: data.pacing, model: data.settings?.model })) lines.push(`  ${line}`);
    for (const x of data.economics.byTier) lines.push(`  tier ${x.tier}: ${x.users} users, ${x.runs} runs, ${x.determinations} determinations (${x.freeGiven} free, ${x.failed} failed), cost ${money(x.costUsd, data.economics.currency)}, listing ${money(x.extractUsd, data.economics.currency)}, revenue at list ${money(x.revenueUsd, data.economics.currency)}, margin ${money(x.marginUsd, data.economics.currency)}, coverage ${x.coverage === null ? '—' : x.coverage.toFixed(2)}`);
    const measured = modelsLines(data.economics);
    if (measured.length) lines.push('', `The models, measured, since ${sinceWords(data.economics.trialSince)}`, ...measured.map((l) => `  ${l}`));
  }
  if (data.recentFailures?.length) {
    lines.push('', 'Recent failures');
    for (const f of data.recentFailures) lines.push(`  ${f.at} ${f.where} ${f.code || ''} ${f.message}`);
  }
  return lines.join('\n');
}

async function run() {
  const verdict = $('#verdict');
  verdict.className = 'check-verdict is-waiting';
  verdict.textContent = 'Checking…';
  try {
    const res = await fetch('api/selftest', { cache: 'no-store' });
    if (res.status === 404) {
      // This page came from the files on disk, but the running server has no such route: the
      // process is older than the files around it. Almost always an earlier FactEngine window still open.
      verdict.className = 'check-verdict is-blocked';
      verdict.textContent = 'The FactEngine that is running is older than the FactEngine on this computer. '
        + 'Close every FactEngine window, then start it again from the Desktop.';
      $('#report').value = 'The running server does not have /api/selftest, so it predates the files '
        + 'it is serving. An older FactEngine window is still holding the port.';
      return;
    }
    if (res.status === 401 || res.status === 403) {
      // The check page is the operator's (5 October): signed out, or signed in with a reader's account.
      verdict.className = 'check-verdict is-blocked';
      verdict.textContent = res.status === 401 ? 'Sign in on the main page with the operator\'s account, then check again.' : 'This page is for the operator\'s account.';
      $('#report').value = verdict.textContent;
      return;
    }
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    const data = await res.json();
    verdict.className = `check-verdict ${data.ready ? 'is-ready' : 'is-blocked'}`;
    verdict.textContent = data.summary;
    renderChecks(data.checks);
    renderSettings(data.settings, data.build, data.pacing, data.silentSites, data.tools, data.readers);
    renderEconomics(data.economics, { pacing: data.pacing, model: data.settings?.model });
    renderFailures(data.recentFailures);
    await renderAccounts(data);
    $('#report').value = asText(data);
  } catch (err) {
    verdict.className = 'check-verdict is-blocked';
    verdict.textContent = `The FactEngine server did not answer: ${err.message}. Is the FactEngine window still open?`;
    $('#report').value = `The FactEngine server did not answer: ${err.message}`;
  }
}

// ---- Try a link (21 October): every way FactEngine reads one address, each told in a few words ------------------------
const OWN_WORDS = {
  url_refused: 'refused', url_silent: 'no answer in time', url_shell: 'a page its scripts build, with no prose to read',
  url_paywall: 'judged a paywall', url_unreachable: 'could not be reached', url_redirects: 'redirected too many times',
  url_status: 'answered with an error status', url_no_text: 'almost no text', url_private: 'a private address, never read',
  url_not_web: 'not a web address', url_too_big: 'too large', url_not_text: 'not text',
};
$('#try-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#try-out');
  out.textContent = '';
  const go = $('#try-go');
  go.disabled = true;
  go.textContent = 'Trying…';
  const line = (label, text) => { const li = el('li'); li.append(el('b', null, `${label}: `), document.createTextNode(text)); out.append(li); };
  try {
    const r = await post('api/operator/try-link', { url: $('#try-url').value.trim() });
    const n = (x) => Number(x || 0).toLocaleString('en-US');
    line(`FactEngine's reader (${r.site})`, r.own.ok ? `read it (${n(r.own.chars)} characters${r.own.wall ? ', marked as for subscribers' : ''})` : `${OWN_WORDS[r.own.code] || r.own.code}${r.own.detail ? ` (${r.own.detail})` : ''}`);
    line('The search service\'s reader', r.reader?.ok ? `read it (${[r.reader.from, `${n(r.reader.chars)} characters`].filter(Boolean).join(', ')})` : `could not: ${r.reader?.why || 'not asked'}`);
    line('Copies elsewhere', `${r.copies.found ? `${r.copies.found} found` : 'none found'}${r.copies.notes?.length ? ` (${r.copies.notes.join('; ')})` : ''}`);
  } catch (err) {
    out.append(el('li', null, `Could not try it: ${err.message}`));
  } finally {
    go.disabled = false;
    go.textContent = 'Try it';
  }
});

$('#again').addEventListener('click', run);
$('#copy').addEventListener('click', async () => {
  const report = $('#report');
  try {
    await navigator.clipboard.writeText(report.value);
    $('#copy').textContent = 'Copied';
    setTimeout(() => { $('#copy').textContent = 'Copy this report'; }, 2000);
  } catch {
    report.hidden = false;      // clipboard refused: show it so it can be selected by hand
    report.select();
  }
});

run();
