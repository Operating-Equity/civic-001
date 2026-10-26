// The operator's trial (14 October): their own determinations on another model, chosen on the page, beside the readers'
// model, which does not change. "I think the best experiment is to use the new DeepSeek deep reasoning model through the
// already connected API." "Before optimizing caching on OpenAI, I would rather use DeepSeek's newest model, built for
// the second and most important stage." On 18 October: "There is only 1 DeepSeek model for fact checking" (V4 Pro, the
// deep-reasoning one), and Gemini 4 Argon beside it, "argon medium and argon high", on their own Google key. On 24
// October: "GPT-6.1 Sol make it also an option for testing side by side", at xhigh, the readers' level: OpenAI's own
// fact-check, with only its model and effort its own. On 25 October: "multiple options for the top tier models and not a
// single default selection … compare using different power settings for each of the models … especially … against
// DeepSeek": every frontier model at every level its maker supports, each model and level an entry of its own, ticked
// on the page in any number, each ticked entry a card of its own for every claim chosen. On 26 October, on their own
// Anthropic key: "The two high-end models opus and fable at all levels other than the bottom two tiers."
//
// Only the operator's runs go there (a reader's choice of model is no choice: it is ignored), so the readers' texts
// (Privacy, Terms) stay true. A trial fact-check is a row of its own kind, never charged and never in the readers'
// measurements; /check sums it by model (server/economics.js).
//
// DeepSeek's Responses API ignores `web_search` and every other built-in tool, silently, so a fact-check there searches
// through FactEngine's own tools, offered to the model as functions (server/tools: the search service and the page
// reader): without the search service DeepSeek's trial cannot run, and says so. Gemini searches with Google's own search
// and reads pages itself (server/gemini.js), so it needs its key alone, and so does Claude, which searches and reads pages
// with Anthropic's own tools (server/anthropic.js). Each model is ready or not on its own: one that
// cannot run is offered with its reason, and the others still run.
import { config } from './config.js';
import { registry } from './tools/index.js';
import { ApiError, operatorKey } from './openai.js';
import { isGeminiModel } from './gemini.js';
import { isAnthropicModel } from './anthropic.js';

/**
 * The levels each model's maker supports, from their own pages (read 25 October 2026), in the order the page shows them:
 *   - OpenAI (developers.openai.com, each model's page): GPT-6 Astra and GPT-6.1 Sol take low to max, not none or
 *     minimal; GPT-5.6 Sol takes none to max. Each is sent as `reasoning.effort`.
 *   - Google (ai.google.dev, "Gemini thinking"): Gemini 4 Argon takes low, medium and high, as `thinking_level`.
 *   - DeepSeek (api-docs.deepseek.com, "Thinking Mode"): none (thinking off), low, high and max, as `reasoning.effort`;
 *     DeepSeek reads medium as high and xhigh as max, so those are not levels of their own there.
 *   - Anthropic (platform.claude.com, read 26 October): Claude Opus 5.5 and Claude Fable 5.1 take low, medium, high,
 *     xhigh and max, as `output_config.effort`, with thinking always on. The operator's rule leaves out the bottom two
 *     (26 October: "all levels other than the bottom two tiers"), so here they take high, xhigh and max.
 * A model of the trial's list that is not here is not offered: its levels are not known, and none is guessed.
 */
export const LEVELS = {
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5-5': ['high', 'xhigh', 'max'],
  'claude-fable-5-1': ['high', 'xhigh', 'max'],
  'gemini-4-argon': ['low', 'medium', 'high'],
  'deepseek-v4-pro': ['none', 'low', 'high', 'max'],
  'deepseek-flash': ['none', 'low', 'high', 'max'],
};
/** A model's levels, or none when they are not known. */
export const levelsOf = (id) => LEVELS[id] || [];

/** A model is DeepSeek's by its name: DeepSeek's ids begin so (deepseek-flash, deepseek-v4-pro). */
export const isDeepSeekModel = (id) => /^deepseek-/i.test(String(id || ''));
/** A model is OpenAI's by its name: OpenAI's ids begin so (gpt-6.1-sol). */
export const isOpenAIModel = (id) => /^gpt-/i.test(String(id || ''));
export { isGeminiModel, isAnthropicModel };

/** Whose model it is: 'deepseek', 'gemini', 'anthropic', 'openai', or null for one the trial cannot run. */
export const providerOf = (id) => (isDeepSeekModel(id) ? 'deepseek' : isGeminiModel(id) ? 'gemini' : isAnthropicModel(id) ? 'anthropic' : isOpenAIModel(id) ? 'openai' : null);

