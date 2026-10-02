-- Facts have a price; every user is measured (server/economics.js). Applied once, at boot, under an
-- advisory lock (server/db.js). A run is one document listed; a determination is one claim tested;
-- a cost line is one ledger line with the ids that tie it to both; a window is six hours of one
-- tier at one price; a guard event is the loss guard switching to tier 1 and back.
CREATE TABLE IF NOT EXISTS runs (
  id            text PRIMARY KEY,                -- the extraction's job id, made by the page
  owner         text,                            -- the sign-in that started it (the code's fingerprint and the email), or null on an open door
  email         text,
  code_fp       text,
  started_at    timestamptz NOT NULL,
  tier          integer NOT NULL,                -- fixed when the extraction starts; holds for the document
  window_start  timestamptz,
  price_cents   integer,                         -- the window's price per determination; null = no price yet (measuring)
  free_allowed  integer NOT NULL DEFAULT 0,      -- claims the reader may test free on this document (the tier's figure)
  chars         integer,
  claims_total  integer,
  extract_usd   numeric(14,6) NOT NULL DEFAULT 0, -- the cost of listing, kept apart from the determinations
  status        text NOT NULL DEFAULT 'running'  -- running | done | failed | cancelled
);
CREATE INDEX IF NOT EXISTS runs_started_at ON runs (started_at);
CREATE INDEX IF NOT EXISTS runs_owner ON runs (owner);

CREATE TABLE IF NOT EXISTS determinations (
  id            text PRIMARY KEY,                -- the determination's job id
  run_id        text REFERENCES runs (id),
  n             integer,                         -- the claim's number in the run, when the page said
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  status        text NOT NULL DEFAULT 'running', -- running | done | failed
  failure       text,                            -- why it failed: the error's code, cancelled, deploy, lost
  free          boolean NOT NULL DEFAULT false,  -- one of the document's free ones (a failed one never uses one up)
  price_cents   integer NOT NULL DEFAULT 0,      -- revenue at list, booked when it reaches done; 0 when free, failed or unpriced
  cost_usd      numeric(14,6) NOT NULL DEFAULT 0, -- its own ledger line: tokens and searches, at the price table
  priced        boolean NOT NULL DEFAULT true,   -- false when the model was not in the price table, so the cost is only the searches
  searches      integer NOT NULL DEFAULT 0,
  verdict       text,
  model         text,
  chars         integer,
  collected     boolean NOT NULL DEFAULT false   -- true once payments exist and the money is in
);
CREATE INDEX IF NOT EXISTS determinations_run ON determinations (run_id);
CREATE INDEX IF NOT EXISTS determinations_started_at ON determinations (started_at);

CREATE TABLE IF NOT EXISTS cost_lines (
  id                bigserial PRIMARY KEY,
  at                timestamptz NOT NULL,
  kind              text NOT NULL,               -- extract | evaluate | search | illustrate | art-direction | tool
  run_id            text,
  determination_id  text,
  owner             text,
  model             text,
  usd               numeric(14,6),
  priced            boolean,
  ok                boolean,
  line              jsonb NOT NULL               -- the ledger line as written (no claim text, no key)
);
CREATE INDEX IF NOT EXISTS cost_lines_at ON cost_lines (at);
CREATE INDEX IF NOT EXISTS cost_lines_determination ON cost_lines (determination_id);

CREATE TABLE IF NOT EXISTS windows (
  window_start  timestamptz PRIMARY KEY,
  tier          integer NOT NULL,
  price_cents   integer,                         -- fixed at the window's start for everyone
  avg_cost_usd  numeric(14,6),                   -- the measured average the price came from
  sample        integer NOT NULL DEFAULT 0,      -- how many determinations the average had
  basis         text NOT NULL DEFAULT 'none'     -- measured | start | none
);

CREATE TABLE IF NOT EXISTS guard_events (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL,
  engaged       boolean NOT NULL,                -- true: every new run goes to tier 1; false: the rotation resumes
  window_start  timestamptz,
  loss_usd      numeric(14,6),
  earned_usd    numeric(14,6)
);
