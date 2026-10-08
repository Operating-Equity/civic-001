// Step 2 — each claim is tested by the protected evaluation prompt, sent verbatim.
// Three claims at a time (config.evalConcurrency). What is tested is the claim's whole entry as the
// extractor wrote it (Claim, Attribution, what the source leaves unspecified), and the source goes
// ahead of the prompt as its own message, as the conversation carried it in the workflow the
// prompts were tested in. A claim tested bare, with "the speech" and no speaker or date, was
// being tested without the context the extraction prompt had written for it.
//
// Nothing the model returns is edited, trimmed or withheld. The card receives the complete
// output text, the reasoning summary, every web search the model performed, and every source
// it cited. The verdict is read out of the model's own Conclusion, in whatever form the model
// wrote it (server/verdict.js); an entry that states no verdict at all is Unverified, by the
// operator's ruling, and its closing words are recorded for /check.
//
// When the reader may converse with the inspector (server/chat.js), the result also carries what the conversation
// goes on with: the inspector's letter, the answer's message items as OpenAI listed them, and the server's seal over
// exactly what was asked and answered. The request is the same either way.
import { config } from './config.js';
import { evaluationPrompt } from './prompts.js';
import { clientFor, withModelFallback, describeError, throughGate } from './openai.js';
import { gateFor } from './gate.js';
import { record as recordFailure } from './diagnostics.js';
import { estimateTextCost } from './pricing.js';
import { record, claimHash } from './ledger.js';
import { parseEntry, conclusionExcerpt, inspectorOf } from './verdict.js';
import { requestTools, searchCount } from './tools/request.js';
import { newReply, readReply, goAgain } from './respond.js';
import { chatOpening } from './chat.js';
export { parseEntry, VERDICTS } from './verdict.js';

