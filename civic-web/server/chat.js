// The conversation under every fact-check, in place of the challenge (the operator, 7–8 October: "My goal is to change
// challenge to chat", from a guide of their own). The fact-check stays exactly as it was asked and answered:
// it is the conversation's first turn. Each reply is asked with:
//   instructions  the operator's chat prompt above its question line (server/prompts.js), the same on every reply,
//                 the inspector's name and letter in its slots;
//   input         the fact-check's two messages exactly as they were sent (the source, rebuilt with the day it was
//                 stamped with, then the evaluation prompt with the claim) and its answer word for word, each message
//                 with its phase; every earlier question as it was asked and every reply as it was delivered, roles
//                 kept; then the reader's message, once, with any evidence;
//   the rest      the same model, reasoning and tools as the fact-check, read from its seal, never from the page or
//                 today's settings; streamed; store false.
// Nothing is summarised. The model's private reasoning is not carried from one reply to the next (the guide's §9, the
// operator's answer of 8 October): each reply thinks afresh, under the same instructions, over the conversation as
// written.
//
// In chat the inspector is Inspector A, the first letter of its own first name (the operator, 8 October). The name
// never enters a chat event: the page is told the letter. A reply that says the name anyway is counted (server/
// screen.js), and on the operator's trial delivered as written, so the trial measures whether the model keeps it. A
// run of a prompt's words in a reply is held back, always.
//
// The page holds the conversation, as it holds the results; nothing of its text is kept here. The server seals what it
// delivered (server/seal.js) and checks the page's history against the seal before anything is held or sent, so the
// page can neither put words in the inspector's mouth nor start the count again. At most CIVIC_CHAT_MAX_TURNS
// questions (four: "I am concerned context will explode in size. I want to be safe"). A reply is a determination of
// kind chat (server/economics.js), measured apart from the fact-checks; nothing is charged in the operator's trial.
// A reply's words reach the page only once it is finished and screened; meanwhile, what the model is doing.
import { config } from './config.js';
import { hasPrompt, promptVersions, evaluationPrompt, chatPromptStatus, chatInstructions, chatMessage } from './prompts.js';
import { ApiError, operatorKey, clientFor, describeError, throughGate } from './openai.js';
import { estimateTextCost } from './pricing.js';
import { record, claimHash } from './ledger.js';
import { inspectorLetter } from './verdict.js';
import { seal, unseal, sha, sealReady, sealStore } from './seal.js';
import { screenReply } from './screen.js';
import { newReply, readReply, goAgain } from './respond.js';
import { requestTools, searchCount } from './tools/request.js';
import { normalise } from './documents.js';
import { sourceMeta, sourceBlock } from './source.js';
import { openStream } from './stream.js';
import * as jobs from './jobs.js';
import * as economics from './economics.js';
import { required as signinRequired, isOperator } from './access.js';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const DOC_EXT = ['.pdf', '.txt', '.md', '.docx', '.csv', '.json', '.html', '.srt', '.vtt'];
/** What a reader may attach as evidence: documents (read to text first, by /api/parse) and photos. The challenge's list. */
export const ACCEPTED_EVIDENCE_EXT = [...IMAGE_EXT, ...DOC_EXT];
const IMAGE_DATA = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

// ---- who may converse -----------------------------------------------------------------------------------------------
/** off, or operator: the operator's own account alone, for the trial. `on` (readers) waits for a reply's price; until then it is the operator's. */
export function chatMode() { return config.chat === 'operator' || config.chat === 'on' ? 'operator' : 'off'; }

/** Whether the chat can run at all: on, both prompts it needs installed and usable, and the seal's key made. */
export function chatReady() { return chatMode() !== 'off' && hasPrompt('evaluate') && chatPromptStatus().ready && sealReady(); }

/** Whether this request's reader may converse: the operator, on the trial (everyone on an open door, as /check is). */
export function chatOpenFor(req) { return chatReady() && (!signinRequired() || isOperator(req?.account)); }

/** What the page is told: the figures it needs, or null when this reader cannot converse. Never a prompt's text. */
export function publicChat(req) {
  if (!chatOpenFor(req)) return null;
  return { open: true, maxTurns: config.chatMaxTurns, maxFiles: config.chatMaxFiles, maxFileBytes: config.chatMaxFileBytes, maxRequestBytes: config.maxRequestBytes, acceptedExt: ACCEPTED_EVIDENCE_EXT };
}

