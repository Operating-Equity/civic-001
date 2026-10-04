// Is FactEngine actually able to work right now? This answers that in plain language, so a fault is
// never a guess made between two people who cannot see each other's screens.
//
// It checks the things that really stop a run: the prompts, the key, whether OpenAI accepts that
// key, and whether the key may use the model the operator configured. It spends nothing: the model
// check reads the model's description rather than running it, so no tokens are consumed.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { promptStatus, promptVersions, extractionShape } from './prompts.js';
import { clientFor, describeError } from './openai.js';
import { onDeepSeek, listingKey, listingClient, deepseekFailure, listingProviderName, deepseekHost } from './deepseek.js';
import { HEADER_SAFE } from './key.js';
import { recent } from './diagnostics.js';
import { whereTheShellSetsIt } from './key.js';
import { gateStates } from './gate.js';
import { readers as readersNow } from './jobs.js';
import { silentSites } from './fetchurl.js';
import { searchOn } from './copies.js';
import { registry } from './tools/index.js';
import { toolsOn } from './tools/request.js';

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
  // OpenAI is asked about the models it serves: both steps', or only the determinations' when the listing is on DeepSeek.
  const models = [...new Set(onDeepSeek() ? [config.evalModels[0]] : [config.extractModels[0], config.evalModels[0]])];
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
 * The listing's own provider when it is not OpenAI: DeepSeek's key, its model and whether its account can pay,
 * asked without spending a token (GET /models, GET /user/balance). With no DeepSeek key nothing is asked of
 * DeepSeek at all. Every viewer sees whether the account can pay (so a stop always has its row); the figures
 * are the operator's alone.
 */
async function checkListing({ operator }) {
  const checks = [];
  if (!config.extractProviderKnown) {
    checks.push(bad('The listing\'s provider is not one FactEngine knows', `CIVIC_EXTRACT_PROVIDER is "${config.extractProvider}".`, 'Set it to openai or deepseek.'));
    return checks;
  }
  if (!onDeepSeek()) return checks;
  const model = config.extractModels[0];
  const key = listingKey({ optional: true });
  if (!key) {
    checks.push(bad('No DeepSeek key for the listing', 'The listing is set to run on DeepSeek (CIVIC_EXTRACT_PROVIDER=deepseek) and DEEPSEEK_API_KEY is not set. Nothing is sent to DeepSeek without it.',
      'Paste the key in Render: the civic service, Environment, DEEPSEEK_API_KEY, then deploy. Or set CIVIC_EXTRACT_PROVIDER=openai to list on OpenAI.'));
    return checks;
  }
  if (!HEADER_SAFE.test(key)) {
    const o = config.deepseekKeyInfo?.offending;
    checks.push(bad('The DeepSeek key cannot be sent in a request at all',
      `It came from ${config.deepseekKeyInfo?.source}.${o ? ` Character ${o.index} of it is ${JSON.stringify(o.char)}, which a request cannot carry.` : ''}`,
      'Paste the key alone in DEEPSEEK_API_KEY: no space, no line break, nothing before or after it.'));
    return checks;
  }
  checks.push(ok('A DeepSeek key is configured for the listing', `It ends ${key.slice(-4)} and is ${key.length} characters long.`));
  const client = listingClient(key);
  const started = Date.now();
  try {
    const page = await client.models.list();
    const ids = (page?.data || []).map((m) => m.id);
    if (ids.includes(model)) checks.push(ok(`DeepSeek accepts this key for ${model}`, `Answered in ${Date.now() - started} ms. No tokens were used.`));
    else checks.push(bad(`DeepSeek does not list ${model}`, `It lists ${ids.join(', ') || 'no model'}.`, 'Set CIVIC_EXTRACT_MODELS to one of them.'));
  } catch (err) {
    const safe = deepseekFailure(err);
    if (safe.status === 401) {
      checks.push(bad('DeepSeek rejected the listing\'s key', safe.detail || safe.message, 'The key is wrong or revoked. Make a new one at platform.deepseek.com and paste it in Render as DEEPSEEK_API_KEY.'));
      return checks;
    }
    checks.push(bad('Could not reach DeepSeek', safe.detail || safe.message, `Check that this machine is online and that nothing is blocking ${deepseekHost()}.`));
    return checks;
  }
  try {
    const b = await client.get('/user/balance');
    const figures = (b?.balance_infos || []).map((x) => `${x.total_balance} ${x.currency} (topped up ${x.topped_up_balance}, granted ${x.granted_balance})`).join('; ');
    if (b?.is_available) checks.push(ok('The listing\'s DeepSeek account can pay for requests', operator && figures ? `Balance ${figures}.` : ''));
    else checks.push(bad('The listing\'s DeepSeek account cannot pay for requests', operator && figures ? `Balance ${figures}.` : 'Its balance is used up.', 'Top it up in DeepSeek\'s dashboard, platform.deepseek.com.'));
  } catch (err) {
    const safe = deepseekFailure(err);
    checks.push(warn('DeepSeek\'s balance could not be read', safe.detail || safe.message));
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

  // The door's own settings, when the door is shut: said here so the operator sees them once.
  if (config.accessCodes.length) {
    if (!config.sessionSecret) {
      checks.push(warn('The sign-in cookie is signed with a secret derived from the OpenAI key', 'A change of that key signs every reader out.',
        'Set CIVIC_SESSION_SECRET to 32 random bytes so the two are independent. Setting it signs everyone out once.'));
    }
    if (!config.operatorCodes.length) {
      checks.push(warn('Every code holder can see this page\'s sign-in list', 'The sign-ins and the runs per code are shown to anyone with a code.',
        'Set CIVIC_OPERATOR_CODES to the codes that are yours; both are then shown to those alone.'));
    }
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
    tools: { reachable: toolsOn(), ...registry.summary() }, // the sources the model can reach for, and whether the requests name the gateway
    recentFailures: recent(10),
  };
}
