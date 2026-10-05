// Accounts (5 October). The operator: "Get rid of access codes … We need to establish a sign-up and sign-on process
// first, followed by payments … assume everyone who signs up gets $10 in their account." A reader signs up with an
// email address and a password and signs in with them. No email is sent (there is no mail service and no domain yet),
// so an address is never verified: it names the account and nothing more. Whoever forgets their password writes to
// support; the operator makes a one-time link on /check and sends it.
//
// - A password is kept only as a scrypt hash (16-byte salt; N=2^14, r=8, p=5: OWASP's setting of the same strength as
//   N=2^17 with an eighth of the memory, 16 MiB a hash, which a 512 MB instance can afford), and compared in constant
//   time. An unknown email costs the time a wrong password does.
// - A session is 32 random bytes in the cookie; the server keeps only their SHA-256, the account, and when the session
//   began, was last used and ends. It slides forward as it is used (at most once an hour), and it ends at sign-out,
//   at "sign out everywhere", at a change of password and when the account is closed.
// - The sign-up credit (CIVIC_SIGNUP_GRANT_CENTS) is written in the same transaction as the account (server/credit.js).
// - The operator's own account is not made through the open form: an address in CIVIC_OPERATOR_EMAILS answers there as
//   any taken address does, since otherwise whoever signed up first as the operator would see every account. It is made
//   through a one-time link whose SHA-256 alone is the setting CIVIC_OPERATOR_CLAIM; the link itself goes to the
//   operator as a private file. The account it makes carries the operator's flag, which nothing else sets.
//
// Postgres when DATABASE_URL is set; memory otherwise (a laptop, the guard), where accounts end with the process.
import crypto from 'node:crypto';
import { config } from './config.js';
import { dbOn, query, tx } from './db.js';
import * as credit from './credit.js';
import { ApiError } from './openai.js';
import { now } from './clock.js';

export const SCRYPT = { N: 16384, r: 8, p: 5 };
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_PASSWORD = 1024;   // a body no longer than this is hashed; past it, a refusal instead of a long computation

export const accountsOn = () => config.accounts;

// ---- passwords -------------------------------------------------------------------------------------------
const scryptAsync = (password, salt, { N, r, p }) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
});

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password), salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

