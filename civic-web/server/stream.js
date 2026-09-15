// Newline-delimited JSON streaming to the browser, with heartbeats so long reasoning
// phases do not get cut by idle-connection timeouts on proxies.
import { config } from './config.js';

export function openStream(req, res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const send = (event) => {
    if (closed) return;
    res.write(JSON.stringify(event) + '\n');
  };
  const heartbeat = setInterval(() => send({ t: 'ping', at: Date.now() }), config.heartbeatMs);

  const abort = new AbortController();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.end();
  };
  // Reader navigated away or pressed reset before we finished: stop paying for tokens.
  // (`req` emits 'close' as soon as its body is consumed, so the response is the right signal.)
  res.on('close', () => {
    if (res.writableFinished) return;
    abort.abort();
    closed = true;
    clearInterval(heartbeat);
  });

  return { send, close, signal: abort.signal, isClosed: () => closed };
}
