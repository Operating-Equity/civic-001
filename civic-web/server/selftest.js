// Is FactEngine actually able to work right now? This answers that in plain language, so a fault is
// never a guess made between two people who cannot see each other's screens.
//
// It checks the things that really stop a run: the prompts, the key, whether OpenAI accepts that
// key, and whether the key may use the model the operator configured. It spends nothing: the model
// check reads the model's description rather than running it, so no tokens are consumed.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { dbOn } from './db.js';
import { promptStatus, promptVersions, extractionShape } from './prompts.js';
import { clientFor, describeError } from './openai.js';
import { onDeepSeek, onFireworks, onOwnProvider, listingKey, listingClient, listingFailure, listingProviderName, listingHost } from './listing.js';
import { HEADER_SAFE } from './key.js';
import { siteFetch } from './http.js';
import { lastEcho } from './fireworks.js';
import { recent } from './diagnostics.js';
import { whereTheShellSetsIt } from './key.js';
import { gateStates } from './gate.js';
import { readers as readersNow } from './jobs.js';
import { silentSites } from './fetchurl.js';
import { searchOn } from './copies.js';
import { registry } from './tools/index.js';
import { toolsOn, gatewayOn } from './tools/request.js';
import { openDoor, doorsOpen } from './tools/doors.js';
import { listPrice, retiredSettings } from './economics.js';

const ok = (title, detail = '') => ({ state: 'ok', title, detail });
const bad = (title, detail = '', fix = '') => ({ state: 'bad', title, detail, fix });
const warn = (title, detail = '', fix = '') => ({ state: 'warn', title, detail, fix });

async function checkKeyAndModel(apiKey) {
  const checks = [];
  if (!apiKey) {
    checks.push(bad('No OpenAI key', 'This server has no key, and none was sent from the page.',
      'FactEngine runs only on the operator\'s key, never on a reader\'s. Put OPENAI_API_KEY in the settings file next to the server.'));
    return checks;
  }
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    const mine = config.serverKey === apiKey;
    const o = mine ? config.key?.offending : null;
    const where = mine ? `It came from ${config.key?.source}.` : 'It came from this browser.';
    const which = o ? ` Character ${o.index} of it is ${JSON.stringify(o.char)}, which a request cannot carry.` : '';
    const fix = !mine
      ? 'Remove the key saved in this browser and add it again, in full, from platform.openai.com.'
      : config.key?.fromFile
        ? 'Open the settings file next to FactEngine and replace the key with the whole key from platform.openai.com.'
        : ['This key is set in this computer\'s environment. In a Terminal window run:  unset OPENAI_API_KEY',
           ...whereTheShellSetsIt().map((at) => `It is also set in ${at.file}, line ${at.line}; remove that line and open a new Terminal window.`),
          ].join('  ');
    checks.push(bad('The key cannot be sent in a request at all',
      `${where}${which} A key copied from somewhere that shortened it for display ends this way, and every test fails before it is sent.`,
      fix));
    return checks;
  }
  checks.push(ok('A key is configured', `It ends ${apiKey.slice(-4)} and is ${apiKey.length} characters long.`));

  const client = clientFor(apiKey);
  // OpenAI is asked about the models it serves: both steps', or only the determinations' when the listing is elsewhere.
  const models = [...new Set(onOwnProvider() ? [config.evalModels[0]] : [config.extractModels[0], config.evalModels[0]])];
  for (const model of models) {
    const started = Date.now();
    try {
      await client.models.retrieve(model);
      checks.push(ok(`OpenAI accepts this key for ${model}`, `Answered in ${Date.now() - started} ms. No tokens were used.`));
    } catch (err) {
      const safe = describeError(err);
      if (safe.status === 401) {
        checks.push(bad('OpenAI rejected the key', safe.detail || safe.message,
          'The key is wrong, revoked, or from a different account. Make a new one at platform.openai.com and put it in the .env file.'));
        break;
      }
      if (safe.status === 404 || /does not exist|do not have access|not found/i.test(safe.message)) {
        checks.push(bad(`This key cannot use ${model}`, safe.message,
          `The account behind this key has no access to ${model}. Check the model's availability on your OpenAI account, or set CIVIC_MODEL to one it can use.`));
        continue;
      }
      if (safe.status === 429) {
        checks.push(bad('OpenAI is refusing requests from this key right now', safe.message,
          'This is usually a spending limit or a rate limit. Check Billing and Limits on platform.openai.com.'));
        break;
      }
      checks.push(bad('Could not reach OpenAI', safe.message,
        'Check that this machine is online and that nothing is blocking api.openai.com.'));
      break;
    }
  }
  return checks;
}

