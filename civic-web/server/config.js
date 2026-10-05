import fs from 'node:fs';
import { resolveKey, envByName } from './key.js';
import { extractionShape } from './prompts.js';
// Runtime configuration.
//
// ONE RULE GOVERNS THIS FILE. The requests sent to OpenAI (and, for the listing when the operator
// puts it there, to DeepSeek or Fireworks) carry the operator's tested configuration and nothing else: the
// model, the reasoning effort, the prompt, web search.
// No parameter is added that the operator did not test with. No cap, no mode, no verbosity,
// no context-size, no fallback, no limit. `npm run verify` inspects the request bodies the
// server actually sends and fails if any key beyond that set appears.
//
// Web search is available to BOTH prompts and is not configurable. The prompts were tested in a
// UI where search is available to every prompt; a request without it is not what was tested.
//
// Model ids were read from the OpenAI SDK type definitions (openai@7.15, Sept 2026).

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const list = (name, fallback) => env(name, fallback).split(',').map((s) => s.trim()).filter(Boolean);
const int = (name, fallback) => Number.parseInt(env(name, String(fallback)), 10);
const bool = (name, fallback) => /^(1|true|yes|on)$/i.test(env(name, fallback ? 'true' : 'false'));
const num = (name, fallback) => { const v = Number(env(name, String(fallback))); return Number.isFinite(v) ? v : fallback; };
// A figure the operator may leave unset: null then, never a number of ours.
const optInt = (name) => { const v = Number.parseInt(env(name, ''), 10); return Number.isInteger(v) ? v : null; };
const optNum = (name) => { const raw = env(name, ''); const v = Number(raw); return raw !== '' && Number.isFinite(v) ? v : null; };

// The operator's configuration: gpt-5.6-sol, OpenAI's flagship below GPT-6. Tested by the operator at
// reasoning effort xhigh; on 21 September they asked for the model's maximum power short of GPT-6, which
// OpenAI's pages put at effort `max` (the top of the ladder) in reasoning mode `pro` ("the
// highest-intelligence API option": more model work per answer, billed at the ordinary per-token rates).
// On 5 October, after a listing had taken fifteen minutes and $3.81 and one determination almost seven
// minutes and $3.71 at that power ("This model is expensive and terrible"), the operator stepped back to the
// setting before 21 September: effort xhigh in standard mode. Used for both steps unless the operator sets
// a step separately. A mode of `standard` or empty sends no mode key at all; `pro` brings pro mode back.
const MODEL = env('CIVIC_MODEL', 'gpt-5.6-sol');
const EFFORT = env('CIVIC_EFFORT', 'xhigh');
const MODE = env('CIVIC_REASONING_MODE', 'standard');
const modeOrNone = (v) => (v && v !== 'standard' ? v : '');

// CIVIC's own key. The rule lives in server/key.js and is the same whatever shape either key is in.
// CIVIC runs on the operator's key and no other. There is no switch here, because there is no
// alternative to switch to: a reader's key is never accepted (see operatorKey in server/openai.js).
const chosenKey = resolveKey({ settingsFile: new URL('../.env', import.meta.url).pathname });

