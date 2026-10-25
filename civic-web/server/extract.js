// Step 1 — empirical claim extraction, streamed. Claims are parsed out of the numbered
// list as it arrives so the browser can show them one by one.
import { config } from './config.js';
import { extractionRequest, extractionShape } from './prompts.js';
import { sourceBlock, headlineBlock } from './source.js';
import { withModelFallback, usageOf, isRetryable, isRateLimit, isConnectionDrop, connectionWait, rateLimitWaitMs, sleep, throughGate, streamFailure, asStreamFailure, spacedWaitMs, cutReply } from './openai.js';
import { onDeepSeek, onFireworks, onOwnProvider, listingClient, listingFailure, listingHost, listingProviderName, openaiHost } from './listing.js';
import { ThoughtCut, usageFrom, noteEcho } from './fireworks.js';
import { noteFailure, noteReply } from './reach.js';
import { gateFor, parseRefusal } from './gate.js';
import { estimateTextCost } from './pricing.js';
import { toolStep, searchCount, verbOf } from './tools/request.js';
import { names, anyOf } from './names.js';
import { record, spentWords } from './ledger.js';
import { runRanking } from './rank.js';

/**
 * Parses "1. claim\n2. claim" incrementally. Returns the claims completed so far. A number written in bold or after a
 * Markdown heading mark ("**1.**", "### 1.") is the number all the same.
 */
export function parseNumberedList(text) {
  const items = [];
  const re = /(?:^|\n)\s*(?:#{1,6}[ \t]*)?[*_]{0,2}(\d{1,3})[.)\]:][*_]{0,2}\s+/g;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) {
    if (last) items.push({ n: last.n, text: text.slice(last.end, match.index) });
    last = { n: Number(match[1]), end: match.index + match[0].length };
  }
  if (last) items.push({ n: last.n, text: text.slice(last.end), open: true });
  return items.map((it) => ({ n: it.n, text: cleanClaim(it.text), open: !!it.open }));
}

// The claim is the model's wording. Only the surrounding whitespace is removed.
function cleanClaim(s) {
  return String(s).trim();
}

// A line's lead-in before its label: any indent, then a bullet, then bold.
const LEAD = '[ \\t]*(?:[-*•+][ \\t]+)?[*_]*';
// The claim's label at the start of a line: the operator's word (server/names.js), "Claim" unless set.
const CLAIM_LINE = new RegExp(`(?:^|\\n)${LEAD}(?:${anyOf(names.claim)})[*_]*:[*_]*[ \\t]*`, 'iu');
// A further labelled line: a label of up to four words, joined by spaces, slashes or hyphens, then its colon.
const LABEL_LINE = /\n[ \t]*(?:[-*•+][ \t]+)?[*_]*\p{Lu}\p{L}*(?:[ /-]\p{L}+){0,3}[*_]*:[*_]*(?=\s)/u;
// One of the listing's own fields (server/names.js), on its own line or on the claim's line, bold or plain: DeepSeek
// wrote "Claim: … **Role:** Supporting. **Source anchor:** …" on one line (24 October). The labels are read as written.
const FIELD = new RegExp(`(?:^|\\s)(?:[-*•+][ \\t]+)?[*_]*(?:${anyOf([...names.role, ...names.fields])})[*_]*:`, 'u');
// Where the claim ends in what follows its label: at the first further field, wherever it is written.
const claimEnd = (rest) => {
  const field = FIELD.exec(rest);
  const ends = [rest.search(LABEL_LINE), field ? field.index + field[0].search(/\S/) : -1].filter((i) => i >= 0);
  return ends.length ? Math.min(...ends) : -1;
};

/**
 * An entry may be written as labelled fields: the claim under a "Claim:" label, then further
 * fields, such as its role, who said it and when, or what the source does not say, each on its
 * own line or on the claim's line. The claim is what comes before the first of them, and the
 * claim alone is shown and tested (24 October: "I don't want the extraction to affect downstream
 * processing in any way"); the further fields are kept, verbatim, for the role and the raw output.
 * Without the label, the claim is what comes before the first field; an entry with none is the
 * claim, whole.
 */
export function splitEntry(entry) {
  const head = entry.match(CLAIM_LINE);
  if (!head) {
    const next = claimEnd(entry);
    return next < 0 ? { text: entry, more: '' } : { text: entry.slice(0, next).trim(), more: entry.slice(next).trim() };
  }
  const before = entry.slice(0, head.index).trim();   // lines written ahead of the claim's own, kept with the rest
  const rest = entry.slice(head.index + head[0].length);
  const next = claimEnd(rest);
  const text = (next < 0 ? rest : rest.slice(0, next)).trim();
  return { text, more: [before, next < 0 ? '' : rest.slice(next).trim()].filter(Boolean).join('\n') };
}