let dummyHash = null;   // a hash of a password nobody knows: what an unknown email is checked against
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    dummyHash = dummyHash || await hashPassword(crypto.randomBytes(24).toString('hex'));
    await verifyPassword(password, dummyHash);
    return false;
  }
  const [, N, r, p, salt, key] = parts;
  const want = Buffer.from(key, 'base64url');
  const got = await scryptAsync(String(password), Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---- small things ----------------------------------------------------------------------------------------
const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');
export const emailKey = (email) => String(email || '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+$/;

const refuse = {
  emailInvalid: () => new ApiError(400, 'email_invalid', 'Enter the email address you use.'),
  passwordShort: () => new ApiError(400, 'password_short', `Choose a password of at least ${config.passwordMinChars} characters.`),
  passwordLong: () => new ApiError(400, 'password_long', `A password can have at most ${MAX_PASSWORD} characters.`),
  terms: () => new ApiError(400, 'terms_required', 'Tick the box to agree to the Terms and the Privacy Policy.'),
  taken: () => new ApiError(409, 'email_taken', 'An account with this email exists. Sign in instead.'),
  wrong: () => new ApiError(401, 'wrong_password', 'That email and password do not match.'),
  closed: () => new ApiError(403, 'account_closed', 'This account is closed. Write to support@operatingequity.ai.'),
  resetInvalid: () => new ApiError(400, 'reset_invalid', 'This link has been used or has run out. Write to support@operatingequity.ai for a new one.'),
  claimInvalid: () => new ApiError(400, 'claim_invalid', 'This link has been used or is not the operator\'s.'),
  wait: (seconds, code = 'tries_wait') => Object.assign(new ApiError(429, code, `Too many tries. Try again in ${Math.max(1, Math.ceil(seconds / 60))} minutes.`), { extra: { waitSeconds: Math.ceil(seconds) } }),
};

function checkPassword(password) {
  const p = String(password ?? '');
  if (p.length > MAX_PASSWORD) throw refuse.passwordLong();
  if ([...p].length < config.passwordMinChars) throw refuse.passwordShort();
  return p;
}
function checkEmail(email) {
  const e = String(email ?? '').trim();
  if (e.length > 254 || !EMAIL.test(e)) throw refuse.emailInvalid();
  return e;
}

// ---- limits on wrong passwords and on sign-ups (in memory: no address is ever stored) --------------------------
const tries = new Map();     // 'e:<email key>' or 'a:<address>' → times of wrong passwords in the last hour
const signups = new Map();   // '<address>' → times of sign-ups in the last day
function recent(map, key, windowMs) {
  const t = now();
  const list = (map.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length) map.set(key, list); else map.delete(key);
  return list;
}
/** Seconds to wait before this email (or this address) may try again; 0 when it may now. */
function triesWait(key, address) {
  const t = now();
  let wait = 0;
  const e = recent(tries, `e:${key}`, HOUR);
  if (config.signinTries > 0 && e.length >= config.signinTries) wait = Math.max(wait, (e[e.length - config.signinTries] + HOUR - t) / 1000);
  if (address && config.signinTriesPerAddress > 0) {
    const a = recent(tries, `a:${address}`, HOUR);
    if (a.length >= config.signinTriesPerAddress) wait = Math.max(wait, (a[a.length - config.signinTriesPerAddress] + HOUR - t) / 1000);
  }
  return wait;
}
function noteWrong(key, address) {
  const t = now();
  tries.set(`e:${key}`, [...recent(tries, `e:${key}`, HOUR), t]);
  if (address && config.signinTriesPerAddress > 0) tries.set(`a:${address}`, [...recent(tries, `a:${address}`, HOUR), t]);
}

// ---- the store ---------------------------------------------------------------------------------------------
const mem = { users: new Map(), byKey: new Map(), sessions: new Map(), resets: new Map(), claims: new Map(), nextId: 1 };
const ms = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.getTime() : Number(v));
const rowUser = (r) => (r ? {
  id: Number(r.id), email: r.email, emailKey: r.email_key, passwordHash: r.password_hash, createdAt: ms(r.created_at),
  termsAt: ms(r.terms_at), termsVersion: r.terms_version, monthlyLimitCents: r.monthly_limit_cents === null ? null : Number(r.monthly_limit_cents),
  operator: Boolean(r.operator), blockedAt: ms(r.blocked_at), deletedAt: ms(r.deleted_at),
} : null);

async function userByKey(key) {
  if (!dbOn()) { const id = mem.byKey.get(key); return id ? { ...mem.users.get(id) } : null; }
  return rowUser((await query('SELECT * FROM users WHERE email_key = $1', [key])).rows[0]);
}
export async function userById(id) {
  if (!dbOn()) { const u = mem.users.get(Number(id)); return u ? { ...u } : null; }
  return rowUser((await query('SELECT * FROM users WHERE id = $1', [id])).rows[0]);
}

/** Makes the account and its sign-up credit together. `c` is a transaction's client (Postgres). */
async function createUser({ email, passwordHash, operator = false }, c = null) {
  const key = emailKey(email);
  const at = now();
  if (!dbOn()) {
    if (mem.byKey.has(key)) throw refuse.taken();
    const user = { id: mem.nextId++, email, emailKey: key, passwordHash, createdAt: at, termsAt: at, termsVersion: config.termsVersion, monthlyLimitCents: null, operator: Boolean(operator), blockedAt: null, deletedAt: null };
    mem.users.set(user.id, user);
    mem.byKey.set(key, user.id);
    await credit.grant(user.id, config.signupGrantCents, 'sign-up credit');
    return { ...user };
  }
  const r = await c.query('INSERT INTO users (email, email_key, password_hash, created_at, terms_at, terms_version, operator) VALUES ($1, $2, $3, $4, $4, $5, $6) ON CONFLICT (email_key) DO NOTHING RETURNING *',
    [email, key, passwordHash, new Date(at), config.termsVersion, Boolean(operator)]);
  if (!r.rows[0]) throw refuse.taken();
  const user = rowUser(r.rows[0]);
  await credit.grant(user.id, config.signupGrantCents, 'sign-up credit', c);
  return user;
}

// ---- sign-up, sign-in, sessions --------------------------------------------------------------------------------
/** A new account through the open form: { user }. */
export async function signUp({ email, password, agree, address = null }) {
  const e = checkEmail(email);
  const p = checkPassword(password);
  if (agree !== true) throw refuse.terms();
  if (config.operatorEmails.includes(emailKey(e))) throw refuse.taken();   // made only through the operator's link
  if (address && config.signupsPerAddressPerDay > 0) {
    const list = recent(signups, address, DAY);
    if (list.length >= config.signupsPerAddressPerDay) throw refuse.wait((list[list.length - config.signupsPerAddressPerDay] + DAY - now()) / 1000, 'signups_wait');
  }
  const passwordHash = await hashPassword(p);
  const user = dbOn() ? await tx((c) => createUser({ email: e, passwordHash }, c)) : await createUser({ email: e, passwordHash });
  if (address && config.signupsPerAddressPerDay > 0) signups.set(address, [...recent(signups, address, DAY), now()]);
  console.log(`[accounts] a new account (${user.id})`);
  return { user };
}

/** An account's email and password: { user }, or the refusal. */
export async function signIn({ email, password, address = null }) {
  const key = emailKey(email);
  const wait = triesWait(key, address);
  if (wait > 0) throw refuse.wait(wait);
  const p = String(password ?? '').slice(0, MAX_PASSWORD + 1);
  const user = key ? await userByKey(key) : null;
  const ok = await verifyPassword(p, user && !user.deletedAt ? user.passwordHash : null);
  if (!user || !ok || user.deletedAt) { noteWrong(key, address); throw refuse.wrong(); }
  if (user.blockedAt) throw refuse.closed();
  tries.delete(`e:${key}`);
  return { user };
}

/** A new session for an account: the token for the cookie (never kept), and when it ends. */
export async function openSession(userId) {
  const token = newToken();
  const id = hashToken(token);
  const at = now();
  const expiresAt = at + config.sessionDays * DAY;
  if (!dbOn()) mem.sessions.set(id, { id, userId, createdAt: at, seenAt: at, expiresAt, revokedAt: null });
  else await query('INSERT INTO sessions (id, user_id, created_at, seen_at, expires_at) VALUES ($1, $2, $3, $3, $4)', [id, userId, new Date(at), new Date(expiresAt)]);
  return { token, id, expiresAt };
}

/** The session a cookie's token proves, with its account: { id, user }, or null. */
export async function sessionFor(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const id = hashToken(token);
  const at = now();
  if (!dbOn()) {
    const s = mem.sessions.get(id);
    const u = s ? mem.users.get(s.userId) : null;
    if (!s || !u || s.revokedAt || s.expiresAt <= at || u.blockedAt || u.deletedAt) return null;
    if (at - s.seenAt > HOUR) { s.seenAt = at; s.expiresAt = at + config.sessionDays * DAY; }
    return { id, user: { ...u } };
  }
  const r = await query(`SELECT s.id AS session_id, s.seen_at AS session_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.blocked_at IS NULL AND u.deleted_at IS NULL`, [id, new Date(at)]);
  const row = r.rows[0];
  if (!row) return null;
  if (at - ms(row.session_seen) > HOUR) {
    query('UPDATE sessions SET seen_at = $2, expires_at = $3 WHERE id = $1', [id, new Date(at), new Date(at + config.sessionDays * DAY)])
      .catch((err) => console.error('[accounts] a session could not be renewed:', err.message));
  }
  return { id, user: rowUser(row) };
}

export async function closeSession(id) {
  if (!id) return;
  if (!dbOn()) { const s = mem.sessions.get(id); if (s) s.revokedAt = now(); return; }
  await query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, new Date(now())]);
}

