-- What a determination's row remembers of its claim (server/economics.js): a SHA-256 of the claim it was asked about,
-- never its text, so a delivered claim's one free second go (its result lost on the way) is for the same claim and never
-- another. `kind` names what a row is: a claim's determination is 'fact', and the measurements read those rows.
-- Applied once, at boot, under the advisory lock (server/db.js).
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fact';
ALTER TABLE determinations ADD COLUMN IF NOT EXISTS fingerprint text;
