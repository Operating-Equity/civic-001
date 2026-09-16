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

// The one configuration the operator reported testing: gpt-5.6-sol at reasoning effort xhigh.
// It is used for both steps unless the operator sets a step separately.
const MODEL = env('CIVIC_MODEL', 'gpt-5.6-sol');
const EFFORT = env('CIVIC_EFFORT', 'xhigh');

// CIVIC's own key. The rule lives in server/key.js and is the same whatever shape either key is in.
// CIVIC runs on the operator's key and no other. There is no switch here, because there is no
// alternative to switch to: a reader's key is never accepted (see operatorKey in server/openai.js).
const chosenKey = resolveKey({ settingsFile: new URL('../.env', import.meta.url).pathname });


export const config = {
  port: int('PORT', 3000),

  // Step 1 — empirical claim extraction.
  extractModels: list('CIVIC_EXTRACT_MODELS', MODEL), // one id = no fallback
  extractEffort: env('CIVIC_EXTRACT_EFFORT', EFFORT),
  // Reasoning summaries are the model's own account of its reasoning, shown on the page. They do
  // not change the answer. 'auto' lets the API decide the form. Blank turns them off.
  extractSummary: env('CIVIC_EXTRACT_REASONING_SUMMARY', 'auto'),

  // Step 2 — determination.
  evalModels: list('CIVIC_EVAL_MODELS', MODEL), // one id = no fallback
  evalEffort: env('CIVIC_EVAL_EFFORT', EFFORT),
  evalReasoningSummary: env('CIVIC_EVAL_REASONING_SUMMARY', 'auto'),
  webSearch: true, // both steps, always; not an environment setting
  evalConcurrency: int('CIVIC_EVAL_CONCURRENCY', 20), // the operator asked for the 20 to run in parallel
  evalRetries: int('CIVIC_EVAL_RETRIES', 8),           // rate limits and 5xx only; never on a model or parameter error

  // Source documents. No limit of ours. If a document exceeds the model's context window the API
  // refuses it and that error is shown verbatim; nothing is ever read in part.
  // Development only: lets the link reader reach localhost, so the fixture site in scripts/ can be
  // tested. Never enable on a public server; it would let a stranger aim the reader at your network.
  allowPrivateUrls: bool('CIVIC_ALLOW_PRIVATE_URLS', false),
  maxSourceChars: int('CIVIC_MAX_SOURCE_CHARS', 0),
  allowSourceTruncation: bool('CIVIC_ALLOW_SOURCE_TRUNCATION', false),
  maxClaims: 20, // the automatic run; claims beyond wait for the reader's selection (operator's rule)
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
};

/** Exactly what each request will carry. Printed at startup and reported by /api/health. */
export function requestShape() {
  const source = extractionShape();
  return {
    extract: { model: config.extractModels[0], effort: config.extractEffort, summary: config.extractSummary || null, webSearch: true, fallback: config.extractModels.length > 1, source },
    evaluate: { model: config.evalModels[0], effort: config.evalEffort, summary: config.evalReasoningSummary || null, webSearch: true, fallback: config.evalModels.length > 1 },
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
      evaluate: shape.evaluate.model,
      evaluateEffort: shape.evaluate.effort,
      illustrate: config.illustrateModels[0],
      illustrateQuality: config.illustrateQuality,
      webSearch: true,
    },
    prompts: promptStatus,
  };
}
