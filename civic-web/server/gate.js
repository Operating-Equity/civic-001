// The gate in front of every request to OpenAI.
//
// OpenAI's limiter, in its own figures. A refusal reads, for example: "Limit 500000, Used 500000,
// Requested 83734. Please try again in 10.048s". 83734 × 60 s ÷ 500000 = 10.048 s. Five refusals
// from one run, each with a different Used and Requested, gave that arithmetic to the millisecond.
// So the limiter is a bucket of `limit` tokens that refills continuously at `limit` per minute;
// each request costs what OpenAI estimates for it ("Requested", which varies from request to
// request); a request is admitted when the bucket holds its cost and refused otherwise, with
// exactly the wait that refills the difference. The requests-per-minute bucket works the same way
// at one per request. Nothing else is in the rule: no window that opens all at once, no reset to full.
//
// The gate keeps those buckets from the headers of every reply and from every refusal, and sends
// one request at a time: the next goes only after the previous reply's headers have been read (a
// stream's headers arrive as it starts), so every admission is checked against the server's latest
// figure plus the refill since it. The cost of a kind of request (an extraction, a determination,
// the art direction for the picture) is learned only from OpenAI's exact figures: the drop shown
// by a request sent into a full minute, or the Requested figure in a refusal. A kind whose cost is
// not yet known goes only when the figures say the minute is full, so its reply shows its cost
// exactly. A refusal that arrives anyway (two CIVICs on one key, a cost larger than any seen) is
// handled here: the refused request waits exactly what OpenAI asked and goes first. The one earlier
// gate learned the cost from the drop between two replies without the refill in between, took the
// whole minute to be back after a refusal's wait, and had been proved against a stand-in whose
// minute opened all at once; it admitted everything and OpenAI refused most of it.
// Nothing here is a number of ours.

/** "1.2s", "850ms", "1m2.5s" and the like, as OpenAI writes its times. */
export function parseDuration(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  let ms = 0;
  let matched = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/g)) {
    matched = true;
    const v = Number(m[1]);
    ms += m[2] === 'ms' ? v : m[2] === 's' ? v * 1000 : m[2] === 'm' ? v * 60000 : v * 3600000;
  }
  return matched ? ms : null;
}

const header = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  return headers[name] || headers[name.toLowerCase()] || '';
};
const int = (v) => { const n = parseInt(String(v ?? '').replace(/,/g, ''), 10); return Number.isFinite(n) ? n : null; };

/** One of OpenAI's per-minute buckets, as its figures describe it. */
export class Bucket {
  constructor(name) {
    this.name = name;
    this.limit = null;      // the minute's capacity
    this.observed = null;   // what the bucket held when the server last said
    this.observedAt = 0;    // when that arrived, on this clock
    this.rate = null;       // the refill, per millisecond
    this.fullAt = 0;        // when the bucket is back in full, by those figures
  }

  known() { return this.limit !== null && this.observed !== null; }

  /**
   * A reply's figures, or a refusal's: the limit, what was left after the request the figures came
   * with, and the server's own time to full when it gave one. The refill is the limit per minute;
   * a reset time slower than that is believed instead, so the gate never assumes more than the
   * server states.
   */
  observe({ limit, remaining, resetMs = null }, at = Date.now()) {
    if (limit !== null && limit > 0) this.limit = limit;
    if (this.limit === null || remaining === null || remaining < 0) return;
    this.observed = Math.min(remaining, this.limit);
    this.observedAt = at;
    const deficit = this.limit - this.observed;
    // The refill. The server's own time to full states it, when that time is long enough to carry
    // the figure (it is written to the millisecond, so under a second it has too few digits);
    // otherwise the rate already known stands, and before anything is known, the limit per
    // minute, which is what the headers name and what the server's figures come to.
    if (resetMs !== null && resetMs >= 1000 && deficit > 0) this.rate = deficit / resetMs;
    else if (this.rate === null) this.rate = this.limit / 60000;
    this.fullAt = at + (deficit > 0 ? deficit / this.rate : 0);
  }

  /** What the bucket holds now: the last figure plus the refill since, never above the limit. */
  available(now = Date.now()) {
    if (!this.known()) return null;
    return Math.min(this.limit, this.observed + Math.max(0, now - this.observedAt) * this.rate);
  }

  /**
   * Milliseconds until the bucket holds `amount`: 0 when it does now; Infinity when it never will.
   * The server's figures are given to the millisecond, so the wait is rounded up to the next one
   * and one more: a wait cut short by that precision would arrive a fraction early and be refused.
   */
  waitFor(amount, now = Date.now()) {
    if (!this.known()) return 0;
    if (amount > this.limit) return Infinity;
    const have = this.available(now);
    return have >= amount ? 0 : Math.ceil((amount - have) / this.rate) + 1;
  }
}

