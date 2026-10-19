// What a reader receives of a run: their own run's work and its results (the operator's decision of 19 October). The
// operator, and an open door, receive every event as it is made; anyone else receives each event through readerView,
// field by field, from a list of what the page needs. An event or a field not on the list is the operator's, whatever it
// is: the model's thinking, which model and at what effort, which tool did a step and what it was asked, where a verdict
// was read, the listing's raw output, a provider's own words for a failure.
//
// The view is applied where the job records each event (server/jobs.js), so a page that comes back after a cut connection,
// or reads a finished run again, receives exactly what it would have received: never more.
//
// The inspector is a mark for a reader ("Inspector A", server/verdict.js), on the card and on the entry's own line as it
// streams; the rest of the entry is the model's, unchanged. The work shows as a work log: what each step did, in a plain
// word, counted.
import { config } from './config.js';
import { inspectorMark, maskEntry, NameMasker } from './verdict.js';
import { verbOf } from './tools/request.js';

const pick = (ev, keys) => {
  const out = {};
  for (const k of keys) if (ev[k] !== undefined) out[k] = ev[k];
  return out;
};

// A failure's own words reach a reader only when they are FactEngine's: its refusals, in sentences written for the page.
// Any other failure is said by its code alone, which the page turns into its own sentence; a code the page has no
// sentence for is 'failed'. The provider's words go to the operator and to /check, never to a reader.
const OWN_WORDS = new Set(['source_too_long', 'too_short', 'no_claims', 'too_many_claims', 'books_wait', 'run_required',
  'not_your_job', 'credit_short', 'month_limit', 'already_tested', 'signin_required']);
const PAGE_CODES = new Set([...OWN_WORDS, 'prompt_missing', 'invalid_key', 'missing_key', 'balance_exhausted', 'key_not_sendable',
  'no_operator_key', 'rate_limited', 'quota_exhausted', 'stream_ended']);

/** A failure as a reader receives it: FactEngine's own words, or the code alone. */
export function readerError(ev) {
  const code = PAGE_CODES.has(ev?.code) ? ev.code : 'failed';
  return {
    t: 'error', ...(ev?.i !== undefined ? { i: ev.i } : {}), code,
    message: OWN_WORDS.has(code) ? String(ev?.message || '') : '',
    ...(Number.isInteger(ev?.status) ? { status: ev.status } : {}),
    ...(ev?.extra && typeof ev.extra === 'object' ? ev.extra : {}),
  };
}

/** A step of the research as a reader sees it: what it did, in a plain word; what it was asked only when the operator lets readers see that. */
function readerStep(step, queries) {
  if (!step || typeof step !== 'object') return null;
  return { verb: step.verb || verbOf(step), ...(queries && step.query ? { query: step.query } : {}), ...(queries && step.url ? { url: step.url } : {}) };
}

/** The listing's ranking as a reader sees it: the order and the headline; never why it failed or what ran it. */
function readerRanking(r) {
  if (!r || typeof r !== 'object') return r;
  return {
    ...pick(r, ['ok', 'summary', 'order', 'keep', 'ranked', 'notEmpirical', 'missing', 'duplicate']),
    ...(r.headline ? { headline: pick(r.headline, ['text', 'kind', 'tested']) } : {}),
  };
}

/**
 * A reader's view of one job: a function from each event the job makes to what the reader receives of it (an event, a
 * list of events, or nothing). It keeps what it needs between events: each claim's entry as it streams, so the
 * inspector's name is made the mark before any of it is sent.
 */
export function readerView({ queries = config.readerQueries } = {}) {
  const maskers = new Map();
  const thinking = new Set();
  const masker = (i) => { if (!maskers.has(i)) maskers.set(i, new NameMasker()); return maskers.get(i); };
  const step = (s) => readerStep(s, queries);

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
        // The thinking is the operator's; the reader is told the inspection is under way, once.
        if (ev.i === undefined || thinking.has(ev.i)) return null;
        thinking.add(ev.i);
        return { t: 'phase', i: ev.i, phase: 'inspecting' };
      case 'phase':
        if (ev.phase === 'incomplete') return pick(ev, ['t', 'i', 'phase']);
        if (ev.phase === 'queued') return pick(ev, ['t', 'i', 'phase', 'waitMs', 'position']);
        return pick(ev, ['t', 'i', 'phase', 'searches', 'claims']);
      case 'trail':
        return { ...pick(ev, ['t', 'i', 'searches']), step: step(ev.step) };
      case 'retry': case 'rank-retry':
        return pick(ev, ['t', 'i', 'attempt', 'status', 'reason', 'waitMs', 'code', 'since', 'at']);
      case 'warning':
        if (ev.code === 'model_fallback') return { t: 'warning', ...pick(ev, ['i']), code: 'fallback' };
        if (ev.code === 'source_truncated') return pick(ev, ['t', 'code', 'omitted', 'read', 'original']);
        return null;
      case 'done':
        if (ev.i === undefined) {
          return {
            ...pick(ev, ['t', 'total', 'limit', 'claims', 'ms']),
            incomplete: ev.incomplete ? true : null,
            ...(ev.ranking !== undefined ? { ranking: readerRanking(ev.ranking) } : {}),
          };
        } else {
          const rest = maskers.get(ev.i)?.flush() || '';
          maskers.delete(ev.i);
          const done = {
            ...pick(ev, ['t', 'i', 'verdict', 'confidence', 'conclusion', 'sources', 'searches', 'ms']),
            inspectorMark: ev.inspector ? inspectorMark(ev.inspector) : null,
            text: maskEntry(ev.text || ''),
            trail: (ev.trail || []).map(step),
            incomplete: ev.incomplete ? true : null,
          };
          return rest ? [{ t: 'delta', i: ev.i, text: rest }, done] : done;
        }
      case 'error':
        return readerError(ev);
      default:
        return null;   // gate figures, notes, and anything new: the operator's until it is listed here
    }
  };
}
