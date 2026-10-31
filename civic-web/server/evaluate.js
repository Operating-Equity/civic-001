// Step 2 — each claim is tested by the protected evaluation prompt, sent verbatim.
// Ten claims at a time (config.evalConcurrency). What is tested is the claim alone, as the page sends
// it: nothing else the listing wrote goes with it (the operator, 24 October: "I don't want the
// extraction to affect downstream processing in any way"). The source goes ahead of the prompt as
// its own message, with what FactEngine knows of who produced it and when, as the conversation
// carried it in the workflow the prompts were tested in, so "the speech" has a speaker and a date.
//
// Nothing the model returns is edited, trimmed or withheld. The card receives the complete
// output text, the reasoning summary, every web search the model performed, and every source
// it cited. The verdict is read out of the model's own Conclusion, in whatever form the model
// wrote it (server/verdict.js); an entry that states no verdict at all is Unverified, by the
// operator's ruling, and its closing words are recorded for /check.
//
// The operator's trial (14 October, server/trial.js) runs the same two messages on DeepSeek, for the operator's own
// runs alone. DeepSeek's Responses API ignores web search, so there the model is offered FactEngine's own tools as
// functions (the search service and the page reader, server/tools) and FactEngine runs each call it makes, round after
// round, until it writes its entry. Its private reasoning never reaches the page, the record or /check: it is held in
// memory for that one fact-check only, to go back with each round, as DeepSeek requires of a model using tools.
//
// On Gemini (18 October, server/gemini.js) the same two messages go to Google's Interactions API in one request per
// claim: the model searches with Google's own search and reads pages itself inside that request, at the level the
// operator chose (medium or high), and says store: false, so Google keeps nothing. Its own summary of its thinking shows
// on the card, as the readers' model's does (the operator's answer); its thought signature is neither sent nor kept.
//
// On Claude (26 October, server/anthropic.js) the same two texts go to Anthropic's Messages API in one message, in the
// same order, at the level the operator ticked: the model searches with Anthropic's web search and reads pages with its
// page reader inside that request, each told to leave out the operator's lists, and its own summary of its thinking
// shows on the card. A turn Anthropic pauses goes back to it as it stands until it ends. A claim Anthropic declines ends
// with its decline on the card, and nothing else answers in its place (the operator's answer).
import { config } from './config.js';
import { evaluationPrompt } from './prompts.js';
import { readersStandby } from './standby.js';
import { clientFor, withModelFallback, usageOf, isRetryable, isRateLimit, isConnectionDrop, connectionWait, rateLimitWaitMs, sleep, describeError, throughGate, streamFailure, asStreamFailure, spacedWaitMs, cutReply } from './openai.js';
import { openaiHost } from './providers.js';
import * as deepseek from './deepseek.js';
import * as gemini from './gemini.js';
import * as anthropic from './anthropic.js';
import { noteFailure, noteReply } from './reach.js';
import { gateFor, parseRefusal } from './gate.js';
import { record as recordFailure } from './diagnostics.js';
import { estimateTextCost } from './pricing.js';
import { record, claimHash, factCheckWords } from './ledger.js';
import { parseEntry, conclusionExcerpt, classFigures, countClass } from './verdict.js';
import { requestTools, requestInclude, toolStep, searchCount, verbOf } from './tools/request.js';
import { listedSite, listedCounts, anthropicExclusions, NOT_CONSULTED } from './sites.js';
import { registry } from './tools/index.js';
export { parseEntry, VERDICTS } from './verdict.js';

const round4 = (v) => Math.round(v * 10000) / 10000;

/** The tools a model on DeepSeek is offered: FactEngine's own, as functions, in the words the model reads (server/tools/verbs.js). */
export const trialTools = () => registry.table.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }));

/** How many of a trial's steps were searches, and how many read a page or a transcript. */
const searchesOf = (trail) => trail.filter((s) => s.kind === 'tool' && s.name === 'search_web').length;
const readsOf = (trail) => trail.filter((s) => s.kind === 'tool' && s.name !== 'search_web').length;

/**
 * A delivered entry's searches and pages read, counted alike for every model (23 October), so the operator's table
 * compares like with like: a search is a query sent (OpenAI's or Google's own, or FactEngine's search service), a page
 * read is a page opened (OpenAI's or Google's own) or read through FactEngine's tools. What each provider bills stays
 * on the line as `searches`: OpenAI bills a page opened, or a look within one, as a search.
 */
const queriesIn = (trail) => trail.filter((s) => s.kind === 'search' || (s.kind === 'tool' && s.name === 'search_web')).length;
const pagesIn = (trail) => trail.filter((s) => s.kind === 'open_page' || (s.kind === 'tool' && s.name !== 'search_web')).length;

/**
 * A fact-check's time and entry, for its line (23 October, the operator's "Are you measuring the attributes of the
 * different models, such as how long they take to run, the length of their outputs, cost"): its waits (the gate, a
 * provider's "wait", a connection's) apart from its work; of the work, what came before the delivered entry's first word
 * apart from the writing of it; and the entry's length. Counts and times only, never a word of it.
 */
function measured({ ms, waitMs, firstAt, endAt, text }) {
  const workMs = Math.max(0, ms - waitMs);
  const writeMs = firstAt !== null && endAt !== null && endAt >= firstAt ? endAt - firstAt : null;
  return {
    waitMs, workMs, firstWordMs: writeMs === null ? null : Math.max(0, workMs - writeMs), writeMs, entryChars: text.length, entryWords: (text.match(/\S+/g) || []).length,
    ...classFigures(text),   // with the operator's class set: the name written in it, and in full outside it (31 October, evening)
  };
}

/** A wait, timed: `onWaited` is told how long it took, so the line can keep the waits apart from the work. */
async function pause(ms, onWaited) {
  if (!(ms > 0)) return;
  const at = Date.now();
  await sleep(ms);
  onWaited(Date.now() - at);
}

/**
 * What the operator keeps out of the research (server/sites.js, 25 October): a cited source or a step of the trail of
 * one of their sites or columns, or of a page that names itself one of the kinds kept out, is marked for the operator's
 * card (server/view.js keeps the mark from a reader's), and what the fact-check took of them is counted for its line. A
 * read FactEngine's reader refused for it (its own sentence) is marked too, whatever the page's address. With nothing
 * set, nothing is marked and the line holds no count.
 */
const marked = (item, title = null) => (item?.url && listedSite(item.url, { title }) ? { ...item, listed: true } : item);
const markSource = (source) => marked(source, source?.title);
const markStep = (step) => (step?.kind === 'tool' && step.url && step.error === NOT_CONSULTED ? { ...step, listed: true } : marked(step));
const counted = (what) => listedCounts(what) || {};

/** The addresses a search through FactEngine's own tools returned to the model (the tool's answer, as the model reads it). */
function returnedUrls(name, output) {
  if (name !== 'search_web' || typeof output !== 'string') return [];
  try { return (JSON.parse(output)?.items || []).map((x) => x?.url).filter(Boolean); } catch { return []; }
}

/** A finished fact-check's line: kept on the ledger and said in the host's log, counts and times only. */
function recordDone(line, ctx) {
  record(line, ctx);
  countClass(line);
  console.log(factCheckWords(line));
}