// ---- the shapes a conversation travels in ------------------------------------------------------------------------------
const PHASE = /^[a-z_]{1,40}$/;
/** Message items as the page sends them back: [{ phase, text }], or null when they are not that. */
function cleanItems(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const it of list) {
    if (!it || typeof it.text !== 'string') return null;
    out.push({ phase: typeof it.phase === 'string' && PHASE.test(it.phase) ? it.phase : null, text: it.text });
  }
  return out;
}
const canonItems = (items) => JSON.stringify(items.map((x) => [x.phase, x.text]));

/** Evidence as the page sends it: documents already read to text, photos as data addresses. Null when malformed. */
function cleanAttachments(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const a of list) {
    if (!a || typeof a.name !== 'string' || !a.name.trim()) return null;
    const name = a.name.trim().slice(0, 300);
    if (a.kind === 'image' && typeof a.dataUrl === 'string' && IMAGE_DATA.test(a.dataUrl)) out.push({ kind: 'image', name, dataUrl: a.dataUrl });
    else if (a.kind === 'document' && typeof a.text === 'string') out.push({ kind: 'document', name, text: a.text });
    else return null;
  }
  return out;
}
const canonMessage = (question, attachments) => JSON.stringify([question, attachments.map((a) => [a.kind, a.name, a.kind === 'image' ? a.dataUrl : a.text])]);

/** A reader's message as it goes to the model: the chat prompt's message part with their words, then any evidence. */
const userMessage = (text, attachments) => ({
  role: 'user',
  content: [
    { type: 'input_text', text },
    ...attachments.map((a) => (a.kind === 'image'
      ? { type: 'input_image', image_url: a.dataUrl, detail: 'auto' }
      : { type: 'input_text', text: `[Attached document: ${a.name}]\n${a.text}` })),
  ],
});
/** An answer as it goes back to the model: its own words, with the phase OpenAI gave it. */
const assistantMessages = (items) => items.filter((it) => it.text).map((it) => ({ role: 'assistant', content: it.text, ...(it.phase ? { phase: it.phase } : {}) }));

/** The tools a reply goes with: the fact-check's, which are today's as long as nothing changed (an entry's pass is never sealed). */
function replayTools(sealed) {
  const now = requestTools();
  const bare = (list) => JSON.stringify((list || []).map(({ headers, ...t }) => t));
  return bare(now) === bare(sealed) ? now : sealed;
}

/** The day the source was stamped with, as a time on that day (server/source.js writes the day alone). */
const onDay = (day) => new Date(`${day}T12:00:00Z`);

// ---- the fact-check's opening --------------------------------------------------------------------------------------
/**
 * What the fact-check's result carries for a conversation (server/evaluate.js): the inspector's letter, the answer's
 * message items, and the seal over exactly what was asked and answered. The page is never told the prompt's text, the
 * name (here), the key or the gateway's pass. A result whose inspector cannot be read has no conversation.
 */
export function chatOpening({ det, run, n, owner, day, document, prompt, body, items, inspector }) {
  if (!inspector || !det || !body) return { unavailable: 'no_name' };
  const letter = inspectorLetter(inspector, config.chatTitles);
  if (!letter) return { unavailable: 'no_name' };
  if (!sealReady()) return { unavailable: 'no_seal' };
  const clean = cleanItems(items) || [{ phase: null, text: '' }];
  const state = {
    kind: 'chat', v: 1, det, run: run || null, n: Number.isInteger(n) ? n : null, owner: owner ?? null, at: Date.now(),
    day: document ? day : null, doc: document ? sha(document) : null, prompt: sha(prompt), ev: promptVersions().evaluate?.version || null,
    model: body.model, reasoning: body.reasoning, tools: (body.tools || []).map(({ headers, ...t }) => t),
    answer: sha(canonItems(clean)), name: inspector, letter, chat: null, turns: [],
  };
  return { letter, seal: seal(state), items: clean };
}

// ---- the refusals a reader may meet -------------------------------------------------------------------------------------
const expected = (err, extra = null) => Object.assign(err, { expected: true }, extra ? { extra } : {});
const altered = () => expected(new ApiError(400, 'conversation_altered', 'This conversation could not be continued.'));
const changed = () => expected(new ApiError(409, 'prompt_changed', 'The inspector\'s instructions have changed since this fact-check, so this conversation has ended.'));

// The replies each fact-check has had delivered, kept here too, for a FactEngine whose measurement is off.
const delivered = new Map();
// Requests for one reply that arrive together: the second waits for the first's opening, then joins its job.
const opening = new Map();
// The ids a page names: the fact-check's job id.
const ID = /^[A-Za-z0-9_.:-]{8,120}$/;