/**
 * What a refusal says. OpenAI writes "Rate limit reached for <model> in organization <org> on
 * tokens per min (TPM): Limit 500000, Used 500000, Requested 83734. Please try again in 10.048s.
 * Visit ...". The figures and the wait are read out; nothing is inferred beyond them. The wait is
 * taken from retry-after-ms, else from the message (both exact), else from retry-after (whole
 * seconds, rounded up by OpenAI).
 */
export function parseRefusal(err) {
  const message = String(err?.error?.message || err?.message || '');
  const num = (label) => { const m = message.match(new RegExp(`\\b${label}\\s+(\\d[\\d,]*)`, 'i')); return m ? int(m[1]) : null; };
  const bucket = /requests per|\(RP[MD]\)/i.test(message) ? 'requests' : 'tokens';
  const perDay = /per day|\(TPD\)|\(RPD\)/i.test(message);
  const said = message.match(/try again in\s+((?:\d+(?:\.\d+)?\s*(?:ms|s|m|h)\s*)+)/i);
  const h = err?.headers;
  const candidates = [
    parseFloat(header(h, 'retry-after-ms')),
    said ? parseDuration(said[1]) : null,
    parseFloat(header(h, 'retry-after')) * 1000,
  ];
  const waitMs = candidates.find((v) => Number.isFinite(v) && v > 0) ?? null;
  const resetMs = parseDuration(header(h, bucket === 'requests' ? 'x-ratelimit-reset-requests' : 'x-ratelimit-reset-tokens'));
  return { bucket, perDay, limit: num('Limit'), used: num('Used'), requested: num('Requested'), waitMs, resetMs, message };
}

function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

export class RateGate {
  constructor(model) {
    this.model = model;
    this.tokens = new Bucket('tokens');
    this.requests = new Bucket('requests');
    this.costs = new Map();   // kind → the largest cost OpenAI has shown for it, in its own accounting
    this.queue = [];          // tickets in the order asked; the head goes next
    this.lane = null;         // the ticket sent whose reply headers have not arrived yet
    this.inFlight = 0;        // sent, and not yet over
    this.waiters = [];
    this.seq = 0;
    this.replies = 0;
    this.refusals = 0;
    this.last = null;         // the last figures seen, for the report
  }

  cost(kind) { return this.costs.get(kind) ?? null; }

  learn(kind, cost) {
    if (cost !== null && cost > 0 && cost > (this.costs.get(kind) ?? 0)) this.costs.set(kind, cost);
  }

  /** Milliseconds until a request of this kind may go, by the figures: 0 now, Infinity never. */
  waitFor(kind, now = Date.now()) {
    if (!this.tokens.known()) return 0;                          // nothing known yet: it goes alone and teaches
    const cost = this.cost(kind);
    const tokens = cost === null ? this.tokens.waitFor(this.tokens.limit, now) : this.tokens.waitFor(cost, now);
    const requests = this.requests.known() ? this.requests.waitFor(1, now) : 0;
    return Math.max(tokens, requests);
  }

  /** The wait a ticket at `position` in the line sees: the budget must cover what is ahead of it too. */
  waitAt(position, now = Date.now()) {
    if (!this.tokens.known()) return 0;
    let need = 0;
    for (let k = 0; k <= position && k < this.queue.length; k++) {
      const c = this.cost(this.queue[k].kind);
      need += c === null ? this.tokens.limit : c;
    }
    need = Math.min(need, this.tokens.limit);
    const requests = this.requests.known() ? this.requests.waitFor(Math.min(position + 1, this.requests.limit), now) : 0;
    return Math.max(this.tokens.waitFor(need, now), requests);
  }

  /**
   * Resolves with a ticket when the request may be sent. Admission is in the order asked, one at
   * a time. `first` puts a request turned back by OpenAI at the head of the line, and `notBefore`
   * is the time OpenAI itself named for it. `onHold` is told, in figures, whenever the wait changes.
   */
  async admit({ kind = 'request', signal, onHold, first = false, notBefore = 0 } = {}) {
    const ticket = { kind, seq: ++this.seq, held: null, sentAt: 0 };
    if (first) this.queue.unshift(ticket); else this.queue.push(ticket);
    try {
      for (;;) {
        if (signal?.aborted) throw abortError();
        const now = Date.now();
        const position = this.queue.indexOf(ticket);
        let wait = null;
        if (position === 0 && this.lane === null) {
          wait = Math.max(this.waitFor(kind, now), notBefore - now);
          if (wait <= 0) break;
          if (wait === Infinity) {
            const e = new Error(`OpenAI counts more tokens for this request than the key's limit of ${this.tokens.limit} a minute, so it can never be sent on this key.`);
            e.status = 413; e.code = 'over_minute_limit';
            throw e;
          }
        }
        const est = wait !== null ? wait : this.waitAt(position, now);
        if (onHold && (!ticket.held || Math.abs(ticket.held.waitMs - est) > 1000 || ticket.held.position !== position + 1)) {
          ticket.held = { waitMs: Math.max(0, Math.round(est)), position: position + 1 };
          onHold(ticket.held);
        }
        await this.wait(signal, wait);
      }
      this.queue.shift();
      this.lane = ticket;
      this.inFlight++;
      ticket.sentAt = Date.now();
      this.wake();
      return ticket;
    } catch (err) {
      const i = this.queue.indexOf(ticket);
      if (i >= 0) this.queue.splice(i, 1);
      this.wake();
      throw err;
    }
  }