export async function runEvaluation({ apiKey, claims, document = '', send, signal, ctx = {}, trial = null }) {
  // `trial`: null for the readers' determination; else the operator's choice (server/trial.js): DeepSeek's model and
  // effort, Gemini's model and level, Claude's model and level, an OpenAI model at its level (24 October: GPT-6.1 Sol), or the readers' own model
  // beside them, recorded as a trial.
  const onDeepSeek = trial?.provider === 'deepseek';
  const onGemini = trial?.provider === 'gemini';
  const onAnthropic = trial?.provider === 'anthropic';
  const onOpenAITrial = trial?.provider === 'openai' && Boolean(trial.effort);   // OpenAI's fact-check, its own model and level
  const client = onDeepSeek ? deepseek.client(apiKey) : onGemini || onAnthropic ? null : clientFor(apiKey);
  const models = onDeepSeek || onGemini || onAnthropic || onOpenAITrial ? [trial.model] : config.evalModels;
  const effort = onDeepSeek || onGemini || onAnthropic || onOpenAITrial ? trial.effort : config.evalEffort;
  const mode = onDeepSeek || onGemini || onAnthropic ? null : config.evalReasoningMode || null;
  const kind = trial ? 'trial' : 'evaluate';
  // The readers' standby (server/standby.js): a reader's claim the readers' model still fails goes once more to it, on
  // Anthropic's path. None for the operator's trial, and none when it is not set or its key is missing.
  const standby = trial ? null : readersStandby();
  // Whose work each claim's line is: the run, the sign-in, and the determination's own id (server/economics.js).
  const lineCtx = (i) => ({ runId: ctx.runId || null, owner: ctx.owner || null, determinationId: ctx.determinationIds?.[i] || null });
  // Whose turn the request takes at the gate: the sign-in when the door is shut, else the run, else the job.
  const owner = ctx.owner || ctx.runId || ctx.jobId || null;
  const total = claims.length;
  let completed = 0;
  const started = Date.now();
  send({ t: 'batch-start', total, at: started, model: models[0], effort, mode, ...(trial ? { trial: true, provider: trial.provider } : {}) });

  const tools = requestTools(); // web search always (the prompts were tested with it); CIVIC's own tools when the gateway is set
  const include = requestInclude();   // with the operator's list set: every address the search consulted, to count

  // The key's minute figures, once the gate has them from OpenAI: the page is told the limit, what
  // OpenAI counts for one determination, how many start at once and how often one more can. All
  // of it is OpenAI's own arithmetic; it is sent whenever the figures change.
  let announced = '';
  const announceGate = (model) => {
    const g = gateFor(model).state();
    if (!g.determination) return;
    const key = `${g.tokens.limit}:${g.costs.determination}:${g.determination.everyMs}`;
    if (key === announced) return;
    announced = key;
    send({ t: 'gate', model, limit: g.tokens.limit, cost: g.costs.determination, ...g.determination });
  };

  /** The two messages every determination begins with: the source ahead, as its own message, then the prompt verbatim with the entry in its slot. */
  const firstInput = (prompt) => [
    ...(document ? [{ role: 'user', content: [{ type: 'input_text', text: document }] }] : []),
    { role: 'user', content: [{ type: 'input_text', text: prompt }] },
  ];

  const evaluateOne = async (claim, i) => {
    const prompt = evaluationPrompt(claim);
    const startedAt = Date.now();
    let text = '';
    let reasoning = '';
    let usage = null;
    let modelUsed = null;
    let incomplete = null;
    let wantSummary = Boolean(config.evalReasoningSummary);
    let fellBack = null;
    const trail = [];   // every web action the model took, in the attempt that delivered
    const sources = []; // every URL it cited, in that attempt
    const consulted = []; // every URL its searches consulted, in that attempt (asked for only with the operator's list set)
    const seen = new Set();
    let spentSearches = 0;   // the searches of attempts cut short: OpenAI ran them, so they are paid for
    let waited = 0;          // the gate's holds and every wait, apart from the work (the line's `waitMs`)
    let firstAt = null;      // the delivered entry's first written word, and its last event
    let endAt = null;
    const waitedFor = (ms) => { waited += ms; };

    const request = (model) => {
      // The operator's tested configuration and nothing else. No cap, no mode, no verbosity,
      // no context size. `npm run verify` fails if any other key ever appears here.
      const reasoning = { effort };
      if (config.evalReasoningMode) reasoning.mode = config.evalReasoningMode; // pro: more model work per answer, at the same rates
      if (wantSummary) reasoning.summary = config.evalReasoningSummary;
      const body = {
        model,
        input: firstInput(prompt),
        reasoning,
        tools,
        ...(include ? { include } : {}),
        stream: true,
        store: false, // the prompt must not appear in any dashboard: the operator's key runs every request
      };
      // Through the gate: sent only when the key's minute holds it. A held claim's row says so, in figures.
      return throughGate(client, body, { kind: 'determination', owner, signal, onHold: (h) => send({ t: 'phase', i, phase: 'queued', ...h }) });
    };

    for (let tries = 0; ; tries++) {
      const attemptAt = Date.now();
      // Each go starts its own record, as the page starts its row again at `start`: what a go cut short had found is not
      // the entry's, though the searches it made were made, and are counted in the cost.
      spentSearches += searchCount(trail);
      trail.length = 0;
      sources.length = 0;
      consulted.length = 0;
      seen.clear();
      usage = null;
      incomplete = null;
      firstAt = null;
      endAt = null;
      try {
        text = '';
        reasoning = '';
        await withModelFallback('evaluate', models, async (model) => {
          const { data: stream, release, heldMs } = await request(model);
          waitedFor(heldMs || 0);
          modelUsed = model;
          announceGate(model);
          let ended = false;   // completed or incomplete: the reply's own last word
          try {
          send({ t: 'start', i, model, requested: models[0], at: Date.now() });
          for await (const event of stream) {
            if (signal.aborted) return;
            switch (event.type) {
              case 'response.output_text.delta':
                if (firstAt === null && event.delta) firstAt = Date.now();
                text += event.delta;
                send({ t: 'delta', i, text: event.delta });
                break;

              case 'response.reasoning_summary_text.delta':
              case 'response.reasoning_text.delta':
                reasoning += event.delta || '';
                send({ t: 'reasoning', i, text: event.delta || '' });
                break;
              case 'response.reasoning_summary_part.done':
                reasoning += '\n\n';
                break;

              case 'response.web_search_call.in_progress':
              case 'response.web_search_call.searching':
                send({ t: 'phase', i, phase: 'searching', searches: searchCount(trail) + 1 });
                break;

              case 'response.mcp_call.in_progress':
                send({ t: 'phase', i, phase: 'reading' }); // the model is reaching for one of CIVIC's tools
                break;

              case 'response.output_item.done': {
                const item = event.item;
                if (item?.type === 'web_search_call') {
                  const a = item.action || {};
                  const step = markStep({ kind: a.type || 'search', verb: verbOf({ kind: a.type || 'search' }), query: a.query || null, url: a.url || null, pattern: a.pattern || null, status: item.status });
                  trail.push(step);
                  // What the search consulted, as OpenAI lists it (a feed of its own has a name and no address).
                  for (const src of Array.isArray(a.sources) ? a.sources : []) if (typeof src?.url === 'string') consulted.push(src.url);
                  send({ t: 'trail', i, step, searches: searchCount(trail) });
                } else if (item?.type === 'mcp_call') {
                  // One of CIVIC's tools, called and answered inside the response; its answer is the model's to use.
                  const step = markStep(toolStep(item));
                  if (step.status !== 'failed') consulted.push(...returnedUrls(step.name, item.output));
                  trail.push(step);
                  send({ t: 'trail', i, step, searches: searchCount(trail) });
                }
                break;
              }

              case 'response.output_text.annotation.added': {
                const a = event.annotation;
                if (a && a.type === 'url_citation' && a.url && !seen.has(a.url)) {
                  seen.add(a.url);
                  const source = markSource({ url: a.url, title: a.title || a.url });
                  sources.push(source);
                  send({ t: 'source', i, source });
                }
                break;
              }

              case 'response.completed':
                ended = true;
                usage = usageOf(event.response);
                break;
              case 'response.incomplete':
                ended = true;
                usage = usageOf(event.response);
                incomplete = event.response?.incomplete_details?.reason || 'incomplete';
                send({ t: 'phase', i, phase: 'incomplete', reason: incomplete });
                break;
              case 'response.failed':
              case 'error':
                throw streamFailure(event, 'evaluation failed');
              default:
                break;
            }
          }
          // A reply that stops without its last word was cut, however politely: it goes again, as a cut connection does.
          // It is never delivered as an entry, and never charged as one.
          if (!ended && !signal.aborted) throw cutReply();
          endAt = Date.now();
          } finally {
            release();   // the gate learns the request is over, whatever ended it
          }
        }, (f) => { fellBack = f; send({ t: 'warning', i, code: 'model_fallback', ...f }); });
        break;
      } catch (caught) {
        if (signal.aborted) return;
        // An `error` event in the middle of the stream reaches here with no status: it is read as the stream's own
        // failure, so a rate limit there is a wait and an overload a retry, as at the door.
        const err = asStreamFailure(caught, 'evaluation failed');
        // Reasoning summaries need a verified organisation on some accounts. Drop them and keep going.
        if (wantSummary && err?.status === 400 && /summar/i.test(String(err?.error?.message || err?.message || ''))) {
          wantSummary = false;
          send({ t: 'note', i, code: 'no_reasoning_summary' });
          continue;
        }
        if (isRateLimit(err)) {
          // A refusal inside a streamed reply: the response's own later call (after a web search,
          // say) found the minute short, and OpenAI ended the response with its figures instead of
          // turning the request back at the door. The figures go to the gate as any refusal's do;
          // the claim waits exactly what OpenAI asked and goes again, whole. Never a failure.
          const refusal = parseRefusal(err);
          gateFor(modelUsed || models[0]).refusedInStream('determination', refusal);
          send({ t: 'retry', i, attempt: tries + 1, status: 429, reason: 'rate_limit', waitMs: refusal.waitMs || 0 });
          await pause(refusal.waitMs, waitedFor);
          continue;
        }
        if (isConnectionDrop(err)) {
          // The connection could not be made, or was cut: the operating system's report, never
          // OpenAI's. Nothing was decided, and a request that never left this computer spent
          // nothing. It is a wait for the connection, as a refusal is a wait for the minute: the
          // claim goes again a second after this go began, however long the route is missing,
          // and is never counted out. The row says why, in the system's words; the outage is on
          // record for /check, with its start, its cause and its length.
          const { code, why, waitMs } = connectionWait(err, attemptAt);
          const { since } = noteFailure({ code, why });
          send({ t: 'retry', i, attempt: tries + 1, status: null, reason: 'connection', code, why, since, waitMs, at: Date.now() });
          await pause(waitMs, waitedFor);
          continue;
        }
        if (tries < config.evalRetries && isRetryable(err)) {
          // A 5xx from OpenAI cost nothing and is tried again, on the operator's count. The attempt
          // rejoins the line at the gate, and its place in the line is its wait; when OpenAI names
          // a wait of its own (retry-after), that comes first. No back-off of ours. A refusal at
          // the door never arrives here: the gate handles it.
          const waitMs = rateLimitWaitMs(err) || 0;
          send({ t: 'retry', i, attempt: tries + 1, status: err?.status ?? null, reason: 'error', waitMs });
          await pause(waitMs, waitedFor);
          continue;
        }
        const safe = describeError(err);
        record({ kind, ok: false, code: safe.code, ...(trial ? { provider: 'openai' } : {}), model: modelUsed, effort, claim: claimHash(claim), ms: Date.now() - startedAt }, lineCtx(i));
        if (standby) {
          // One more try, by itself, on the readers' standby (31 October, night: "One more try on standby"): the reader's
          // claim goes on as if nothing had happened, and only the standby's own failure reaches them. The operator is told
          // which model answered; /check and the log keep why the readers' model did not.
          const said = `${modelUsed || models[0]} could not test a reader's claim (${safe.code}); it went once more, to the standby (${standby.model} at ${standby.effort})`;
          recordFailure({ where: 'evaluate:standby', code: safe.code, message: `${said}.`, status: safe.status, detail: safe.detail || null });
          console.log(`[standby] ${said}`);
          send({ t: 'warning', i, code: 'model_fallback', used: standby.model, requested: modelUsed || models[0] });
          await evaluateOnAnthropic(claim, i, { model: standby.model, effort: standby.effort, key: anthropic.key(), standby: true });
          return;
        }
        send({ t: 'error', i, code: safe.code, message: safe.message });
        completed++;
        send({ t: 'batch-progress', completed, total });
        return;
      }
    }

    if (signal.aborted) return;
    const parsed = parseEntry(text);
    // An entry whose Conclusion could not be read counts as Unverified; what it said at its
    // Conclusion is kept for /check, so the reader can be corrected to the form the model wrote.
    if (parsed.verdictSource === 'unread') recordFailure({ where: 'server:verdict', code: 'verdict_unread', message: conclusionExcerpt(text) });
    const ms = Date.now() - startedAt;
    const searches = searchCount(trail) + spentSearches;
    const cost = estimateTextCost({ model: modelUsed, usage, searches });
    const tokens = estimateTextCost({ model: modelUsed, usage });
    const fromList = counted({ sources, trail, consulted });
    recordDone({
      kind, ok: true, ...(trial ? { provider: 'openai' } : {}), model: modelUsed, effort, mode: config.evalReasoningMode || null, webSearch: true,
      claim: claimHash(claim), chars: claim.length, fellBack: fellBack?.used || null, verdict: parsed.verdict, verdictSource: parsed.verdictSource,
      confidence: parsed.confidence, usage, searches, queries: queriesIn(trail), reads: pagesIn(trail), sources: sources.length, ...(include ? { consulted: new Set(consulted).size } : {}), ...fromList, incomplete, ms,
      ...measured({ ms, waitMs: waited, firstAt, endAt, text }),
      tokenUsd: tokens.priced ? tokens.usd : null, searchUsd: round4(cost.usd - tokens.usd), usd: cost.usd, priced: cost.priced,
    }, lineCtx(i));
    completed++;
    send({
      t: 'done', i,
      verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence, inspector: parsed.inspector,
      conclusion: parsed.conclusion, // the Conclusion section, for the closed row
      text: parsed.text,            // complete, unmodified
      reasoning: reasoning.trim() || null,
      trail, sources,
      model: modelUsed, requested: models[0], fellBack, effort, mode: config.evalReasoningMode || null, // no token figures go to the page; the ledger keeps them
      standby: Boolean(fellBack),   // a standby model answered: what every page marks, whoever reads it
      searches: searchCount(trail), ms, cost, incomplete, ...fromList,
      ...(trial ? { trial: true, provider: 'openai' } : {}),
    });
    send({ t: 'batch-progress', completed, total });
  };

  // ---- the operator's trial on DeepSeek ---------------------------------------------------------------------------

  const tables = onDeepSeek ? trialTools() : null;

  /**
   * One round on DeepSeek: the conversation so far, the model's reply streamed, and the round's own output items (its
   * reasoning and its calls, to go back with the next round). A wait is a wait, as for the listing: a 429 waits for
   * DeepSeek's figure or a second from the go's start, a 5xx is spaced the same way on the operator's count, a mid-stream
   * error is read for its status, and a round that stops before its last event goes again. Nothing else is repeated.
   */
  const deepseekRound = async ({ input, i, onDelta, onWaited }) => {
    for (let tries = 0; ; tries++) {
      const attemptAt = Date.now();
      try {
        // The model, the conversation, the effort, FactEngine's tools as functions, and nothing else: DeepSeek has no
        // mode, makes no summary and keeps nothing (so no `store`), and ignores built-in tools.
        const body = { model: trial.model, input, reasoning: { effort: trial.effort }, tools: tables, stream: true };
        const { data: stream } = await client.responses.create(body, { signal }).withResponse();
        noteReply('DeepSeek');
        let text = '';
        let output = null;
        let usage = null;
        let incompleteReason = null;
        let ended = false;
        let thinking = false;
        let firstAt = null;   // this round's first written word
        for await (const event of stream) {
          if (signal.aborted) return null;
          switch (event.type) {
            case 'response.output_text.delta':
              if (firstAt === null && event.delta) firstAt = Date.now();
              text += event.delta || '';
              onDelta(event.delta || '');
              break;
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
              // DeepSeek's chain of thought: neither sent nor kept beyond this fact-check (the operator's answer of
              // 4 October). The row says only that the model is thinking.
              if (!thinking) { thinking = true; send({ t: 'phase', i, phase: 'reasoning' }); }
              break;
            case 'response.completed':
              ended = true;
              output = event.response?.output || [];
              usage = usageOf(event.response);
              break;
            case 'response.incomplete':
              ended = true;
              output = event.response?.output || [];
              usage = usageOf(event.response);
              incompleteReason = event.response?.incomplete_details?.reason || 'incomplete';
              send({ t: 'phase', i, phase: 'incomplete', reason: incompleteReason });
              break;
            case 'response.failed':
            case 'error':
              throw streamFailure(event, 'evaluation failed');
            default:
              break;
          }
        }
        if (!ended) throw cutReply();
        return { text, output, usage, incomplete: incompleteReason, at: attemptAt, firstAt, endAt: Date.now() };
      } catch (caught) {
        if (signal.aborted) return null;
        const err = asStreamFailure(caught, 'evaluation failed');
        if (isRateLimit(err)) {
          const waitMs = parseRefusal(err).waitMs || spacedWaitMs(attemptAt);
          send({ t: 'retry', i, attempt: tries + 1, status: 429, reason: 'rate_limit', waitMs });
          await pause(waitMs, onWaited);
          continue;
        }
        if (isConnectionDrop(err)) {
          const wait = connectionWait(err, attemptAt);
          const why = String(wait.why || '').split(openaiHost()).join(deepseek.host());
          const { since } = noteFailure({ code: wait.code, why, who: deepseek.NAME });
          send({ t: 'retry', i, attempt: tries + 1, status: null, reason: 'connection', code: wait.code, why, since, waitMs: wait.waitMs, at: Date.now() });
          await pause(wait.waitMs, onWaited);
          continue;
        }
        if (tries < config.evalRetries && isRetryable(err)) {
          const waitMs = rateLimitWaitMs(err) || spacedWaitMs(attemptAt);
          send({ t: 'retry', i, attempt: tries + 1, status: err?.status ?? null, reason: 'error', waitMs });
          await pause(waitMs, onWaited);
          continue;
        }
        throw err;
      }
    }
  };

  const evaluateOnDeepSeek = async (claim, i) => {
    const startedAt = Date.now();
    const input = firstInput(evaluationPrompt(claim));
    const trail = [];
    const returned = [];   // every address FactEngine's search returned to the model
    const used = { input: 0, output: 0, reasoning: 0, cached: 0 };   // the tokens of every round
    let tokenUsd = 0;
    let toolUsd = 0;
    let priced = true;
    let rounds = 0;
    let text = '';
    let incomplete = null;
    let waited = 0;          // every round's waits, apart from the work (the line's `waitMs`)
    let firstAt = null;      // the delivered entry's first written word (its own round's), and that round's end
    let endAt = null;
    const tally = (round) => {
      for (const k of Object.keys(used)) used[k] += Number(round.usage?.[k]) || 0;
      const c = estimateTextCost({ model: trial.model, usage: round.usage, at: round.at });   // DeepSeek's price is the hour's
      tokenUsd += Number(c.usd) || 0;
      priced = priced && c.priced;
    };
    /** One call the model made, run through FactEngine's tools: a step of the trail, and its answer for the next round. */
    const runTool = async (call) => {
      const name = String(call?.name || '');
      let args = {};
      let unreadable = null;
      try {
        const parsed = call?.arguments ? JSON.parse(call.arguments) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
        else unreadable = 'they are not an object';
      } catch { unreadable = 'they are not JSON'; }
      send({ t: 'phase', i, phase: name === 'search_web' ? 'searching' : 'reading', ...(name === 'search_web' ? { searches: searchesOf(trail) + 1 } : {}) });
      const result = unreadable
        ? { content: [{ type: 'text', text: `The tool's arguments could not be read: ${unreadable}.` }], isError: true }
        : await registry.call(name, args, { signal, filedUnder: lineCtx(i), onCost: (usd) => { toolUsd += usd; } });
      const output = (result?.content || []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
      const step = markStep(toolStep({ name, arguments: args, status: result?.isError ? 'failed' : 'completed', error: result?.isError ? output.slice(0, 300) : null }));
      if (!result?.isError) returned.push(...returnedUrls(name, output));
      trail.push(step);
      send({ t: 'trail', i, step, searches: searchesOf(trail) });
      return { type: 'function_call_output', call_id: call?.call_id, output };
    };

    send({ t: 'start', i, model: trial.model, requested: trial.model, at: Date.now() });
    try {
      for (;;) {
        rounds++;
        const round = await deepseekRound({ input, i, onDelta: (d) => send({ t: 'delta', i, text: d }), onWaited: (ms) => { waited += ms; } });
        if (!round || signal.aborted) return;
        tally(round);
        const calls = round.output.filter((item) => item?.type === 'function_call');
        if (!calls.length || round.incomplete) { text = round.text; incomplete = round.incomplete; firstAt = round.firstAt; endAt = round.endAt; break; }
        // The round goes back as DeepSeek wrote it (its reasoning, held for DeepSeek alone, and its calls), then each
        // call's answer.
        input.push(...round.output);
        input.push(...await Promise.all(calls.map(runTool)));
        if (signal.aborted) return;
      }
    } catch (err) {
      if (signal.aborted) return;
      const failure = deepseek.failure(err);
      const safe = describeError(failure);
      recordFailure({ where: 'trial:deepseek', code: safe.code, message: safe.message || safe.code, detail: failure.detail || null });
      record({ kind: 'trial', ok: false, provider: 'deepseek', code: safe.code, model: trial.model, effort: trial.effort, claim: claimHash(claim), rounds, usage: used, ms: Date.now() - startedAt, usd: round4(tokenUsd + toolUsd), priced }, lineCtx(i));
      send({ t: 'error', i, code: safe.code, message: safe.message });
      completed++;
      send({ t: 'batch-progress', completed, total: claims.length });
      return;
    }

    const parsed = parseEntry(text);
    if (parsed.verdictSource === 'unread') recordFailure({ where: 'trial:verdict', code: 'verdict_unread', message: conclusionExcerpt(text) });
    const ms = Date.now() - startedAt;
    const cost = { usd: round4(tokenUsd + toolUsd), priced };
    const fromList = counted({ trail, consulted: returned });
    // No `sources`: DeepSeek gives no citations of its own (its card lists none), so the table says "—", never 0.
    recordDone({
      kind: 'trial', ok: true, provider: 'deepseek', model: trial.model, effort: trial.effort, mode: null,
      claim: claimHash(claim), chars: claim.length, verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence,
      usage: used, rounds, searches: searchesOf(trail), queries: queriesIn(trail), reads: readsOf(trail), ...fromList, incomplete, ms,
      ...measured({ ms, waitMs: waited, firstAt, endAt, text }),
      tokenUsd: round4(tokenUsd), toolUsd: round4(toolUsd), usd: cost.usd, priced,
    }, lineCtx(i));
    completed++;
    send({
      t: 'done', i,
      verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence, inspector: parsed.inspector,
      conclusion: parsed.conclusion,
      text: parsed.text,
      reasoning: null,   // DeepSeek makes no summary, and its chain of thought stays off the page
      trail, sources: [],
      model: trial.model, requested: trial.model, fellBack: null, effort: trial.effort, mode: null,
      searches: searchesOf(trail), ms, cost, incomplete, ...fromList,
      trial: true, provider: 'deepseek',
    });
    send({ t: 'batch-progress', completed, total: claims.length });
  };

  // ---- the operator's trial on Gemini (18 October) ----------------------------------------------------------------

  /** The two messages every determination begins with, as Google's Interactions API takes them: the source, then the prompt. */
  const geminiInput = (prompt) => [
    ...(document ? [{ type: 'user_input', content: [{ type: 'text', text: document }] }] : []),
    { type: 'user_input', content: [{ type: 'text', text: prompt }] },
  ];
  const searchesIn = (list) => list.filter((s) => s.kind === 'search').length;
  const readsIn = (list) => list.filter((s) => s.kind === 'open_page').length;

  /**
   * One claim on Gemini: one request, in which the model searches Google and reads pages itself, streamed. Its searches
   * and the pages it read become the card's trail, its citations the card's sources, its summary of its thinking the
   * card's reasoning, as for the readers' model. A wait is a wait, as for DeepSeek: a 429 waits for Google's figure or a
   * second from the go's start, a 5xx is tried again on the operator's count, a cut connection or a reply without its
   * last event goes again; Google's balance used up (402) ends the claim at once.
   */
  const evaluateOnGemini = async (claim, i) => {
    const prompt = evaluationPrompt(claim);
    const startedAt = Date.now();
    let text = '';
    let reasoning = '';
    let usage = null;
    let billed = null;        // the searches Google bills for the delivered go, when it says
    let incomplete = null;
    let pricedAt = null;
    const trail = [];          // the delivered go's searches and pages
    const sources = [];        // the delivered go's citations
    const seen = new Set();
    let spentSearches = 0;     // the searches of goes cut short: Google ran them, so they are paid for
    let waited = 0;            // every wait, apart from the work (the line's `waitMs`)
    let firstAt = null;        // the delivered go's first written word, and its last event
    let endAt = null;
    const waitedFor = (ms) => { waited += ms; };
    const addSources = (annotations) => {
      for (const a of annotations || []) {
        if (a?.type !== 'url_citation' || !a.url || seen.has(a.url)) continue;
        seen.add(a.url);
        const source = markSource({ url: a.url, title: a.title || a.url });
        sources.push(source);
        send({ t: 'source', i, source });
      }
    };
    const addText = (piece) => { if (piece) { if (firstAt === null) firstAt = Date.now(); text += piece; send({ t: 'delta', i, text: piece }); } };
    const addThought = (piece) => { if (piece) { reasoning += piece; send({ t: 'reasoning', i, text: piece }); } };
    let lastSaid = null;       // the wording of Google's last refusal kept for this claim, its figures aside

    for (let tries = 0; ; tries++) {
      const attemptAt = Date.now();
      // Each go starts its own record, as the page starts its row again at `start`.
      spentSearches += searchesIn(trail);
      trail.length = 0;
      sources.length = 0;
      seen.clear();
      text = '';
      reasoning = '';
      usage = null;
      billed = null;
      incomplete = null;
      firstAt = null;
      endAt = null;
      try {
        // The model, the two messages, the operator's level with Gemini's own summary of its thinking, Google's search and
        // its page reading, the stream, and store: false (Google would otherwise keep the interaction for 55 days).
        // Nothing else: no output cap, no sampling setting, no system instruction.
        const body = {
          model: trial.model,
          input: geminiInput(prompt),
          generation_config: { thinking_level: trial.effort, thinking_summaries: 'auto' },
          tools: [{ type: 'google_search' }, { type: 'url_context' }],
          stream: true,
          store: false,
        };
        const events = await gemini.stream(body, { key: apiKey, signal });
        noteReply(gemini.NAME);
        pricedAt = attemptAt;
        send({ t: 'start', i, model: trial.model, requested: trial.model, at: Date.now() });
        let ended = false;
        const steps = new Map();   // index → the step in flight: its type and what it named
        const pages = new Map();   // url → its trail step, so Google's report of the read can say how it went
        for await (const ev of events) {
          if (signal.aborted) return;
          switch (ev.type) {
            case 'step.start': {
              const s = ev.step || {};
              steps.set(ev.index, { type: s.type, queries: [...(s.arguments?.queries || [])], urls: [...(s.arguments?.urls || [])], results: Array.isArray(s.result) ? [...s.result] : [] });
              if (s.type === 'thought') for (const part of s.summary || []) addThought(part?.type === 'text' ? part.text : '');
              else if (s.type === 'model_output') for (const c of s.content || []) { if (c?.type === 'text') { addText(c.text); addSources(c.annotations); } }
              else if (s.type === 'google_search_call') send({ t: 'phase', i, phase: 'searching', searches: searchesIn(trail) + 1 });
              else if (s.type === 'url_context_call') send({ t: 'phase', i, phase: 'reading' });
              break;
            }
            case 'step.delta': {
              const d = ev.delta || {};
              const step = steps.get(ev.index);
              if (d.type === 'text') { addText(d.text); addSources(d.annotations); }
              else if (d.type === 'thought_summary') addThought(d.content?.type === 'text' ? d.content.text : '');
              else if (d.type === 'text_annotation_delta' || d.type === 'text_annotation') addSources(d.annotations);
              else if (step && d.type === 'google_search_call') step.queries.push(...(d.arguments?.queries || []));
              else if (step && d.type === 'url_context_call') step.urls.push(...(d.arguments?.urls || []));
              else if (step && (d.type === 'url_context_result' || d.type === 'google_search_result')) step.results.push(...(Array.isArray(d.result) ? d.result : []));
              // thought_signature: Gemini's own, neither sent nor kept.
              break;
            }
            case 'step.stop': {
              const step = steps.get(ev.index);
              steps.delete(ev.index);
              if (!step) break;
              if (step.type === 'thought') { if (reasoning && !reasoning.endsWith('\n\n')) reasoning += '\n\n'; }
              else if (step.type === 'google_search_call') {
                for (const query of step.queries) {
                  const t = { kind: 'search', verb: 'search', query, url: null, pattern: null, status: 'completed' };
                  trail.push(t);
                  send({ t: 'trail', i, step: t, searches: searchesIn(trail) });
                }
              } else if (step.type === 'url_context_call') {
                for (const url of step.urls) {
                  const t = markStep({ kind: 'open_page', verb: 'open', query: null, url, pattern: null, status: null });   // its status comes with Google's report
                  trail.push(t);
                  pages.set(url, t);
                  send({ t: 'trail', i, step: t, searches: searchesIn(trail) });
                }
              } else if (step.type === 'url_context_result') {
                for (const r of step.results) { const t = pages.get(r?.url); if (t) t.status = r?.status === 'success' ? 'completed' : r?.status || null; }
              }
              break;
            }
            case 'interaction.completed': {
              const it = ev.interaction || {};
              if (it.status === 'failed') throw gemini.streamError({ error: it.error || { code: 'api_error', message: 'Gemini ended the interaction as failed.' } });
              ended = true;
              usage = gemini.usageOf(it.usage);
              billed = gemini.searchesBilled(it.usage);
              if (it.status && it.status !== 'completed') {
                incomplete = it.incomplete_details?.reason || it.status;
                send({ t: 'phase', i, phase: 'incomplete', reason: incomplete });
              }
              break;
            }
            case 'error':
              throw gemini.streamError(ev);
            default:
              break;
          }
        }
        // A reply that stops without its last word was cut, however politely: it goes again, as a cut connection does.
        if (!ended && !signal.aborted) throw cutReply();
        endAt = Date.now();
        break;
      } catch (err) {
        if (signal.aborted) return;
        // Google's limit for this key is nothing ("limit: 0 … on Free Tier"): no wait can let it through, so it is no
        // wait. The fact-check stops below and says why, in Google's sentence (the operator's answer of 19 October:
        // "Stop and say why").
        const outright = gemini.limitZero(err);
        if (!gemini.balanceGone(err) && !outright) {
          // Every other 429 of Google's is a wait: a rate limit, a daily quota, the tier's spend limit. (Google words its
          // rate limits as a quota "exceeded"; OpenAI's reading of those words as its own billing does not apply here.)
          // The wait is Google's own figure; when it names none, a second from this go's start, never at once. The card
          // says whose wait it is, until when, and why, in Google's words (the operator's answer of 18 October: "Say why
          // and keep waiting"), and the words are kept on /check and in the log, once for each new wording on this
          // claim: Google's figures change from one refusal to the next, its reason seldom does.
          if (err?.status === 429) {
            const waitMs = err.waitMs > 0 ? err.waitMs : spacedWaitMs(attemptAt);
            const why = gemini.words(err);
            const said = why.replace(/\d+(?:\.\d+)?/g, '#');
            if (said !== lastSaid) {
              lastSaid = said;
              const asked = `Google asked ${trial.model} at ${trial.effort} to wait ${Math.round(waitMs / 1000)} s`;
              recordFailure({ where: 'trial:gemini', code: 'rate_limited', status: 429, message: `${asked} (refusal ${tries + 1} of this fact-check).`, detail: why || null });
              console.log(`[gemini] ${asked} (refusal ${tries + 1} of this fact-check): "${why}"`);
            }
            send({ t: 'retry', i, attempt: tries + 1, status: 429, reason: 'rate_limit', waitMs, who: gemini.PROVIDER, why, until: Date.now() + waitMs });
            await pause(waitMs, waitedFor);
            continue;
          }
          if (isConnectionDrop(err)) {
            const wait = connectionWait(err, attemptAt);
            const why = String(wait.why || '').split(openaiHost()).join(gemini.host());
            const { since } = noteFailure({ code: wait.code, why, who: gemini.NAME });
            send({ t: 'retry', i, attempt: tries + 1, status: null, reason: 'connection', code: wait.code, why, since, waitMs: wait.waitMs, at: Date.now() });
            await pause(wait.waitMs, waitedFor);
            continue;
          }
          if (tries < config.evalRetries && isRetryable(err)) {
            const waitMs = err.waitMs > 0 ? err.waitMs : spacedWaitMs(attemptAt);
            send({ t: 'retry', i, attempt: tries + 1, status: err?.status ?? null, reason: 'error', waitMs });
            await pause(waitMs, waitedFor);
            continue;
          }
        }
        // Anything else (a key refused, the balance used up, a request Google will not take): the claim ends with
        // FactEngine's own sentence, and Google's words go to /check. A limit of 0 ends it with Google's sentence on the
        // card as well, saying whose it is, since only the key's project can change it.
        const failure = gemini.failure(err);
        const safe = describeError(failure);
        recordFailure({ where: 'trial:gemini', code: safe.code, message: safe.message || safe.code, detail: failure.detail || null });
        const why = outright ? gemini.words(err) : null;
        if (outright) console.log(`[gemini] Google refused ${trial.model} at ${trial.effort} outright, its limit for this key being 0: "${why}"`);
        const searches = spentSearches + searchesIn(trail);
        const spent = estimateTextCost({ model: trial.model, usage: null, searches, at: startedAt });
        record({ kind: 'trial', ok: false, provider: 'gemini', code: safe.code, model: trial.model, effort: trial.effort, claim: claimHash(claim), searches, ms: Date.now() - startedAt, usd: spent.usd, priced: false }, lineCtx(i));
        send({ t: 'error', i, code: safe.code, message: outright ? why : safe.message, ...(outright ? { who: gemini.PROVIDER } : {}) });
        completed++;
        send({ t: 'batch-progress', completed, total: claims.length });
        return;
      }
    }

    if (signal.aborted) return;
    const parsed = parseEntry(text);
    if (parsed.verdictSource === 'unread') recordFailure({ where: 'trial:verdict', code: 'verdict_unread', message: conclusionExcerpt(text) });
    const ms = Date.now() - startedAt;
    // Google's own count of the searches it bills, when it gives one; else the searches the model named. Plus those of
    // goes cut short.
    const searches = (billed ?? searchesIn(trail)) + spentSearches;
    const tokens = estimateTextCost({ model: trial.model, usage, at: pricedAt });   // the day's price: Argon's changes on 1 December
    const all = estimateTextCost({ model: trial.model, usage, searches, at: pricedAt });
    const cost = { usd: all.usd, priced: all.priced };
    const fromList = counted({ sources, trail });   // Google's API cannot keep a site out: counted only
    recordDone({
      kind: 'trial', ok: true, provider: 'gemini', model: trial.model, effort: trial.effort, mode: null,
      claim: claimHash(claim), chars: claim.length, verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence,
      usage, searches, queries: queriesIn(trail), reads: readsIn(trail), sources: sources.length, ...fromList, incomplete, ms,
      ...measured({ ms, waitMs: waited, firstAt, endAt, text }),
      tokenUsd: tokens.usd, searchUsd: round4(all.usd - tokens.usd), usd: cost.usd, priced: cost.priced,
    }, lineCtx(i));
    completed++;
    send({
      t: 'done', i,
      verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence, inspector: parsed.inspector,
      conclusion: parsed.conclusion,
      text: parsed.text,
      reasoning: reasoning.trim() || null,   // Gemini's own summary of its thinking, as the readers' model's
      trail, sources,
      model: trial.model, requested: trial.model, fellBack: null, effort: trial.effort, mode: null,
      searches: searchesIn(trail), ms, cost, incomplete, ...fromList,
      trial: true, provider: 'gemini',
    });
    send({ t: 'batch-progress', completed, total: claims.length });
  };

  // ---- the operator's trial on Claude (26 October) ------------------------------------------------------------------

  /** The two texts every determination begins with, as Anthropic's Messages API takes them: the source, then the prompt, in one message. */
  const anthropicContent = (prompt) => [
    ...(document ? [{ type: 'text', text: document }] : []),
    { type: 'text', text: prompt },
  ];
  /**
   * Anthropic's web search and page reader, each told to leave out the operator's lists (server/sites.js): the search
   * both lists, columns included; the page reader, which matches a site and never a path, every site of them. Nothing
   * else: no cap on their uses, Anthropic's own settings for the rest.
   */
  const anthropicTools = () => {
    const { search, fetch } = anthropicExclusions();
    return [
      { type: 'web_search_20260318', name: 'web_search', ...(search.length ? { blocked_domains: search } : {}) },
      { type: 'web_fetch_20260318', name: 'web_fetch', ...(fetch.length ? { blocked_domains: fetch } : {}) },
    ];
  };
  const addUsage = (a, b) => (!b ? a : !a ? { ...b } : { input: a.input + b.input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cached: a.cached + b.cached });

  /**
   * One claim on Claude: one request, in which the model searches and reads pages with Anthropic's own tools, streamed;
   * when Anthropic pauses a long turn (`pause_turn`), the turn goes back to it as it stands, with the same tools, until
   * it ends, every turn's tokens and searches counted. Its searches and the pages it read become the card's trail, its
   * citations the card's sources, its summary of its thinking the card's reasoning. A wait is a wait: a 429 or a 529
   * waits for Anthropic's retry-after or a second from the turn's start, a 5xx is tried again on the operator's count,
   * a cut connection or a reply without its last event goes again; each goes again from the last finished turn, never
   * from the start. A decline ends the claim with Anthropic's own words, and nothing else answers in its place (the
   * operator's answer of 26 October); the balance used up ends it at once.
   */
  // `on`: whose fact-check this is. The operator's trial on Claude by default; or a reader's claim gone once more to the
  // readers' standby (server/standby.js), which is the readers' determination, booked, measured and charged as one.
  const evaluateOnAnthropic = async (claim, i, on = { model: trial?.model, effort: trial?.effort, key: apiKey, standby: false }) => {
    const prompt = evaluationPrompt(claim);
    const startedAt = Date.now();
    const tools = anthropicTools();
    let ceiling = null;        // the model's own ceiling for `max_tokens`, from Anthropic's Models API
    // The entry as it stood at its last finished turn: what a turn cut short goes again from, and what the card is given
    // again when it does. A paused turn is a finished one.
    const empty = () => ({ messages: [{ role: 'user', content: anthropicContent(prompt) }], container: null, text: '', reasoning: '', trail: [], sources: [], consulted: [], usage: null, billed: 0, firstAt: null });
    let kept = empty();
    let text = '';
    let reasoning = '';
    let trail = [];
    let sources = [];
    let consulted = [];        // every address Anthropic's searches returned, to count what was taken of the lists
    let seen = new Set();
    let firstAt = null;
    let endAt = null;
    let incomplete = null;
    let pricedAt = null;
    let spentSearches = 0;     // the searches of turns cut short: Anthropic ran them, so they are paid for
    let waited = 0;            // every wait, apart from the work (the line's `waitMs`)
    let anew = true;           // whether the next reply starts the card's row again (the first, and one after a failure)
    let tries = 0;             // the failures of this claim so far
    let lastSaid = null;       // the wording of Anthropic's last wait kept for this claim, its figures aside
    const waitedFor = (ms) => { waited += ms; };
    const addSource = (c) => {
      if (c?.type !== 'web_search_result_location' || !c.url || seen.has(c.url)) return;
      seen.add(c.url);
      const source = markSource({ url: c.url, title: c.title || c.url });
      sources.push(source);
      send({ t: 'source', i, source });
    };
    const addText = (piece) => { if (piece) { if (firstAt === null) firstAt = Date.now(); text += piece; send({ t: 'delta', i, text: piece }); } };
    const addThought = (piece) => { if (piece) { reasoning += piece; send({ t: 'reasoning', i, text: piece }); } };
    // Back to the last finished turn, after a failure; and the card, once the next reply begins, starts its row again
    // and is given that much again.
    const rollback = () => {
      text = kept.text; reasoning = kept.reasoning; trail = [...kept.trail]; sources = [...kept.sources]; consulted = [...kept.consulted];
      seen = new Set(sources.map((s) => s.url)); firstAt = kept.firstAt; incomplete = null;
    };
    const resume = () => {
      send({ t: 'start', i, model: on.model, requested: on.standby ? models[0] : on.model, at: Date.now() });
      if (reasoning) send({ t: 'reasoning', i, text: reasoning });
      for (const step of trail) send({ t: 'trail', i, step, searches: searchesIn(trail) });
      for (const source of sources) send({ t: 'source', i, source });
      if (text) send({ t: 'delta', i, text });
    };

    for (;;) {
      const attemptAt = Date.now();
      try {
        if (ceiling === null) ceiling = await anthropic.ceiling(on.model, { key: on.key });
        // The model, its own ceiling for what it writes, the two texts, the operator's level, Claude's summary of its
        // thinking, Anthropic's two tools and the stream; a paused turn's own reply and container go back with it.
        // Nothing else: no sampling setting, no system prompt, no cap on the tools.
        const body = {
          model: on.model,
          max_tokens: ceiling,
          messages: kept.messages,
          output_config: { effort: on.effort },
          thinking: { type: 'adaptive', display: 'summarized' },
          tools,
          stream: true,
          ...(kept.container ? { container: kept.container } : {}),
        };
        const { events, final } = anthropic.stream(body, { key: on.key, signal });
        let ended = false;
        let stop = null;
        let details = null;
        const blocks = new Map();   // index → the block in flight: its type, tool, id and input as it streams
        const steps = new Map();    // a tool call's id → its trail step, so the result can say how it went
        for await (const ev of events) {
          if (signal.aborted) return;
          switch (ev.type) {
            case 'message_start':
              noteReply(anthropic.NAME);
              if (pricedAt === null) pricedAt = attemptAt;
              if (anew) { anew = false; resume(); }
              break;
            case 'content_block_start': {
              const b = ev.content_block || {};
              blocks.set(ev.index, { type: b.type, name: b.name, id: b.id, json: '', input: b.input });
              if (b.type === 'text') { addText(b.text); for (const c of b.citations || []) addSource(c); }
              else if (b.type === 'thinking') addThought(b.thinking);
              else if (b.type === 'server_tool_use' && b.name === 'web_search') send({ t: 'phase', i, phase: 'searching', searches: searchesIn(trail) + 1 });
              else if (b.type === 'server_tool_use' && b.name === 'web_fetch') send({ t: 'phase', i, phase: 'reading' });
              else if (b.type === 'web_search_tool_result') {
                const step = steps.get(b.tool_use_id);
                const results = Array.isArray(b.content) ? b.content : null;
                if (step) step.status = results ? 'completed' : b.content?.error_code || 'error';
                for (const r of results || []) if (r?.url) consulted.push(r.url);
              } else if (b.type === 'web_fetch_tool_result') {
                const step = steps.get(b.tool_use_id);
                if (step) step.status = b.content?.type === 'web_fetch_result' ? 'completed' : b.content?.error_code || 'error';
              }
              break;
            }
            case 'content_block_delta': {
              const d = ev.delta || {};
              const block = blocks.get(ev.index);
              if (d.type === 'text_delta') addText(d.text);
              else if (d.type === 'thinking_delta') addThought(d.thinking);
              else if (d.type === 'citations_delta') addSource(d.citation);
              else if (d.type === 'input_json_delta' && block) block.json += d.partial_json || '';
              // signature_delta: Claude's own, sent back only inside a paused turn, as Anthropic returned it.
              break;
            }
            case 'content_block_stop': {
              const block = blocks.get(ev.index);
              blocks.delete(ev.index);
              if (!block) break;
              if (block.type === 'thinking') { if (reasoning && !reasoning.endsWith('\n\n')) reasoning += '\n\n'; break; }
              if (block.type !== 'server_tool_use' || (block.name !== 'web_search' && block.name !== 'web_fetch')) break;
              let input = block.input && typeof block.input === 'object' ? block.input : {};
              if (block.json) { try { input = JSON.parse(block.json); } catch { /* the call as Anthropic began it */ } }
              const step = block.name === 'web_search'
                ? { kind: 'search', verb: 'search', query: typeof input.query === 'string' ? input.query : null, url: null, pattern: null, status: null }
                : markStep({ kind: 'open_page', verb: 'open', query: null, url: typeof input.url === 'string' ? input.url : null, pattern: null, status: null });
              trail.push(step);
              if (block.id) steps.set(block.id, step);
              send({ t: 'trail', i, step, searches: searchesIn(trail) });
              break;
            }
            case 'message_delta':
              if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
              if (ev.delta?.stop_details) details = ev.delta.stop_details;
              break;
            case 'message_stop':
              ended = true;
              break;
            default:
              break;
          }
        }
        if (signal.aborted) return;
        // A reply that stops without its last word was cut, however politely: it goes again, as a cut connection does.
        // An error Anthropic sent in it that the events did not raise is raised here, with its status.
        if (!ended) {
          let held = null;
          try { await final(); } catch (err) { held = err; }
          throw held?.status ? held : cutReply();
        }
        const message = await final();
        stop = message?.stop_reason || stop;
        details = message?.stop_details || details;
        const turnUsage = anthropic.usageOf(message?.usage);
        const turnSearches = anthropic.searchesBilled(message?.usage) ?? (searchesIn(trail) - searchesIn(kept.trail));
        // A finished turn is kept: whatever happens next goes again from here.
        kept = {
          messages: stop === 'pause_turn' ? [...kept.messages, { role: 'assistant', content: message.content }] : kept.messages,
          container: message?.container?.id || kept.container,
          text, reasoning, trail: [...trail], sources: [...sources], consulted: [...consulted],
          usage: addUsage(kept.usage, turnUsage), billed: kept.billed + turnSearches, firstAt,
        };
        if (stop === 'pause_turn') continue;   // Anthropic paused the turn: it goes back as it stands
        if (stop === 'refusal') {
          // Anthropic declined the claim: the claim ends with Anthropic's words, and nothing else answers in its place.
          const said = anthropic.declineWords(details);
          const searches = kept.billed + spentSearches;
          const spent = estimateTextCost({ model: on.model, usage: kept.usage, searches, at: pricedAt });
          recordFailure({ where: on.standby ? 'evaluate:standby' : 'trial:anthropic', code: 'declined', message: `${said} (${on.model} at ${on.effort}).`, detail: details?.category || null });
          console.log(`[anthropic] ${said.replace(/\.$/, '')} (${on.model} at ${on.effort})`);
          record({ kind: on.standby ? 'evaluate' : 'trial', ok: false, provider: 'anthropic', ...(on.standby ? { standby: true, requested: models[0] } : {}), code: 'declined', model: on.model, effort: on.effort, claim: claimHash(claim), usage: kept.usage, searches, ms: Date.now() - startedAt, usd: spent.usd, priced: spent.priced }, lineCtx(i));
          send({ t: 'error', i, code: 'declined', message: said });
          completed++;
          send({ t: 'batch-progress', completed, total: claims.length });
          return;
        }
        if (stop && stop !== 'end_turn' && stop !== 'stop_sequence') {
          incomplete = stop;   // max_tokens, the context window, or anything else that ended the turn early
          send({ t: 'phase', i, phase: 'incomplete', reason: incomplete });
        }
        endAt = Date.now();
        break;
      } catch (err) {
        if (signal.aborted) return;
        tries++;
        anew = true;
        // What the cut turn searched was searched: it is paid for, and the turn goes again from the last finished one.
        spentSearches += Math.max(0, searchesIn(trail) - searchesIn(kept.trail));
        rollback();
        if (!anthropic.balanceGone(err)) {
          // A rate limit (429) or Anthropic overloaded (529) is a wait: Anthropic's own figure, or a second from this
          // turn's start, never at once. The card says whose wait it is, until when, and why, in Anthropic's words, and
          // the words are kept on /check and in the log, once for each new wording on this claim.
          if (anthropic.isWait(err)) {
            const waitMs = err.waitMs > 0 ? err.waitMs : spacedWaitMs(attemptAt);
            const why = anthropic.words(err);
            const said = why.replace(/\d+(?:\.\d+)?/g, '#');
            if (said !== lastSaid) {
              lastSaid = said;
              const asked = `Anthropic asked ${on.model} at ${on.effort} to wait ${Math.round(waitMs / 1000)} s (${err.status})`;
              recordFailure({ where: on.standby ? 'evaluate:standby' : 'trial:anthropic', code: err.status === 529 ? 'overloaded' : 'rate_limited', status: err.status, message: `${asked} (refusal ${tries} of this fact-check).`, detail: why || null });
              console.log(`[anthropic] ${asked} (refusal ${tries} of this fact-check): "${why}"`);
            }
            send({ t: 'retry', i, attempt: tries, status: err.status, reason: 'rate_limit', waitMs, who: anthropic.PROVIDER, why, until: Date.now() + waitMs });
            await pause(waitMs, waitedFor);
            continue;
          }
          if (isConnectionDrop(err)) {
            const wait = connectionWait(err, attemptAt);
            const why = String(wait.why || '').split(openaiHost()).join(anthropic.host());
            const { since } = noteFailure({ code: wait.code, why, who: anthropic.NAME });
            send({ t: 'retry', i, attempt: tries, status: null, reason: 'connection', code: wait.code, why, since, waitMs: wait.waitMs, at: Date.now() });
            await pause(wait.waitMs, waitedFor);
            continue;
          }
          if (tries <= config.evalRetries && isRetryable(err)) {
            const waitMs = err.waitMs > 0 ? err.waitMs : spacedWaitMs(attemptAt);
            send({ t: 'retry', i, attempt: tries, status: err?.status ?? null, reason: 'error', waitMs });
            await pause(waitMs, waitedFor);
            continue;
          }
        }
        // Anything else (a key refused, the balance used up, a request Anthropic will not take): the claim ends with
        // FactEngine's own sentence, and Anthropic's words go to /check.
        const failure = anthropic.failure(err);
        const safe = describeError(failure);
        recordFailure({ where: on.standby ? 'evaluate:standby' : 'trial:anthropic', code: safe.code, message: safe.message || safe.code, detail: failure.detail || null });
        const searches = kept.billed + spentSearches;
        const spent = estimateTextCost({ model: on.model, usage: kept.usage, searches, at: pricedAt ?? startedAt });
        record({ kind: on.standby ? 'evaluate' : 'trial', ok: false, provider: 'anthropic', ...(on.standby ? { standby: true, requested: models[0] } : {}), code: safe.code, model: on.model, effort: on.effort, claim: claimHash(claim), usage: kept.usage, searches, ms: Date.now() - startedAt, usd: spent.usd, priced: Boolean(kept.usage) && spent.priced }, lineCtx(i));
        send({ t: 'error', i, code: safe.code, message: safe.message });
        completed++;
        send({ t: 'batch-progress', completed, total: claims.length });
        return;
      }
    }

    if (signal.aborted) return;
    const parsed = parseEntry(text);
    if (parsed.verdictSource === 'unread') recordFailure({ where: on.standby ? 'server:verdict' : 'trial:verdict', code: 'verdict_unread', message: conclusionExcerpt(text) });
    const ms = Date.now() - startedAt;
    // Anthropic's own count of the searches it bills, turn by turn; plus those of turns cut short.
    const searches = kept.billed + spentSearches;
    const usage = kept.usage;
    const tokens = estimateTextCost({ model: on.model, usage, at: pricedAt });
    const all = estimateTextCost({ model: on.model, usage, searches, at: pricedAt });
    const cost = { usd: all.usd, priced: all.priced };
    const fromList = counted({ sources, trail, consulted });
    recordDone({
      kind: on.standby ? 'evaluate' : 'trial', ok: true, provider: 'anthropic', model: on.model, effort: on.effort, mode: null,
      ...(on.standby ? { standby: true, requested: models[0] } : {}),
      claim: claimHash(claim), chars: claim.length, verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence,
      usage, searches, queries: queriesIn(trail), reads: readsIn(trail), sources: sources.length, ...fromList, incomplete, ms,
      ...measured({ ms, waitMs: waited, firstAt, endAt, text }),
      tokenUsd: tokens.usd, searchUsd: round4(all.usd - tokens.usd), usd: cost.usd, priced: cost.priced,
    }, lineCtx(i));
    completed++;
    send({
      t: 'done', i,
      verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence, inspector: parsed.inspector,
      conclusion: parsed.conclusion,
      text: parsed.text,
      reasoning: reasoning.trim() || null,   // Claude's own summary of its thinking, as the readers' model's
      trail, sources,
      model: on.model, requested: on.standby ? models[0] : on.model, fellBack: on.standby ? { used: on.model, requested: models[0] } : null,
      effort: on.effort, mode: null, standby: on.standby,
      searches: searchesIn(trail), ms, cost, incomplete, ...fromList,
      ...(on.standby ? { provider: 'anthropic' } : { trial: true, provider: 'anthropic' }),
    });
    send({ t: 'batch-progress', completed, total: claims.length });
  };

  const run = onDeepSeek ? evaluateOnDeepSeek : onGemini ? evaluateOnGemini : onAnthropic ? evaluateOnAnthropic : evaluateOne;
  const queue = claims.map((c, i) => [c, i]);
  const workers = Array.from({ length: Math.min(config.evalConcurrency, total) }, async () => {
    while (queue.length && !signal.aborted) {
      const [claim, i] = queue.shift();
      await run(claim, i);
    }
  });
  await Promise.all(workers);
  if (!signal.aborted) send({ t: 'complete', total, completed, ms: Date.now() - started });
}
