-- Payments (1 November): credit bought on the payment processor's hosted page, and topped up automatically when the
-- reader has asked for it (server/payments.js). Card numbers never come here: the processor holds them. Each payment,
-- each of the processor's notices (so a repeated one counts once), and each account's saved card and automatic top-up.

-- The ledger: a dispute takes the disputed amount off the balance when the processor takes the funds, and a won
-- dispute puts it back. Each row the processor's events write names what wrote it (`ref`: the payment, the refund or
-- the dispute), once.
ALTER TABLE credit DROP CONSTRAINT IF EXISTS credit_kind_check;
ALTER TABLE credit ADD CONSTRAINT credit_kind_check
  CHECK (kind IN ('grant', 'hold', 'charge', 'release', 'adjustment', 'purchase', 'refund', 'dispute', 'dispute_won'));
ALTER TABLE credit ADD COLUMN IF NOT EXISTS payment_id text;     -- the payment a purchase, refund or dispute row belongs to
ALTER TABLE credit ADD COLUMN IF NOT EXISTS ref text;            -- the processor's id of what wrote the row
CREATE UNIQUE INDEX IF NOT EXISTS credit_ref_once ON credit (kind, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id                  text PRIMARY KEY,               -- our own id, given to the processor as the payment's reference
  user_id             bigint NOT NULL REFERENCES users (id),
  kind                text NOT NULL CHECK (kind IN ('checkout', 'auto')),   -- on the hosted page, or an automatic top-up
  mode                text NOT NULL CHECK (mode IN ('test', 'live')),       -- the processor's test mode is never money
  amount_cents        integer NOT NULL CHECK (amount_cents > 0),
  currency            text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'refunded', 'disputed', 'lost', 'won')),
  created_at          timestamptz NOT NULL,
  paid_at             timestamptz,
  save_card           boolean NOT NULL DEFAULT false, -- the reader asked to keep the card for automatic top-ups
  session_id          text UNIQUE,                    -- the hosted page's session
  intent_id           text UNIQUE,                    -- the processor's payment
  fee_cents           integer,                        -- the processor's own fee, from its record of the payment
  net_cents           integer,
  refunded_cents      integer NOT NULL DEFAULT 0,
  dispute_fee_cents   integer NOT NULL DEFAULT 0,     -- the processor's dispute fee, from its record
  card_brand          text,
  card_country        text,                           -- for the fee analysis: a card from abroad costs more
  wallet              text,                           -- apple_pay, google_pay, link, … when one was used
  failure             text                            -- the processor's code when it failed: declined, authentication_required, …
);
CREATE INDEX IF NOT EXISTS payments_user ON payments (user_id, created_at);
-- One automatic top-up at a time per account.
CREATE UNIQUE INDEX IF NOT EXISTS payments_auto_one ON payments (user_id) WHERE kind = 'auto' AND status = 'pending';

CREATE TABLE IF NOT EXISTS payment_notices (
  id           text PRIMARY KEY,                      -- the processor's event id
  type         text NOT NULL,
  received_at  timestamptz NOT NULL,
  done_at      timestamptz,                           -- null until handled; a notice that failed is handled again
  outcome      text
);

-- Each account: the processor's customer, the saved card (never its number), the automatic top-up and its consent,
-- and a hold while a dispute is open.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_customer text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_mode text;                  -- test or live: the customer and its card exist in that mode alone
ALTER TABLE users ADD COLUMN IF NOT EXISTS card_method text;               -- the saved card's id at the processor
ALTER TABLE users ADD COLUMN IF NOT EXISTS card_brand text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS card_last4 text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS card_exp text;                  -- MM/YY
ALTER TABLE users ADD COLUMN IF NOT EXISTS topup_on boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS topup_level_cents integer;      -- top up when the balance falls below this
ALTER TABLE users ADD COLUMN IF NOT EXISTS topup_amount_cents integer;     -- by this much
ALTER TABLE users ADD COLUMN IF NOT EXISTS topup_cap_cents integer;        -- never more than this a calendar month (UTC)
ALTER TABLE users ADD COLUMN IF NOT EXISTS topup_consent_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS topup_consent_version text;     -- the version of the agreement's wording shown
ALTER TABLE users ADD COLUMN IF NOT EXISTS topup_paused_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS topup_paused_reason text;       -- declined | confirm | dispute
ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_hold_at timestamptz;        -- a dispute is open: testing and buying paused
ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_hold_reason text;
