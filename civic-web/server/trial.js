// The operator's trial (14 October): their own determinations on DeepSeek, chosen on the page, beside the readers'
// model, which does not change. "I think the best experiment is to use the new DeepSeek deep reasoning model through the
// already connected API." "Before optimizing caching on OpenAI, I would rather use DeepSeek's newest model, built for
// the second and most important stage."
//
// Only the operator's runs go there (a reader's choice of model is no choice: it is ignored), so the readers' texts
// (Privacy, Terms) stay true. A trial fact-check is a row of its own kind, never charged and never in the readers'
// measurements; /check sums it by model (server/economics.js).
//
// DeepSeek's Responses API ignores `web_search` and every other built-in tool, silently, so a fact-check there searches
// through FactEngine's own tools, offered to the model as functions (server/tools: the search service and the page
// reader): without the search service the trial cannot run, and says so.
import { config } from './config.js';
import { registry } from './tools/index.js';
import { ApiError } from './openai.js';

/** DeepSeek's reasoning efforts (its own documentation). The page opens on high, the level DeepSeek gives xhigh. */
export const DEEPSEEK_EFFORTS = ['none', 'low', 'high', 'max'];
export const DEFAULT_EFFORT = 'high';

/** A model is DeepSeek's by its name: DeepSeek's ids begin so (deepseek-flash, deepseek-v4-pro). */
export const isDeepSeekModel = (id) => /^deepseek-/i.test(String(id || ''));

// The names a person reads; an id the table does not know is shown as it is.
const LABELS = { 'deepseek-v4-pro': 'DeepSeek V4 Pro', 'deepseek-flash': 'DeepSeek V4.1 Flash', 'gpt-5.6-sol': 'GPT-5.6 Sol' };
export const modelLabel = (id) => LABELS[id] || String(id || '');

/** Whether the trial can run here, and if not, why (for the page and /check). */
export function trialReady() {
  if (!config.evalTrialModels.length) return { ok: false, why: 'The trial is off (CIVIC_EVAL_TRIAL_MODELS=off).' };
  const deepseek = config.evalTrialModels.some(isDeepSeekModel);
  if (deepseek && !config.deepseekKey) return { ok: false, why: 'DEEPSEEK_API_KEY is not set, so nothing can be sent to DeepSeek.' };
  if (deepseek && !registry.table.some((t) => t.name === 'search_web')) {
    return { ok: false, why: 'FactEngine\'s search service is not set (CIVIC_SEARCH_URL and CIVIC_SEARCH_KEY), and DeepSeek has no search of its own, so a fact-check there could not search.' };
  }
  return { ok: true, why: null };
}

/** What the operator's page is told of the trial: the models, the efforts, and whether it can run. Never a key. */
export function trialState() {
  if (!config.evalTrialModels.length) return null;
  const ready = trialReady();
  return {
    models: config.evalTrialModels.map((id) => ({ id, label: modelLabel(id) })),
    efforts: DEEPSEEK_EFFORTS,
    effort: DEFAULT_EFFORT,
    readers: { id: config.evalModels[0], label: modelLabel(config.evalModels[0]) },
    ready: ready.ok,
    why: ready.why,
  };
}

const refuse = (status, code, message) => Object.assign(new ApiError(status, code, message), { expected: true });

/**
 * The trial a request asks for, or null for the readers' determination. `operator` is whether the request is the
 * operator's own; anyone else's `model` is ignored. The readers' own model may be asked for too (side by side), and
 * then the request is exactly a reader's, recorded as a trial.
 */
export function trialOf(body, { operator }) {
  const asked = typeof body?.model === 'string' ? body.model.trim() : '';
  if (!asked || !operator) return null;
  if (config.evalModels.includes(asked)) return { provider: 'openai', model: asked };
  if (!config.evalTrialModels.includes(asked)) throw refuse(400, 'trial_model', `${asked} is not one of the trial's models (CIVIC_EVAL_TRIAL_MODELS).`);
  if (!isDeepSeekModel(asked)) throw refuse(400, 'trial_model', `${asked} is not DeepSeek's: the trial runs DeepSeek's models.`);
  const ready = trialReady();
  if (!ready.ok) throw refuse(503, 'trial_unavailable', ready.why);
  const effort = typeof body?.effort === 'string' && DEEPSEEK_EFFORTS.includes(body.effort.trim()) ? body.effort.trim() : DEFAULT_EFFORT;
  return { provider: 'deepseek', model: asked, effort };
}
