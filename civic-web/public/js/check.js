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

/** The gate's figures, in OpenAI's own numbers: what the key's minute holds and what each request costs. */
function pacingRows(pacing) {
  const rows = [];
  const n = (v) => Number(v).toLocaleString('en-US');
  for (const g of pacing || []) {
    const parts = [];
    if (g.tokens?.limit) parts.push(`${n(g.tokens.limit)} tokens a minute`);
    if (g.requests?.limit) parts.push(`${n(g.requests.limit)} requests a minute`);
    for (const [kind, cost] of Object.entries(g.costs || {})) parts.push(`OpenAI has counted up to ${n(cost)} for one ${kind}`);
    if (g.tokens?.available !== null && g.tokens?.available !== undefined) parts.push(`${n(g.tokens.available)} tokens available now`);
    parts.push(`${g.inFlight} in flight · ${g.waiting} waiting · ${g.replies} replies · ${g.refusals} refusals`);
    rows.push([`Pacing, ${g.model}`, parts.join(' · ')]);
  }
  if (!rows.length) rows.push(['Pacing', 'Nothing has been sent since this FactEngine started. The key\'s minute figures arrive with the first reply.']);
  return rows;
}

function renderSettings(s, build, pacing, silent, tools) {
  const rows = [
    ['Model', s.model],
    ['Reasoning effort', s.effort],
    ['Web search', s.webSearch ? 'on, for both steps' : 'off'],
    ['Claims per run', String(s.claimsPerRun)],
    ['Key comes from', s.keySource],
    ['Prompt versions', s.prompts || 'none installed'],
    ['Version', build],
    ...pacingRows(pacing),
    ...(silent && silent.length ? [['Sites that stayed silent', silent.map((x) => `${x.host} (${x.cause}, since ${x.at.slice(11, 19)} UTC)`).join(' · ') + ' — a site that never answers the connection is remembered until FactEngine restarts, and re-checked whenever it is asked for again']] : []),
    ...(tools ? [['Sources the model can reach for', (tools.sources || []).length ? (tools.sources.map((x) => `${x.name} (${x.verbs.join(', ')})`).join(' · ') + (tools.reachable ? '' : ' — not in the requests yet: the gateway\'s address and pass are not both set')) : 'none on']] : []),
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

function table(head, rows) {
  const wrap = el('div', 'check-scroll');   // a wide table scrolls sideways rather than widening the page
  const t = document.createElement('table');
  t.className = 'check-settings';
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

/** The lines of the measurement, as sentences (the page and the text report share them). */
function economicsLines(e) {
  const c = e.currency;
  const lines = [];
  const p = e.price;
  if (p.cents === null || p.cents === undefined) {
    lines.push(`No price yet. ${p.measuredSample} of the ${p.minSample} determinations the average needs have been measured over the last ${p.days} days` +
      (p.measuredAvgUsd !== null ? `, averaging ${money(p.measuredAvgUsd, c)} each (${money(p.measuredAvgUsd * (1 + p.markupPercent / 100), c)} with the ${p.markupPercent} % markup)` : '') +
      '. Until the sample exists nothing is priced; set CIVIC_PRICE_START_CENTS to price from today, and the measured figure takes over at the first window after the sample is complete.');
  } else {
    lines.push(`Price per claim: ${cents(p.cents, c)}, fixed for the window that began ${p.windowStart.slice(0, 16).replace('T', ' ')} UTC` +
      (p.basis === 'measured' ? ` from the measured average of ${money(p.windowAvgUsd, c)} over ${p.windowSample} determinations in the ${p.days} days before it, marked up ${p.markupPercent} % and rounded up to the cent.`
        : ` from CIVIC_PRICE_START_CENTS, because the ${p.days}-day sample held ${p.windowSample} of the ${p.minSample} determinations the average needs.`) +
      (p.measuredSample ? ` Measured so far: ${p.measuredSample} determinations averaging ${money(p.measuredAvgUsd, c)}, which would price at ${money(Math.ceil(p.measuredAvgUsd * (100 + p.markupPercent)) / 100, c)}.` : ''));
  }
  const t = e.tier;
  lines.push(t.fixed ? `Tier ${t.now} for everyone (CIVIC_TIER_FIXED): ${t.freeFacts} free claim${t.freeFacts === 1 ? '' : 's'} per document.`
    : `Tier ${t.now} now${t.underGuard ? ', held there by the loss guard' : ''}: ${t.freeFacts} free claim${t.freeFacts === 1 ? '' : 's'} per document. The tiers change every ${t.hours} hours in the order ${t.order.join(', ')}, starting ${t.shift} later each day${t.shift ? ' so that every tier meets every time of day' : ''}; the next change is at ${t.nextChangeAt.slice(11, 16)} UTC. A run keeps the tier it started under.`);
  const g = e.guard;
  if (!g.configured) lines.push('The loss guard is off: set CIVIC_TIER_LOSS_GUARD_USD to the loss in one window that should send every new run to tier 1 until it is earned back.');
  else if (g.engaged) lines.push(`The loss guard is engaged since ${g.since.slice(0, 16).replace('T', ' ')} UTC: the window had lost ${money(g.lossUsd, c)} (the guard is ${money(g.thresholdUsd, c)}); ${money(g.earnedUsd, c)} has been earned back since, and the rotation resumes once that covers the loss.`);
  else lines.push(`The loss guard is watching: this window's margin is ${money(g.windowMarginUsd, c)} against a guard of ${money(g.thresholdUsd, c)}${g.released ? `; last released ${g.released.slice(0, 16).replace('T', ' ')} UTC` : ''}.`);
  lines.push(`${e.note} The rows live in ${e.store === 'postgres' ? 'Postgres and outlive every deploy' : 'this instance\'s memory and reset when it restarts'}.`);
  return lines;
}

/** The operator's measurement: the price, the tier clock, the guard, and the money per tier, per user and per window. */
function renderEconomics(e) {
  let box = $('#economics');
  if (!box) { box = el('div', 'check-failures'); box.id = 'economics'; $('#failures').before(box); }
  box.textContent = '';
  if (!e) return;
  box.append(el('h2', null, 'Prices, tiers and what each user costs'));
  if (e.error) { box.append(el('p', 'check-detail', `The measurement could not be read: ${e.error}`)); return; }
  const ul = el('ul');
  for (const line of economicsLines(e)) ul.append(el('li', null, line));
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
  box.append(el('p', 'check-detail', 'Cost is each determination\'s own ledger line (OpenAI\'s token counts at the price table, plus its searches); the listing cost is each run\'s extraction, kept apart. Margin is revenue at list less the determinations\' cost. Coverage is revenue against cost plus the markup: 1.00 means the tokens and the markup are both covered. A free determination counts as given; a failed one keeps its cost and books nothing.'));
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

/** Who signed in, most recent first, when a sign-in is required. */
function renderSignins(data) {
  let box = $('#signins');
  if (!box) { box = el('div', 'check-failures'); box.id = 'signins'; $('#failures').after(box); }
  box.textContent = '';
  if (!data.access?.required) return;
  box.append(el('h2', null, 'Recent sign-ins'));
  if (!data.signins?.length) { box.append(el('p', 'check-detail', 'Nobody has signed in since this FactEngine started.')); return; }
  const ul = el('ul');
  for (const s of data.signins) {
    const li = document.createElement('li');
    li.append(el('time', null, new Date(s.at).toLocaleString()), document.createTextNode(` · ${s.email || 'no email given'} · code ending ${s.code}`));
    ul.append(li);
  }
  box.append(ul);
  renderCodes(data, box);
}

/** Each listed code, by its last two characters: the runs it has started and the runs it allows. */
function renderCodes(data, after) {
  if (!data.codes?.length) return;
  after.append(el('h2', null, 'Runs per code'));
  const ul = el('ul');
  for (const c of data.codes) ul.append(el('li', null, `code ending ${c.ending} · ${c.used} of ${c.allowed} runs used`));
  after.append(ul);
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
    for (const line of economicsLines(data.economics)) lines.push(`  ${line}`);
    for (const x of data.economics.byTier) lines.push(`  tier ${x.tier}: ${x.users} users, ${x.runs} runs, ${x.determinations} determinations (${x.freeGiven} free, ${x.failed} failed), cost ${money(x.costUsd, data.economics.currency)}, listing ${money(x.extractUsd, data.economics.currency)}, revenue at list ${money(x.revenueUsd, data.economics.currency)}, margin ${money(x.marginUsd, data.economics.currency)}, coverage ${x.coverage === null ? '—' : x.coverage.toFixed(2)}`);
  }
  if (data.recentFailures?.length) {
    lines.push('', 'Recent failures');
    for (const f of data.recentFailures) lines.push(`  ${f.at} ${f.where} ${f.code || ''} ${f.message}`);
  }
  if (data.access?.required) {
    lines.push('', 'Recent sign-ins');
    for (const s of data.signins || []) lines.push(`  ${s.at} ${s.email || 'no email given'} code ending ${s.code}`);
    lines.push('', 'Runs per code');
    for (const c of data.codes || []) lines.push(`  code ending ${c.ending}: ${c.used} of ${c.allowed} runs used`);
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
    if (res.status === 401) {
      // The door is locked and this browser has not signed in: the main page's Sign in opens it.
      verdict.className = 'check-verdict is-blocked';
      verdict.textContent = 'Sign in on the main page first, then check again.';
      $('#report').value = 'This FactEngine needs a sign-in. Open the main page, sign in with an access code, then come back here.';
      return;
    }
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    const data = await res.json();
    verdict.className = `check-verdict ${data.ready ? 'is-ready' : 'is-blocked'}`;
    verdict.textContent = data.summary;
    renderChecks(data.checks);
    renderSettings(data.settings, data.build, data.pacing, data.silentSites, data.tools);
    renderEconomics(data.economics);
    renderFailures(data.recentFailures);
    renderSignins(data);
    $('#report').value = asText(data);
  } catch (err) {
    verdict.className = 'check-verdict is-blocked';
    verdict.textContent = `The FactEngine server did not answer: ${err.message}. Is the FactEngine window still open?`;
    $('#report').value = `The FactEngine server did not answer: ${err.message}`;
  }
}

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