/**
 * The claim alone, from what a page sends to be tested (24 October, night): a copy of the page loaded before the claim
 * alone was shown sends each claim's whole entry, its fields with it. Anything carrying the claim's label at its start, a
 * further labelled line or one of the listing's fields is an entry, read as the listing reads it; anything else is a
 * claim already, the listing's own, and is taken exactly as sent.
 */
export function claimAlone(sent) {
  const s = String(sent ?? '').trim();
  const entry = CLAIM_LINE.exec(s)?.index === 0 || LABEL_LINE.test(s) || FIELD.test(s);
  return entry ? splitEntry(s).text : s;
}

// A claim's role (24 October): the words after its role label, on its own line or on the claim's, read against the
// operator's role words (server/names.js) whatever their capitals or bold, the longest first, so a longer word is never
// read as a shorter one.
const ROLE_LINE = new RegExp(`(?:^|\\s)(?:[-*•+][ \\t]+)?[*_]*(?:${anyOf(names.role)})[*_]*:[*_]*[ \\t]*([^\\n]*)`, 'u');
const ROLE_WORDS = Object.entries(names.roles).flatMap(([role, list]) => list.map((w) => ({ role, w })))
  .sort((a, b) => b.w.length - a.w.length)
  .map(({ role, w }) => ({ role, re: new RegExp(`^(?:${anyOf([w])})(?![\\p{L}\\p{N}])`, 'iu') }));