/**
 * POST /api/chat: one reply, as a job (server/jobs.js), so a cut connection rejoins it by its id and a deploy's end is
 * started over by the page. Its id is the fact-check's and its turn, so a second request for the same turn joins the
 * first and one conversation never runs two replies at once.
 */
export function mountChatRoute(app, { wrap, ownerOf, seesCost, withoutCost, booksWait }) {
  app.post('/api/chat', wrap(async (req, res) => {
    if (!chatOpenFor(req)) throw expected(new ApiError(403, 'chat_closed', 'Conversations are not open.'));
    const owner = ownerOf(req);
    const b = req.body || {};
    const factId = typeof b.factId === 'string' && ID.test(b.factId.trim()) ? b.factId.trim() : null;
    const st = unseal(b.seal);
    if (!factId || !st || st.kind !== 'chat' || st.det !== factId || (st.owner ?? null) !== (owner ?? null) || !Array.isArray(st.turns)) throw altered();
    const k = st.turns.length;   // replies so far; this one is turn k + 1
    const id = `${factId}.c${k + 1}`;
    const known = jobs.get(id, owner);
    if (known) { known.attach(openStream(req, res), b.cursor); return; }

    if (k >= config.chatMaxTurns) throw expected(new ApiError(409, 'chat_limit', `This conversation has had its ${config.chatMaxTurns} questions.`), { maxTurns: config.chatMaxTurns });
    const versions = promptVersions();
    if (st.ev !== (versions.evaluate?.version || null) || (st.chat && st.chat !== (versions.chat?.version || null))) throw changed();

    // The fact-check, rebuilt exactly as it was sent, and checked against its seal.
    const source = b.text ? normalise(b.text) : null;
    const document = st.day && source && source.chars >= 20 ? sourceBlock(source.text, sourceMeta(b.source), onDay(st.day)) : '';
    const claim = String(b.claim || '').trim();
    const prompt = evaluationPrompt(claim);
    const answer = cleanItems(b.items);
    if ((document ? sha(document) : null) !== (st.doc || null) || sha(prompt) !== st.prompt || !answer || sha(canonItems(answer)) !== st.answer) throw altered();
    // The conversation so far: every question as it was asked, every reply as it was delivered.
    const turns = Array.isArray(b.turns) ? b.turns : [];
    if (turns.length !== k) throw altered();
    const history = [];
    for (let j = 0; j < k; j++) {
      const t = turns[j] || {};
      const question = typeof t.question === 'string' ? t.question : null;
      const attachments = cleanAttachments(t.attachments);
      const reply = cleanItems(t.reply);
      if (question === null || !attachments || !reply || sha(canonMessage(question, attachments)) !== st.turns[j]?.q || sha(canonItems(reply)) !== st.turns[j]?.r) throw altered();
      history.push({ question, attachments, reply });
    }
    // The reader's message: words, evidence, or both; at most the challenge's five items, each within its size.
    const question = typeof b.question === 'string' ? b.question.trim() : '';
    const attachments = cleanAttachments(b.attachments);
    if (!attachments) throw expected(new ApiError(400, 'bad_evidence', 'That evidence could not be read.'));
    if (!question && !attachments.length) throw expected(new ApiError(400, 'empty_message', 'Write a question or attach evidence first.'));
    if (attachments.length > config.chatMaxFiles) throw expected(new ApiError(400, 'too_many_files', `Attach up to ${config.chatMaxFiles} items.`), { maxFiles: config.chatMaxFiles });
    if (attachments.some((a) => (a.kind === 'image' ? Math.floor(((a.dataUrl.length - a.dataUrl.indexOf(',') - 1) * 3) / 4) : Buffer.byteLength(a.text, 'utf8')) > config.chatMaxFileBytes)) throw expected(new ApiError(413, 'file_too_large', 'An item is too large.'), { maxFileBytes: config.chatMaxFileBytes });
    // A history that has been gone past already (an older window of the same conversation) cannot go on.
    const latest = Math.max(delivered.get(factId) || 0, await economics.latestReply(factId).catch(() => 0));
    if (latest > k + 1) throw expected(new ApiError(409, 'conversation_moved_on', 'This conversation went on in another window.'));

    if (opening.has(id)) {
      await opening.get(id).catch(() => {});
      const joined = jobs.get(id, owner);
      if (joined) { joined.attach(openStream(req, res), b.cursor); return; }
    }
    let opened;
    opening.set(id, new Promise((resolve) => { opened = resolve; }));
    const user = req.account?.user || null;
    let quote = null;
    try {
      quote = await economics.openDetermination({
        id, runId: st.run, n: st.n, chars: question.length, userId: user?.id ?? null, owner, limitCents: user?.monthlyLimitCents ?? null,
        requireRun: signinRequired(), kind: 'chat', parentId: factId, turn: k + 1, fingerprint: sha(canonMessage(question, attachments)),
      }).catch((err) => {
        if (err?.expected) throw err;
        console.error('[economics] the reply could not be recorded:', err.message);
        if (signinRequired()) throw booksWait();
        return null;
      });
    } finally {
      opening.delete(id);
      opened();
    }
    const attempt = quote?.attempt ?? null;
    const showCost = seesCost(req);
    const ctx = { runId: st.run, owner, determinationId: id };

    jobs.start(id, 'conversation', async ({ send: sendAll, signal }) => {
      const send = showCost ? sendAll : (ev) => sendAll(withoutCost(ev));
      const startedAt = Date.now();
      const chatVersion = versions.chat?.version || null;
      try {
        const names = { inspector: st.name, letter: st.letter };
        const instructions = chatInstructions(names);
        const input = [
          ...(document ? [{ role: 'user', content: [{ type: 'input_text', text: document }] }] : []),
          { role: 'user', content: [{ type: 'input_text', text: prompt }] },
          ...assistantMessages(answer),
          ...history.flatMap((t) => [userMessage(chatMessage({ ...names, question: t.question }), t.attachments), ...assistantMessages(t.reply)]),
          userMessage(chatMessage({ ...names, question }), attachments),
        ];
        const body = { model: st.model, ...(instructions ? { instructions } : {}), input, reasoning: st.reasoning, tools: replayTools(st.tools), stream: true, store: false };
        const client = clientFor(operatorKey());
        send({ t: 'start', i: 0, turn: k + 1, at: Date.now() });
        let acc = null;
        let searches = 0;   // every go's searches were made and paid for
        for (let tries = 0; ; tries++) {
          const attemptAt = Date.now();
          acc = newReply();
          try {
            const { data: stream, release } = await throughGate(client, body, { kind: 'conversation', owner: owner || st.run || id, signal, onHold: (h) => send({ t: 'phase', i: 0, phase: 'queued', ...h }) });
            try { await readReply(stream, { acc, send, i: 0, signal, forward: false }); }
            finally { release(); searches += searchCount(acc.trail); }
            break;
          } catch (err) {
            if (signal.aborted) return;
            if (await goAgain(err, { tries, attemptAt, kind: 'conversation', model: st.model, send, i: 0, retries: config.evalRetries })) continue;
            throw err;
          }
        }
        if (signal.aborted) return;

        // The screen, before the page sees a word: the prompts held back, the name counted (and, for a reader, masked).
        const items = acc.items.length ? acc.items : [{ phase: null, text: acc.text }];
        const shown = [source?.text || '', claim, ...answer.map((x) => x.text), ...history.flatMap((t) => [t.question, ...t.attachments.map((a) => a.text || ''), ...t.reply.map((x) => x.text)]), question, ...attachments.map((a) => a.text || '')];
        const screened = screenReply({ items, trail: acc.trail, sources: acc.sources, inspector: st.name, letter: st.letter, titles: config.chatTitles, shown, mask: false });
        const reply = screened.items.map((it) => ({ phase: it.phase && PHASE.test(it.phase) ? it.phase : null, text: it.text }));
        const next = seal({ ...st, at: Date.now(), chat: st.chat || chatVersion, turns: [...st.turns, { q: sha(canonMessage(question, attachments)), r: sha(canonItems(reply)) }] });
        const ms = Date.now() - startedAt;
        const cost = estimateTextCost({ model: st.model, usage: acc.usage, searches });
        const chars = (instructions || '').length + input.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : m.content.reduce((s, c) => s + (c.text || '').length, 0)), 0);
        record({
          kind: 'chat', ok: true, model: st.model, effort: st.reasoning?.effort || null, mode: st.reasoning?.mode || null, webSearch: (body.tools || []).some((x) => x.type === 'web_search'),
          prompts: { evaluate: st.ev, chat: chatVersion }, turn: k + 1, limit: config.chatMaxTurns, chars, evidence: attachments.length + history.reduce((n, t) => n + t.attachments.length, 0),
          usage: acc.usage, searches, sources: acc.sources.length, incomplete: acc.incomplete, ms, usd: cost.usd, priced: cost.priced,
          nameSaid: screened.slips.name, promptHeld: screened.slips.prompt, sourcesNaming: screened.slips.sources, claim: claimHash(claim),
        }, ctx);
        await economics.book(id, { attempt, status: 'done', model: st.model });
        delivered.set(factId, Math.max(delivered.get(factId) || 0, k + 1));
        send({
          t: 'done', i: 0, turn: k + 1, left: Math.max(0, config.chatMaxTurns - (k + 1)),
          text: reply.map((x) => x.text).join(''), items: reply, trail: screened.trail, sources: screened.sources, held: screened.slips.prompt > 0,
          seal: next, model: st.model, effort: st.reasoning?.effort || null, mode: st.reasoning?.mode || null, searches, ms, cost, incomplete: acc.incomplete,
          ...(showCost ? { slips: screened.slips } : {}),   // the operator's trial: what the reply said that it should not have
        });
      } catch (err) {
        if (signal.aborted) return;
        const safe = describeError(err);
        record({ kind: 'chat', ok: false, code: safe.code, model: st.model, turn: k + 1, ms: Date.now() - startedAt }, ctx);
        await economics.book(id, { attempt, status: 'failed', failure: safe.code || 'error' });
        send({ t: 'error', i: 0, code: safe.code, message: safe.message, status: safe.status });
      } finally {
        await economics.closeOpen(attempt === null ? [] : [{ id, attempt }], signal.aborted ? 'cancelled' : 'ended');
      }
    }, { owner }).attach(openStream(req, res), 0);
  }));
}

