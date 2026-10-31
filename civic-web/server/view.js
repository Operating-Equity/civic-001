// What a reader receives of a run: all of its work and its results, under the operator's names (the operator's decision
// of 19 October). The operator, and an open door, receive every event as it is made; anyone else receives each event
// through readerView, which keeps every output the page shows and gives it the operator's names:
// - the inspector's name is its mark ("Inspector B" for an Albert, server/verdict.js) wherever it stands for the
//   inspector: on the card, in the entry, in the thinking's summary and the research steps (31 October). The entry
//   comes whole with the finished claim; as it is written, a reader receives only how much there is of it;
// - each research step's tool is a plain word (search, open, find, read, transcript), with its question and address;
// - the model is "LLR" on the page, with no name and no level (31 October: "The users do not care what level the model
//   is run at. They care about the answers.");
// - a provider's own words for a failure or a wait keep their sense, with model ids, companies, hosts and accounts named
//   no more.
// Fields no page shows are not sent: where a verdict was read, the request's own settings, the key's minute figures.
// Nor is what is the operator's alone: which sources and steps are of a site the operator keeps out of the research, and
// how many a fact-check took from that list (server/sites.js), so the list is never a tell.
//
// The view is applied where the job records each event (server/jobs.js), so a page that comes back after a cut connection,
// or reads a finished run again, receives exactly what it would have received.
import { inspectorMark, keptWords, maskEntry, maskName } from './verdict.js';
import { verbOf } from './tools/request.js';

const pick = (ev, keys) => {
  const out = {};
  for (const k of keys) if (ev[k] !== undefined) out[k] = ev[k];
  return out;
};

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

/** A cited source as a reader receives it: its address and title, and nothing the operator's card adds to it. */
const readerSource = (s) => (s && typeof s === 'object' ? pick(s, ['url', 'title']) : s);

/** A research step as a reader receives it: what it did, in a plain word, what it asked and where it went; never the tool. */
function readerStep(step, name, keep = '') {
  if (!step || typeof step !== 'object') return null;
  const out = { verb: step.verb || verbOf(step) };
  if (step.query) out.query = maskName(step.query, name, keep);
  if (step.url) out.url = step.url;
  if (step.pattern) out.pattern = maskName(step.pattern, name, keep);
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
 * list of events, or nothing). As a claim's entry is written, a reader receives only how much of it there is (the card's
 * bar); the entry itself, its thinking and its steps' details arrive with the finished claim, the inspector's name made
 * the mark wherever it stands for the inspector, but in the words the reader gave (`keep`: the claims and the document).
 */
export function readerView({ keep = [] } = {}) {
  // Read when a claim finishes, once for the run, so a long document is read once and not for every text masked.
  let read = null;
  const keptOf = () => (read ??= keptWords((Array.isArray(keep) ? keep : [keep]).filter(Boolean).join('\n')));
  const thinking = new Set();

  return (ev) => {
    if (!ev || typeof ev !== 'object') return null;
    switch (ev.t) {
      case 'pricing': case 'quote': case 'claim': case 'progress': case 'summary': case 'batch-progress': case 'complete':
        return ev;
      case 'source':
        return { ...ev, source: readerSource(ev.source) };
      case 'start':
        if (ev.i !== undefined) thinking.delete(ev.i);   // a claim starting again starts its entry again
        return pick(ev, ['t', 'i', 'at', 'rank']);
      case 'batch-start':
        return pick(ev, ['t', 'total', 'at']);
      case 'delta': {
        const n = String(ev.text || '').length;
        return n ? { t: 'delta', i: ev.i, n } : null;
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
          const name = ev.inspector || null;
          const kept = keptOf();
          return {
            ...pick(ev, ['t', 'i', 'verdict', 'confidence', 'searches', 'ms']),
            ...(Array.isArray(ev.sources) ? { sources: ev.sources.map(readerSource) } : {}),
            inspectorMark: name ? inspectorMark(name) : null,
            conclusion: ev.conclusion ? maskName(ev.conclusion, name, kept) : ev.conclusion ?? null,
            text: maskEntry(ev.text || '', { name, keep: kept }),
            reasoning: ev.reasoning ? maskName(ev.reasoning, name, kept) : null,
            trail: (ev.trail || []).map((s) => readerStep(s, name, kept)),
            fellBack: ev.fellBack ? { standby: true } : null,
            incomplete: ev.incomplete || null,
          };
        }
      case 'error':
        return readerError(ev);
      default:
        return null;   // the key's minute figures, and anything new: the operator's until it is listed here
    }
  };
}
