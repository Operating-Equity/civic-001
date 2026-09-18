// Newline-delimited JSON streaming to the browser, with heartbeats so a long silence (the model
// thinking for minutes) is not taken for a dead connection by anything on the way.
//
// A stream is one connection's view of a job (server/jobs.js): opened by the request, fed by the
// job, ended by the job's end or by the connection closing. Its closing stops nothing: the job
// goes on, and the page attaches again when it can.
import { config } from './config.js';

export function openStream(req, res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const closers = [];
  const send = (event) => {
    if (closed) return;
    res.write(JSON.stringify(event) + '\n');
  };
  const heartbeat = setInterval(() => send({ t: 'ping', at: Date.now() }), config.heartbeatMs);
  const settle = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of closers) fn();
  };
  const end = () => { if (closed) return; settle(); res.end(); };
  // The connection went, however it went: the job is not told to stop, only that this listener is gone.
  res.on('close', settle);
  res.on('error', settle);   // a write that finds the socket already gone is that same news, not a fault

  return { send, end, onClose: (fn) => { if (closed) fn(); else closers.push(fn); }, isClosed: () => closed };
}
