// Runtime configuration. Everything here can be overridden with environment variables.
// Model ids were verified against the OpenAI SDK type definitions (openai@7.15, Sept 2026).

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const list = (name, fallback) => env(name, fallback).split(',').map((s) => s.trim()).filter(Boolean);
const int = (name, fallback) => Number.parseInt(env(name, String(fallback)), 10);
const bool = (name, fallback) => /^(1|true|yes|on)$/i.test(env(name, fallback ? 'true' : 'false'));

export const config = {
  port: int('PORT', 3000),

  // Step 1 — empirical claim extraction.
  // Recommendation: gpt-5.6-terra at medium effort. Extraction is careful reading, not deep
  // reasoning; terra follows long instructions well over long documents, streams fast, and costs
  // roughly a tenth of sol. Fallbacks are tried in order if a model id is not available to the key.
  extractModels: list('CIVIC_EXTRACT_MODELS', 'gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4-mini'),
  extractEffort: env('CIVIC_EXTRACT_EFFORT', 'medium'),
  // 0 = no cap. The extraction list is shown in full, so it must be allowed to finish.
  extractMaxOutputTokens: int('CIVIC_EXTRACT_MAX_OUTPUT_TOKENS', 0),

  // Step 2 — determination. Requested: GPT-5.6 at extra-high reasoning effort.
  evalModels: list('CIVIC_EVAL_MODELS', 'gpt-5.6-sol,gpt-5.6,gpt-5.5'),
  evalEffort: env('CIVIC_EVAL_EFFORT', 'xhigh'),
  // 0 = no cap. The entry is shown in full and must never be cut off mid-sentence; reasoning
  // tokens count toward any cap you do set, so a low value truncates the visible answer.
  evalMaxOutputTokens: int('CIVIC_EVAL_MAX_OUTPUT_TOKENS', 0),
  // Reasoning summaries are extra output, shown on the card. '' turns them off.
  evalReasoningSummary: env('CIVIC_EVAL_REASONING_SUMMARY', 'auto'),
  evalWebSearch: bool('CIVIC_EVAL_WEB_SEARCH', true), // lets the inspector fetch primary sources
  evalConcurrency: int('CIVIC_EVAL_CONCURRENCY', 20), // all 20 claims in parallel
  evalRetries: int('CIVIC_EVAL_RETRIES', 3),

  // Visual echo — art-directed, then drawn by the fast image model while the document is processed.
  illustrateModels: list('CIVIC_IMAGE_MODELS', 'gpt-image-2.5-flare,gpt-image-2.5-sunburst,gpt-image-1.5,gpt-image-1-mini'),
  illustrateQuality: env('CIVIC_IMAGE_QUALITY', 'high'), // low | medium | high | xhigh | max
  illustrateSize: env('CIVIC_IMAGE_SIZE', '1024x1024'),
  illustrateEnabled: bool('CIVIC_IMAGE_ENABLED', true),
  // Stage 1 of the echo: a small model writes a concrete photographic brief first. This is what
  // separates a considered image from a generic one. Adds roughly two seconds.
  artDirection: bool('CIVIC_IMAGE_ART_DIRECTION', true),
  artDirectionModels: list('CIVIC_IMAGE_ART_DIRECTION_MODELS', 'gpt-5.6-luna,gpt-5.6-terra,gpt-5.4-mini'),
  artDirectionEffort: env('CIVIC_IMAGE_ART_DIRECTION_EFFORT', 'low'),

  // Challenge — mechanics run, but the OpenAI call is withheld until the prompt is certified.
  challengeEnabled: bool('CIVIC_CHALLENGE_ENABLED', false),
  challengeMaxFiles: 5,
  challengeMaxFileBytes: 20 * 1024 * 1024,

  // Limits.
  maxClaims: 20, // hard ceiling: never more than 20 claims are ever evaluated
  // A document longer than this is REFUSED, not silently shortened: a claim that is never read
  // is a claim that can never be tested, and the reader would have no way to know. Set
  // CIVIC_ALLOW_SOURCE_TRUNCATION=true to cut instead, and the page will say so in red.
  maxSourceChars: int('CIVIC_MAX_SOURCE_CHARS', 2000000), // ≈500k tokens, inside a 1.05M window
  allowSourceTruncation: bool('CIVIC_ALLOW_SOURCE_TRUNCATION', false),
  maxUploadBytes: int('CIVIC_MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
  heartbeatMs: 15000,

  // Internal accounting (operator view, not a customer feature): per-claim tokens, estimated cost,
  // and an append-only ledger file. Turn the page display off with CIVIC_INTERNAL_ACCOUNTING=false.
  accounting: bool('CIVIC_INTERNAL_ACCOUNTING', true),
  ledgerFile: env('CIVIC_LEDGER_FILE', new URL('../data/ledger.jsonl', import.meta.url).pathname),
  webSearchUsdPerCall: Number(env('CIVIC_WEB_SEARCH_USD_PER_CALL', '0.01')),
  imageUsdPerImage: Number(env('CIVIC_IMAGE_USD_PER_IMAGE', '0.02')),

  // Optional server-side key. Off by default: readers bring their own key. When
  // CIVIC_ALLOW_SERVER_KEY=true and OPENAI_API_KEY is set, requests without a reader key use it
  // (the operator pays). Keep this off on any public deployment without accounts.
  serverKey: bool('CIVIC_ALLOW_SERVER_KEY', false) ? env('OPENAI_API_KEY', '') : '',

  // Optional: point the OpenAI client somewhere else (used by scripts/mock-openai.js in dev).
  openaiBaseUrl: env('OPENAI_BASE_URL', ''),
};

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
    models: {
      extract: config.extractModels[0],
      extractEffort: config.extractEffort,
      evaluate: config.evalModels[0],
      evaluateEffort: config.evalEffort,
      illustrate: config.illustrateModels[0],
      illustrateQuality: config.illustrateQuality,
      webSearch: config.evalWebSearch,
    },
    prompts: promptStatus, // { extract: true/false, evaluate: true/false, challenge: true/false }
  };
}
