// Sign-in by code. No accounts yet, no database: a short list of codes in the environment, and a
// cookie that proves a browser presented one of them.
//
// The site is public once it runs in the cloud, and every run spends the operator's key, so the
// door needs a lock. Until accounts exist the lock is a seven-character code. Five are generated
// and handed to the operator; the list lives in CIVIC_ACCESS_CODES and nowhere else. Only the code
// gates; the email address the sign-in dialog collects is recorded, not checked.
//
// The cookie carries the email, a fingerprint of the code it was issued under, and a signature
// over both, keyed by that code together with the server's own key. So a code taken off the list
// signs out exactly the browsers that used it and nobody else, and a cookie proves nothing on a
// FactEngine whose list does not hold its code. The server's key in the derivation means a cookie
// alone does not let anyone work the code back out of it. Nothing is counted and nothing locks:
// seven characters from an alphabet of thirty-one give 27 billion codes, and guessing is hopeless
// without any limit of ours.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ApiError } from './openai.js';

export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0, O, 1, I or L: a code is read aloud and typed
export const LENGTH = 7;
const COOKIE = 'civic_access';
const MAX_AGE = 400 * 24 * 60 * 60;   // the longest a browser keeps a cookie; the list, not the clock, ends a sign-in

export function generateCode() {
  let s = '';
  for (let i = 0; i < LENGTH; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

/** A code as typed, made canonical: upper case, with spaces and dashes dropped. */
export function normalise(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

export function codes() { return config.accessCodes; }
export function required() { return codes().length > 0; }
/** Whether any code has been named the operator's (CIVIC_OPERATOR_CODES). */
export function operatorsConfigured() { return config.operatorCodes.length > 0; }
/** Whether this session's code is one of the operator's. */
export function isOperator(session) { return Boolean(session) && config.operatorCodes.includes(session.code); }

// The cookie's secret: CIVIC_SESSION_SECRET when the operator has set one (a secret of its own, so
// a change of the OpenAI key signs nobody out and the key plays no part in any cookie); until then,
// as before, a derivation from the server's key. Either way a stolen cookie cannot be worked back
// to its code. Setting the secret once signs everyone out once; /check says so while it is unset.
const secret = () => crypto.createHash('sha256').update(`civic-access:${config.sessionSecret || config.serverKey || ''}`).digest();
const fingerprint = (code) => crypto.createHmac('sha256', secret()).update(`fp:${code}`).digest('hex').slice(0, 16);
/** A code's fingerprint: what a record may hold in place of the code itself. */
export function fingerprintOf(code) { return fingerprint(code); }
const sign = (code, email) => crypto.createHmac('sha256', secret()).update(`mac:${code}\n${email}`).digest('base64url');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

/** The cookie value for a browser that presented `code`. */
export function issue(email, code) {
  const e = String(email || '').trim().slice(0, 254);
  return `${b64(e)}.${fingerprint(code)}.${sign(code, e)}`;
}

/** The session a cookie proves, or null: the email, and the listed code it was issued under. */
export function verify(value) {
  if (!value) return null;
  const parts = String(value).split('.');
  if (parts.length !== 3) return null;
  let email;
  try { email = unb64(parts[0]); } catch { return null; }
  for (const code of codes()) {
    if (fingerprint(code) !== parts[1]) continue;
    const expect = Buffer.from(sign(code, email));
    const got = Buffer.from(parts[2]);
    return expect.length === got.length && crypto.timingSafeEqual(expect, got) ? { email, code } : null;
  }
  return null;
}

function cookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=');
  }
  return '';
}

/** Who this request is, when a sign-in is required and the cookie proves one; null otherwise. */
export function sessionOf(req) { return required() ? verify(cookieOf(req)) : null; }

const attrs = (req, maxAge) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
export function setCookie(req, res, value) { res.setHeader('Set-Cookie', `${COOKIE}=${value}; ${attrs(req, MAX_AGE)}`); }
export function clearCookie(req, res) { res.setHeader('Set-Cookie', `${COOKIE}=; ${attrs(req, 0)}`); }

// Who signed in: kept for /check, written to the sign-in log, and said in the server's own log
// stream, which the host keeps when the file does not survive a deploy.
const signins = [];
// What the log already holds, so a restart in place does not forget who signed in.
try {
  if (config.signinLog && fs.existsSync(config.signinLog)) {
    for (const line of fs.readFileSync(config.signinLog, 'utf8').trim().split('\n').slice(-50).reverse()) {
      try { const e = JSON.parse(line); if (e?.at) signins.push(e); } catch { /* a torn line */ }
    }
  }
} catch { /* the list starts empty */ }
export function recordSignin(email, code) {
  const entry = { at: new Date().toISOString(), email: email || '', code: code.slice(-2) };
  signins.unshift(entry);
  if (signins.length > 50) signins.length = 50;
  console.log(`[civic] sign-in ${entry.at} ${entry.email || '(no email given)'} with a code ending ${entry.code}`);
  if (config.signinLog) {
    try {
      fs.mkdirSync(path.dirname(config.signinLog), { recursive: true });
      fs.appendFileSync(config.signinLog, `${JSON.stringify(entry)}\n`);
    } catch { /* a log that cannot be written must never stop a sign-in */ }
  }
  return entry;
}
export function recentSignins(n = 10) { return signins.slice(0, n); }

/**
 * The door. Mounted at /api (server/index.js), so the path it sees has that prefix taken off and
 * Express's own matching decides what is under /api: the router is case-sensitive there, so
 * /API/extract is nobody's route and reaches no handler (until 30 September it did, and the gate,
 * which compared the path in lower case, let it through unchecked). Open when no codes are set
 * (the Mac, the guard, the stand-in). Otherwise every route but the health line, the sign-in
 * itself and the sign-out needs the cookie. The page, its files and the check page's HTML are
 * public: what they cannot do without a code is work.
 *
 * A request that another site's page makes from this browser is refused whatever cookie it
 * carries: the browser says where a request came from (Sec-Fetch-Site), and "cross-site" is never
 * the page. The cookie is SameSite=Lax and every body is JSON, which already keeps such a request
 * out in every current browser; this is the same rule said once more, in words the guard proves.
 */
const OPEN = new Set(['/health', '/signin', '/signout']);
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export function gate(req, res, next) {
  if (!SAFE.has(req.method) && req.get('sec-fetch-site') === 'cross-site') {
    return next(new ApiError(403, 'cross_site', 'That request came from another site, so FactEngine did not act on it.'));
  }
  if (!required() || OPEN.has(req.path)) return next();
  const session = verify(cookieOf(req));
  if (!session) return next(new ApiError(401, 'signin_required', 'Sign in with an access code first.'));
  req.session = session;
  next();
}