/**
 * The listing's own provider when it is not OpenAI: its key and its model, and (DeepSeek's own service) whether its
 * account can pay, asked without spending a token (GET /models, GET /user/balance). With no key for it nothing is asked
 * of the provider at all. Every viewer sees whether the account can pay (so a stop always has its row); the figures
 * are the operator's alone. On Fireworks, too, whether FactEngine's tool server answers at the address the listing
 * gives Fireworks, which is how the model searches there.
 */
async function checkListing({ operator }) {
  const checks = [];
  if (!config.extractProviderKnown) {
    checks.push(bad('The listing\'s provider is not one FactEngine knows', `CIVIC_EXTRACT_PROVIDER is "${config.extractProvider}".`, 'Set it to openai, deepseek or fireworks.'));
    return checks;
  }
  if (!onOwnProvider()) return checks;
  const who = listingProviderName();
  const keyName = onFireworks() ? 'FIREWORKS_API_KEY' : 'DEEPSEEK_API_KEY';
  const keyInfo = onFireworks() ? config.fireworksKeyInfo : config.deepseekKeyInfo;
  const dashboard = onFireworks() ? 'app.fireworks.ai' : 'platform.deepseek.com';
  const model = config.extractModels[0];
  const key = listingKey({ optional: true });
  if (!key) {
    const spellings = keyInfo?.ambiguous || [];
    if (spellings.length) {
      checks.push(bad(`Two settings hold the ${who} key, with different values`, `${spellings.join(' and ')} differ only in capitals and hold different keys, so FactEngine uses neither. Nothing is sent to ${who}.`,
        `In Render, keep one of them, named ${keyName}, and delete the other.`));
      return checks;
    }
    checks.push(bad(`No ${who} key for the listing`, `The listing is set to run on ${who} (CIVIC_EXTRACT_PROVIDER=${config.extractProvider}) and ${keyName} is not set. Nothing is sent to ${who} without it.`,
      `Paste the key in Render: the civic service, Environment, ${keyName}, then deploy. Or set CIVIC_EXTRACT_PROVIDER=openai to list on OpenAI.`));
    return checks;
  }
  if (!HEADER_SAFE.test(key)) {
    const o = keyInfo?.offending;
    checks.push(bad(`The ${who} key cannot be sent in a request at all`,
      `It came from ${keyInfo?.source}.${o ? ` Character ${o.index} of it is ${JSON.stringify(o.char)}, which a request cannot carry.` : ''}`,
      `Paste the key alone in ${keyName}: no space, no line break, nothing before or after it.`));
    return checks;
  }
  checks.push(ok(`A ${who} key is configured for the listing`, `It ends ${key.slice(-4)} and is ${key.length} characters long.${keyInfo?.savedAs ? ` It is saved in Render as ${keyInfo.savedAs}, which differs from ${keyName} only in capitals; FactEngine reads it under that name.` : ''}`));
  const client = listingClient(key);
  const started = Date.now();
  try {
    const page = await client.models.list();
    const ids = (page?.data || []).map((m) => m.id);
    if (ids.includes(model)) checks.push(ok(`${who} accepts this key for ${model}`, `Answered in ${Date.now() - started} ms. No tokens were used.`));
    else if (onFireworks()) checks.push(warn(`${who} accepted this key but did not list ${model}`, `It listed ${ids.length} model${ids.length === 1 ? '' : 's'}. A listing says at once if the model is refused.`, 'Set CIVIC_EXTRACT_MODELS to a model Fireworks serves if a listing is refused.'));
    else checks.push(bad(`${who} does not list ${model}`, `It lists ${ids.join(', ') || 'no model'}.`, 'Set CIVIC_EXTRACT_MODELS to one of them.'));
  } catch (err) {
    const safe = listingFailure(err);
    if (safe.status === 401) {
      checks.push(bad(`${who} rejected the listing\'s key`, safe.detail || safe.message, `The key is wrong or revoked. Make a new one at ${dashboard} and paste it in Render as ${keyName}.`));
      return checks;
    }
    checks.push(bad(`Could not reach ${who}`, safe.detail || safe.message, `Check that this machine is online and that nothing is blocking ${listingHost()}.`));
    return checks;
  }
  if (onDeepSeek()) {
    try {
      const b = await client.get('/user/balance');
      const figures = (b?.balance_infos || []).map((x) => `${x.total_balance} ${x.currency} (topped up ${x.topped_up_balance}, granted ${x.granted_balance})`).join('; ');
      if (b?.is_available) checks.push(ok('The listing\'s DeepSeek account can pay for requests', operator && figures ? `Balance ${figures}.` : ''));
      else checks.push(bad('The listing\'s DeepSeek account cannot pay for requests', operator && figures ? `Balance ${figures}.` : 'Its balance is used up.', 'Top it up in DeepSeek\'s dashboard, platform.deepseek.com.'));
    } catch (err) {
      const safe = listingFailure(err);
      checks.push(warn('DeepSeek\'s balance could not be read', safe.detail || safe.message));
    }
  }
  if (onFireworks()) {
    checks.push(...await checkToolServer());
    // What Fireworks says it applied, from its own echo of the last listing's request (none yet: no row).
    const e = lastEcho();
    if (e) {
      const when = `${e.at.slice(0, 16).replace('T', ' ')} UTC`;
      if (e.reasoning?.effort === config.extractEffort) checks.push(ok(`Fireworks took the listing's effort as ${config.extractEffort}`, `Its own echo of the last listing's request, at ${when}.`));
      else checks.push(warn('Fireworks did not echo the listing\'s effort as sent', `FactEngine sent effort ${config.extractEffort}; Fireworks echoed ${JSON.stringify(e.reasoning)} for the last listing, at ${when}.`, 'The effort may not be reaching the model. Nothing else is affected.'));
    }
  }
  return checks;
}