/** The role an entry gives its claim: central, supporting, incidental or unranked; null when it gives none of them. */
export function roleOf(entry) {
  const m = String(entry ?? '').match(ROLE_LINE);
  if (!m) return null;
  const value = m[1].replace(/^[\s*_`"'“‘]+/, '');
  return ROLE_WORDS.find((r) => r.re.test(value))?.role ?? null;
}

/** Whether an entry carries its claim under the claim label: the log line counts them, so a format kept is seen. */
export const labelled = (entry) => CLAIM_LINE.test(String(entry ?? ''));

// The entries' counts for the log line: how many the listing wrote, how many under their claim label, and their roles.
function entryWords(read) {
  const count = (role) => read.filter((r) => r.role === role).length;
  const roles = [['central', 'central'], ['supporting', 'supporting'], ['unranked', 'unranked'], ['incidental', 'incidental (not offered)']]
    .map(([role, word]) => [count(role), word]).filter(([k]) => k > 0).map(([k, word]) => `${k} ${word}`);
  const none = count(null);
  const n = read.length;
  return ` · ${n} ${n === 1 ? 'entry' : 'entries'}, ${read.filter((r) => r.labelled).length} under their claim label; ${roles.length ? `roles: ${roles.join(', ')}${none ? `, ${none} without one` : ''}` : 'no role lines'}`;
}

export async function runExtraction({ apiKey, text, meta, send, signal, sourceWarning, ctx = {}, rank = false }) {
  // The listing's provider: OpenAI as before, or DeepSeek's own service (CIVIC_EXTRACT_PROVIDER=deepseek; 4 October),
  // or the same model on Fireworks (fireworks; 5 October). apiKey is that provider's key (listingKey, listing.js).
  const deepseek = onDeepSeek();
  const fireworks = onFireworks();
  const own = onOwnProvider();   // not OpenAI: not through OpenAI's gate, and its waits name its own provider
  const client = listingClient(apiKey);
  // A prompt with a slot for the source asked for what is known of its origin too, so the source
  // goes in with what CIVIC knows of that. A prompt without a slot gets the text with its headline ahead of it, or
  // "(none given)" (the operator's answer of 24 October): the text read from a link holds no headline of its own.
  const request = extractionRequest(extractionShape() === 'inserted' ? sourceBlock(text, meta) : headlineBlock(text, meta));
  let full = '';
  let emitted = 0;   // the entries read so far
  let offered = [];   // the claims sent to the page, in the listing's order
  let read = [];   // each entry read: its role, and whether it had its claim label (the log line's counts)
  const started = Date.now();
  // Each entry is read once, when the next number closes it. An Incidental claim is not offered for testing, so it is
  // never sent to the page or counted there (the operator's answers of 24 October: "not important enough to test", and
  // not erased: the raw output keeps it); a Supporting one waits behind "Show the other claims" (`top: false`). Only the
  // claim leaves the listing (24 October, night): its number, its text and whether it is shown first. Its entry's fields
  // stay here, for its role and the counts, and in the raw output; a copy of the page from before the claim alone was
  // shown drew them under the claim and sent them to the fact-check.
  const readEntry = (item) => {
    const entry = item.text;
    if (!entry) return;
    const role = roleOf(entry);
    read.push({ role, labelled: labelled(entry) });
    if (role === 'incidental') return;
    const { text: claimText } = splitEntry(entry);
    if (!claimText) return;
    const claim = { n: offered.length + 1, text: claimText, top: role !== 'supporting' };
    offered.push(claim);
    send({ t: 'claim', ...claim });
  };

  let wantSummary = Boolean(config.extractSummary);
  let reasoning = '';
  let reasoningEcho;   // Fireworks' own echo of the reasoning it was asked for (response.created), for /check
  const trail = []; // every web action the model took during extraction, if any
  const attempt = async (model) => {
    if (fireworks) {
      // Fireworks: the model, the prompt verbatim, the effort and `store: false`, without which Fireworks keeps the
      // conversation for 30 days. Nothing else, and no tool: the listing reads the document it is given and nothing
      // else (24 October). Not through OpenAI's gate: a 429 is a wait, below.
      const body = {
        model,
        ...(request.instructions ? { instructions: request.instructions } : {}),
        input: [{ role: 'user', content: [{ type: 'input_text', text: request.message }] }],
        reasoning: { effort: config.extractEffort },
        stream: true,
        store: false,
      };
      const { data, response } = await client.responses.create(body, { signal }).withResponse();
      noteReply('Fireworks');
      return { data, response, release: () => {} };
    }
    if (deepseek) {
      // DeepSeek: the model, the prompt verbatim and the effort, and nothing else. DeepSeek has no mode, makes no
      // summary and keeps nothing (so no `store`). Its Responses API ignores `web_search` and every other built-in
      // tool, silently (its own guide, read 14 October), so none is sent: the listing reads the document it is given.
      // Not through the gate: DeepSeek sends no per-minute figures to pace by, and its own limit (2,500 requests in
      // flight) answers with a 429, which is a wait below.
      const body = {
        model,
        ...(request.instructions ? { instructions: request.instructions } : {}),
        input: [{ role: 'user', content: [{ type: 'input_text', text: request.message }] }],
        reasoning: { effort: config.extractEffort },
        stream: true,
      };
      const { data, response } = await client.responses.create(body, { signal }).withResponse();
      noteReply('DeepSeek');
      return { data, response, release: () => {} };
    }
    // The operator's configuration and nothing else. `npm run verify` fails if any other key appears.
    const r = { effort: config.extractEffort };
    if (config.extractReasoningMode) r.mode = config.extractReasoningMode; // pro: more model work per answer, at the same rates
    if (wantSummary) r.summary = config.extractSummary;
    const body = {
      model,
      // The prompt verbatim: as the only message with the source in its place, or as the
      // instructions with the source as the only message. The prompt's own shape decides.
      ...(request.instructions ? { instructions: request.instructions } : {}),
      input: [{ role: 'user', content: [{ type: 'input_text', text: request.message }] }],
      reasoning: r,
      // No tool: the listing reads the document it is given and nothing else (24 October). Web
      // search and FactEngine's own tools are the fact-checks'.
      stream: true,
      store: false,
    };
    return throughGate(client, body, { kind: 'extraction', owner: ctx.owner || ctx.runId || null, signal, onHold: (h) => send({ t: 'phase', phase: 'queued', ...h }) });
  };

  let usage = null;
  let modelUsed = null;
  let incomplete = null;
  let fellBack = null;
  let pricedAt = null;   // the start of the go that succeeded: DeepSeek's price depends on the hour
  let firstTextAt = null;   // when that go's first word arrived: before it, the model was thinking (the log line below)
  let goes = 0;
  if (sourceWarning) send({ t: 'warning', ...sourceWarning });
  for (let tries = 0; ; tries++) {
    const attemptAt = Date.now();
    goes++;
    try {
      full = '';
      emitted = 0;
      offered = [];
      read = [];
      firstTextAt = null;
      await withModelFallback('extract', config.extractModels, async (model) => {
        const { data: stream, release } = await attempt(model);
        modelUsed = model;
        pricedAt = attemptAt;
        // `rank`: the claims will be ranked before they are shown (server/rank.js), so the page holds them back and counts.
        send({ t: 'start', model, requested: config.extractModels[0], at: started, ...(rank ? { rank: true } : {}) });
        let ended = false;   // completed, incomplete or failed: the reply's own last word
        // On Fireworks the model's chain of thought comes inside the answer's text; the cut hands on the answer alone.
        const cut = fireworks ? new ThoughtCut() : null;
        const take = (piece) => {
          if (!piece) return;
          firstTextAt ??= Date.now();
          full += piece;
          const items = parseNumberedList(full);
          // Each claim is read once it is closed by the next number.
          while (emitted < items.length - 1) readEntry(items[emitted++]);
          send({ t: 'progress', chars: full.length, found: offered.length });
        };
        try {
        for await (const event of stream) {
          if (signal.aborted) return;
          if (event.type === 'response.output_text.delta') {
            take(cut ? cut.feed(event.item_id, event.delta) : event.delta);
          } else if (cut && event.type === 'response.output_item.added') {
            cut.begin(event.item);
          } else if (cut && event.type === 'response.output_item.done' && event.item?.type === 'message') {
            take(cut.end(event.item.id));
          } else if (cut && event.type === 'response.created') {
            reasoningEcho = event.response?.reasoning ?? null;
            noteEcho(reasoningEcho);
          } else if (cut && /reasoning/.test(String(event.type))) {
            // Fireworks' reasoning sent apart, in whatever form: neither sent nor kept.
          } else if (event.type === 'response.reasoning_summary_text.delta') {
            // The model's own summary of its reasoning (OpenAI). A raw chain of thought
            // (`response.reasoning_text.delta`, which is what DeepSeek streams) is neither sent nor kept: it
            // restates the prompt's instructions in the model's words, and stays off the page (the operator's
            // answer of 4 October).
            reasoning += event.delta || '';
            send({ t: 'reasoning', text: event.delta || '' });
          } else if (event.type === 'response.reasoning_summary_part.done') {
            reasoning += '\n\n';
          } else if (event.type === 'response.output_item.done' && event.item?.type === 'web_search_call') {
            const a = event.item.action || {};
            const step = { kind: a.type || 'search', verb: verbOf({ kind: a.type || 'search' }), query: a.query || null, url: a.url || null, pattern: a.pattern || null, status: event.item.status };
            trail.push(step);
            send({ t: 'trail', step, searches: searchCount(trail) });
          } else if (event.type === 'response.output_item.done' && event.item?.type === 'mcp_call') {
            const step = toolStep(event.item); // one of CIVIC's tools, called inside the response
            trail.push(step);
            send({ t: 'trail', step, searches: searchCount(trail) });
          } else if (event.type === 'response.completed') {
            ended = true;
            if (cut) take(cut.finish());
            usage = cut ? usageFrom(event.response) : usageOf(event.response);
          } else if (event.type === 'response.incomplete') {
            ended = true;
            if (cut) take(cut.finish());
            usage = cut ? usageFrom(event.response) : usageOf(event.response);
            incomplete = event.response?.incomplete_details?.reason || 'incomplete';
            send({ t: 'phase', phase: 'incomplete', reason: incomplete });
          } else if (event.type === 'response.failed' || event.type === 'error') {
            throw streamFailure(event, 'extraction failed');
          }
        }
        // A reply that stops without its last word was cut, however politely: DeepSeek closes a request that
        // has not started inside ten minutes. It goes again; it is never a listing of no claims (and what the
        // cut was holding goes with it: the next go starts its own).
        if (!ended && !signal.aborted) throw cutReply();
        } finally {
          release();
        }
      }, (f) => { fellBack = f; send({ t: 'warning', code: 'model_fallback', ...f }); });
      break;
    } catch (caught) {
      if (signal.aborted) return null;
      // An `error` event in the middle of a stream reaches here from the SDK with no status: it is read as
      // the stream's own failure, so a rate limit there is a wait and an overload a retry.
      const err = asStreamFailure(caught, 'extraction failed');
      if (wantSummary && err?.status === 400 && /summar/i.test(String(err?.error?.message || err?.message || ''))) {
        wantSummary = false;
        send({ t: 'note', code: 'no_reasoning_summary' });
        continue;
      }
      if (isRateLimit(err)) {
        // A refusal inside the streamed reply, as in evaluate.js: OpenAI's figures go to the gate,
        // the extraction waits exactly what OpenAI asked, and goes again, whole.
        const refusal = parseRefusal(err);
        if (!own) gateFor(modelUsed || config.extractModels[0]).refusedInStream('extraction', refusal);
        // A refusal that names no wait (DeepSeek's never do; Fireworks' may) goes again a second after this go
        // began, the same second as a missing connection: never at once, which would be an endless loop.
        const waitMs = refusal.waitMs || spacedWaitMs(attemptAt);
        send({ t: 'retry', attempt: tries + 1, status: 429, reason: 'rate_limit', waitMs });
        if (waitMs > 0) await sleep(waitMs);
        continue;
      }
      if (isConnectionDrop(err)) {
        // As in evaluate.js: a connection that could not be made or was cut is the operating
        // system's report, not OpenAI's; the extraction waits for the connection, going again a
        // second after this go began, however long the route is missing, never counted out.
        const wait = connectionWait(err, attemptAt);
        const { code, waitMs } = wait;
        const why = own ? String(wait.why || '').split(openaiHost()).join(listingHost()) : wait.why;
        const { since } = noteFailure({ code, why, ...(own ? { who: listingProviderName() } : {}) });
        send({ t: 'retry', attempt: tries + 1, status: null, reason: 'connection', code, why, since, waitMs, at: Date.now() });
        if (waitMs > 0) await sleep(waitMs);
        continue;
      }
      if (tries < config.evalRetries && isRetryable(err)) {
        // As in evaluate.js: a 5xx goes again on the operator's count; the provider's own
        // retry-after, when given, is honoured first; otherwise the go is spaced like a connection's
        // (a second after this go began), never eight in under a second. A refusal at OpenAI's door
        // never arrives here (the gate keeps it).
        const waitMs = rateLimitWaitMs(err) || spacedWaitMs(attemptAt);
        send({ t: 'retry', attempt: tries + 1, status: err?.status ?? null, reason: 'error', waitMs });
        if (waitMs > 0) await sleep(waitMs);
        continue;
      }
      throw listingFailure(err);
    }
  }

  if (signal.aborted) return null;
  const items = parseNumberedList(full);
  while (emitted < items.length) readEntry(items[emitted++]);
  // No claim to show first (none Central, Unranked or without a role): the Supporting ones are shown instead, so a list
  // never opens empty (the operator's answer of 24 October).
  if (offered.length && !offered.some((c) => c.top)) for (const c of offered) c.top = true;
  const claims = offered;
  const roles = Object.fromEntries(['central', 'supporting', 'unranked', 'incidental', 'none'].map((r) => [r, read.filter((x) => (x.role ?? 'none') === r).length]));
  const ms = Date.now() - started;
  const cost = estimateTextCost({ model: modelUsed, usage, at: pricedAt });
  record({ kind: 'extract', provider: config.extractProvider, model: modelUsed, effort: config.extractEffort, mode: config.extractReasoningMode || null, ...(fireworks ? { reasoningEcho: reasoningEcho ?? null } : {}), chars: text.length, claims: claims.length, entries: read.length, labelled: read.filter((x) => x.labelled).length, roles, usage, ms, usd: cost.usd, priced: cost.priced }, { runId: ctx.runId, owner: ctx.owner });
  // Where the listing's time went, for the service's log (18 October: an article took five minutes at `high`, and nothing
  // said how much of it was thinking), then the entries' counts (24 October: whether the listing keeps to its format, and
  // the claims' roles). Counts and times only.
  console.log(`[listing] ${claims.length} claims from ${text.length.toLocaleString('en-US')} characters in ${Math.round(ms / 1000)} s on ${modelUsed} at ${config.extractEffort}${goes > 1 ? ` (${goes} goes)` : ''}: ${spentWords({ usage, thoughtMs: firstTextAt == null ? null : firstTextAt - pricedAt })}${entryWords(read)}`);
  // The second pass (server/rank.js, 16 October): the same model ranks the claims, inside this job and before the page is
  // told the listing is done, so a cut connection loses nothing and the page draws the list once, in its order. A ranking
  // that fails or cannot be read leaves the list whole.
  const ranking = rank && claims.length ? await runRanking({ client, model: modelUsed, text, meta, claims, send, signal, ctx }) : null;
  if (signal.aborted) return null;
  // `raw` is the model's complete extraction output, exactly as returned, so it can be inspected.
  // No token figures go to the page (the operator's rule of 18 September); the ledger line above keeps them.
  const result = { t: 'done', total: claims.length, limit: config.maxClaims, claims, raw: full, reasoning: reasoning.trim() || null, trail, model: modelUsed, requested: config.extractModels[0], fellBack, effort: config.extractEffort, mode: config.extractReasoningMode || null, ms, cost, incomplete, ...(ranking ? { ranking } : {}) };
  send(result);
  return result;
}
