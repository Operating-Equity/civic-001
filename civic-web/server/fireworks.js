// Fireworks, for the listing when the operator puts it there (CIVIC_EXTRACT_PROVIDER=fireworks): the operator's choice of
// 5 October, "Maybe someone in the US is hosting the model so we can avoid the China issue." The model is DeepSeek's
// V4.1 Flash, served by Fireworks, a US company: told `store: false` on every request it keeps nothing, it trains on
// nothing, and DeepSeek the company receives nothing. Determinations stay on OpenAI and never come near this file.
//
// Fireworks answers OpenAI's Responses API at its own address (https://api.fireworks.ai/inference/v1, POST /responses),
// so the listing keeps its request and its stream. What is Fireworks' own is handled here, through server/listing.js:
//   - Its key. The client carries Fireworks' own key and nothing of OpenAI's (server/providers.js).
//   - Its search. Fireworks has no web search of its own; it calls the tool servers a request names, itself, during
//     the response. The listing names FactEngine's (server/tools: a search, a page, a transcript), extract.js.
//   - Its chain of thought. Fireworks' own Responses examples read the answer as the text after `</think>`: the
//     model's reasoning arrives inside the answer's text. It is cut off here (ThoughtCut), so it never becomes a claim,
//     never reaches the page, the job's replay, the ledger or a failure record (the operator's answer of 4 October).
//   - Its usage. Fireworks counts tokens as prompt_tokens and completion_tokens; they are read into the shape the
//     price table reads (pricing.js).
//   - Its failures. A key it rejects (401) or an account that cannot pay (402, or a billing refusal) is shown to a
//     reader as FactEngine's own sentence, naming no provider and no key; Fireworks' own words go to the record.
//   - Its limits. Fireworks' per-minute figures are not OpenAI's, so the listing does not go through OpenAI's gate; a
//     429 is a wait, for Fireworks' own retry-after when it gives one (extract.js).
import { config } from './config.js';
import { HEADER_SAFE } from './key.js';
import { ApiError, describeError } from './openai.js';
import { ownClient, providerWords } from './providers.js';

export const NAME = 'Fireworks';

export function host() {
  try { return new URL(config.fireworksBaseUrl).hostname; } catch { return 'api.fireworks.ai'; }
}

/** Fireworks' key, the operator's. A refusal names no provider and no key on the page; what is wrong is in `detail`. */
export function key({ optional = false } = {}) {
  const k = config.fireworksKey;
  if (!k) {
    if (optional) return '';
    const spellings = config.fireworksKeyInfo?.ambiguous || [];
    throw new ApiError(503, 'no_operator_key', '', spellings.length
      ? `FIREWORKS_API_KEY is saved in Render under ${spellings.join(' and ')}, which differ only in capitals and hold different keys, so neither is used. Keep one, named FIREWORKS_API_KEY.`
      : 'The listing is set to run on Fireworks (CIVIC_EXTRACT_PROVIDER=fireworks) and FIREWORKS_API_KEY is not set. ' +
        'The operator pastes it in Render: the civic service, Environment.');
  }
  if (optional) return k;
  if (!HEADER_SAFE.test(k)) {
    throw new ApiError(400, 'key_not_sendable', '',
      `FIREWORKS_API_KEY (from ${config.fireworksKeyInfo.source}) holds a space, a line break or another character a request cannot carry. Paste the key alone.`);
  }
  return k;
}

/** The client the listing talks to: Fireworks' key and address, nothing of OpenAI's. */
export function client(k) {
  if (!k) throw new ApiError(503, 'no_operator_key', '', 'No Fireworks key: nothing is sent to Fireworks without one.');
  return ownClient({ key: k, baseURL: config.fireworksBaseUrl });
}

// Words Fireworks uses when an account cannot pay: its own, read from the refusal, never guessed beyond these.
const BILLING = /\b(credit|credits|balance|billing|payment|insufficient funds|spend limit|suspended)\b/i;

/**
 * A Fireworks failure as the page may see it (no provider, no key) with Fireworks' own words kept in `detail` for the
 * record on /check. Everything else keeps the shared description (openai.js).
 */
export function failure(err) {
  if (err instanceof ApiError) return err;
  const status = err?.status ?? null;
  const words = providerWords(err, config.fireworksKey);
  if (status === 401) return new ApiError(401, 'invalid_key', '', `Fireworks rejected the key in FIREWORKS_API_KEY (401${words ? `: ${words}` : ''}).`);
  if (status === 402 || ((status === 403 || status === 412) && BILLING.test(words))) {
    return new ApiError(402, 'balance_exhausted', '',
      `Fireworks answered ${status}${words ? ` (${words})` : ''}: the account cannot pay for requests. Add credit or a payment method at app.fireworks.ai, under Billing.`);
  }
  const safe = describeError(err);
  return new ApiError(safe.status, safe.code, safe.message, `Fireworks: ${words || safe.code}`);
}

