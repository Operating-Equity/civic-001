// The readers' standby (31 October, night). The operator: "it does not help you or the service to show that it is
// struggling. But it also shouldn't fail." Their answers that night: a reader's claim that the readers' model still fails
// after its own tries goes once more, by itself, to a standby model, and only if that fails too does the reader see a
// failure; the reader is never told a standby answered.
//
// The standby is set on Render (CIVIC_EVAL_STANDBY, written `model|level`) and never named in this repository. It runs on
// its provider's path, Google's or Anthropic's (the ones the operator's trial uses for Gemini and Claude), on the
// operator's key there. Unset, there is none, and a claim the readers' model fails is a failure, as before. A setting
// that cannot be read stops the start, naming the setting.
import { config } from './config.js';
import { providerOf, levelsOf, modelReady } from './trial.js';

let standing = null;   // what the setting reads as, once loaded: { provider, model, effort } or null
const PATHS = new Set(['gemini', 'anthropic']);   // the providers whose own path a reader's claim can go once more on

/** The setting read: `model|level`, or nothing. Throws, naming the setting, when it cannot be read. */
export function readStandby(raw = config.evalStandby) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const parts = s.split('|').map((x) => x.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('CIVIC_EVAL_STANDBY is written model|level (one model, one of its levels)');
  const [model, effort] = parts;
  const provider = providerOf(model);
  if (!PATHS.has(provider)) throw new Error('CIVIC_EVAL_STANDBY names a model that is neither Google\'s nor Anthropic\'s; the standby runs on one of their paths');
  if (!levelsOf(model).length) throw new Error('CIVIC_EVAL_STANDBY names a model whose levels FactEngine does not know (server/trial.js, LEVELS)');
  if (!levelsOf(model).includes(effort)) throw new Error(`CIVIC_EVAL_STANDBY names a level the model does not have (it has ${levelsOf(model).join(', ')})`);
  return { provider, model, effort };
}

/** Reads the setting at the start; a setting that cannot be read throws, and the start stops. */
export function loadStandby() {
  standing = readStandby();
  return standing;
}

/** The standby as it stands: its model and level, and whether it can run here (its key set), and if not, why. */
export function standbyState() {
  if (!standing) return null;
  const ready = modelReady(standing.model);
  return { ...standing, ready: ready.ok, why: ready.why };
}

/** The standby a reader's claim may go to now, or null: none set, or its key missing. */
export function readersStandby() {
  const s = standbyState();
  return s?.ready ? { provider: s.provider, model: s.model, effort: s.effort } : null;
}