/** Every session of an account ends, but one (the one asking, when it asks to stay). */
export async function closeSessions(userId, { except = null } = {}) {
  if (!dbOn()) { for (const s of mem.sessions.values()) if (s.userId === userId && s.id !== except && !s.revokedAt) s.revokedAt = now(); return; }
  await query('UPDATE sessions SET revoked_at = $3 WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)', [userId, except, new Date(now())]);
}

/** A new password for a signed-in account, given the current one; every other session ends. */
export async function changePassword(user, { current, next, sessionId }) {
  const p = checkPassword(next);
  const fresh = await userById(user.id);
  if (!fresh || !(await verifyPassword(String(current ?? '').slice(0, MAX_PASSWORD + 1), fresh.passwordHash))) throw refuse.wrong();
  await setPasswordHash(user.id, await hashPassword(p));
  await closeSessions(user.id, { except: sessionId });
}

async function setPasswordHash(userId, hash) {
  if (!dbOn()) { const u = mem.users.get(userId); if (u) u.passwordHash = hash; return; }
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
}

// ---- reset links (made by the operator on /check) ------------------------------------------------------------------
export async function makeResetLink(userId, { byEmail = null } = {}) {
  const user = await userById(userId);
  if (!user || user.deletedAt) throw new ApiError(404, 'no_account', 'There is no such account.');
  const token = newToken();
  const id = hashToken(token);
  const at = now();
  const expiresAt = at + config.resetLinkHours * HOUR;
  if (!dbOn()) mem.resets.set(id, { id, userId, madeAt: at, madeBy: byEmail, expiresAt, usedAt: null });
  else await query('INSERT INTO password_resets (id, user_id, made_at, made_by, expires_at) VALUES ($1, $2, $3, $4, $5)', [id, userId, new Date(at), byEmail, new Date(expiresAt)]);
  return { token, expiresAt, email: user.email };
}

