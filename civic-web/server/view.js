// What a reader receives of a run: every output the operator's prompts write, under the operator's names (the operator's
// decision of 19 October), and nothing of the work behind it (1 November). The operator, and an open door, receive every
// event as it is made; anyone else receives each event through readerView:
// - every output, whole: the listing's claims; for each claim, the entry, its verdict, its confidence, its conclusion and
//   the sources it cites (1 November: "Sources cited in reading the article should remain");
// - the inspector's name is its mark ("Inspector B" for an Albert, server/verdict.js) wherever it stands for the
//   inspector: on the card, in the entry and in its conclusion (31 October). An entry that writes the operator's class
//   for the name is read by it (31 October, evening), and no span's markup reaches a reader. The entry comes whole with
//   the finished claim; as it is written, a reader receives only how much there is of it;
// - the work behind the outputs is the operator's alone (31 October: "We are not going to have the boxes on the user
//   interface that allow people to see how the system is running underneath"; 1 November: "the actual processes that
//   are at the very end"): no thinking summary, no research step's question or address, no listing as the model wrote
//   it, and no note about any of them. A claim's steps are counted as they happen, a plain word each, for its progress
//   and its card's counts;
// - the model is "LLR" on the page, with no name and no level (31 October: "The users do not care what level the model
//   is run at. They care about the answers.");
// - nothing of what FactEngine works around on its way (31 October, night: "it does not help you or the service to show
//   that it is struggling"): no wait, no retry, no figure of a claim's turn, and no word that a standby model answered
//   (server/standby.js); a failure is told as it is only when a reader can act on it (the document, the credit, a link),
//   and any other as one plain sentence.
// Fields no page shows are not sent: where a verdict was read, the request's own settings, the key's minute figures, the
// price's tier.
// Nor is what is the operator's alone: which sources are of a site the operator keeps out of the research, and how many a
// fact-check took from that list (server/sites.js), so the list is never a tell.
//
// The view is applied where the job records each event (server/jobs.js), so a page that comes back after a cut connection,
// or reads a finished run again, receives exactly what it would have received.
import { classForms, inspectorMark, keptWords, maskClassed, maskEntry, maskName, withoutSpans } from './verdict.js';
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

// The refusals a reader can act on (31 October, night: "Faults a reader can act on stay specific, in plain words"):
// a sign-in, the document, the credit, a link or a file, the account's own. Any other failure is FactEngine's own (a key,
// a model, a prompt, a provider, a fault) and a reader receives one plain sentence for it, whatever it was; the
// operator receives the true one, on their page and on /check.
const READER_CODES = new Set([
  'signin_required', 'cross_site', 'json_only', 'bad_body', 'too_large', 'LIMIT_FILE_SIZE', 'not_found',
  'too_short', 'no_claims', 'too_many_claims', 'source_too_long', 'no_file', 'empty_document', 'unsupported_file',
  'credit_short', 'month_limit', 'already_tested', 'not_your_job', 'books_wait',
  'email_invalid', 'email_taken', 'password_short', 'password_long', 'terms_required', 'wrong_password', 'account_closed',
  'reset_invalid', 'claim_invalid', 'tries_wait', 'signups_wait', 'no_account', 'limit_invalid', 'accounts_off',
  // buying credit (server/payments.js, 1 November)
  'payments_off', 'account_hold', 'amount_invalid', 'payment_unavailable', 'no_payment', 'card_needed', 'topup_invalid', 'agreement_changed',
]);
/** Whether a reader is told this refusal as it is: one they can act on, or a link's (every url_… code). */
export const readerCode = (code) => READER_CODES.has(String(code)) || /^url_/.test(String(code));

// The plain sentence for any other failure, by what was asked: a claim's test (the operator's words of 31 October),
// the listing, or anything else.
export const UNAVAILABLE = {
  claim: 'This claim could not be tested just now. Try again shortly.',
  listing: 'The claims could not be listed just now. Try again shortly.',
  other: 'This could not be done just now. Try again shortly.',
};

/**
 * A failure as a reader receives it: a refusal they can act on keeps its code and its words, with the services' names
 * replaced; any other is `unavailable`, with the plain sentence for what was asked (`what`: claim, listing or other).
 */