/**
 * The listing on Fireworks searches through FactEngine's tool server: Fireworks' servers call it at the address the
 * listing's request gives, through a door opened for that listing alone (tools/doors.js). Asked here as they ask it: a
 * door is opened for this check, the tool server is asked for its tools at its public address through that door, and
 * the door is closed; then the same address must be refused, as each listing's is when it ends. No tool is called and
 * nothing is spent.
 */
async function checkToolServer() {
  const checks = [];
  if (!gatewayOn()) {
    checks.push(warn('The listing on Fireworks cannot search or read pages', 'FactEngine\'s tool server has no public address: neither CIVIC_TOOLS_URL nor RENDER_EXTERNAL_URL is set. The listing reads the document alone.',
      'On Render the address is the service\'s own and is set by Render; elsewhere set CIVIC_TOOLS_URL to this server\'s public address followed by /mcp.'));
    return checks;
  }
  let at = config.gatewayUrl;
  try { at = new URL(config.gatewayUrl).host; } catch { /* the setting as written */ }
  const door = openDoor();
  const ask = async () => {
    const r = await siteFetch(`${config.gatewayUrl}/t/${door.id}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    let json = null;
    try { json = JSON.parse(await r.text()); } catch { /* not the tool server's answer */ }
    return { status: r.status, names: (json?.result?.tools || []).map((t) => t.name) };
  };
  try {
    const open = await ask();
    door.close();
    const shut = await ask();
    if (open.status === 200 && open.names.length > 0 && shut.status === 401) {
      checks.push(ok(`FactEngine's tool server answers at ${at}`, `Through a door opened for this check it listed ${open.names.join(', ')}, and refused the same door once closed. Fireworks reaches it the same way during a listing, through a door of that listing's own.`));
    } else {
      checks.push(warn(`FactEngine's tool server did not answer as expected at ${at}`, `Through an open door it answered ${open.status}${open.status === 200 ? ` and listed ${open.names.length ? open.names.join(', ') : 'no tools'}` : ''}; through the same door closed, ${shut.status} rather than 401.`,
        'Fireworks will not be able to use it either: the listing would read the document alone.'));
    }
  } catch (err) {
    checks.push(warn(`FactEngine's tool server could not be reached at ${at}`, String(err?.cause?.code || err?.message || err), 'Fireworks will not be able to reach it either: the listing would read the document alone.'));
  } finally {
    door.close();
  }
  if (!registry.summary().verbs.includes('search_web')) {
    checks.push(warn('The listing on Fireworks cannot search the web', 'The search service is not set (CIVIC_SEARCH_URL and CIVIC_SEARCH_KEY); the model can still read a page or a video\'s transcript.'));
  }
  return checks;
}

