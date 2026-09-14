// Runtime configuration.
//
// ONE RULE GOVERNS THIS FILE. Every setting that touches a determination defaults to the API's
// own ceiling: the maximum value the OpenAI API accepts, read from the SDK's type definitions.
// Not a value anyone here judged reasonable. Lowering any of them is the operator's decision,
// made in the environment; the README lists every one. `npm run verify-ceiling` inspects the
// request bodies the server actually sends and fails if any of them is below ceiling.
//
// The image pipeline is the only exception: it draws a picture, not a determination, and the
// operator asked for speed there.

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const list = (name, fallback) => env(name, fallback).split(',').map((s) => s.trim()).filter(Boolean);
const int = (name, fallback) => Number.parseInt(env(name, String(fallback)), 10);
const bool = (name, fallback) => /^(1|true|yes|on)$/i.test(env(name, fallback ? 'true' : 'false'));

// The model the operator chose. Used for both steps unless overridden per step.
// A single id means there is no fallback: if the key cannot use it, the run fails and says why.
const MODEL = env('CIVIC_MODEL', 'gpt-5.6-sol');

export const CEILING = Object.freeze({
  effort: 'max',          // reasoning.effort:  none | minimal | low | medium | high | xhigh | max
  mode: 'pro',            // reasoning.mode:    standard | pro
  summary: 'detailed',    // reasoning.summary: auto | concise | detailed
  verbosity: 'high',      // text.verbosity:    low | medium | high
  searchContext: 'high',  // web_search.search_context_size: low | medium | high
  truncation: 'disabled', // never let the API drop input silently
  maxOutputTokens: 0,     // 0 = no cap
  maxSourceChars: 0,      // 0 = no limit of ours; the model's context window is the only limit
});

export const config = {
  port: int('PORT', 3000),

  // Step 1 — empirical claim extraction. Same model, same ceiling as step 2.
  extractModels: list('CIVIC_EXTRACT_MODELS', MODEL),
  extractEffort: env('CIVIC_EXTRACT_EFFORT', CEILING.effort),
  extractMode: env('CIVIC_EXTRACT_REASONING_MODE', CEILING.mode),
  extractSummary: env('CIVIC_EXTRACT_REASONING_SUMMARY', CEILING.summary),
  extractVerbosity: env('CIVIC_EXTRACT_VERBOSITY', CEILING.verbosity),
  extractMaxOutputTokens: int('CIVIC_EXTRACT_MAX_OUTPUT_TOKENS', CEILING.maxOutputTokens),

  // Step 2 — determination.
  evalModels: list('CIVIC_EVAL_MODELS', MODEL),
  evalEffort: env('CIVIC_EVAL_EFFORT', CEILING.effort),
  evalMode: env('CIVIC_EVAL_REASONING_MODE', CEILING.mode),
  evalReasoningSummary: env('CIVIC_EVAL_REASONING_SUMMARY', CEILING.summary),
  evalVerbosity: env('CIVIC_EVAL_VERBOSITY', CEILING.verbosity),
  evalMaxOutputTokens: int('CIVIC_EVAL_MAX_OUTPUT_TOKENS', CEILING.maxOutputTokens),
  evalWebSearch: bool('CIVIC_EVAL_WEB_SEARCH', true),
  evalSearchContext: env('CIVIC_EVAL_SEARCH_CONTEXT', CEILING.searchContext),
  evalConcurrency: int('CIVIC_EVAL_CONCURRENCY', 20), // speed only; the operator asked for parallel
  evalRetries: int('CIVIC_EVAL_RETRIES', 8),           // rate limits and 5xx only; never on a model error
  truncation: CEILING.truncation,

  // Source documents. 0 = no limit of ours. If a document exceeds the model's context window the
  // API refuses it and that error is shown verbatim; nothing is ever read in part.
  maxSourceChars: int('CIVIC_MAX_SOURCE_CHARS', CEILING.maxSourceChars),
  allowSourceTruncation: bool('CIVIC_ALLOW_SOURCE_TRUNCATION', false),
  maxClaims: 20, // the automatic run; claims beyond wait for the reader's selection (operator's rule)
  maxUploadBytes: int('CIVIC_MAX_UPLOAD_BYTES', 200 * 1024 * 1024),
  heartbeatMs: 15000,

  // Visual echo — a picture, not a determination. The operator asked for the fast model.
  illustrateModels: list('CIVIC_IMAGE_MODELS', 'gpt-image-2.5-flare,gpt-image-2.5-sunburst,gpt-image-1.5,gpt-image-1-mini'),
  illustrateQuality: env('CIVIC_IMAGE_QUALITY', 'high'),
  illustrateSize: env('CIVIC_IMAGE_SIZE', '1024x1024'),
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
  webSearchUsdPerCall: Number(env('CIVIC_WEB_SEARCH_USD_PER_CALL', '0.01')),
  imageUsdPerImage: Number(env('CIVIC_IMAGE_USD_PER_IMAGE', '0.02')),

  // Optional server-side key. Off by default.
  serverKey: bool('CIVIC_ALLOW_SERVER_KEY', false) ? env('OPENAI_API_KEY', '') : '',

  // Optional: point the OpenAI client somewhere else (used by scripts/mock-openai.js in dev).
  openaiBaseUrl: env('OPENAI_BASE_URL', ''),
};

/** True when every determination setting is at the API ceiling. Reported by /api/health. */
export function atCeiling() {
  const c = config;
  const checks = {
    extractEffort: c.extractEffort === CEILING.effort,
    extractMode: c.extractMode === CEILING.mode,
    extractSummary: c.extractSummary === CEILING.summary,
    extractVerbosity: c.extractVerbosity === CEILING.verbosity,
    extractNoCap: c.extractMaxOutputTokens === 0,
    evalEffort: c.evalEffort === CEILING.effort,
    evalMode: c.evalMode === CEILING.mode,
    evalSummary: c.evalReasoningSummary === CEILING.summary,
    evalVerbosity: c.evalVerbosity === CEILING.verbosity,
    evalNoCap: c.evalMaxOutputTokens === 0,
    webSearch: c.evalWebSearch === true,
    searchContext: c.evalSearchContext === CEILING.searchContext,
    noFallback: c.extractModels.length === 1 && c.evalModels.length === 1,
    noSourceLimit: c.maxSourceChars === 0,
    noSourceTruncation: c.allowSourceTruncation === false,
  };
  return { all: Object.values(checks).every(Boolean), checks };
}

// What the browser is allowed to know. Never anything about prompt contents.
export function publicConfig(promptStatus) {
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
    ceiling: atCeiling(),
    models: {
      extract: config.extractModels[0],
      extractEffort: config.extractEffort,
      extractMode: config.extractMode,
      evaluate: config.evalModels[0],
      evaluateEffort: config.evalEffort,
      evaluateMode: config.evalMode,
      evaluateVerbosity: config.evalVerbosity,
      searchContext: config.evalSearchContext,
      illustrate: config.illustrateModels[0],
      illustrateQuality: config.illustrateQuality,
      webSearch: config.evalWebSearch,
    },
    prompts: promptStatus,
  };
}