// The listing (step 1) on another provider than the determinations: the operator's choice of 4 October, "I want
// use DeepSeek flash for the generating of empirical claims. It is 10 times faster and better." DeepSeek answers
// OpenAI's Responses API at its own address and with its own key, runs web search on its own side, honours
// reasoning.effort (none, low, high, max), makes no reasoning summary and has no mode; so on DeepSeek the request
// carries the model, the prompt, the effort, web search and nothing else. The listing's effort is its own
// (CIVIC_EXTRACT_EFFORT) and never inherited from CIVIC_EFFORT, so a change of OpenAI's effort cannot move the
// listing: high, the operator's answer of 5 October after a small article took over seven minutes at max ("We may
// need to reduce from max"); max was their answer of 4 October. Unset, the listing is on OpenAI exactly as before.
//
// Fireworks, the operator's choice of 5 October ("Maybe someone in the US is hosting the model so we can avoid the
// China issue"): the same DeepSeek V4.1 Flash, served by a US company that keeps nothing it is told not to keep and
// trains on nothing; DeepSeek the company receives nothing. Fireworks answers OpenAI's Responses API at its own
// address with its own key; it has no web search of its own, so the model reaches FactEngine's tool server instead
// (server/tools: a search, a page, a transcript); it keeps a conversation 30 days unless the request says
// store: false, which the listing always says; and its model's chain of thought arrives inside the answer's text,
// ahead of `</think>`, and is cut off there (server/fireworks.js). The effort is the listing's own, as on DeepSeek.
const PROVIDERS = ['openai', 'deepseek', 'fireworks'];
const PROVIDER = env('CIVIC_EXTRACT_PROVIDER', 'openai').trim().toLowerCase();
const DEEPSEEK = PROVIDER === 'deepseek';
const FIREWORKS = PROVIDER === 'fireworks';
const OWN = DEEPSEEK || FIREWORKS;   // the listing is not on OpenAI: its own model and effort, no mode, no summary
const deepseekKey = resolveKey({ settingsFile: new URL('../.env', import.meta.url).pathname, name: 'DEEPSEEK_API_KEY' });
const fireworksKey = resolveKey({ settingsFile: new URL('../.env', import.meta.url).pathname, name: 'FIREWORKS_API_KEY' });

// FactEngine's tool server (server/tools/gateway.js), for a model that reaches it from its provider's servers. Its
// address: CIVIC_TOOLS_URL, or else the service's own, which Render puts on every web service as RENDER_EXTERNAL_URL
// (its onrender.com address), followed by /mcp: no setting and no domain. A listing on Fireworks enters through a door
// of its own in that address (server/tools/doors.js), so no pass is needed for it and none is sent.
const PUBLIC_URL = env('RENDER_EXTERNAL_URL', '').trim().replace(/\/+$/, '');


/** "ABCD234" or "ABCD234:150": the code as typed made canonical, and its own allowance of runs if given. */
function parseCodes(entries) {
  return entries.map((entry) => {
    const [raw, uses] = String(entry).split(':');
    const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const n = uses === undefined ? null : Number.parseInt(uses, 10);
    return { code, allowance: Number.isFinite(n) && n >= 0 ? n : null };
  }).filter((c) => c.code);
}

