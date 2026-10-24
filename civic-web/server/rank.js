// The second pass (16 October): after the listing, the listing's own DeepSeek model reads the document and the numbered
// claims the listing wrote, and answers with a summary, the article's headline and its kind, and the empirical claims in
// one order, most load-bearing first. The operator's rules:
//   - a claim that is not empirical is eliminated, and the empirical ones are force-ranked by how far the article would
//     change, in its meaning and in its worth, were each one false (their own words are in the prompt);
//   - "The title of the article must be an empirical statement; if so, it should be the first fact tested, and always
//     tested first. The remaining claims appear in the order in which they are force-ranked."
//   - "I only want the top 25% of the most important claims, or 1/4, presented for testing."
//
// The prompt is the operator's (the vault's `rank`, written from their rules and approved by them). FactEngine fills
// its two slots and reads the answer by its headings: SUMMARY, HEADLINE, HEADLINE TYPE, HEADLINE CLAIM, RANKED and
// NOT EMPIRICAL. The page then shows the top quarter of the ranked claims, rounded up (the operator's answers), with an
// empirical headline on top of it and the rest behind "Show the other claims"; the claims the model found not empirical
// are set aside and counted. The headline is tested only when the model copied it word for word from the page's title
// or the document: FactEngine never tests words of the model's own. A ranking that cannot be read leaves the list whole,
// as before, and is recorded on /check. A wait is a wait, as for the listing; the model's chain of thought is neither
// sent nor kept.
import { config } from './config.js';
import { rankingPrompt, rankingProblem } from './prompts.js';
import { sourceBlock, titleOf, NO_TITLE } from './source.js';
export { titleOf, NO_TITLE } from './source.js';
import { usageOf, isRetryable, isRateLimit, isConnectionDrop, connectionWait, rateLimitWaitMs, sleep, streamFailure, asStreamFailure, spacedWaitMs, cutReply } from './openai.js';
import { onDeepSeek, listingFailure, openaiHost } from './listing.js';
import * as deepseek from './deepseek.js';
import { noteFailure, noteReply } from './reach.js';
import { parseRefusal } from './gate.js';
import { estimateTextCost } from './pricing.js';
import { record, spentWords } from './ledger.js';
import { record as recordFailure } from './diagnostics.js';

/** Whether the ranking can run here, and if not, why: for /check, the startup line and the route. Never a key. */
export function rankState() {
  const base = { mode: config.rank, keepPercent: config.rankKeepPercent, model: config.extractModels[0], effort: config.rankEffort };
  if (config.rank === 'off') {
    const named = String(config.rankSetting || '').trim();
    return { ...base, ready: false, why: named && !/^off$/i.test(named)
      ? `CIVIC_RANK is "${named}"; FactEngine knows off, operator and on, so the claims are listed unranked.`
      : 'The ranking is off (CIVIC_RANK=off): the claims are listed unranked.' };
  }
  const problem = rankingProblem();
  if (problem) return { ...base, ready: false, why: problem };
  if (!onDeepSeek()) return { ...base, ready: false, why: `The ranking runs on the listing's DeepSeek model, and the listing is on ${config.extractProvider} (CIVIC_EXTRACT_PROVIDER).` };
  if (!config.deepseekKey) return { ...base, ready: false, why: 'DEEPSEEK_API_KEY is not set, so nothing can be sent to DeepSeek.' };
  return { ...base, ready: true, why: null };
}

/** Whether this run's claims are ranked: the operator's own runs when the mode is `operator`, everyone's when `on`. */
export function rankFor({ operator }) {
  const s = rankState();
  return s.ready && (s.mode === 'on' || (s.mode === 'operator' && Boolean(operator)));
}

/** The claims as the prompt is given them: each one's number, then its whole entry as the listing wrote it. */
export function claimsBlock(claims) {
  return claims.map((c) => `${c.n}. ${String(c.entry || c.text || '').trim()}`).join('\n\n');
}

/**
 * How many of `n` ranked claims are shown for testing: the operator's part of them, rounded up (their answer of 16
 * October), so any ranked list shows at least one. Worked in whole millionths, so 15 % of 20 is 3 and never 4.
 */
export function keepCount(n, percent = config.rankKeepPercent) {
  if (!Number.isInteger(n) || n <= 0) return 0;
  return Math.min(n, Math.ceil(Math.round(n * percent * 1e6) / 1e8));
}

