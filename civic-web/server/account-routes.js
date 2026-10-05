// The account's routes (5 October): sign up, sign in, sign out, a reset link, the operator's one-time link, the
// account's own page, and the operator's tools. The gate (server/access.js) has already decided who may reach each:
// the first five are open, /api/account/* needs a session, /api/operator/* the operator's.
import { config } from './config.js';
import { ApiError } from './openai.js';
import * as accounts from './accounts.js';
import * as credit from './credit.js';
import * as economics from './economics.js';
import { sessionOf, isOperator, setSessionCookie, clearSessionCookie } from './access.js';
import { now } from './clock.js';

const expected = (err) => Object.assign(err, { expected: true });
const address = (req) => String(req.ip || '');
const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

/** What the page is told of a session: never more than the account's own email, flag and balance. */
async function sessionView(user) {
  return { email: user.email, operator: Boolean(user.operator), balanceCents: await credit.balanceOf(user.id).catch(() => null) };
}

/** A new session replaces whatever session this request carried (a fresh token at every sign-in: no fixation). */
async function signInAs(req, res, user) {
  const old = req.account?.id;
  if (old) await accounts.closeSession(old).catch(() => {});
  const { token } = await accounts.openSession(user.id);
  setSessionCookie(req, res, token);
  return sessionView(user);
}

/** The session the gate let through; with accounts off there is none, and the account's routes have nothing to act on. */
async function sessionNeeded(req) {
  const s = await sessionOf(req);
  if (!s) throw expected(new ApiError(401, 'signin_required', 'Sign in or create an account first.'));
  return s;
}

const userIdOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw expected(new ApiError(400, 'no_account', 'There is no such account.')); return n; };

/** A reader's activity, newest first: the sign-up credit, the operator's adjustments, and each test, charged, free or not charged. */
async function activity(userId, beforeAt) {
  const limit = 50;
  const ledger = await credit.rowsFor(userId, { beforeAt, limit });
  const free = await economics.freeTestsFor(userId, { beforeAt, limit });
  const ids = ledger.rows.filter((r) => r.kind === 'hold' && r.determinationId).map((r) => r.determinationId);
  const tests = await economics.testsByIds(ids);
  const lines = [
    ...ledger.rows.map((r) => {
      if (r.kind === 'hold') {
        const d = tests.get(r.determinationId) || {};
        return { at: r.at, kind: 'test', state: r.state, amountCents: r.amountCents, n: d.n ?? null, verdict: d.verdict ?? null, runId: r.runId };
      }
      return { at: r.at, kind: r.kind, amountCents: r.amountCents, cents: r.cents, note: r.kind === 'adjustment' ? r.note : null };
    }),
    ...free.rows.map((d) => ({ at: d.startedAt, kind: 'test', state: 'free', amountCents: 0, n: d.n ?? null, verdict: d.verdict ?? null, runId: d.runId })),
  ].sort((a, b) => b.at - a.at).slice(0, limit);
  const more = ledger.more || free.more || ledger.rows.length + free.rows.length > limit;
  return { lines: lines.map((l) => ({ ...l, at: new Date(l.at).toISOString() })), more, before: lines.length ? new Date(lines[lines.length - 1].at).toISOString() : null };
}