export function readerError(ev, { what = 'other' } = {}) {
  const raw = String(ev?.code || 'failed');
  const at = ev?.i !== undefined ? { i: ev.i } : {};
  if (!readerCode(raw)) return { t: 'error', ...at, code: 'unavailable', message: UNAVAILABLE[what] || UNAVAILABLE.other };
  return {
    t: 'error', ...at, code: raw,
    message: maskProviders(ev?.message || ''),
    ...(Number.isInteger(ev?.status) ? { status: ev.status } : {}),
    ...(ev?.extra && typeof ev.extra === 'object' ? ev.extra : {}),
  };
}

/** A cited source as a reader receives it: its address and title, and nothing the operator's card adds to it. */
const readerSource = (s) => (s && typeof s === 'object' ? pick(s, ['url', 'title']) : s);

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
 * bar); the entry itself arrives with the finished claim, the inspector's name made the mark wherever it stands for the
 * inspector, but in the words the reader gave (`keep`: the claims and the document).
 */
export function readerView({ keep = [], what = 'other' } = {}) {
  // Read when a claim finishes, once for the run, so a long document is read once and not for every text masked.
  let read = null;
  const keptOf = () => (read ??= keptWords((Array.isArray(keep) ? keep : [keep]).filter(Boolean).join('\n')));
  const thinking = new Set();

  return (ev) => {
    if (!ev || typeof ev !== 'object') return null;
    switch (ev.t) {
      case 'pricing': {
        // The price as the page shows it; not the tier it was read from (31 October, night).
        const { tier, ...price } = ev;
        return price;
      }
      case 'quote': case 'claim': case 'progress': case 'summary': case 'batch-progress': case 'complete':
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
        // Thinking is the work behind the outputs, the operator's alone: the listing's is not sent; a claim's first piece
        // tells the reader's card that its inspector is at work, and nothing of what it thought.
        if (ev.i === undefined) return null;
        if (thinking.has(ev.i)) return null;
        thinking.add(ev.i);
        return { t: 'phase', i: ev.i, phase: 'inspecting' };
      case 'phase':
        if (ev.phase === 'incomplete') return pick(ev, ['t', 'i', 'phase', 'reason']);
        if (ev.phase === 'queued') return pick(ev, ['t', 'i', 'phase']);   // its turn, without its figures
        return pick(ev, ['t', 'i', 'phase', 'searches', 'claims']);
      case 'trail':
        // A claim's step is counted as it happens, by its plain word (search, open, find, read, transcript), for its
        // progress and its card's counts; what it asked and where it went are the operator's. The listing's, counted alone.
        if (ev.i === undefined) return pick(ev, ['t', 'searches']);
        return { ...pick(ev, ['t', 'i', 'searches']), step: { verb: ev.step?.verb || verbOf(ev.step) } };
      case 'note':
        return null;   // a note about the work's own boxes (no thinking summary came): the operator's, with the boxes
      case 'retry': case 'rank-retry':
        return null;   // a wait or a retry is FactEngine's to work around, never the reader's to watch
      case 'warning':
        if (ev.code === 'source_truncated') return pick(ev, ['t', 'code', 'omitted', 'read', 'original']);
        return null;   // a standby model's answer among them: the reader is not told (31 October, night)
      case 'done':
        if (ev.i === undefined) {
          // The listing's claims, its time and its ranking; not the listing as the model wrote it, its thinking or its steps.
          return {
            ...pick(ev, ['t', 'total', 'limit', 'claims', 'ms']),
            incomplete: ev.incomplete || null,
            ...(ev.ranking !== undefined ? { ranking: readerRanking(ev.ranking) } : {}),
          };
        } else {
          const name = ev.inspector || null;
          const kept = keptOf();
          // The conclusion is the entry's own words: read by the class when the entry writes it (31 October, evening).
          const classed = classForms(ev.text || '').length > 0;
          const concluded = (x) => withoutSpans(classed ? maskClassed(x, name, kept) : maskName(x, name, kept));
          return {
            ...pick(ev, ['t', 'i', 'verdict', 'confidence', 'searches', 'ms']),
            ...(Array.isArray(ev.sources) ? { sources: ev.sources.map(readerSource) } : {}),
            inspectorMark: name ? inspectorMark(name) : null,
            conclusion: ev.conclusion ? concluded(ev.conclusion) : ev.conclusion ?? null,
            text: maskEntry(ev.text || '', { name, keep: kept }),
            incomplete: ev.incomplete || null,
          };
        }
      case 'error':
        // A claim's failure is said as the claim's; the run's, as what the run was (the listing, or the claims' tests).
        return readerError(ev, { what: ev.i !== undefined ? 'claim' : what });
      default:
        return null;   // the key's minute figures, and anything new: the operator's until it is listed here
    }
  };
}
