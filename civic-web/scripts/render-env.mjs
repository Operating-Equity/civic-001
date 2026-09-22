// Operator tooling: read and set the CIVIC service's own settings on Render, one variable at a time.
//
// THE RULE THIS FILE EXISTS TO KEEP. A setting is an address, a header name or a switch; a key is a
// secret. This script sets settings and refuses keys. Anything whose name carries KEY, PASS, SECRET,
// TOKEN, PASSWORD or CODES is refused and left to the operator, who pastes it into Render's dashboard
// themselves — the operator's standing rule, and the reason a key has never appeared in this repository.
// Nothing here is in the path of a run: it touches no request, no prompt and no reader.
//
// It writes one variable at a time (PUT /services/{id}/env-vars/{name}) and never the whole-list PUT,
// which would replace what the operator set by hand. Render stores a change without restarting; the new
// values take effect on the next deploy, which the operator triggers by saving anything in the dashboard.
//
//   node scripts/render-env.mjs list
//   node scripts/render-env.mjs set CIVIC_TRANSCRIPT_HEADER=x-api-key CIVIC_TOOLS_URL=https://…/mcp
//
// RENDER_API_KEY comes from the environment. The service is the one CIVIC runs on; CIVIC_RENDER_SERVICE
// overrides it for a second service later.
const KEY = process.env.RENDER_API_KEY;
const SVC = process.env.CIVIC_RENDER_SERVICE || 'srv-dam9vlrm8hqs73d28tk0';
const SECRET = /KEY|PASS|SECRET|TOKEN|PASSWORD|CODES/;

if (!KEY) {
  console.error('No RENDER_API_KEY in the environment. This script reads it from there and never from a file.');
  process.exit(1);
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.render.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* an error page is not JSON; the text is the message */ }
  return { status: res.status, json, text };
};

const names = async () => {
  const r = await api('GET', `/services/${SVC}/env-vars?limit=100`);
  if (r.status >= 300) { console.error(`Render answered ${r.status}: ${r.text.slice(0, 200)}`); process.exit(1); }
  return (r.json || []).map((e) => e.envVar?.key || e.key).filter(Boolean);
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === 'list') {
  const list = await names();
  console.log(`${SVC} carries ${list.length} settings:`);
  for (const k of list.sort()) console.log(`  ${k}${SECRET.test(k) ? '   (a key: this script never writes it)' : ''}`);
} else if (cmd === 'set') {
  const pairs = rest.map((a) => { const i = a.indexOf('='); return i < 0 ? null : [a.slice(0, i), a.slice(i + 1)]; }).filter(Boolean);
  if (!pairs.length) { console.error('Nothing to set. Usage: node scripts/render-env.mjs set NAME=value [NAME=value …]'); process.exit(1); }
  const refused = pairs.filter(([k]) => !/^CIVIC_[A-Z0-9_]+$/.test(k) || SECRET.test(k));
  if (refused.length) {
    for (const [k] of refused) {
      console.error(SECRET.test(k)
        ? `Refused ${k}: it is a key, and a key is pasted into Render's dashboard by the operator, never written from here.`
        : `Refused ${k}: this script sets only CIVIC_* settings, so it can never touch the OpenAI key or the access codes.`);
    }
    process.exit(1);
  }
  for (const [k, v] of pairs) {
    const r = await api('PUT', `/services/${SVC}/env-vars/${k}`, { value: v });
    console.log(`${k}=${v} → ${r.status}${r.status < 300 ? ' set' : ` ${r.text.slice(0, 160)}`}`);
    if (r.status >= 300) process.exitCode = 1;
  }
  console.log('\nRender stores a change without restarting: these take effect on the next deploy.');
} else {
  console.error(`Unknown command "${cmd}". Use list or set.`);
  process.exit(1);
}