export function mountAccountRoutes(app, { wrap }) {
  // ---- the open doors ----
  app.post('/api/account/signup', wrap(async (req, res) => {
    if (!accounts.accountsOn()) throw expected(new ApiError(404, 'accounts_off', 'This FactEngine has no accounts.'));
    const b = body(req);
    const { user } = await accounts.signUp({ email: b.email, password: b.password, agree: b.agree === true, address: address(req) });
    res.json({ ok: true, session: await signInAs(req, res, user) });
  }));

  app.post('/api/account/signin', wrap(async (req, res) => {
    if (!accounts.accountsOn()) throw expected(new ApiError(404, 'accounts_off', 'This FactEngine has no accounts.'));
    const b = body(req);
    const { user } = await accounts.signIn({ email: b.email, password: b.password, address: address(req) });
    res.json({ ok: true, session: await signInAs(req, res, user) });
  }));

  app.post('/api/account/signout', wrap(async (req, res) => {
    const s = await sessionOf(req).catch(() => null);
    if (s) await accounts.closeSession(s.id).catch(() => {});
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }));

  app.post('/api/account/reset', wrap(async (req, res) => {
    const b = body(req);
    const { user } = await accounts.useResetLink({ token: b.token, password: b.password });
    res.json({ ok: true, session: await signInAs(req, res, user) });
  }));

  app.post('/api/account/claim', wrap(async (req, res) => {
    const b = body(req);
    const { user } = await accounts.claimOperator({ token: b.token, email: b.email, password: b.password, agree: b.agree === true });
    res.json({ ok: true, session: await signInAs(req, res, user) });
  }));

  // ---- the account's own ----
  app.get('/api/account', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = await sessionNeeded(req);
    res.json({ ok: true, account: await accounts.view(s.user), claim: false });
  }));

  app.get('/api/account/activity', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = await sessionNeeded(req);
    const before = req.query.before ? Date.parse(String(req.query.before)) : null;
    res.json({ ok: true, ...(await activity(s.user.id, Number.isFinite(before) ? before : null)) });
  }));

  app.post('/api/account/limit', wrap(async (req, res) => {
    const s = await sessionNeeded(req);
    const cents = body(req).cents;
    const set = await accounts.setMonthlyLimit(s.user.id, cents === null || cents === undefined || cents === '' ? null : Number(cents));
    res.json({ ok: true, monthlyLimitCents: set });
  }));

  app.post('/api/account/password', wrap(async (req, res) => {
    const s = await sessionNeeded(req);
    const b = body(req);
    await accounts.changePassword(s.user, { current: b.current, next: b.next, sessionId: s.id });
    res.json({ ok: true });
  }));

  app.post('/api/account/signout-all', wrap(async (req, res) => {
    const s = await sessionNeeded(req);
    await accounts.closeSessions(s.user.id);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }));

  // The reader deletes their own account (their password, again): the email and password go, every session ends.
  app.post('/api/account/delete', wrap(async (req, res) => {
    const s = await sessionNeeded(req);
    if (s.user.operator) throw expected(new ApiError(409, 'operator_account', 'The operator\'s account cannot be deleted here.'));
    await accounts.signIn({ email: s.user.email, password: body(req).password, address: address(req) });
    await accounts.deleteAccount(s.user.id);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }));

  // ---- the operator's tools (the gate lets the operator's session alone through) ----
  app.get('/api/operator/accounts', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, accounts: await accounts.list(), totals: await credit.totals(), currency: config.currency, at: new Date(now()).toISOString(), claimSet: accounts.claimSet(), claimUsed: await accounts.claimUsed() });
  }));

  app.post('/api/operator/credit', wrap(async (req, res) => {
    const s = await sessionNeeded(req);
    const b = body(req);
    const userId = userIdOf(b.userId);
    const cents = Number(b.cents);
    if (!Number.isInteger(cents) || cents === 0 || Math.abs(cents) > 100_000_00) throw expected(new ApiError(400, 'amount_invalid', 'An amount of credit is a whole number of cents, not zero.'));
    const target = await accounts.userById(userId);
    if (!target || target.deletedAt) throw expected(new ApiError(404, 'no_account', 'There is no such account.'));
    await credit.adjust(userId, cents, { note: String(b.note || '').trim().slice(0, 200) || null, byEmail: s.user.email });
    res.json({ ok: true, balanceCents: await credit.balanceOf(userId) });
  }));

  app.post('/api/operator/reset-link', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = await sessionNeeded(req);
    const userId = userIdOf(body(req).userId);
    const link = await accounts.makeResetLink(userId, { byEmail: s.user.email });
    // The token travels after `#`, so it never reaches a server's log or another site as a referrer.
    res.json({ ok: true, link: `${req.protocol}://${req.get('host')}/account#reset=${link.token}`, email: link.email, expiresAt: new Date(link.expiresAt).toISOString() });
  }));

  app.post('/api/operator/block', wrap(async (req, res) => {
    const b = body(req);
    const userId = userIdOf(b.userId);
    const target = await accounts.userById(userId);
    if (target?.operator) throw expected(new ApiError(409, 'operator_account', 'The operator\'s account cannot be closed here.'));
    await accounts.setBlocked(userId, b.blocked === true);
    res.json({ ok: true });
  }));

  app.post('/api/operator/delete', wrap(async (req, res) => {
    const userId = userIdOf(body(req).userId);
    const target = await accounts.userById(userId);
    if (target?.operator) throw expected(new ApiError(409, 'operator_account', 'The operator\'s account cannot be deleted here.'));
    await accounts.deleteAccount(userId);
    res.json({ ok: true });
  }));
}

export { isOperator };