export async function runEvaluation({ apiKey, claims, document = '', send, signal, ctx = {} }) {
  const client = clientFor(apiKey);
  // Whose work each claim's line is: the run, the sign-in, and the determination's own id (server/economics.js).
  const lineCtx = (i) => ({ runId: ctx.runId || null, owner: ctx.owner || null, determinationId: ctx.determinationIds?.[i] || null });
  // Whose turn the request takes at the gate: the sign-in when the door is shut, else the run, else the job.
  const owner = ctx.owner || ctx.runId || ctx.jobId || null;
  const total = claims.length;
  let completed = 0;
  const started = Date.now();
  send({ t: 'batch-start', total, at: started, model: config.evalModels[0], effort: config.evalEffort, mode: config.evalReasoningMode || null });

  const tools = requestTools(); // web search always (the prompts were tested with it); CIVIC's own tools when the gateway is set

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

  const evaluateOne = async (claim, i) => {
    const prompt = evaluationPrompt(claim);
    const startedAt = Date.now();
    // The claim's reply. Its trail and its sources run across its goes (a search a cut go made was made and paid for);
    // its words, its reasoning summary and its message items are each go's own.
    const acc = newReply();
    let modelUsed = null;
    let wantSummary = Boolean(config.evalReasoningSummary);
    let fellBack = null;
    let sent = null;   // the body of the go that answered: the conversation goes on with exactly that

    const request = (model) => {
      // The operator's tested configuration and nothing else. No cap, no mode, no verbosity,
      // no context size. `npm run verify` fails if any other key ever appears here.
      const reasoning = { effort: config.evalEffort };
      if (config.evalReasoningMode) reasoning.mode = config.evalReasoningMode; // pro: more model work per answer, at the same rates
      if (wantSummary) reasoning.summary = config.evalReasoningSummary;
      const body = {
        model,
        // The source ahead, as its own message, then the prompt verbatim with the entry in its slot.
        input: [
          ...(document ? [{ role: 'user', content: [{ type: 'input_text', text: document }] }] : []),
          { role: 'user', content: [{ type: 'input_text', text: prompt }] },
        ],
        reasoning,
        tools,
        stream: true,
        store: false, // the prompt must not appear in any dashboard: the operator's key runs every request
      };
      sent = body;
      // Through the gate: sent only when the key's minute holds it. A held claim's row says so, in figures.
      return throughGate(client, body, { kind: 'determination', owner, signal, onHold: (h) => send({ t: 'phase', i, phase: 'queued', ...h }) });
    };

    for (let tries = 0; ; tries++) {
      const attemptAt = Date.now();
      try {
        acc.text = '';
        acc.reasoning = '';
        acc.items = [];
        await withModelFallback('evaluate', config.evalModels, async (model) => {
          const { data: stream, release } = await request(model);
          modelUsed = model;
          announceGate(model);
          try {
            send({ t: 'start', i, model, requested: config.evalModels[0], at: Date.now() });
            await readReply(stream, { acc, send, i, signal, failure: 'evaluation failed' });
          } finally {
            release();   // the gate learns the request is over, whatever ended it
          }
        }, (f) => { fellBack = f; send({ t: 'warning', i, code: 'model_fallback', ...f }); });
        break;
      } catch (err) {
        if (signal.aborted) return;
        // Reasoning summaries need a verified organisation on some accounts. Drop them and keep going.
        if (wantSummary && err?.status === 400 && /summar/i.test(String(err?.error?.message || err?.message || ''))) {
          wantSummary = false;
          send({ t: 'note', i, code: 'no_reasoning_summary' });
          continue;
        }
        // A refusal inside the stream, a cut connection or a 5xx is a wait and another go (server/respond.js).
        if (await goAgain(err, { tries, attemptAt, kind: 'determination', model: modelUsed || config.evalModels[0], send, i, retries: config.evalRetries })) continue;
        const safe = describeError(err);
        record({ kind: 'evaluate', ok: false, code: safe.code, model: modelUsed, effort: config.evalEffort, claim: claimHash(claim), ms: Date.now() - startedAt }, lineCtx(i));
        send({ t: 'error', i, code: safe.code, message: safe.message });
        completed++;
        send({ t: 'batch-progress', completed, total });
        return;
      }
    }

    if (signal.aborted) return;
    const { text, reasoning, usage, trail, sources, incomplete } = acc;
    const parsed = parseEntry(text);
    // The Name line opens its line in the answer's own message; run together with a preamble the model wrote before it
    // (a message of its own, phase commentary), it may not open a line of the whole text. Each message is read too.
    if (!parsed.inspector) parsed.inspector = acc.items.map((it) => inspectorOf(it.text)).find(Boolean) || null;
    // An entry whose Conclusion could not be read counts as Unverified; what it said at its
    // Conclusion is kept for /check, so the reader can be corrected to the form the model wrote.
    if (parsed.verdictSource === 'unread') recordFailure({ where: 'server:verdict', code: 'verdict_unread', message: conclusionExcerpt(text) });
    const ms = Date.now() - startedAt;
    const cost = estimateTextCost({ model: modelUsed, usage, searches: searchCount(trail) });
    record({
      kind: 'evaluate', ok: true, model: modelUsed, effort: config.evalEffort, mode: config.evalReasoningMode || null, webSearch: true,
      claim: claimHash(claim), chars: claim.length, fellBack: fellBack?.used || null, verdict: parsed.verdict, verdictSource: parsed.verdictSource,
      confidence: parsed.confidence, usage, searches: searchCount(trail), sources: sources.length, incomplete, ms,
      usd: cost.usd, priced: cost.priced,
    }, lineCtx(i));
    // What a conversation with this result's inspector goes on with, when the reader may hold one (server/chat.js).
    const chat = ctx.chat
      ? chatOpening({
        det: ctx.determinationIds?.[i] || ctx.jobId || null, run: ctx.runId || null, n: ctx.n ?? null, owner: ctx.owner || null,
        day: ctx.day || null, document, prompt, body: sent, items: acc.items.length ? acc.items : [{ phase: null, text }], inspector: parsed.inspector,
      })
      : null;
    completed++;
    send({
      t: 'done', i,
      verdict: parsed.verdict, verdictSource: parsed.verdictSource, confidence: parsed.confidence, inspector: parsed.inspector,
      conclusion: parsed.conclusion, // the Conclusion section, for the closed row
      text: parsed.text,            // complete, unmodified
      reasoning: reasoning.trim() || null,
      trail, sources,
      model: modelUsed, requested: config.evalModels[0], fellBack, effort: config.evalEffort, mode: config.evalReasoningMode || null, // no token figures go to the page; the ledger keeps them
      searches: searchCount(trail), ms, cost, incomplete,
      ...(chat ? { chat } : {}),
    });
    send({ t: 'batch-progress', completed, total });
  };

  const queue = claims.map((c, i) => [c, i]);
  const workers = Array.from({ length: Math.min(config.evalConcurrency, total) }, async () => {
    while (queue.length && !signal.aborted) {
      const [claim, i] = queue.shift();
      await evaluateOne(claim, i);
    }
  });
  await Promise.all(workers);
  if (!signal.aborted) send({ t: 'complete', total, completed, ms: Date.now() - started });
}
