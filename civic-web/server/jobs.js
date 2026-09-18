// The run belongs to the server, not to the connection that asked for it.
//
// On 18 September the cloud copy finished a four-minute extraction and streamed all of it, and the
// reader's browser never received the end: something on the way (the relay the reader's Safari
// goes through) cut the connection, the page said CIVIC was not reachable, and the finished work
// was gone, because a closed connection was taken for a reader who had left and the work was
// thrown away. So now every extraction and every determination is a job, under an id the page
// made. The job records every event it sends. A connection is a subscriber that can come and go:
// a page whose connection was cut attaches again, saying how many events it already has, and
// receives the rest. Nothing is run twice, nothing is paid for twice, nothing finished is lost.
//
// A closed connection stops nothing. What stops a job is the page saying so (Start a new test,
// leaving the page): the cancel route. A finished job is kept until the page says it has all of
// it (the release route), because an end that was written may not have arrived. A deploy ends the
// process and with it every job; the page starts those over on the new one, as before.
import crypto from 'node:crypto';
import { describeError } from './openai.js';

const jobs = new Map();
const listeners = new Set();
const changed = () => { for (const fn of listeners) fn(); };

/** Called whenever a job starts or ends (the shutdown waits on it). Returns the way to stop listening. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Jobs still working right now: the runs in flight, whatever their connections are doing. */
export function active() { let n = 0; for (const j of jobs.values()) if (!j.finished) n++; return n; }

export function ids() { return [...jobs.keys()]; }

class Job {
  constructor(id, kind) {
    this.id = id;
    this.kind = kind;
    this.startedAt = Date.now();
    this.events = [];             // every event sent, in order; a subscriber's cursor indexes this
    this.finished = false;
    this.subscribers = new Set();
    this.abort = new AbortController();
  }

  send(event) {
    if (this.finished) return;
    this.events.push(event);
    for (const s of this.subscribers) s.send(event);
  }

  /**
   * A connection joins: it is told where it is joining (`from`: the first event it will receive,
   * which is its own count unless that is more than exists), receives every event from there, and
   * then everything that follows until the job ends. A job already over is replayed and the
   * connection ended.
   */
  attach(stream, cursor) {
    const asked = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
    const from = Math.min(asked, this.events.length);
    stream.send({ t: 'attached', job: this.id, kind: this.kind, from, total: this.events.length, finished: this.finished, startedAt: this.startedAt });
    for (let k = from; k < this.events.length; k++) stream.send(this.events[k]);
    if (this.finished) { stream.end(); return; }
    this.subscribers.add(stream);
    stream.onClose(() => this.subscribers.delete(stream));
  }

  end() {
    if (this.finished) return;
    this.finished = true;
    for (const s of this.subscribers) s.end();
    this.subscribers.clear();
    changed();
  }
}

/**
 * Starts the job `id` and runs `work({ send, signal })`. Everything `work` sends is recorded and
 * forwarded; when it settles, the job is finished and every attached connection is ended. `work`
 * is expected to send its own error event when it fails; one that throws anyway is reported as
 * an error event, so no job ends in silence.
 */
export function start(id, kind, work) {
  const job = new Job(id, kind);
  jobs.set(id, job);
  changed();
  Promise.resolve()
    .then(() => work({ send: (event) => job.send(event), signal: job.abort.signal }))
    .catch((err) => { const safe = describeError(err); job.send({ t: 'error', code: safe.code, message: safe.message, status: safe.status }); })
    .finally(() => job.end());
  return job;
}

export function get(id) { return jobs.get(id) || null; }

/** The page says stop: the model calls are aborted and the jobs forgotten. Returns how many were. */
export function cancel(list) {
  let n = 0;
  for (const id of list) {
    const job = jobs.get(id);
    if (!job) continue;
    job.abort.abort();
    job.end();
    jobs.delete(id);
    n++;
  }
  return n;
}

/** The page says it has everything: finished jobs are forgotten. A job still working is kept. */
export function release(list) {
  let n = 0;
  for (const id of list) {
    const job = jobs.get(id);
    if (!job || !job.finished) continue;
    jobs.delete(id);
    n++;
  }
  return n;
}

const ID = /^[A-Za-z0-9_.:-]{8,80}$/;

/** The id the page gave, or one made here for a request without one (no coming back to it then). */
export function idFrom(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return ID.test(s) ? s : `j-${crypto.randomUUID()}`;
}

/** The ids in a cancel or release request, as given, unknown ones included (they count for nothing). */
export function idList(value) {
  return (Array.isArray(value) ? value : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => ID.test(x));
}
