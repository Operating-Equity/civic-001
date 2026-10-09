-- The conversation under every fact-check (8 October; server/chat.js). The operator: "My goal is to change challenge to
-- chat." A reply is a determination of kind `chat`, under its fact-check (`parent_id`) and numbered by its turn, so its
-- hold, its charge or release, a deploy's end and a crash's are what they are for a fact-check. The fingerprint is a
-- hash of what was asked (the claim's entry, or the reader's message): a delivered one goes again free, once, only when
-- the same thing is asked again. The server's own keys: the one that seals what a conversation's page holds, made by
-- the server, kept here, never a setting. Applied once, at boot, under the advisory lock (server/db.js).
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fact';   -- fact | chat
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS parent_id text;                      -- a reply's fact-check
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS turn integer;                        -- a reply's place in its conversation, from 1
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS fingerprint text;                    -- a hash of what was asked
CREATE INDEX IF NOT EXISTS determinations_parent ON determinations (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS server_keys (
  name     text PRIMARY KEY,
  value    text NOT NULL,                          -- random, made by the server; never shown, logged or sent
  made_at  timestamptz NOT NULL DEFAULT now()
);
