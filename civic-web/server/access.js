// The door (5 October): an account's session, and nothing else. The access codes of 17 September are gone (the
// operator: "Get rid of access codes"); a reader signs up or signs in with an email and a password (server/accounts.js),
// and the cookie carries a session's random token, which the server holds only as its hash.
//
// Mounted at /api (server/index.js), so the path it sees has that prefix taken off and Express's own matching decides
// what is under /api: the router is case-sensitive there, so /API/extract is nobody's route and reaches no handler
// (until 30 September it did, and the gate, which compared the path in lower case, let it through unchecked).
// Open: the health line and the account's own doors (sign up, sign in, sign out, a reset link, the operator's link).
// Everything else needs a session; /api/operator/* needs the operator's. With CIVIC_ACCOUNTS=off (a laptop, the guard's
// older checks) the door is open, as it was with no codes set.
//
// A request that another site's page makes from this browser is refused whatever cookie it carries: the browser says
// where a request came from (Sec-Fetch-Site), and "cross-site" is never the page. That also keeps another site from
// signing a browser into an account of its choosing. The cookie is SameSite=Lax and every body is JSON, which already
// keeps such a request out in every current browser; this is the same rule said once more, in words the guard proves.
import { config } from './config.js';
import { ApiError } from './openai.js';
import { accountsOn, sessionFor } from './accounts.js';

const COOKIE = 'fe_session';
const OLD_COOKIE = 'civic_access';   // the code sign-in's cookie: cleared when an account signs in or out

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

const attrs = (req, maxAge) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
export function setSessionCookie(req, res, token) {
  res.append('Set-Cookie', `${COOKIE}=${token}; ${attrs(req, config.sessionDays * 24 * 60 * 60)}`);
  res.append('Set-Cookie', `${OLD_COOKIE}=; ${attrs(req, 0)}`);
}
export function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; ${attrs(req, 0)}`);
  res.append('Set-Cookie', `${OLD_COOKIE}=; ${attrs(req, 0)}`);
}

export const required = () => accountsOn();

/** This request's session, { id, user }, or null; read once per request. A store that cannot be read throws. */
export async function sessionOf(req) {
  if (!accountsOn()) return null;
  if (req.account !== undefined) return req.account;
  req.account = await sessionFor(cookieOf(req, COOKIE));
  return req.account;
}

/** Whether this session is the operator's: the flag the operator's one-time link set, and nothing else. */
export const isOperator = (session) => Boolean(session?.user?.operator);

const OPEN = new Set(['/health', '/account/signup', '/account/signin', '/account/signout', '/account/reset', '/account/claim']);
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Whether a request says it comes from another site: the browser's Sec-Fetch-Site, or an Origin naming another host (older Safari sends no Sec-Fetch-Site). */
function fromAnotherSite(req) {
  if (req.get('sec-fetch-site') === 'cross-site') return true;
  const origin = req.get('origin');
  if (!origin || origin === 'null') return false;
  try { return new URL(origin).host !== req.get('host'); } catch { return true; }
}

export async function gate(req, res, next) {
  if (!SAFE.has(req.method) && fromAnotherSite(req)) {
    return next(new ApiError(403, 'cross_site', 'That request came from another site, so FactEngine did not act on it.'));
  }
  // The account's doors and the operator's tools take JSON alone: a form on another site cannot send it.
  if (!SAFE.has(req.method) && /^\/(account|operator)\//.test(req.path) && !req.is('application/json')) {
    return next(Object.assign(new ApiError(415, 'json_only', 'That request must be sent as JSON.'), { expected: true }));
  }
  if (!accountsOn()) return next();
  let session = null;
  try {
    session = await sessionOf(req);
  } catch (err) {
    // The records cannot be read just now: a wait, never an open door. The open routes still answer (the health line).
    console.error('[accounts] a session could not be read:', err.message);
    req.account = null;
    if (OPEN.has(req.path)) return next();
    return next(Object.assign(new ApiError(503, 'books_wait', 'FactEngine is waiting for its records. It will go on by itself.'), { expected: true }));
  }
  if (OPEN.has(req.path)) return next();
  if (!session) return next(Object.assign(new ApiError(401, 'signin_required', 'Sign in or create an account first.'), { expected: true }));
  if (req.path.startsWith('/operator/') && !isOperator(session)) return next(Object.assign(new ApiError(403, 'operator_only', 'That is for the operator\'s account.'), { expected: true }));
  next();
}
