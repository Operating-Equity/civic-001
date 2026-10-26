// Internal accounting: estimated cost of goods sold per call. Token counts come from the API and
// are exact; the dollar figures are estimates from this table (USD per million tokens) and should
// be checked against the OpenAI pricing page before being relied on. Override with
// CIVIC_PRICING_JSON='{"gpt-5.6-sol":{"input":4,"cached":0.4,"output":20}}'.
// Sol's row is OpenAI's pricing page of 21 September 2026 (promotional through 21 November 2026). GPT-6.1 Sol's and
// GPT-6 Luna's rows are OpenAI's pricing page of 24 October 2026 (standard, under 272K tokens of context); cache writes,
// which OpenAI bills at 1.25 times the input rate, are not counted.
// DeepSeek's rows are its Models & Pricing page of 4 October 2026: a peak price, an off-peak price at half, and the
// peak hours (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday); a call is priced at the hour it went. An override
// of a DeepSeek row in CIVIC_PRICING_JSON replaces the whole row, so it repeats `offPeak` and `peakUtc`.
// Fireworks' row (DeepSeek V4.1 Flash served from the US) is its serverless price from 1 October 2026, in its release note of
// 18 September (the row of 5 October carried the earlier $0.22 / $0.007 / $0.66): one price at every hour.
// Gemini 4 Argon's row (the operator's trial, 18 October) is Google's pricing page of 16 October: an introductory price
// through 30 November 2026, then the one in `from` (a row's `from` entries change it at their moment, UTC; a call is
// priced at the moment it went). Output includes the thinking. `search` is Google Search's own price, $14 per 1,000
// searches; the 5,000 free a month are not counted, so while they last the estimate is an upper bound.
// Claude Opus 5.5's and Claude Fable 5.1's rows (the operator's trial, 26 October) are Anthropic's pricing page of 26
// October: output includes the thinking; `cached` is a read from Anthropic's cache, which FactEngine never asks for;
// `search` is Anthropic's web search, $10 per 1,000 searches. Its page reader is billed as tokens alone.
import { config } from './config.js';

const DEFAULT_PRICES = {
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cached: 0.10, output: 10 },
  'gpt-6-luna': { input: 0.10, cached: 0.01, output: 0.50 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'deepseek-flash': { input: 0.30, cached: 0.006, output: 1.20, offPeak: { input: 0.15, cached: 0.003, output: 0.60 }, peakUtc: { days: [1, 2, 3, 4, 5], hours: [[1, 4], [6, 10]] } },
  'deepseek-v4-pro': { input: 1.32, cached: 0.044, output: 3.96, offPeak: { input: 0.66, cached: 0.022, output: 1.98 }, peakUtc: { days: [1, 2, 3, 4, 5], hours: [[1, 4], [6, 10]] } },
  'accounts/fireworks/models/deepseek-v4p1-flash': { input: 0.30, cached: 0.006, output: 1.20 },
  'claude-opus-5-5': { input: 4, cached: 0.20, output: 20, search: 0.01 },
  'claude-fable-5-1': { input: 10, cached: 0.25, output: 50, search: 0.01 },
  'gemini-4-argon': { input: 2, cached: 0.10, output: 10, search: 0.014, from: [{ at: '2026-12-01T00:00:00Z', input: 4, cached: 0.20, output: 20 }] },
};

/** A row as it stood at `at`: its dated changes applied in order, then its off-peak price when the hour is off-peak. */
export function rowAt(row, at = Date.now()) {
  if (!row) return null;
  let p = row;
  for (const step of row.from || []) {
    const when = Date.parse(step?.at);
    if (Number.isFinite(when) && when <= at) { const { at: _when, ...price } = step; p = { ...p, ...price }; }
  }
  return p.offPeak && !isPeak(p, at) ? { ...p, ...p.offPeak } : p;
}

/** Whether `at` falls in a row's peak hours (UTC). A row without peak hours has one price at every hour. */
export function isPeak(row, at = Date.now()) {
  const p = row?.peakUtc;
  if (!p) return true;
  const d = new Date(at ?? Date.now());
  if (!(p.days || []).includes(d.getUTCDay())) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  return (p.hours || []).some(([from, to]) => h >= from && h < to);
}

let prices = { ...DEFAULT_PRICES };
if (process.env.CIVIC_PRICING_JSON) {
  try { prices = { ...prices, ...JSON.parse(process.env.CIVIC_PRICING_JSON) }; } catch { console.error('[pricing] CIVIC_PRICING_JSON is not valid JSON; ignoring'); }
}

function priceFor(model) {
  if (!model) return null;
  if (prices[model]) return prices[model];
  // dated snapshots such as gpt-5.6-sol-2026-07-09
  const base = Object.keys(prices).find((k) => model.startsWith(k + '-'));
  return base ? prices[base] : null;
}

/** Estimated cost of one text call. Returns { usd, priced } — priced=false when the model is not in the table. */
export function estimateTextCost({ model, usage, searches = 0, at = null }) {
  const p = rowAt(priceFor(model), at ?? Date.now());
  // A provider's own search price when its row has one (Gemini's Google Search); OpenAI's web search otherwise.
  const searchUsd = searches * (Number.isFinite(p?.search) ? p.search : config.webSearchUsdPerCall);
  if (!p || !usage) return { usd: searchUsd, priced: false };
  const cached = usage.cached || 0;
  const uncached = Math.max(0, (usage.input || 0) - cached);
  const usd = (uncached * p.input + cached * p.cached + (usage.output || 0) * p.output) / 1e6 + searchUsd;
  return { usd: round(usd), priced: true };
}

export function estimateImageCost() {
  return { usd: config.imageUsdPerImage, priced: config.imageUsdPerImage > 0 };
}

export function round(usd) {
  return Math.round(usd * 10000) / 10000;
}

export function pricingTable() {
  return prices;
}
