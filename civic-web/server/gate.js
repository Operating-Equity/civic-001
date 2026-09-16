// The gate in front of every request to OpenAI.
//
// OpenAI answers every request with three headers: the minute's token limit for this key and
// model, how much of it is left, and when it refills. Twenty determinations fired at once against
// a budget that held seven meant thirteen refusals, a schedule of retries, and a run that looked
// broken. Now nothing is sent that the remaining budget cannot hold. The first request goes alone
// and teaches the gate the limit and what is left; the second goes alone and teaches it what one
// request costs in OpenAI's accounting (the drop in what is left); after that, requests start as
// the budget covers them, and each next one starts as the budget refills. A refusal that arrives
// anyway (two CIVICs on one key, say) teaches the gate again from the refusal's own headers and
// message. Every number here is OpenAI's; none is ours.

/** "1.2s", "850ms", "1m2.5s" and the like, as OpenAI writes its reset times. */
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

const header = (headers, name) => (headers && typeof headers.get === 'function' ? headers.get(name) : headers?.[name]) || '';

export class RateGate {
  constructor(model) {
    this.model = model;
    this.limit = null;        // tokens per minute, from x-ratelimit-limit-tokens
    this.remaining = null;    // what is left, from x-ratelimit-remaining-tokens, less what was admitted since
    this.resetAt = 0;         // when the budget is back in full, from x-ratelimit-reset-tokens
    this.reservation = null;  // what one request costs in OpenAI's accounting
    this.admittedSeq = 0;     // requests admitted so far; each carries its number
    this.lastSeq = 0;         // the number of the request whose reply was observed last
    this.lastRemaining = null; // the remaining figure in that reply, for learning the cost
    this.learning = false;    // a request is out alone, so the gate can learn from its reply
    this.inFlight = 0;
    this.queue = [];
    this.waiters = [];
  }

  /**
   * What OpenAI said with a reply, or with a refusal. `seq` is the number the request was given
   * when admitted: a reply's figures describe the budget as it stood when that request was
   * processed, so requests admitted after it are deducted again here.
   */
  observe(headers, { seq = 0, message = '', refused = false, waitMs = null } = {}) {
    const now = Date.now();
    const limit = parseInt(header(headers, 'x-ratelimit-limit-tokens'), 10);
    const remaining = parseInt(header(headers, 'x-ratelimit-remaining-tokens'), 10);
    const reset = parseDuration(header(headers, 'x-ratelimit-reset-tokens'));
    if (Number.isFinite(limit) && limit > 0) this.limit = limit;
    const asked = String(message).match(/Requested\s+(\d[\d,]*)/i);
    if (asked) this.reservation = Number(asked[1].replace(/,/g, ''));   // OpenAI's own figure for one request
    if (refused) {
      this.remaining = 0;
      this.lastRemaining = null;
      if (waitMs !== null && waitMs > 0) this.resetAt = now + waitMs;
      else if (reset !== null) this.resetAt = now + reset;
    } else {
      if (Number.isFinite(remaining) && remaining >= 0 && seq > this.lastSeq) {
        // Exactly one request went out between the last reply and this one: the drop is its cost.
        if (this.lastRemaining !== null && seq === this.lastSeq + 1 && this.lastRemaining - remaining > 0) {
          this.reservation = this.lastRemaining - remaining;
        }
        const admittedAfter = this.admittedSeq - seq;
        this.remaining = Math.max(0, remaining - admittedAfter * (this.reservation ?? 0));
        this.lastSeq = seq;
        this.lastRemaining = remaining;
      }
      if (reset !== null) this.resetAt = now + reset;
    }
    this.learning = false;
    this.wake();
  }

  /** The window came round: the budget is back in full. */
  refill() {
    if (this.resetAt && Date.now() >= this.resetAt) {
      if (this.limit !== null) this.remaining = this.limit;
      this.resetAt = 0;
    }
  }

  /** Whether the next request may go now. */
  canGo() {
    this.refill();
    if (this.learning) return false;
    if (this.reservation === null || this.remaining === null) return true;   // nothing known yet: go, and learn
    return this.remaining >= this.reservation;
  }

  /** Resolves, with the request's number, when the budget can hold one more request. Admission is in the order asked. */
  async admit({ signal, onHold } = {}) {
    const ticket = {};
    this.queue.push(ticket);
    try {
      let held = false;
      for (;;) {
        if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        if (this.queue[0] === ticket && this.canGo()) break;
        if (!held) { held = true; onHold?.({ waitMs: Math.max(0, this.resetAt - Date.now()) }); }
        await this.wait(signal);
      }
      if (this.reservation === null || this.remaining === null) this.learning = true;   // goes alone and teaches
      else this.remaining -= this.reservation;                                          // corrected by the next reply
      this.inFlight++;
      return ++this.admittedSeq;
    } finally {
      const i = this.queue.indexOf(ticket);
      if (i >= 0) this.queue.splice(i, 1);
      this.wake();
    }
  }

  /** A request ended, with or without a reply. */
  done() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.learning = false;   // a request that died before its headers must not hold the others
    this.wake();
  }

  wait(signal) {
    return new Promise((resolve) => {
      const until = this.resetAt ? Math.max(50, this.resetAt - Date.now()) : null;
      const timer = until !== null ? setTimeout(finish, until) : null;
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

  /** For the check page and the log. */
  state() {
    return { model: this.model, limit: this.limit, remaining: this.remaining, reservation: this.reservation, inFlight: this.inFlight, queued: this.queue.length, resetInMs: this.resetAt ? Math.max(0, this.resetAt - Date.now()) : 0 };
  }
}

const gates = new Map();
export function gateFor(model) {
  let g = gates.get(model);
  if (!g) { g = new RateGate(model); gates.set(model, g); }
  return g;
}
