// What a conversation's page holds is sealed by the server (server/chat.js). The page holds the conversation, as it
// holds the results, and FactEngine keeps none of its text; so that the page can neither put words in the inspector's
// mouth nor start a conversation's count of questions again, every state the server delivers (the fact-check's, then
// each reply's) is sealed here, and a page's history is checked against its seal before anything is held or sent.
//
// A seal is AES-256-GCM: the page can neither read it (it carries the inspector's name, which readers are not to see)
// nor make or change one. Its key is random, made by the server, kept in Postgres (server_keys), never a setting and
// never shown. Without a database each process makes its own, and its conversations end at a restart.
import crypto from 'node:crypto';
import { dbOn, query } from './db.js';

let key = null;
let store = 'none';

/** Reads the seal's key, or makes it the first time: once, at boot. */
export async function loadSealKey() {
  if (dbOn()) {
    await query('INSERT INTO server_keys (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', ['seal', crypto.randomBytes(32).toString('hex')]);
    const r = await query('SELECT value FROM server_keys WHERE name = $1', ['seal']);
    key = Buffer.from(r.rows[0].value, 'hex');
    store = 'postgres';
    return;
  }
  key = crypto.randomBytes(32);
  store = 'memory';
}

export const sealReady = () => Boolean(key);
/** Where the key lives: 'postgres' (conversations outlive a deploy) or 'memory' (they end with this process). */
export const sealStore = () => store;

/** A sealed copy of `payload`, for the page to hold and hand back. */
export function seal(payload) {
  if (!key) throw new Error('the seal has no key yet');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url')}`;
}

/** The payload of a seal this server made, or null for anything else (altered, from another key, not a seal). */
export function unseal(token) {
  if (!key || typeof token !== 'string' || !token.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(token.slice(3), 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
  } catch { return null; }
}

/** SHA-256 of a text, in hex: how a seal names what it covers without carrying it. */
export const sha = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
