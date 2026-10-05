-- Accounts and credit (5 October; server/accounts.js, server/credit.js). The operator: "We need to establish a sign-up
-- and sign-on process first, followed by payments ... assume everyone who signs up gets $10 in their account."
-- A user signs up with an email and a password (kept only as a scrypt hash); a session is a random token whose SHA-256
-- alone is kept; credit is an append-only ledger whose sum is the balance. A test's price is held when it starts,
-- charged when its determination is delivered, released when it is not. Applied once, at boot, under the advisory lock.
CREATE TABLE IF NOT EXISTS users (
  id                   bigserial PRIMARY KEY,
  email                text NOT NULL,                  -- as typed (trimmed); '' once the account is deleted
  email_key            text NOT NULL UNIQUE,           -- lower case: one account per address; 'deleted:<id>' once deleted
  password_hash        text NOT NULL,                  -- scrypt$N$r$p$salt$hash; never the password; '' once deleted
  created_at           timestamptz NOT NULL DEFAULT now(),
  terms_at             timestamptz NOT NULL,           -- when the box was ticked
  terms_version        text NOT NULL,                  -- the Terms in force then
  monthly_limit_cents  integer CHECK (monthly_limit_cents IS NULL OR monthly_limit_cents >= 0),
  operator             boolean NOT NULL DEFAULT false, -- made through the operator's one-time link, and only so
  blocked_at           timestamptz,
  deleted_at           timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,                        -- SHA-256 of the cookie's token; the token itself is never kept
  user_id     bigint NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,                    -- slides forward as the session is used
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id          text PRIMARY KEY,                        -- SHA-256 of the link's token
  user_id     bigint NOT NULL REFERENCES users (id),
  made_at     timestamptz NOT NULL DEFAULT now(),
  made_by     text,                                    -- the operator's email
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE IF NOT EXISTS operator_claims (
  id          text PRIMARY KEY,                        -- SHA-256 of the one-time link's token (CIVIC_OPERATOR_CLAIM)
  user_id     bigint NOT NULL REFERENCES users (id),
  claimed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit (
  id                bigserial PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users (id),
  at                timestamptz NOT NULL DEFAULT now(),
  kind              text NOT NULL CHECK (kind IN ('grant', 'hold', 'charge', 'release', 'adjustment', 'purchase', 'refund')),
  cents             integer NOT NULL,                  -- the change to the balance: + grant, adjustment, purchase, release; - hold, refund; 0 charge
  amount_cents      integer NOT NULL CHECK (amount_cents >= 0), -- the face amount
  hold_id           bigint REFERENCES credit (id),     -- a charge or a release names the hold it settles
  determination_id  text,
  run_id            text,
  note              text,
  by_email          text                               -- who made an adjustment
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_settles_once ON credit (hold_id) WHERE kind IN ('charge', 'release');
CREATE INDEX IF NOT EXISTS credit_user ON credit (user_id, id);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS user_id bigint;
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS hold_id bigint;
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS runs_user ON runs (user_id);
-- A test whose result was delivered (and charged) and then lost on the way gets one more go, never charged again.
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS rerun boolean NOT NULL DEFAULT false;
