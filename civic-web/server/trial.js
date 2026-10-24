// The operator's trial (14 October): their own determinations on another model, chosen on the page, beside the readers'
// model, which does not change. "I think the best experiment is to use the new DeepSeek deep reasoning model through the
// already connected API." "Before optimizing caching on OpenAI, I would rather use DeepSeek's newest model, built for
// the second and most important stage." On 18 October: "There is only 1 DeepSeek model for fact checking" (V4 Pro, the
// deep-reasoning one), and Gemini 4 Argon beside it, "argon medium and argon high", on their own Google key. On 24
// October: "GPT-6.1 Sol make it also an option for testing side by side", at xhigh, the readers' level: OpenAI's own
// fact-check, with only its model and effort its own.
//
// Only the operator's runs go there (a reader's choice of model is no choice: it is ignored), so the readers' texts
// (Privacy, Terms) stay true. A trial fact-check is a row of its own kind, never charged and never in the readers'
// measurements; /check sums it by model (server/economics.js).
//
// DeepSeek's Responses API ignores `web_search` and every other built-in tool, silently, so a fact-check there searches
// through FactEngine's own tools, offered to the model as functions (server/tools: the search service and the page
// reader): without the search service DeepSeek's trial cannot run, and says so. Gemini searches with Google's own search
// and reads pages itself (server/gemini.js), so it needs its key alone. Each model is ready or not on its own: one that
// cannot run is offered with its reason, and the others still run.
import { config } from './config.js';
import { registry } from './tools/index.js';
import { ApiError, operatorKey } from './openai.js';
import { isGeminiModel } from './gemini.js';

/** DeepSeek's reasoning efforts (its own documentation). The page opens on high, the level DeepSeek gives xhigh. */
export const DEEPSEEK_EFFORTS = ['none', 'low', 'high', 'max'];
export const DEFAULT_EFFORT = 'high';
/** Gemini's levels, the operator's two (18 October), each its own entry on the page; Google's third, low, is not offered. */
export const GEMINI_EFFORTS = ['medium', 'high'];
/** An OpenAI model's levels in the trial: the operator's one (24 October), xhigh, the readers' level, its own entry. */
export const OPENAI_EFFORTS = ['xhigh'];

/** A model is DeepSeek's by its name: DeepSeek's ids begin so (deepseek-flash, deepseek-v4-pro). */
export const isDeepSeekModel = (id) => /^deepseek-/i.test(String(id || ''));
/** A model is OpenAI's by its name: OpenAI's ids begin so (gpt-6.1-sol). */
export const isOpenAIModel = (id) => /^gpt-/i.test(String(id || ''));
export { isGeminiModel };

/** Whose model it is: 'deepseek', 'gemini', 'openai', or null for one the trial cannot run. */
export const providerOf = (id) => (isDeepSeekModel(id) ? 'deepseek' : isGeminiModel(id) ? 'gemini' : isOpenAIModel(id) ? 'openai' : null);

// The names a person reads; an id the table does not know is shown as it is.
const LABELS = { 'deepseek-v4-pro': 'DeepSeek V4 Pro', 'deepseek-flash': 'DeepSeek V4.1 Flash', 'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gemini-4-argon': 'Gemini 4 Argon' };
export const modelLabel = (id) => LABELS[id] || String(id || '');

const EFFORTS = { gemini: GEMINI_EFFORTS, deepseek: DEEPSEEK_EFFORTS, openai: OPENAI_EFFORTS };
const effortsOf = (id) => EFFORTS[providerOf(id)] || [];
// An entry per level, the level being the choice itself: Gemini's and OpenAI's. DeepSeek's levels stand beside its entry.
const fixedLevels = (provider) => provider === 'gemini' || provider === 'openai';

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
  if (provider === 'openai') {
    // The readers' own key, web search and rate gate: what can run a reader's fact-check can run this one.
    if (!operatorKey({ optional: true })) return { ok: false, why: 'OPENAI_API_KEY is not set, so nothing can be sent to OpenAI.' };
    return { ok: true, why: null };
  }
  return { ok: false, why: `${id} is not DeepSeek's, Gemini's or OpenAI's, and the trial runs those providers' models.` };
}

