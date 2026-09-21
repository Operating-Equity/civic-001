import fs from 'node:fs';
import { resolveKey } from './key.js';
import { extractionShape } from './prompts.js';
// Runtime configuration.
//
// ONE RULE GOVERNS THIS FILE. The requests sent to OpenAI carry the operator's tested
// configuration and nothing else: the model, the reasoning effort, the prompt, web search.
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

// The operator's configuration: gpt-5.6-sol, OpenAI's flagship below GPT-6, at its maximum. Tested by the
// operator at reasoning effort xhigh; on 21 September they asked for the model's maximum power short of
// GPT-6, which OpenAI's pages put at effort `max` (the top of the ladder) in reasoning mode `pro` ("the
// highest-intelligence API option": more model work per answer, billed at the ordinary per-token rates).
// Used for both steps unless the operator sets a step separately. A mode of `standard` or empty sends
// no mode key at all.
const MODEL = env('CIVIC_MODEL', 'gpt-5.6-sol');
const EFFORT = env('CIVIC_EFFORT', 'max');
const MODE = env('CIVIC_REASONING_MODE', 'pro');
const modeOrNone = (v) => (v && v !== 'standard' ? v : '');

// CIVIC's own key. The rule lives in server/key.js and is the same whatever shape either key is in.
// CIVIC runs on the operator's key and no other. There is no switch here, because there is no
// alternative to switch to: a reader's key is never accepted (see operatorKey in server/openai.js).
const chosenKey = resolveKey({ settingsFile: new URL('../.env', import.meta.url).pathname });


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

  // Step 1 — empirical claim extraction.
  extractModels: list('CIVIC_EXTRACT_MODELS', MODEL), // one id = no fallback
  extractEffort: env('CIVIC_EXTRACT_EFFORT', EFFORT),
  extractReasoningMode: modeOrNone(env('CIVIC_EXTRACT_REASONING_MODE', MODE)), // '' = no mode key in the request
  // Reasoning summaries are the model's own account of its reasoning, shown on the page. They do
  // not change the answer. 'auto' lets the API decide the form. Blank turns them off.
  extractSummary: env('CIVIC_EXTRACT_REASONING_SUMMARY', 'auto'),

  // Step 2 — determination.
  evalModels: list('CIVIC_EVAL_MODELS', MODEL), // one id = no fallback
  evalEffort: env('CIVIC_EVAL_EFFORT', EFFORT),
  evalReasoningMode: modeOrNone(env('CIVIC_EVAL_REASONING_MODE', MODE)),
  evalReasoningSummary: env('CIVIC_EVAL_REASONING_SUMMARY', 'auto'),
  webSearch: true, // both steps, always; not an environment setting
  // Four claims at a time (the page sends one claim per request and keeps four in flight; this
  // figure governs a request that carries several claims, as the guard's does). One at a time was
  // the operator's instruction of 17 September, after twenty at once had failed on the key's
  // minute limit every time (a running response is charged again inside the minute at each of its
  // own later calls, after a web search, by 67,000 to 89,000, far above what its admission showed,
  // so many parallel claims starve one another); two ran whole on the address; on 18 September the
  // operator chose three on the 500,000-a-minute figure of 16 September, then four once the check
  // page showed the key's current limit, 2,000,000 a minute (four ≈ 600,000 in a typical minute).
  // Ten remains the size of a run.
  evalConcurrency: int('CIVIC_EVAL_CONCURRENCY', 4),
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
  transcriptKey: env('CIVIC_TRANSCRIPT_KEY', ''),
  transcriptHeader: env('CIVIC_TRANSCRIPT_HEADER', 'x-api-key'),
  // Most services carry the key raw in their own header, so the prefix is empty unless one is named;
  // a service that wants `Authorization: Bearer <key>` sets the header and the prefix `Bearer`.
  transcriptPrefix: env('CIVIC_TRANSCRIPT_PREFIX', ''),
  // When a service answers with a job instead of the words (it is transcribing the video), this is
  // where its result is read, with {jobId} filled in. Without it, a job answer is the end.
  transcriptJobUrl: env('CIVIC_TRANSCRIPT_JOB_URL', ''),
  // Sources as tools (server/tools): the gateway's public address, which the requests to OpenAI name so
  // the model can reach CIVIC's tools, and the pass OpenAI carries to it. Both set: the tools are in
  // both requests. Either empty: the requests are exactly as before, and the gateway answers no one.
  // Every source's own key is that source's setting, named in its adapter, never here.
  toolsUrl: env('CIVIC_TOOLS_URL', ''),
  toolsPass: env('CIVIC_TOOLS_PASS', ''),
  maxSourceChars: int('CIVIC_MAX_SOURCE_CHARS', 0),
  allowSourceTruncation: bool('CIVIC_ALLOW_SOURCE_TRUNCATION', false),
  maxClaims: 10, // the automatic run; claims beyond wait for the reader's selection (operator's rule, ten since 17 September)
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
  signinLog: env('CIVIC_SIGNIN_LOG', new URL('../data/signins.jsonl', import.meta.url).pathname),
  // One line per run started under a code (server/uses.js); on a persistent disk in the cloud.
  usesFile: env('CIVIC_USES_FILE', new URL('../data/uses.jsonl', import.meta.url).pathname),
};

/** Exactly what each request will carry. Printed at startup and reported by /api/health. */
export function requestShape() {
  const source = extractionShape();
  return {
    extract: { model: config.extractModels[0], effort: config.extractEffort, mode: config.extractReasoningMode || null, summary: config.extractSummary || null, webSearch: true, fallback: config.extractModels.length > 1, source },
    evaluate: { model: config.evalModels[0], effort: config.evalEffort, mode: config.evalReasoningMode || null, summary: config.evalReasoningSummary || null, webSearch: true, fallback: config.evalModels.length > 1, source: 'ahead' },
    // Present in every request; never anything else.
    keys: { extract: source === 'inserted' ? ['model', 'input', 'reasoning', 'tools', 'stream', 'store'] : ['model', 'instructions', 'input', 'reasoning', 'tools', 'stream', 'store'], evaluate: ['model', 'input', 'reasoning', 'tools', 'stream', 'store'] },
  };
}

// What the browser is allowed to know. Never anything about prompt contents.
export function publicConfig(promptStatus) {
  const shape = requestShape();
  return {
    maxClaims: config.maxClaims,
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