// The names a person reads; an id the table does not know is shown as it is.
const LABELS = { 'deepseek-v4-pro': 'DeepSeek V4 Pro', 'deepseek-flash': 'DeepSeek V4.1 Flash', 'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6-astra': 'GPT-6 Astra', 'gemini-4-argon': 'Gemini 4 Argon', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-fable-5-1': 'Claude Fable 5.1' };
export const modelLabel = (id) => LABELS[id] || String(id || '');
/** An entry's name: the model and its level ("GPT-6 Astra · high"). */
export const entryLabel = (id, level) => `${modelLabel(id)} · ${level}`;

/** Whether one of the trial's models can run here, and if not, why (for the page, /check and the startup line). */
export function modelReady(id) {
  const provider = providerOf(id);
  if (provider === 'deepseek') {
    if (!config.deepseekKey) return { ok: false, why: 'DEEPSEEK_API_KEY is not set, so nothing can be sent to DeepSeek.' };
    if (!registry.table.some((t) => t.name === 'search_web')) {
      return { ok: false, why: 'FactEngine\'s search service is not set (CIVIC_SEARCH_URL and CIVIC_SEARCH_KEY), and DeepSeek has no search of its own, so a fact-check there could not search.' };
    }
    return { ok: true, why: null };
  }
  if (provider === 'gemini') {
    if (!config.geminiKey) return { ok: false, why: 'GEMINI_API_KEY is not set, so nothing can be sent to Gemini. The operator pastes it in Render: the civic service, Environment.' };
    return { ok: true, why: null };
  }
  if (provider === 'anthropic') {
    if (!config.anthropicKey) return { ok: false, why: 'ANTHROPIC_API_KEY is not set, so nothing can be sent to Anthropic. The operator pastes it in Render: the civic service, Environment.' };
    return { ok: true, why: null };
  }
  if (provider === 'openai') {
    // The readers' own key, web search and rate gate: what can run a reader's fact-check can run this one.
    if (!operatorKey({ optional: true })) return { ok: false, why: 'OPENAI_API_KEY is not set, so nothing can be sent to OpenAI.' };
    return { ok: true, why: null };
  }
  return { ok: false, why: `${id} is not DeepSeek's, Gemini's, Anthropic's or OpenAI's, and the trial runs those providers' models.` };
}

/** Whether a model of the trial's list is offered: its maker's and its levels known. */
function modelOffered(id) {
  if (!providerOf(id)) return { ok: false, why: `${id} is not DeepSeek's, Gemini's, Anthropic's or OpenAI's, and the trial runs those providers' models.` };
  if (!levelsOf(id).length) return { ok: false, why: `${id}'s levels are not known to FactEngine (server/trial.js, LEVELS), so it is not offered.` };
  return { ok: true, why: null };
}

/** Whether the trial can run here at all (any of its models), and if not, why. */
export function trialReady() {
  if (!config.evalTrialModels.length) return { ok: false, why: 'The trial is off (CIVIC_EVAL_TRIAL_MODELS=off).' };
  const states = config.evalTrialModels.map((id) => (modelOffered(id).ok ? modelReady(id) : modelOffered(id)));
  if (states.some((s) => s.ok)) return { ok: true, why: null };
  return { ok: false, why: [...new Set(states.map((s) => s.why))].join(' ') };
}

/**
 * What the operator's page is told of the trial: each model with its levels and whether it can run, and its entries, one
 * per model and level, in that order. A model whose levels are not known is listed with its reason and no entry. Never a
 * key.
 */
export function trialState() {
  if (!config.evalTrialModels.length) return null;
  const models = config.evalTrialModels.map((id) => {
    const offered = modelOffered(id);
    const ready = offered.ok ? modelReady(id) : offered;
    return { id, label: modelLabel(id), provider: providerOf(id), efforts: levelsOf(id), ready: ready.ok, why: ready.why };
  });
  const entries = models.flatMap((m) => m.efforts.map((e) => ({ model: m.id, label: entryLabel(m.id, e), effort: e, ready: m.ready, why: m.why })));
  const ready = trialReady();
  return {
    models,
    entries,
    readers: { id: config.evalModels[0], label: modelLabel(config.evalModels[0]), effort: config.evalEffort },
    ready: ready.ok,
    why: ready.why,
  };
}

const refuse = (status, code, message) => Object.assign(new ApiError(status, code, message), { expected: true });

/**
 * The trial a request asks for, or null for the readers' determination. `operator` is whether the request is the
 * operator's own; anyone else's `model` is ignored. An entry is a model and one of its levels, and runs at exactly that
 * level; a level its maker does not support is refused, and none is chosen for the asker. The readers' own model asked
 * for with no level (a page from before 25 October) is the readers' request exactly, recorded as a trial.
 */
export function trialOf(body, { operator }) {
  const asked = typeof body?.model === 'string' ? body.model.trim() : '';
  if (!asked || !operator) return null;
  const said = typeof body?.effort === 'string' ? body.effort.trim() : '';
  if (config.evalModels.includes(asked) && !said) return { provider: 'openai', model: asked };
  if (!config.evalTrialModels.includes(asked)) throw refuse(400, 'trial_model', `${asked} is not one of the trial's models (CIVIC_EVAL_TRIAL_MODELS).`);
  const offered = modelOffered(asked);
  if (!offered.ok) throw refuse(400, 'trial_model', offered.why);
  const levels = levelsOf(asked);
  if (!levels.includes(said)) throw refuse(400, 'trial_effort', `${modelLabel(asked)} runs at ${levels.join(', ')}; ${said ? `"${said}" was` : 'no level was'} asked for.`);
  const ready = modelReady(asked);
  if (!ready.ok) throw refuse(503, 'trial_unavailable', ready.why);
  return { provider: providerOf(asked), model: asked, effort: said };
}