// A line with its Markdown decorations taken off, for reading a heading: "**HEADLINE:** x" and "## RANKED" read as written.
const bare = (s) => String(s ?? '').replace(/^[\s#>*_`]+/, '').replace(/[*_`]+(?=\s*:)/g, '').replace(/[\s*_`]+$/, '');
const isHeading = (line) => /^headline(\s+type|\s+claim)?\s*:/i.test(line) || /^ranked\s*:?\s*[\d\s,.;#]*$/i.test(line) || /^not\s+empirical\s*:?\s*((none|[\d\s,.;#])*)$/i.test(line);
const numbersIn = (s) => (String(s).match(/\d{1,4}/g) || []).map(Number);
// The claim a ranked line names: "12", "#12", "Claim 12", "12. its text"; and "1. 12", a place and then the claim.
const leadNumber = (line) => {
  let m = line.match(/^\d{1,4}\s*[.)]\s*(?:claim\s*)?#?\s*(\d{1,4})\b/i);
  if (m) return Number(m[1]);
  m = line.match(/^(?:claim\s*)?#?\s*(\d{1,4})\b/i);
  return m ? Number(m[1]) : null;
};
const kindOf = (s) => {
  const v = bare(s).toUpperCase();
  if (/NOT\s+EMPIRICAL/.test(v)) return 'not_empirical';
  if (/EMPIRICAL/.test(v)) return 'empirical';
  if (/QUESTION/.test(v)) return 'question';
  if (/NONE/.test(v)) return 'none';
  return null;
};
const cleanHeadline = (s) => {
  const v = String(s ?? '').replace(/^[\s*_"'“”‘’«»]+|[\s*_"'“”‘’«»]+$/g, '').trim();
  return !v || /^none\.?$/i.test(v) ? null : v;
};
// Words compared as words: case, curly quotes, dashes, spacing and punctuation do not make a headline another.
const words = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[‘’ʼ`´]/g, "'").replace(/[“”«»„]/g, '"').replace(/[–—]/g, '-')
  .replace(/[^\p{L}\p{N}'-]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** The summary written so far, in whole lines: what is under SUMMARY, up to the first heading after it. */
export function summarySoFar(full) {
  const upto = String(full).lastIndexOf('\n');
  if (upto < 0) return '';
  const out = [];
  let started = false;
  for (const raw of String(full).slice(0, upto).split('\n')) {
    const line = bare(raw);
    if (!started) {
      const m = line.match(/^summary\s*:?\s*(.*)$/i);
      if (m) { started = true; if (m[1]) out.push(m[1]); continue; }
      if (!line) continue;
      started = true;   // no heading: the text is the summary until one comes
    }
    if (isHeading(line)) break;
    out.push(raw);
  }
  return out.join('\n').replace(/^\n+/, '');
}

/**
 * The model's answer, read by its headings. `claims` are the listing's (numbered from 1), `title` the headline as
 * published (or ''), `source` the document's text. Returns what the page needs: the summary; the headline, its kind and
 * whether it is tested; the claims in their order (the ranked ones, then any the model left out); how many of them are
 * shown; and the claims set aside as not empirical. A number outside the list, or named twice, is passed over.
 */
export function parseRanking(text, { claims = [], title = '', source = '' } = {}) {
  const max = claims.length;
  const seen = new Set();
  const ranked = [];
  const notEmpirical = [];
  const summary = [];
  const before = [];   // text ahead of every heading: the summary, when the model wrote no SUMMARY heading
  let section = null;
  let sawSummary = false;
  let sawRanked = false;
  let sawAny = false;
  let headline = null;
  let kind = null;
  let headlineClaim = null;
  const take = (list, n) => { if (Number.isInteger(n) && n >= 1 && n <= max && !seen.has(n)) { seen.add(n); list.push(n); } };
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = bare(raw);
    let m;
    if (!sawSummary && !sawAny && (m = line.match(/^summary\s*:?\s*(.*)$/i))) { sawSummary = true; sawAny = true; section = 'summary'; if (m[1]) summary.push(m[1]); continue; }
    if ((m = line.match(/^headline\s+type\s*:\s*(.*)$/i))) { kind = kindOf(m[1]); section = null; sawAny = true; continue; }
    if ((m = line.match(/^headline\s+claim\s*:\s*(.*)$/i))) { const n = numbersIn(m[1])[0]; headlineClaim = Number.isInteger(n) && n >= 1 && n <= max ? n : null; section = null; sawAny = true; continue; }
    if ((m = line.match(/^headline\s*:\s*(.*)$/i))) { headline = cleanHeadline(m[1]); section = null; sawAny = true; continue; }
    if ((m = line.match(/^ranked\s*:?\s*([\d\s,.;#]*)$/i))) { section = 'ranked'; sawRanked = true; sawAny = true; for (const n of numbersIn(m[1])) take(ranked, n); continue; }
    if ((m = line.match(/^not\s+empirical\s*:?\s*((?:none|[\d\s,.;#])*)$/i))) { section = 'notEmpirical'; sawAny = true; for (const n of numbersIn(m[1])) take(notEmpirical, n); continue; }
    if (section === 'summary') { summary.push(raw); continue; }
    if (section === 'ranked') { const n = leadNumber(line); if (n !== null) take(ranked, n); continue; }
    if (section === 'notEmpirical') { for (const n of numbersIn(line)) take(notEmpirical, n); continue; }
    if (!sawAny) before.push(raw);
  }
  // The summary is what is under its heading, or what comes ahead of the first heading when it has none; an answer with
  // no heading at all has no summary to show (its words may be anything, a refusal among them).
  const summaryText = (sawSummary ? summary : sawAny ? before : []).join('\n').trim() || null;

  // The headline is tested when it is empirical and is, word for word, the page's title or a line of the document.
  const h = headline ? words(headline) : '';
  const found = h.length >= 8 && (words(title).includes(h) || words(source).includes(h));
  const tested = kind === 'empirical' && found;
  // A listed claim that says what the headline says: the headline row is that test, so the claim is not shown twice.
  let duplicate = null;
  if (tested && headlineClaim && ranked.includes(headlineClaim)) {
    duplicate = headlineClaim;
    ranked.splice(ranked.indexOf(headlineClaim), 1);
  }
  const missing = claims.map((c) => c.n).filter((n) => !seen.has(n));
  const ok = sawRanked && ranked.length + notEmpirical.length + (duplicate ? 1 : 0) > 0;
  return {
    ok,
    why: ok ? null : (sawRanked ? 'the RANKED list named no claim of the list' : 'the answer has no RANKED list'),
    summary: summaryText,
    headline: headline || kind ? { text: headline, kind, tested, why: tested ? null : (kind !== 'empirical' ? 'not empirical' : 'not word for word in the title or the document') } : null,
    order: ok ? [...ranked, ...missing] : [],
    keep: ok ? keepCount(ranked.length) : 0,
    ranked: ranked.length,
    notEmpirical: ok ? notEmpirical : [],
    missing: missing.length,
    duplicate,
  };
}

/**
 * The second pass, run inside the listing's job before the page is told the listing is done: the source as a message
 * ahead of the prompt (as a determination's is), the prompt with its two slots filled, the listing's model at the
 * ranking's effort, and nothing else. The summary goes to the page as it is written, in whole lines. Returns what the
 * page is given in `done.ranking`, or null when stopped. A failure never fails the listing: the list stays whole.
 */
export async function runRanking({ client, model, text, meta, claims, send, signal, ctx = {} }) {
  if (!claims.length) return null;
  const started = Date.now();
  const title = titleOf(meta);
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: sourceBlock(text, meta) }] },
    { role: 'user', content: [{ type: 'input_text', text: rankingPrompt({ title: title || NO_TITLE, claims: claimsBlock(claims) }) }] },
  ];
  send({ t: 'phase', phase: 'ranking', claims: claims.length });
  let full = '';
  let usage = null;
  let incomplete = null;
  let pricedAt = null;
  let firstTextAt = null;   // when the delivering go's first word arrived: before it, the model was thinking
  let shown = 0;   // characters of the summary the page has
  const restart = () => { if (shown) send({ t: 'summary', reset: true }); shown = 0; };
  const line = (fields) => ({ kind: 'rank', provider: 'deepseek', model, effort: config.rankEffort, chars: text.length, claims: claims.length, ...fields });
  for (let tries = 0; ; tries++) {
    const attemptAt = Date.now();
    try {
      full = '';
      firstTextAt = null;
      // DeepSeek: the model, the source and the prompt, the effort, and nothing else (no tools: it reads what it is
      // given; no store: DeepSeek keeps nothing). Not through OpenAI's gate, as the listing on DeepSeek is not.
      const body = { model, input, reasoning: { effort: config.rankEffort }, stream: true };
      const { data: stream } = await client.responses.create(body, { signal }).withResponse();
      noteReply('DeepSeek');
      pricedAt = attemptAt;
      let ended = false;
      for await (const event of stream) {
        if (signal.aborted) return null;
        if (event.type === 'response.output_text.delta') {
          if (event.delta) firstTextAt ??= Date.now();
          full += event.delta || '';
          const s = summarySoFar(full);
          if (s.length > shown) { send({ t: 'summary', delta: s.slice(shown) }); shown = s.length; }
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          ended = true;
          usage = usageOf(event.response);
          if (event.type === 'response.incomplete') incomplete = event.response?.incomplete_details?.reason || 'incomplete';
        } else if (event.type === 'response.failed' || event.type === 'error') {
          throw streamFailure(event, 'ranking failed');
        }
        // DeepSeek's chain of thought (response.reasoning_text.delta) is neither sent nor kept: the operator's answer of
        // 4 October, as for the listing.
      }
      if (!ended) throw cutReply();
      break;
    } catch (caught) {
      if (signal.aborted) return null;
      const err = asStreamFailure(caught, 'ranking failed');
      if (isRateLimit(err)) {
        const waitMs = parseRefusal(err).waitMs || spacedWaitMs(attemptAt);
        restart();
        send({ t: 'rank-retry', attempt: tries + 1, status: 429, reason: 'rate_limit', waitMs });
        if (waitMs > 0) await sleep(waitMs);
        continue;
      }
      if (isConnectionDrop(err)) {
        const wait = connectionWait(err, attemptAt);
        const why = String(wait.why || '').split(openaiHost()).join(deepseek.host());
        const { since } = noteFailure({ code: wait.code, why, who: deepseek.NAME });
        restart();
        send({ t: 'rank-retry', attempt: tries + 1, status: null, reason: 'connection', code: wait.code, why, since, waitMs: wait.waitMs, at: Date.now() });
        if (wait.waitMs > 0) await sleep(wait.waitMs);
        continue;
      }
      if (tries < config.evalRetries && isRetryable(err)) {
        const waitMs = rateLimitWaitMs(err) || spacedWaitMs(attemptAt);
        restart();
        send({ t: 'rank-retry', attempt: tries + 1, status: err?.status ?? null, reason: 'error', waitMs });
        if (waitMs > 0) await sleep(waitMs);
        continue;
      }
      // Anything else (a key refused, the balance used up, a request refused): the claims are listed whole, as before
      // the ranking, and the provider's own words go to /check.
      const safe = listingFailure(err);
      recordFailure({ where: 'server:ranking', code: safe.code, message: 'The ranking failed, so the claims are listed unranked.', status: safe.status, detail: safe.detail || safe.message || null });
      const ms = Date.now() - started;
      record(line({ ok: false, failure: safe.code || 'error', ms }), { runId: ctx.runId, owner: ctx.owner });
      console.log(`[rank] ${claims.length} claims not ranked: the ranking failed after ${Math.round(ms / 1000)} s at ${config.rankEffort} (${safe.code || 'error'}), so they are listed whole`);
      return { ok: false, why: 'failed', summary: null, ms, model, effort: config.rankEffort };
    }
  }

  const parsed = parseRanking(full, { claims, title, source: text });
  const ms = Date.now() - started;
  const cost = estimateTextCost({ model, usage, at: pricedAt });
  if (!parsed.ok) recordFailure({ where: 'server:ranking', code: 'rank_unread', message: 'The ranking could not be read, so the claims are listed unranked.', status: null, detail: parsed.why });
  else if (parsed.headline?.kind === 'empirical' && !parsed.headline.tested) {
    recordFailure({ where: 'server:ranking', code: 'headline_unmatched', message: 'The headline the ranking wrote is not, word for word, the page\'s title or a line of the document, so it is not tested.', status: null, detail: `${(parsed.headline.text || '').length} characters` });
  }
  record(line({
    ok: parsed.ok, ranked: parsed.ranked, kept: parsed.keep, notEmpirical: parsed.notEmpirical.length, missing: parsed.missing,
    headline: parsed.headline?.kind || null, headlineTested: Boolean(parsed.headline?.tested), ...(incomplete ? { incomplete } : {}),
    usage, ms, usd: cost.usd, priced: cost.priced,
  }), { runId: ctx.runId, owner: ctx.owner });
  // Where the ranking's time went, for the service's log, beside the listing's line. Counts and times only.
  console.log(`[rank] ${claims.length} claims ranked in ${Math.round(ms / 1000)} s on ${model} at ${config.rankEffort}, ${parsed.ok ? `${parsed.keep} shown` : 'not read, so listed whole'}: ${spentWords({ usage, thoughtMs: firstTextAt == null ? null : firstTextAt - pricedAt })}`);
  return { ...parsed, ms, model, effort: config.rankEffort, incomplete };
}