/** A reset link sets a new password once; every session of the account ends, and a new one begins: { user }. */
export async function useResetLink({ token, password }) {
  const p = checkPassword(password);
  const id = hashToken(token);
  const liveInMemory = (at) => { const r = mem.resets.get(id); return r && !r.usedAt && r.expiresAt > at ? r : null; };
  // The link is looked at before the password is hashed: a made-up token costs a lookup, never a hash.
  const unused = !dbOn() ? Boolean(liveInMemory(now()))
    : Boolean((await query('SELECT 1 FROM password_resets WHERE id = $1 AND used_at IS NULL AND expires_at > $2', [id, new Date(now())])).rows[0]);
  if (!unused) throw refuse.resetInvalid();
  const passwordHash = await hashPassword(p);
  // Then it is spent, once: a second request that came in meanwhile finds it used.
  const at = now();
  let userId = null;
  if (!dbOn()) {
    const r = liveInMemory(at);
    if (!r) throw refuse.resetInvalid();
    r.usedAt = at;
    userId = r.userId;
  } else {
    const r = await query('UPDATE password_resets SET used_at = $2 WHERE id = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id', [id, new Date(at)]);
    if (!r.rows[0]) throw refuse.resetInvalid();
    userId = Number(r.rows[0].user_id);
  }
  const user = await userById(userId);
  if (!user || user.deletedAt) throw refuse.resetInvalid();
  if (user.blockedAt) throw refuse.closed();
  await setPasswordHash(userId, passwordHash);
  await closeSessions(userId);
  return { user };
}

// ---- the operator's account, through the one-time link ----------------------------------------------------------
export const claimSet = () => /^[0-9a-f]{64}$/.test(config.operatorClaim || '');
export async function claimOperator({ token, email, password, agree }) {
  if (!claimSet() || hashToken(token) !== config.operatorClaim) throw refuse.claimInvalid();
  const e = checkEmail(email);
  const p = checkPassword(password);
  if (agree !== true) throw refuse.terms();
  const passwordHash = await hashPassword(p);
  const id = config.operatorClaim;
  let user;
  if (!dbOn()) {
    if (mem.claims.has(id)) throw refuse.claimInvalid();
    user = await createUser({ email: e, passwordHash, operator: true });
    mem.claims.set(id, { id, userId: user.id, claimedAt: now() });
  } else {
    user = await tx(async (c) => {
      const used = await c.query('SELECT 1 FROM operator_claims WHERE id = $1 FOR UPDATE', [id]);
      if (used.rows[0]) throw refuse.claimInvalid();
      const u = await createUser({ email: e, passwordHash, operator: true }, c);
      await c.query('INSERT INTO operator_claims (id, user_id) VALUES ($1, $2)', [id, u.id]);
      return u;
    });
  }
  console.log(`[accounts] the operator's account was made (${user.id})`);
  return { user };
}
export async function claimUsed() {
  if (!claimSet()) return false;
  if (!dbOn()) return mem.claims.has(config.operatorClaim);
  return Boolean((await query('SELECT 1 FROM operator_claims WHERE id = $1', [config.operatorClaim])).rows[0]);
}