// ---- /check ----------------------------------------------------------------------------------------------------------
/** The rows /check shows for the chat: whether it is open and to whom, the chat prompt, the limit, and any setting left over from the challenge. */
export function chatChecks() {
  const ok = (title, detail = '') => ({ state: 'ok', title, detail });
  const warn = (title, detail = '', fix = '') => ({ state: 'warn', title, detail, fix });
  const out = [];
  const status = chatPromptStatus();
  const v = promptVersions().chat;
  const raw = String(config.chat || 'off');
  if (!['off', 'operator', 'on'].includes(raw)) out.push(warn('CIVIC_CHAT is not a value FactEngine knows', `It is "${raw}", so conversations are off.`, 'Set CIVIC_CHAT to operator for the trial, or off.'));
  if (raw === 'on') out.push(warn('Conversations are open to the operator\'s account only', 'CIVIC_CHAT=on waits for a reply\'s price; until it exists, a conversation is the operator\'s alone.', 'Set CIVIC_CHAT=operator meanwhile.'));
  if (chatMode() !== 'off') {
    if (!status.ready) {
      const why = status.reason === 'missing' ? 'It is not installed, so no result offers a conversation.'
        : status.reason === 'no_question' ? 'It has no {{QUESTION}} slot, so a reader\'s message has no place in it; no result offers a conversation.'
          : 'It holds {{QUESTION}} more than once; the reader\'s message goes in exactly one place, so no result offers a conversation.';
      out.push(warn('The chat prompt cannot be used', why, 'Point CIVIC_PROMPT_CHAT_FILE at the chat prompt (on Render, the secret file chat.txt), or place it at server/prompts/chat.txt, with {{QUESTION}} once.'));
    } else {
      const slots = [status.slots?.inspector ? 'the inspector\'s name' : null, status.slots?.letter ? 'the letter' : null].filter(Boolean);
      out.push(ok('The chat prompt is installed', `Version ${v.version}, ${v.chars.toLocaleString('en-US')} characters. Its slots: ${slots.length ? `${slots.join(', ')} and ` : ''}the reader's message.${status.slots?.inspector ? '' : ' It has no {{INSPECTOR}} slot, so the model is not told who it is.'} Its text never leaves this machine except inside a request to OpenAI.`));
      out.push(ok('Conversations are open to the operator\'s account', `At most ${config.chatMaxTurns} question${config.chatMaxTurns === 1 ? '' : 's'} to a result (CIVIC_CHAT_MAX_TURNS). The inspector is called by its letter; a reply that says its name is counted below. Nothing is charged for a reply. ${sealStore() === 'postgres' ? 'Conversations outlive a deploy.' : 'Without a database, a conversation ends when this instance restarts.'}`));
    }
  }
  const retired = ['CIVIC_CHALLENGE_ENABLED', 'CIVIC_PROMPT_CHALLENGE', 'CIVIC_PROMPT_CHALLENGE_FILE'].filter((n) => String(process.env[n] || '').trim());
  if (retired.length) out.push(warn('Settings of the challenge are still on the service', `Nothing reads them any more: ${retired.join(', ')}. The conversation under each result took the challenge's place.`, 'Delete them in Render when convenient.'));
  return out;
}
