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

function renderSettings(s, build) {
  const rows = [
    ['Model', s.model],
    ['Reasoning effort', s.effort],
    ['Web search', s.webSearch ? 'on, for both steps' : 'off'],
    ['Claims per run', String(s.claimsPerRun)],
    ['Key comes from', s.keySource],
    ['Prompt versions', s.prompts || 'none installed'],
    ['Version', build],
  ];
  const table = $('#settings');
  table.textContent = '';
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    tr.append(el('td', null, k), el('td', null, v));
    table.append(tr);
  }
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

function asText(data) {
  const lines = [
    `CIVIC self-check · ${data.at}`,
    `Version ${data.build}`,
    data.summary,
    '',
    ...data.checks.map((c) => `${MARKS[c.state] || '·'} ${c.title}${c.detail ? ` — ${c.detail}` : ''}${c.fix ? `\n    To fix: ${c.fix}` : ''}`),
    '',
    'Settings',
    ...Object.entries(data.settings).map(([k, v]) => `  ${k}: ${v}`),
  ];
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
      // process is older than the files around it. Almost always an earlier CIVIC window still open.
      verdict.className = 'check-verdict is-blocked';
      verdict.textContent = 'The CIVIC that is running is older than the CIVIC on this computer. '
        + 'Close every CIVIC window, then start it again from the Desktop.';
      $('#report').value = 'The running server does not have /api/selftest, so it predates the files '
        + 'it is serving. An older CIVIC window is still holding the port.';
      return;
    }
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    const data = await res.json();
    verdict.className = `check-verdict ${data.ready ? 'is-ready' : 'is-blocked'}`;
    verdict.textContent = data.summary;
    renderChecks(data.checks);
    renderSettings(data.settings, data.build);
    renderFailures(data.recentFailures);
    $('#report').value = asText(data);
  } catch (err) {
    verdict.className = 'check-verdict is-blocked';
    verdict.textContent = `The CIVIC server did not answer: ${err.message}. Is the CIVIC window still open?`;
    $('#report').value = `The CIVIC server did not answer: ${err.message}`;
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