export async function selftest({ apiKey, build, operator = true }) {
  const checks = [];

  checks.push(ok('The FactEngine server is running', `Version ${build}. Node ${process.version}.`));

  const prompts = promptStatus();
  const versions = promptVersions();
  for (const [name, label] of [['extract', 'extraction'], ['evaluate', 'evaluation']]) {
    if (prompts[name]) checks.push(ok(`The ${label} prompt is installed`, `Version ${versions[name].version}, ${versions[name].chars.toLocaleString('en-US')} characters.${name === 'extract' ? (extractionShape() === 'inserted' ? ' The source goes in place of its final bracketed line.' : ' It is sent as the instructions, with the source as the only message.') : ''} Its text is held in memory and never leaves this machine except inside a request to ${name === 'extract' ? listingProviderName() : 'OpenAI'}.`));
    else checks.push(bad(`The ${label} prompt is missing`, 'Without it, nothing can be tested.',
      `Point CIVIC_PROMPT_${name.toUpperCase()}_FILE at the prompt file, or place it at server/prompts/${name}.txt.`));
  }
  if (!prompts.challenge) {
    checks.push(warn('The challenge prompt is not installed', 'Challenges are collected but not sent, as intended until that prompt is certified.'));
  }

  if (config.key?.conflict) {
    const at = whereTheShellSetsIt();
    checks.push(warn('Two different keys were found',
      'FactEngine used the one in its own settings file, which is the rule. A different key is set in this computer\'s environment and is being ignored.',
      ['To remove the other one, run:  unset OPENAI_API_KEY',
       ...at.map((x) => `It is also set in ${x.file}, line ${x.line}; remove that line and open a new Terminal window.`),
      ].join('  ')));
  }

  checks.push(...await checkKeyAndModel(apiKey));
  checks.push(...await checkListing({ operator }));

  if (config.accounting && config.ledgerFile) {
    try {
      fs.mkdirSync(path.dirname(config.ledgerFile), { recursive: true });
      fs.appendFileSync(config.ledgerFile, '');
      checks.push(ok('The internal ledger can be written', config.ledgerFile));
    } catch (err) {
      checks.push(warn('The internal ledger cannot be written', err.message, 'Costs will not be recorded. Nothing else is affected.'));
    }
  }

  // The search door (server/copies.js), named by its address and never its key, when it is set.
  if (searchOn()) {
    let host = '';
    try { host = new URL(String(config.searchUrl).trim()).hostname; } catch { host = String(config.searchUrl).trim(); }
    checks.push(ok('A link a site refuses is looked for elsewhere', `Through the search service at ${host}. The reader picks the copy to test; each search's cost is on the ledger.`));
  }

  // Accounts (server/accounts.js): where they are kept, the sign-up credit, the operator's link, and any code setting
  // still on the service (nothing reads them; they are the operator's to delete in Render).
  if (config.accounts) {
    const where = dbOn() ? 'in Postgres, so they outlive every deploy' : 'in this instance\'s memory: they end when it stops';
    checks.push((dbOn() || !process.env.RENDER ? ok : bad)('Readers sign in with an account', `Accounts are kept ${where}. A new account starts with ${(config.signupGrantCents / 100).toLocaleString('en-US', { style: 'currency', currency: config.currency })} of credit.`,
      dbOn() || !process.env.RENDER ? undefined : 'Set DATABASE_URL to the service\'s Postgres.'));
    const retired = ['CIVIC_ACCESS_CODES', 'CIVIC_OPERATOR_CODES', 'CIVIC_CODE_USES', 'CIVIC_USES_FILE', 'CIVIC_SIGNIN_LOG', 'CIVIC_SESSION_SECRET'].filter((n) => String(process.env[n] || '').trim());
    if (retired.length) checks.push(warn('Settings from the access codes are still on the service', `Nothing reads them any more: ${retired.join(', ')}.`, 'Delete them in Render when convenient.'));
  }

  // The price (server/economics.js): one list price since 6 October. Without it nothing is priced; the settings of the
  // measured price before it are read by nothing, and named while they are still on the service.
  if (config.pricingEnabled) {
    if (listPrice() === null) checks.push(warn('No list price is set', 'Nothing is priced: every fact-check is free to the reader.', 'Set CIVIC_LIST_PRICE_CENTS to the price of one fact-check, in cents.'));
    const retiredPrice = retiredSettings();
    if (retiredPrice.length) checks.push(warn('Settings of the measured price are still on the service', `Nothing reads them any more: ${retiredPrice.join(', ')}. The list price (CIVIC_LIST_PRICE_CENTS) prices every window.`, 'Delete them in Render when convenient.'));
  }

  const failures = checks.filter((c) => c.state === 'bad');
  return {
    build,
    at: new Date().toISOString(),
    ready: failures.length === 0,
    summary: failures.length === 0
      ? 'FactEngine is ready. Paste a document or a link and press Test the facts.'
      : failures.length === 1
        ? 'One thing is stopping FactEngine from working.'
        : `${failures.length} things are stopping FactEngine from working.`,
    settings: {
      listingProvider: listingProviderName(),
      listingModel: config.extractModels[0],
      listingEffort: config.extractEffort,
      model: config.evalModels[0],
      effort: config.evalEffort,
      webSearch: true,
      claimsPerRun: config.maxClaims,
      keySource: config.serverKey ? config.key.source : 'the browser',
      prompts: Object.entries(versions).map(([n, v]) => `${n} ${v.version}`).join(', '),
    },
    checks,
    // The gate's figures for each model: the key's minute limit, what OpenAI counts for each kind
    // of request, what is available now, what is in flight and waiting, and what OpenAI last said.
    pacing: gateStates(),
    readers: readersNow(),   // readers with work in flight on this instance right now
    silentSites: silentSites(),
    // The sources the model can reach for, and which requests name the gateway: OpenAI's two when its address and pass
    // are both set, the listing's on Fireworks whenever the tool server has an address; and how many listings' doors
    // are open now (one for each listing on Fireworks in flight).
    tools: { reachable: toolsOn() || (onFireworks() && gatewayOn()), requests: { determinations: toolsOn(), listing: onFireworks() ? gatewayOn() : toolsOn() }, doors: doorsOpen(), ...registry.summary() },
    recentFailures: recent(10),
  };
}