  /** The reply's headers arrived: the buckets as they stood after this request. */
  replied(ticket, headers, at = Date.now()) {
    const figures = (unit) => ({
      limit: int(header(headers, `x-ratelimit-limit-${unit}`)),
      remaining: int(header(headers, `x-ratelimit-remaining-${unit}`)),
      resetMs: parseDuration(header(headers, `x-ratelimit-reset-${unit}`)),
    });
    const tokens = figures('tokens');
    const requests = figures('requests');
    // Sent into a full minute, the drop is this request's cost, exactly. Sent into a part-filled
    // one, the drop would be an estimate, and estimates are not what the gate learns from.
    const before = this.tokens.available(at);
    const wasFull = before !== null && before >= this.tokens.limit;
    this.tokens.observe(tokens, at);
    this.requests.observe(requests, at);
    if (wasFull && tokens.remaining !== null && this.tokens.limit !== null) this.learn(ticket.kind, this.tokens.limit - tokens.remaining);
    this.replies++;
    this.last = { at, kind: ticket.kind, tokens, requests };
    if (this.lane === ticket) this.lane = null;
    this.wake();
  }

  /** OpenAI turned the request back. Its figures are the truth; the request goes again, first. */
  refused(ticket, refusal, at = Date.now()) {
    this.refusals++;
    if (!refusal.perDay) {
      const b = refusal.bucket === 'requests' ? this.requests : this.tokens;
      const need = refusal.bucket === 'requests' ? 1 : refusal.requested;
      if (refusal.limit !== null && refusal.used !== null) {
        b.observe({ limit: refusal.limit, remaining: refusal.limit - refusal.used, resetMs: refusal.resetMs }, at);
      } else if (refusal.waitMs !== null && need !== null && b.limit !== null) {
        // No Used figure: the bucket is placed so that it holds the request exactly when OpenAI said.
        b.observe({ limit: b.limit, remaining: Math.max(0, need - refusal.waitMs * (b.rate ?? b.limit / 60000)), resetMs: refusal.resetMs }, at);
      }
      if (refusal.bucket === 'tokens') this.learn(ticket.kind, refusal.requested);
    }
    this.last = { at, kind: ticket.kind, refusal: { bucket: refusal.bucket, limit: refusal.limit, used: refusal.used, requested: refusal.requested, waitMs: refusal.waitMs } };
    if (this.lane === ticket) this.lane = null;
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.wake();
  }

  /** The request failed before its reply began (a cut connection, a 5xx). Any figures it carried count. */
  failed(ticket, err, at = Date.now()) {
    if (err?.headers) {
      const tokens = { limit: int(header(err.headers, 'x-ratelimit-limit-tokens')), remaining: int(header(err.headers, 'x-ratelimit-remaining-tokens')), resetMs: parseDuration(header(err.headers, 'x-ratelimit-reset-tokens')) };
      if (tokens.limit !== null && tokens.remaining !== null) this.tokens.observe(tokens, at);
    }
    if (this.lane === ticket) this.lane = null;
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.wake();
  }

  /** The reply has been consumed, however it ended. */
  done(ticket) {
    if (this.lane === ticket) this.lane = null;   // a reply that died before its headers must not hold the lane
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.wake();
  }

  wait(signal, ms = null) {
    return new Promise((resolve) => {
      const timer = ms !== null && ms > 0 && ms !== Infinity ? setTimeout(finish, Math.min(ms, 2147483647)) : null;
      const onAbort = () => finish();
      function finish() { if (timer) clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); resolve(); }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.waiters.push(finish);
    });
  }

  wake() {
    const ws = this.waiters.splice(0);
    for (const w of ws) w();
  }

  /** For the check page, its report and the log. */
  state(now = Date.now()) {
    const bucket = (b) => ({ limit: b.limit, available: b.known() ? Math.floor(b.available(now)) : null, fullInMs: b.known() ? Math.max(0, Math.ceil(b.fullAt - now)) : null });
    const costs = Object.fromEntries(this.costs);
    const determination = costs.determination && this.tokens.known()
      ? { atOnce: Math.max(1, Math.floor(this.tokens.limit / costs.determination)), everyMs: Math.round(costs.determination / this.tokens.rate) }
      : null;
    return { model: this.model, tokens: bucket(this.tokens), requests: bucket(this.requests), costs, determination, inFlight: this.inFlight, waiting: this.queue.length, replies: this.replies, refusals: this.refusals, last: this.last };
  }
}

const gates = new Map();
export function gateFor(model) {
  let g = gates.get(model);
  if (!g) { g = new RateGate(model); gates.set(model, g); }
  return g;
}
export function gateStates() {
  return [...gates.values()].map((g) => g.state());
}