// ---- what an account sees, and what the operator sees -----------------------------------------------------------
export async function view(user) {
  const at = now();
  const { end } = credit.monthOf(at);
  const [balanceCents, monthSpentCents] = await Promise.all([credit.balanceOf(user.id), credit.monthSpent(user.id, at)]);
  return {
    email: user.email, createdAt: new Date(user.createdAt).toISOString(), operator: Boolean(user.operator),
    balanceCents, monthlyLimitCents: user.monthlyLimitCents, monthSpentCents, monthEndsAt: new Date(end).toISOString(),
    currency: config.currency, grantCents: config.signupGrantCents,
  };
}

export async function setMonthlyLimit(userId, cents) {
  const v = cents === null || cents === undefined || cents === '' ? null : Number(cents);
  if (v !== null && (!Number.isInteger(v) || v < 0 || v > 100_000_000)) throw new ApiError(400, 'limit_invalid', 'A monthly limit is an amount of money, or none.');
  if (!dbOn()) { const u = mem.users.get(userId); if (u) u.monthlyLimitCents = v; return v; }
  await query('UPDATE users SET monthly_limit_cents = $2 WHERE id = $1', [userId, v]);
  return v;
}

export async function setBlocked(userId, blocked) {
  const at = blocked ? now() : null;
  if (!dbOn()) { const u = mem.users.get(userId); if (!u) throw new ApiError(404, 'no_account', 'There is no such account.'); u.blockedAt = at; }
  else if (!(await query('UPDATE users SET blocked_at = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id', [userId, at === null ? null : new Date(at)])).rows[0]) throw new ApiError(404, 'no_account', 'There is no such account.');
  if (blocked) await closeSessions(userId);
}

/** An account deleted at the reader's request: its email and password go, its sessions end; its amounts stay for the books. */
export async function deleteAccount(userId) {
  const at = now();
  if (!dbOn()) {
    const u = mem.users.get(userId);
    if (!u) throw new ApiError(404, 'no_account', 'There is no such account.');
    mem.byKey.delete(u.emailKey);
    Object.assign(u, { email: '', emailKey: `deleted:${u.id}`, passwordHash: '', deletedAt: at, blockedAt: u.blockedAt || at });
  } else if (!(await query("UPDATE users SET email = '', email_key = 'deleted:' || id, password_hash = '', deleted_at = $2, blocked_at = COALESCE(blocked_at, $2) WHERE id = $1 AND deleted_at IS NULL RETURNING id", [userId, new Date(at)])).rows[0]) {
    throw new ApiError(404, 'no_account', 'There is no such account.');
  }
  await closeSessions(userId);
}

/** Every account, newest first, with its balance, this month's spend and its charged tests: the operator's table. */
export async function list() {
  const at = now();
  const sums = await credit.summaryByUser(at);
  const users = !dbOn() ? [...mem.users.values()].map((u) => ({ ...u })) : (await query('SELECT * FROM users ORDER BY id DESC')).rows.map(rowUser);
  return users.sort((a, b) => b.id - a.id).map((u) => {
    const s = sums.get(u.id) || { balanceCents: 0, monthCents: 0, tests: 0 };
    return { id: u.id, email: u.deletedAt ? null : u.email, createdAt: new Date(u.createdAt).toISOString(), operator: u.operator, blocked: Boolean(u.blockedAt), deleted: Boolean(u.deletedAt), monthlyLimitCents: u.monthlyLimitCents, ...s };
  });
}

/** At boot: the schema is made by server/db.js (economics.boot or here); this only says where the accounts live. */
export function bootLine() {
  if (!accountsOn()) return '[accounts] off (CIVIC_ACCOUNTS=off): the door is open and nothing is charged to anyone';
  const retired = ['CIVIC_ACCESS_CODES', 'CIVIC_OPERATOR_CODES', 'CIVIC_CODE_USES', 'CIVIC_USES_FILE', 'CIVIC_SIGNIN_LOG', 'CIVIC_SESSION_SECRET'].filter((n) => String(process.env[n] || '').trim());
  return `[accounts] sign-in by email and password · ${dbOn() ? 'kept in Postgres' : 'kept in this instance\'s memory until it stops'} · new accounts start with ${config.signupGrantCents} cents of credit`
    + `${claimSet() ? ' · the operator\'s link is set' : ''}${retired.length ? ` · no longer read: ${retired.join(', ')}` : ''}`;
}

/** The guard's view of the memory store. */
export function memState() { return { users: [...mem.users.values()].map((u) => ({ ...u })), sessions: [...mem.sessions.values()].map((s) => ({ ...s })) }; }
