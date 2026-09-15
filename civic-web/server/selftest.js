// Is CIVIC actually able to work right now? This answers that in plain language, so a fault is
// never a guess made between two people who cannot see each other's screens.
//
// It checks the things that really stop a run: the prompts, the key, whether OpenAI accepts that
// key, and whether the key may use the model the operator configured. It spends nothing: the model
// check reads the model's description rather than running it, so no tokens are consumed.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { promptStatus } from './prompts.js';
import { clientFor, describeError } from './openai.js';
import { recent } from './diagnostics.js';
import { whereTheShellSetsIt } from './key.js';

const ok = (title, detail = '') => ({ state: 'ok', title, detail });
const bad = (title, detail = '', fix = '') => ({ state: 'bad', title, detail, fix });
const warn = (title, detail = '', fix = '') => ({ state: 'warn', title, detail, fix });

async function checkKeyAndModel(apiKey) {
  const checks = [];
  if (!apiKey) {
    checks.push(bad('No OpenAI key', 'This server has no key, and none was sent from the page.',
      'Put OPENAI_API_KEY in the .env file next to the server, with CIVIC_ALLOW_SERVER_KEY=true.'));
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
        ? 'Open the settings file next to CIVIC and replace the key with the whole key from platform.openai.com.'
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
  const models = [...new Set([config.extractModels[0], config.evalModels[0]])];
  for (const model of models) {
    const started = Date.now();
    try {
      await client.models.retrieve(model);
      checks.push(ok(`OpenAI accepts this key for ${model}`, `Answered in ${Date.now() - started} ms. No tokens were used.`));
    } catch (err) {
      const safe = describeError(err);
      if (safe.status === 401) {
        checks.push(bad('OpenAI rejected the key', safe.message,
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

export async function selftest({ apiKey, build }) {
  const checks = [];

  checks.push(ok('The CIVIC server is running', `Version ${build}. Node ${process.version}.`));

  const prompts = promptStatus();
  for (const [name, label] of [['extract', 'extraction'], ['evaluate', 'evaluation']]) {
    if (prompts[name]) checks.push(ok(`The ${label} prompt is installed`, 'Its text is held in memory and never leaves this machine except inside a request to OpenAI.'));
    else checks.push(bad(`The ${label} prompt is missing`, 'Without it, nothing can be tested.',
      `Point CIVIC_PROMPT_${name.toUpperCase()}_FILE at the prompt file, or place it at server/prompts/${name}.txt.`));
  }
  if (!prompts.challenge) {
    checks.push(warn('The challenge prompt is not installed', 'Challenges are collected but not sent, as intended until that prompt is certified.'));
  }

  if (config.key?.conflict) {
    const at = whereTheShellSetsIt();
    checks.push(warn('Two different keys were found',
      'CIVIC used the one in its own settings file, which is the rule. A different key is set in this computer\'s environment and is being ignored.',
      ['To remove the other one, run:  unset OPENAI_API_KEY',
       ...at.map((x) => `It is also set in ${x.file}, line ${x.line}; remove that line and open a new Terminal window.`),
      ].join('  ')));
  }

  checks.push(...await checkKeyAndModel(apiKey));

  if (config.accounting && config.ledgerFile) {
    try {
      fs.mkdirSync(path.dirname(config.ledgerFile), { recursive: true });
      fs.appendFileSync(config.ledgerFile, '');
      checks.push(ok('The internal ledger can be written', config.ledgerFile));
    } catch (err) {
      checks.push(warn('The internal ledger cannot be written', err.message, 'Costs will not be recorded. Nothing else is affected.'));
    }
  }

  const failures = checks.filter((c) => c.state === 'bad');
  return {
    build,
    at: new Date().toISOString(),
    ready: failures.length === 0,
    summary: failures.length === 0
      ? 'CIVIC is ready. Paste a document or a link and press Test the facts.'
      : failures.length === 1
        ? 'One thing is stopping CIVIC from working.'
        : `${failures.length} things are stopping CIVIC from working.`,
    settings: {
      model: config.evalModels[0],
      effort: config.evalEffort,
      webSearch: true,
      claimsPerRun: config.maxClaims,
      keySource: config.serverKey ? config.key.source : 'the browser',
    },
    checks,
    recentFailures: recent(10),
  };
}
