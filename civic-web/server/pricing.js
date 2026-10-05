// Internal accounting: estimated cost of goods sold per call. Token counts come from the API and
// are exact; the dollar figures are estimates from this table (USD per million tokens) and should
// be checked against the OpenAI pricing page before being relied on. Override with
// CIVIC_PRICING_JSON='{"gpt-5.6-sol":{"input":4,"cached":0.4,"output":20}}'.
// Sol's row is OpenAI's pricing page of 21 September 2026 (promotional through 21 November 2026).
// DeepSeek's rows are its Models & Pricing page of 4 October 2026: a peak price, an off-peak price at half, and the
// peak hours (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday); a call is priced at the hour it went. An override
// of a DeepSeek row in CIVIC_PRICING_JSON replaces the whole row, so it repeats `offPeak` and `peakUtc`.
// Fireworks' row (DeepSeek V4.1 Flash served from the US) is its model page of 5 October 2026: one price at every hour.
import { config } from './config.js';

const DEFAULT_PRICES = {
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'deepseek-flash': { input: 0.30, cached: 0.006, output: 1.20, offPeak: { input: 0.15, cached: 0.003, output: 0.60 }, peakUtc: { days: [1, 2, 3, 4, 5], hours: [[1, 4], [6, 10]] } },
  'deepseek-v4-pro': { input: 1.32, cached: 0.044, output: 3.96, offPeak: { input: 0.66, cached: 0.022, output: 1.98 }, peakUtc: { days: [1, 2, 3, 4, 5], hours: [[1, 4], [6, 10]] } },
  'accounts/fireworks/models/deepseek-v4p1-flash': { input: 0.22, cached: 0.007, output: 0.66 },
};

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
  const row = priceFor(model);
  const p = row && row.offPeak && !isPeak(row, at ?? Date.now()) ? { ...row, ...row.offPeak } : row;
  const searchUsd = searches * config.webSearchUsdPerCall;
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