/** Whether the trial can run here at all (any of its models), and if not, why. */
export function trialReady() {
  if (!config.evalTrialModels.length) return { ok: false, why: 'The trial is off (CIVIC_EVAL_TRIAL_MODELS=off).' };
  const states = config.evalTrialModels.map(modelReady);
  if (states.some((s) => s.ok)) return { ok: true, why: null };
  return { ok: false, why: [...new Set(states.map((s) => s.why))].join(' ') };
}

/**
 * What the operator's page is told of the trial: each model with its efforts and whether it can run, and the entries of
 * the pull-down. A DeepSeek model is one entry with its efforts beside it; Gemini is one entry per level, the level being
 * the choice itself ("argon medium and argon high"). Never a key.
 */
export function trialState() {
  if (!config.evalTrialModels.length) return null;
  const models = config.evalTrialModels.map((id) => {
    const provider = providerOf(id);
    const ready = modelReady(id);
    return { id, label: modelLabel(id), provider, efforts: effortsOf(id), effort: provider === 'deepseek' ? DEFAULT_EFFORT : null, ready: ready.ok, why: ready.why };
  });
  const entries = models.flatMap((m) => (fixedLevels(m.provider)
    ? m.efforts.map((e) => ({ model: m.id, label: `${m.label} · ${e}`, effort: e, fixed: true, ready: m.ready, why: m.why }))
    : [{ model: m.id, label: m.label, efforts: m.efforts, effort: m.effort, fixed: false, ready: m.ready, why: m.why }]));
  const ready = trialReady();
  return {
    models,
    entries,
    readers: { id: config.evalModels[0], label: modelLabel(config.evalModels[0]) },
    ready: ready.ok,
    why: ready.why,
  };
}

const refuse = (status, code, message) => Object.assign(new ApiError(status, code, message), { expected: true });

/**
 * The trial a request asks for, or null for the readers' determination. `operator` is whether the request is the
 * operator's own; anyone else's `model` is ignored. The readers' own model may be asked for too (side by side), and
 * then the request is exactly a reader's, recorded as a trial. Gemini runs only at one of the operator's two levels:
 * there is no default of ours.
 */
export function trialOf(body, { operator }) {
  const asked = typeof body?.model === 'string' ? body.model.trim() : '';
  if (!asked || !operator) return null;
  if (config.evalModels.includes(asked)) return { provider: 'openai', model: asked };
  if (!config.evalTrialModels.includes(asked)) throw refuse(400, 'trial_model', `${asked} is not one of the trial's models (CIVIC_EVAL_TRIAL_MODELS).`);
  const provider = providerOf(asked);
  if (!provider) throw refuse(400, 'trial_model', `${asked} is not DeepSeek's, Gemini's or OpenAI's, and the trial runs those providers' models.`);
  const ready = modelReady(asked);
  if (!ready.ok) throw refuse(503, 'trial_unavailable', ready.why);
  const said = typeof body?.effort === 'string' ? body.effort.trim() : '';
  if (provider === 'gemini') {
    if (!GEMINI_EFFORTS.includes(said)) throw refuse(400, 'trial_effort', `Gemini's trial runs at ${GEMINI_EFFORTS.join(' or ')}; ${said ? `"${said}" was` : 'no level was'} asked for.`);
    return { provider, model: asked, effort: said };
  }
  if (provider === 'openai') {
    if (!OPENAI_EFFORTS.includes(said)) throw refuse(400, 'trial_effort', `${modelLabel(asked)}'s trial runs at ${OPENAI_EFFORTS.join(' or ')}; ${said ? `"${said}" was` : 'no level was'} asked for.`);
    return { provider, model: asked, effort: said };
  }
  return { provider, model: asked, effort: DEEPSEEK_EFFORTS.includes(said) ? said : DEFAULT_EFFORT };
}