// Fireworks' own echo of the reasoning it was asked for, from the last listing's response.created: the proof, on /check,
// that the effort FactEngine sends is the effort Fireworks applies (its Responses API documents no effort key of its own).
let echo = null;
export function noteEcho(reasoning) { echo = { at: new Date().toISOString(), reasoning: reasoning ?? null }; }
export const lastEcho = () => echo;

/** Fireworks' token counts in the shape the price table reads ({ input, cached, output }), whichever names it uses. */
export function usageFrom(response) {
  const u = response?.usage;
  if (!u) return null;
  const n = (...xs) => { for (const x of xs) { const v = Number(x); if (x !== null && x !== undefined && Number.isFinite(v)) return v; } return 0; };
  return {
    input: n(u.prompt_tokens, u.input_tokens),
    cached: n(u.prompt_tokens_details?.cached_tokens, u.input_tokens_details?.cached_tokens),
    output: n(u.completion_tokens, u.output_tokens),
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? null,
    total: n(u.total_tokens),
  };
}

const OPEN = '<think>';
const CLOSE = '</think>';

/** How many characters at the end of `s` could be the start of `tag`, so a tag split between two pieces is never missed. */
function partialTail(s, tag) {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) return k;
  return 0;
}

/**
 * The chain of thought, cut off. Text arrives in pieces for each output item; this hands back the part of each piece
 * that is the answer, and nothing else:
 *   - An item whose role is not the assistant's is no part of the answer (Fireworks lists the input among its output).
 *   - An assistant item's text is held from its first word. When `</think>` appears, everything before it is the
 *     reasoning and is dropped (with any `<think>`); what follows is the answer and passes as it comes.
 *   - In the answer, a `<think>` starts reasoning again, dropped up to its `</think>`.
 *   - An item that ends without either marker had no reasoning in its text (it came apart, or there was none): what was
 *     held is released then, whole.
 * Nothing is kept of what is dropped, here or anywhere.
 */
export class ThoughtCut {
  constructor() { this.items = new Map(); }

  state(id) {
    const k = id || '_';
    if (!this.items.has(k)) this.items.set(k, { role: 'assistant', mode: 'held', buf: '' });
    return this.items.get(k);
  }

  /** An output item began: its role says whose text it is. */
  begin(item) {
    if (!item || item.type !== 'message') return;
    const s = this.state(item.id);
    if (item.role) s.role = item.role;
  }

  /** A piece of an item's text: the part of it that is the answer, now ('' when none is yet). */
  feed(id, piece) {
    const s = this.state(id);
    if (s.role !== 'assistant') return '';
    s.buf += String(piece || '');
    let out = '';
    for (;;) {
      if (s.mode === 'held') {
        const at = s.buf.indexOf(CLOSE);
        if (at >= 0) { s.buf = s.buf.slice(at + CLOSE.length); s.mode = 'answer'; continue; }
        if (s.buf.trimStart().startsWith(OPEN)) { s.mode = 'thinking'; continue; }
        return out;   // held: it may yet prove to be reasoning
      }
      if (s.mode === 'thinking') {
        const at = s.buf.indexOf(CLOSE);
        if (at >= 0) { s.buf = s.buf.slice(at + CLOSE.length); s.mode = 'answer'; continue; }
        s.buf = s.buf.slice(s.buf.length - partialTail(s.buf, CLOSE));   // dropped, but for what may be the start of the marker
        return out;
      }
      const at = s.buf.indexOf(OPEN);
      if (at >= 0) { out += s.buf.slice(0, at); s.buf = s.buf.slice(at + OPEN.length); s.mode = 'thinking'; continue; }
      const keep = partialTail(s.buf, OPEN);
      out += s.buf.slice(0, s.buf.length - keep);
      s.buf = s.buf.slice(s.buf.length - keep);
      return out;
    }
  }

  /** An item ended: whatever of it is now known to be the answer. */
  end(id) {
    const k = id || '_';
    const s = this.items.get(k);
    if (!s) return '';
    this.items.delete(k);
    if (s.role !== 'assistant' || s.mode === 'thinking') return '';
    return s.buf;   // held with no marker: no reasoning in its text; in the answer: the tail kept for a marker that never came
  }

  /** The reply ended: every item still open ends. */
  finish() {
    let out = '';
    for (const k of [...this.items.keys()]) out += this.end(k);
    return out;
  }
}
