// What a reader receives of a run: all of its work and its results, under the operator's names (the operator's decision
// of 19 October). The operator, and an open door, receive every event as it is made; anyone else receives each event
// through readerView, which keeps every output the page shows and gives it the operator's names:
// - the inspector's name is its mark ("Inspector A", server/verdict.js), on the card, on the entry's own line as it
//   streams, and wherever the name appears in the thinking's summary and the research steps;
// - each research step's tool is a plain word (search, open, find, read, transcript), with its question and address;
// - the model and its effort are a depth ("LLR · depth V" on the page), never a model's name;
// - a provider's own words for a failure or a wait keep their sense, with model ids, companies, hosts and accounts named
//   no more.
// Fields no page shows are not sent: where a verdict was read, the request's own settings, the key's minute figures.
//
// The view is applied where the job records each event (server/jobs.js), so a page that comes back after a cut connection,
// or reads a finished run again, receives exactly what it would have received.
import { inspectorMark, maskEntry, maskName, NameMasker } from './verdict.js';
import { verbOf } from './tools/request.js';

const pick = (ev, keys) => {
  const out = {};
  for (const k of keys) if (ev[k] !== undefined) out[k] = ev[k];
  return out;
};

// How hard the model was asked to think, as a depth: the operator's names for the efforts (the page writes "depth V").
const DEPTH = { none: 1, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

// The names in a provider's words that would say whose services do the work: model ids first (they hold the companies'
// names), then hosts, then the companies, then accounts.
const MODEL_IDS = /\b(?:accounts\/[\w-]+\/models\/[\w.-]+|(?:gpt|chatgpt|o\d|deepseek|gemini|claude|kimi|llama|qwen|mistral)-[\w.-]+)\b/gi;
const HOSTS = /\b(?:[a-z0-9-]+\.)*(?:openai\.com|deepseek\.com|googleapis\.com|google\.com|fireworks\.ai|exa\.ai|supadata\.ai)\b/gi;
const COMPANIES = /\b(?:OpenAI|DeepSeek|Gemini|Google|Fireworks|Exa|Supadata)\b/gi;
const ACCOUNTS = /\s*\b(?:in\s+)?organi[sz]ation\s+org-[A-Za-z0-9]+|\s*\borg-[A-Za-z0-9]{6,}\b/gi;

/** A provider's words, with what would name the services replaced and their sense kept. */
export function maskProviders(text) {
  return String(text ?? '').replace(ACCOUNTS, '').replace(MODEL_IDS, 'LLR').replace(HOSTS, 'the model service')
    .replace(COMPANIES, 'the model service').replace(/[ \t]{2,}/g, ' ').trim();
}

/** A failure as a reader receives it: its code and its words, with the services' names replaced. */
export function readerError(ev) {
  const raw = String(ev?.code || 'failed');
  return {
    t: 'error', ...(ev?.i !== undefined ? { i: ev.i } : {}),
    code: /openai|deepseek|gemini|google|fireworks|exa|supadata/i.test(raw) ? 'failed' : raw,
    message: maskProviders(ev?.message || ''),
    ...(Number.isInteger(ev?.status) ? { status: ev.status } : {}),
    ...(ev?.extra && typeof ev.extra === 'object' ? ev.extra : {}),
  };
}

/** A research step as a reader receives it: what it did, in a plain word, what it asked and where it went; never the tool. */
function readerStep(step, name) {
  if (!step || typeof step !== 'object') return null;
  const out = { verb: step.verb || verbOf(step) };
  if (step.query) out.query = maskName(step.query, name);
  if (step.url) out.url = step.url;
  if (step.pattern) out.pattern = maskName(step.pattern, name);
  if (step.status) out.status = step.status;
  if (step.error) out.error = maskProviders(step.error);
  return out;
}

/** The listing's ranking as a reader receives it: the summary, the order and the headline; not why it failed or what ran it. */
function readerRanking(r) {
  if (!r || typeof r !== 'object') return r;
  return {
    ...pick(r, ['ok', 'summary', 'order', 'keep', 'ranked', 'notEmpirical', 'missing', 'duplicate']),
    ...(r.headline ? { headline: pick(r.headline, ['text', 'kind', 'tested']) } : {}),
  };
}

/**
 * A reader's view of one job: a function from each event the job makes to what the reader receives of it (an event, a
 * list of events, or nothing). It keeps each claim's entry as it streams, so the inspector's line is the mark before any
 * of it is sent. A claim's thinking and its steps' details arrive with the finished claim, once the inspector's name is
 * known; the card shows them there, as it always has, and counts the steps as they happen.
 */
export function readerView() {
  const maskers = new Map();
  const thinking = new Set();
  const masker = (i) => { if (!maskers.has(i)) maskers.set(i, new NameMasker()); return maskers.get(i); };

  return (ev) => {
    if (!ev || typeof ev !== 'object') return null;
    switch (ev.t) {
      case 'pricing': case 'quote': case 'claim': case 'progress': case 'summary': case 'source': case 'batch-progress': case 'complete':
        return ev;
      case 'start':
        if (ev.i !== undefined) { maskers.set(ev.i, new NameMasker()); thinking.delete(ev.i); }   // a claim starting again starts its entry again
        return pick(ev, ['t', 'i', 'at', 'rank']);
      case 'batch-start':
        return pick(ev, ['t', 'total', 'at']);
      case 'delta': {
        const text = masker(ev.i).push(ev.text || '');
        return text ? { t: 'delta', i: ev.i, text } : null;
      }
      case 'reasoning':
        // The listing's thinking as it comes (it names no inspector); a claim's, with the finished claim.
        if (ev.i === undefined) return { t: 'reasoning', text: ev.text || '' };
        if (thinking.has(ev.i)) return null;
        thinking.add(ev.i);
        return { t: 'phase', i: ev.i, phase: 'inspecting' };
      case 'phase':
        if (ev.phase === 'incomplete') return pick(ev, ['t', 'i', 'phase', 'reason']);
        if (ev.phase === 'queued') return pick(ev, ['t', 'i', 'phase', 'waitMs', 'position']);
        return pick(ev, ['t', 'i', 'phase', 'searches', 'claims']);
      case 'trail':
        // A claim's step is counted as it happens; what it asked comes with the finished claim, its inspector's name made
        // the mark. The listing's steps name no inspector.
        return { ...pick(ev, ['t', 'i', 'searches']), step: ev.i === undefined ? readerStep(ev.step, null) : { verb: ev.step?.verb || verbOf(ev.step) } };
      case 'note':
        return pick(ev, ['t', 'i', 'code']);
      case 'retry': case 'rank-retry':
        return {
          ...pick(ev, ['t', 'i', 'attempt', 'status', 'reason', 'waitMs', 'code', 'since', 'at', 'until']),
          ...(ev.why ? { why: maskProviders(ev.why) } : {}), ...(ev.who ? { who: maskProviders(ev.who) } : {}),
        };
      case 'warning':
        if (ev.code === 'model_fallback') return { t: 'warning', ...pick(ev, ['i']), code: 'fallback' };
        if (ev.code === 'source_truncated') return pick(ev, ['t', 'code', 'omitted', 'read', 'original']);
        return null;
      case 'done':
        if (ev.i === undefined) {
          return {
            ...pick(ev, ['t', 'total', 'limit', 'claims', 'raw', 'reasoning', 'ms']),
            trail: (ev.trail || []).map((s) => readerStep(s, null)),
            incomplete: ev.incomplete || null,
            ...(ev.ranking !== undefined ? { ranking: readerRanking(ev.ranking) } : {}),
          };
        } else {
          const rest = maskers.get(ev.i)?.flush() || '';
          maskers.delete(ev.i);
          const name = ev.inspector || null;
          const done = {
            ...pick(ev, ['t', 'i', 'verdict', 'confidence', 'sources', 'searches', 'ms']),
            inspectorMark: name ? inspectorMark(name) : null,
            conclusion: ev.conclusion ? maskName(ev.conclusion, name) : ev.conclusion ?? null,
            text: maskEntry(ev.text || ''),
            reasoning: ev.reasoning ? maskName(ev.reasoning, name) : null,
            trail: (ev.trail || []).map((s) => readerStep(s, name)),
            depth: DEPTH[ev.effort] ?? null,
            fellBack: ev.fellBack ? { standby: true } : null,
            incomplete: ev.incomplete || null,
          };
          return rest ? [{ t: 'delta', i: ev.i, text: rest }, done] : done;
        }
      case 'error':
        return readerError(ev);
      default:
        return null;   // the key's minute figures, and anything new: the operator's until it is listed here
    }
  };
}
