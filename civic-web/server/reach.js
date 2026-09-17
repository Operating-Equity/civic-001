// Whether OpenAI can be reached from this computer, and the record of the times it could not.
//
// A run of 17 September lost eight of ten claims to EHOSTUNREACH: the operating system had no
// route to api.openai.com for a while (a Wi-Fi roam, a VPN reconnecting, a wake from sleep, a
// network switched off), and the program tried each claim three times within the same few
// milliseconds, into the same missing route, and gave up. OpenAI never received those requests.
// A missing route is waited out, not counted (openai.js, connectionWait). This module keeps the
// account of the wait, so /check can say when the connection was lost, why, and for how long,
// with the addresses this machine had at the time: a network that is off looks different from a
// route that is missing while the network is up.
import os from 'node:os';
import { record } from './diagnostics.js';

let outage = null;   // { since, code, why, goes } while OpenAI cannot be reached

/** The addresses this machine has, for the record. Link-local and loopback addresses say nothing. */
export function addresses() {
  const parts = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.internal) continue;
        const v6 = a.family === 'IPv6' || a.family === 6;
        if (v6 && /^fe80:/i.test(a.address)) continue;
        parts.push(`${name} ${a.address}`);
      }
    }
  } catch { /* the record is a courtesy; a run never depends on it */ }
  return parts.length ? parts.join(', ') : 'no interface has an address';
}

/**
 * A request could not reach OpenAI, or its reply was cut. The first failure opens an outage and
 * records it once, with the addresses at that moment; later failures are counted on it. Returns
 * the outage, whose `since` the row shows.
 */
export function noteFailure({ code, why }) {
  if (outage) { outage.goes++; outage.code = code; outage.why = why; return outage; }
  outage = { since: Date.now(), code, why, goes: 1 };
  record({ where: 'server:connection', code, message: `OpenAI cannot be reached: ${why} (${code}) · addresses: ${addresses()}` });
  return outage;
}

/** A reply arrived, of any kind: OpenAI is reached. Closes the outage, if one is open, with its length. */
export function noteReply() {
  if (!outage) return;
  const ms = Date.now() - outage.since;
  record({ where: 'server:connection', code: 'reachable', message: `OpenAI reachable again after ${(ms / 1000).toFixed(1)} s and ${outage.goes} ${outage.goes === 1 ? 'go' : 'goes'} (${outage.why})` });
  outage = null;
}

/** The outage on record, or null. */
export function current() { return outage ? { ...outage } : null; }