export const config = {
  port: int('PORT', 3000),

  // Step 1 — empirical claim extraction, on OpenAI unless CIVIC_EXTRACT_PROVIDER says deepseek or fireworks.
  extractProvider: PROVIDER,
  extractProviderKnown: PROVIDERS.includes(PROVIDER),
  extractModels: list('CIVIC_EXTRACT_MODELS', DEEPSEEK ? 'deepseek-flash' : FIREWORKS ? 'accounts/fireworks/models/deepseek-v4p1-flash' : MODEL), // one id = no fallback
  extractEffort: OWN ? env('CIVIC_EXTRACT_EFFORT', 'high') : env('CIVIC_EXTRACT_EFFORT', EFFORT),
  extractReasoningMode: OWN ? '' : modeOrNone(env('CIVIC_EXTRACT_REASONING_MODE', MODE)), // '' = no mode key in the request
  // Reasoning summaries are the model's own account of its reasoning, shown on the page. They do
  // not change the answer. 'auto' lets the API decide the form. Blank turns them off. DeepSeek and
  // Fireworks make none (their model's whole chain of thought comes instead, and never reaches the page).
  extractSummary: OWN ? '' : env('CIVIC_EXTRACT_REASONING_SUMMARY', 'auto'),
  // DeepSeek's address and key, used only by the listing when it is on DeepSeek. The address is a setting
  // so the guard can point it at its stand-in; the key follows the same rule as OpenAI's (server/key.js).
  deepseekBaseUrl: env('CIVIC_DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
  deepseekKey: deepseekKey.value,
  deepseekKeyInfo: deepseekKey,
  // Fireworks' address and key, used only by the listing when it is on Fireworks; the same two rules.
  fireworksBaseUrl: env('CIVIC_FIREWORKS_BASE_URL', 'https://api.fireworks.ai/inference/v1'),
  fireworksKey: fireworksKey.value,
  fireworksKeyInfo: fireworksKey,

  // Step 2 — determination.
  evalModels: list('CIVIC_EVAL_MODELS', MODEL), // one id = no fallback
  evalEffort: env('CIVIC_EVAL_EFFORT', EFFORT),
  evalReasoningMode: modeOrNone(env('CIVIC_EVAL_REASONING_MODE', MODE)),
  evalReasoningSummary: env('CIVIC_EVAL_REASONING_SUMMARY', 'auto'),
  webSearch: true, // both steps, always; not an environment setting
  // Ten claims at a time. This one figure paces both the page (which sends one claim per request
  // and keeps this many in flight, reading it from publicConfig below) and a request that carries
  // several claims, as the guard's does, so the pace is one setting and never a release. One at a
  // time was the operator's instruction of 17 September, after twenty at once had failed on the key's
  // minute limit every time (a running response is charged again inside the minute at each of its
  // own later calls, after a web search, by 67,000 to 89,000, far above what its admission showed,
  // so many parallel claims starve one another); two ran whole on the address; on 18 September the
  // operator chose three on the 500,000-a-minute figure of 16 September, then four once the check
  // page showed the key's current limit, 2,000,000 a minute; back to three on 22 September when
  // release M's effort `max` in mode `pro` meant more model work per claim. Ten on 3 October, the
  // operator's choice: the key's minute now reads 40,000,000 tokens (the check page's pacing row),
  // twenty times September's, and a reader's whole selection runs at this pace in one batch. The
  // check page's pacing row, after a run, is the figure to set this by.
  evalConcurrency: int('CIVIC_EVAL_CONCURRENCY', 10),
  evalRetries: int('CIVIC_EVAL_RETRIES', 8),           // rate limits and 5xx only; never on a model or parameter error

  // Source documents. No limit of ours. If a document exceeds the model's context window the API
  // refuses it and that error is shown verbatim; nothing is ever read in part.
  // Development only: lets the link reader reach localhost, so the fixture site in scripts/ can be
  // tested. Never enable on a public server; it would let a stranger aim the reader at your network.
  allowPrivateUrls: bool('CIVIC_ALLOW_PRIVATE_URLS', false),
  youtubeBase: env('CIVIC_YOUTUBE_BASE', 'https://www.youtube.com'), // the guard stands in for YouTube with this
  youtubeClients: list('CIVIC_YOUTUBE_CLIENTS', 'ANDROID,TVHTML5,WEB_EMBEDDED_PLAYER,ANDROID_VR,IOS'), // the doors of YouTube's player, asked in this order
  // A hosted transcript service, the last door, asked only when both of these are set. No vendor is
  // named in the code: whichever one the operator signs up for is an address and a key. The key stays
  // on the server, like the OpenAI key, and never reaches the browser or a failure record.
  transcriptUrl: env('CIVIC_TRANSCRIPT_URL', ''),            // {id} is the video's id, {url} its address
  transcriptKey: envByName(process.env, 'CIVIC_TRANSCRIPT_KEY').value,   // whatever its capitals (key.js)
  transcriptHeader: env('CIVIC_TRANSCRIPT_HEADER', 'x-api-key'),
  // Most services carry the key raw in their own header, so the prefix is empty unless one is named;
  // a service that wants `Authorization: Bearer <key>` sets the header and the prefix `Bearer`.
  transcriptPrefix: env('CIVIC_TRANSCRIPT_PREFIX', ''),
  // When a service answers with a job instead of the words (it is transcribing the video), this is
  // where its result is read, with {jobId} filled in. Without it, a job answer is the end.
  transcriptJobUrl: env('CIVIC_TRANSCRIPT_JOB_URL', ''),
  // A search service, asked only when a site turns CIVIC's server away and only when both of these are
  // set: it finds the same article republished elsewhere (papers that republish with permission end it
  // with "This article originally appeared in ...") and other reports of the same story, from the words
  // the link itself carries, and the reader picks one (server/copies.js). The request is the shape of
  // Exa's /search, the service tested on 1 October; its key stays on the server, like every key, and
  // travels as the transcript door's does.
  searchUrl: env('CIVIC_SEARCH_URL', ''),
  searchKey: envByName(process.env, 'CIVIC_SEARCH_KEY').value,   // whatever its capitals (key.js)
  searchHeader: env('CIVIC_SEARCH_HEADER', 'x-api-key'),
  searchPrefix: env('CIVIC_SEARCH_PREFIX', ''),
  // Results asked of each search: the count the service's base price covers (Exa: up to 10).
  searchResults: int('CIVIC_SEARCH_RESULTS', 10),
  // Sources as tools (server/tools): the gateway's public address, which the requests to OpenAI name so
  // the model can reach CIVIC's tools, and the pass OpenAI carries to it. Both set: the tools are in
  // both requests. Either empty: the requests are exactly as before, and the gateway answers no one.
  // Every source's own key is that source's setting, named in its adapter, never here.
  toolsUrl: env('CIVIC_TOOLS_URL', ''),
  toolsPass: env('CIVIC_TOOLS_PASS', ''),
  // The tool server's address as a listing on Fireworks names it (see PUBLIC_URL above), before the listing's door is
  // added to it: CIVIC_TOOLS_URL when set, else the service's own address.
  gatewayUrl: (env('CIVIC_TOOLS_URL', '') || (PUBLIC_URL ? `${PUBLIC_URL}/mcp` : '')).replace(/\/+$/, ''),
  maxSourceChars: int('CIVIC_MAX_SOURCE_CHARS', 0),
  allowSourceTruncation: bool('CIVIC_ALLOW_SOURCE_TRUNCATION', false),
  maxClaims: int('CIVIC_MAX_CLAIMS', 10), // the most one /api/evaluate request carries (the guard's multi-claim requests); the page sends one claim per request, so this bounds nothing it does
  // How many of the claims found run without a press. The rest are listed with a checkbox and run
  // when the reader chooses them. Ten was the operator's rule of 17 September; 0, the operator's
  // choice of 1 October, means nothing runs until the reader chooses: every claim found is shown
  // with its checkbox. A setting, so the figure moves without a release.
  autoTestFirst: int('CIVIC_AUTO_TEST_FIRST', 10),
  maxUploadBytes: int('CIVIC_MAX_UPLOAD_BYTES', 200 * 1024 * 1024),
  heartbeatMs: 15000,

  // Visual echo — a picture, not a determination. The operator asked for the fast model.
  illustrateModels: list('CIVIC_IMAGE_MODELS', 'gpt-image-2.5-flare,gpt-image-2.5-sunburst,gpt-image-1.5,gpt-image-1-mini'),
  illustrateQuality: env('CIVIC_IMAGE_QUALITY', 'high'),
  illustrateSize: env('CIVIC_IMAGE_SIZE', '1024x1536'),   // upright: the frame it fills is taller than wide
  illustrateEnabled: bool('CIVIC_IMAGE_ENABLED', true),
  artDirection: bool('CIVIC_IMAGE_ART_DIRECTION', true),
  artDirectionModels: list('CIVIC_IMAGE_ART_DIRECTION_MODELS', 'gpt-5.6-luna,gpt-5.6-terra,gpt-5.4-mini'),
  artDirectionEffort: env('CIVIC_IMAGE_ART_DIRECTION_EFFORT', 'low'),

  // Challenge — mechanics run, but the OpenAI call is withheld until the prompt is certified.
  challengeEnabled: bool('CIVIC_CHALLENGE_ENABLED', false),
  challengeMaxFiles: 5,
  challengeMaxFileBytes: 20 * 1024 * 1024,

  // Internal accounting (operator view, not a customer feature).
  accounting: bool('CIVIC_INTERNAL_ACCOUNTING', true),
  ledgerFile: env('CIVIC_LEDGER_FILE', new URL('../data/ledger.jsonl', import.meta.url).pathname),
  // Every failure, from the server or the page, appended here so /check can show it afterwards.
  // No key, no prompt text, no document: only what failed.
  errorLogFile: env('CIVIC_ERROR_LOG', new URL('../data/errors.log', import.meta.url).pathname),
  webSearchUsdPerCall: Number(env('CIVIC_WEB_SEARCH_USD_PER_CALL', '0.01')),
  imageUsdPerImage: Number(env('CIVIC_IMAGE_USD_PER_IMAGE', '0.02')),

  // Optional server-side key. Off by default.
  serverKey: chosenKey.value,
  key: chosenKey, // the whole decision, so it can be explained rather than asserted

  // Optional: point the OpenAI client somewhere else (used by scripts/mock-openai.js in dev).
  openaiBaseUrl: env('OPENAI_BASE_URL', ''),

  // Sign-in by code (server/access.js). Empty: the door is open, as on the operator's Mac. Set:
  // every API route but the health line needs a cookie issued for one of these codes.
  // An entry is a code, or a code with its own allowance of runs after a colon (ABCD234:150).
  accessCodes: parseCodes(list('CIVIC_ACCESS_CODES', '')).map((c) => c.code),
  accessAllowances: Object.fromEntries(parseCodes(list('CIVIC_ACCESS_CODES', '')).filter((c) => c.allowance !== null).map((c) => [c.code, c.allowance])),
  // Runs a code allows unless its entry says otherwise: five, the operator's rule of 18 September.
  codeUses: int('CIVIC_CODE_USES', 5),
  // The sign-in cookie's own secret (server/access.js). Unset, the cookie is signed with a
  // derivation from the OpenAI key, so a change of that key signs everyone out; set, the key plays
  // no part. Setting it once signs everyone out once.
  sessionSecret: env('CIVIC_SESSION_SECRET', ''),
  // The codes whose holders are the operator: /check shows the sign-in list and the runs per code
  // to them alone. Unset, every code holder sees both, as before 30 September.
  operatorCodes: parseCodes(list('CIVIC_OPERATOR_CODES', '')).map((c) => c.code),
  signinLog: env('CIVIC_SIGNIN_LOG', new URL('../data/signins.jsonl', import.meta.url).pathname),
  // One line per run started under a code (server/uses.js); on a persistent disk in the cloud.
  usesFile: env('CIVIC_USES_FILE', new URL('../data/uses.jsonl', import.meta.url).pathname),

  // Facts have a price, and every user is measured (server/economics.js; the operator's program of
  // 2 October). Listing the claims is always free; testing one is priced, and a run's tier says how
  // many of the claims the reader chooses on a document are free (tier 1: none; 2: one; 3: two; 4:
  // three). The price is the measured average cost of a determination marked up by the percentage
  // below, or the start figure until the sample is big enough; nothing is charged yet, revenue is
  // booked at list price and marked not collected. Every figure here is the operator's.
  pricingEnabled: bool('CIVIC_PRICING_ENABLED', true),         // false: the page as before, nothing priced or measured beyond the ledger
  priceMarkupPercent: num('CIVIC_PRICE_MARKUP_PERCENT', 25),    // "the average needs to be marked up 25% to start"
  priceWindowDays: num('CIVIC_PRICE_WINDOW_DAYS', 7),           // the average is taken over this many days (a flagged default)
  priceMinSample: int('CIVIC_PRICE_MIN_SAMPLE', 20),            // determinations the average needs before it sets the price (a flagged default)
  priceStartCents: optInt('CIVIC_PRICE_START_CENTS'),           // the price until the sample exists; unset = nothing is priced until it does
  currency: env('CIVIC_CURRENCY', 'USD'),
  tierHours: num('CIVIC_TIER_HOURS', 6),                        // "change every 6 hours"
  tierOrder: list('CIVIC_TIER_ORDER', '1,2,3,4').map((x) => Number.parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0),
  tierShift: int('CIVIC_TIER_SHIFT', 1),                        // each day the rotation starts one tier later, so every tier meets every time of day (0 = a fixed clock)
  tierLossGuardUsd: optNum('CIVIC_TIER_LOSS_GUARD_USD'),        // "unless one is very unprofitable and I am losing a lot of money. Become 1 until we earn it back"; unset = off
  tierFixed: optInt('CIVIC_TIER_FIXED'),                        // one tier for everyone, for when the data has spoken
  pricingNote: env('CIVIC_PRICING_NOTE', ''),                   // a sentence of the operator's under the prices (for instance that the beta is not charged)
  // The measurement's home: Render's Postgres when DATABASE_URL is set (the rows outlive every
  // deploy); without it, this instance's memory, which a restart empties. Never a CIVIC_ name:
  // DATABASE_URL is what Render itself puts on a service. CIVIC_DATABASE_SSL: auto (verified TLS
  // to a host with a dot in its name, none to an internal one), require, insecure or off.
  databaseUrl: env('DATABASE_URL', ''),
  databaseSsl: env('CIVIC_DATABASE_SSL', 'auto'),
  // The pool to that database. Every determination opens a short transaction on its run's row, so
  // ten readers pressing at once need ten connections, or wait for one; a wait longer than this
  // was a lost price row (the claim ran unmeasured), so it is long, and a setting.
  databasePool: int('CIVIC_DATABASE_POOL', 10),
  databaseWaitMs: int('CIVIC_DATABASE_WAIT_MS', 30000),
  // The guard's clock. Set to an instant (ISO 8601), the economics run as if the server had started
  // then, so a tier change six hours away can be proved in a second. Never set it otherwise.
  clock: env('CIVIC_CLOCK', ''),
};

/** Exactly what each request will carry. Printed at startup and reported by /api/health. */
export function requestShape() {
  const source = extractionShape();
  return {
    // On Fireworks the listing searches through FactEngine's tool server, so it can search when that has an address and a pass.
    extract: { provider: config.extractProvider, model: config.extractModels[0], effort: config.extractEffort, mode: config.extractReasoningMode || null, summary: config.extractSummary || null, webSearch: config.extractProvider === 'fireworks' ? Boolean(config.gatewayUrl) : true, fallback: config.extractModels.length > 1, source },
    evaluate: { model: config.evalModels[0], effort: config.evalEffort, mode: config.evalReasoningMode || null, summary: config.evalReasoningSummary || null, webSearch: true, fallback: config.evalModels.length > 1, source: 'ahead' },
    // Present in every request; never anything else.
    // On DeepSeek the listing carries no `store` (DeepSeek keeps nothing and does not take the key); on Fireworks it
    // carries `store: false`, as on OpenAI.
    keys: { extract: [...(source === 'inserted' ? ['model', 'input'] : ['model', 'instructions', 'input']), 'reasoning', 'tools', 'stream', ...(config.extractProvider === 'deepseek' ? [] : ['store'])], evaluate: ['model', 'input', 'reasoning', 'tools', 'stream', 'store'] },
  };
}

// What the browser is allowed to know. Never anything about prompt contents.
export function publicConfig(promptStatus) {
  const shape = requestShape();
  return {
    maxClaims: config.maxClaims,
    autoTestFirst: config.autoTestFirst,   // the page runs this many without a press; 0 = the reader chooses every one
    findCopies: Boolean(String(config.searchUrl || '').trim() && String(config.searchKey || '').trim()),   // a refused link is looked for elsewhere; never the key itself
    inFlight: config.evalConcurrency,   // the page paces itself by this, so the operator changes it with one setting
    maxSourceChars: config.maxSourceChars,
    maxUploadBytes: config.maxUploadBytes,
    challengeEnabled: config.challengeEnabled,
    challengeMaxFiles: config.challengeMaxFiles,
    illustrateEnabled: config.illustrateEnabled,
    accounting: config.accounting,
    reasoningSummary: Boolean(config.evalReasoningSummary),
    serverKey: Boolean(config.serverKey),
    request: shape,
    models: {
      extractProvider: shape.extract.provider,
      extract: shape.extract.model,
      extractEffort: shape.extract.effort,
      extractMode: shape.extract.mode,
      evaluate: shape.evaluate.model,
      evaluateEffort: shape.evaluate.effort,
      evaluateMode: shape.evaluate.mode,
      illustrate: config.illustrateModels[0],
      illustrateQuality: config.illustrateQuality,
      webSearch: true,
    },
    prompts: promptStatus,
  };
}
