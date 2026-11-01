-- The record (1 November): what is submitted and what FactEngine finds, kept apart from every account, to test and
-- improve the service (server/record.js). Nothing of the reader is kept here: no account, email, address, run or
-- determination number, and no time but the day.
CREATE TABLE IF NOT EXISTS record_documents (
  id           text PRIMARY KEY,                 -- the record's own random id
  fingerprint  text NOT NULL UNIQUE,             -- SHA-256 of the document's text, kept in the record alone
  day          date NOT NULL,                    -- the day it was first kept (UTC)
  kind         text,                             -- text | link | file | video
  title        text,
  author       text,
  site         text,
  published    text,
  url          text,
  chars        integer NOT NULL,
  text         text NOT NULL,                    -- the document as the listing read it
  listing      jsonb                             -- the listing: its output, its claims, model, level, prompt version, measures
);
CREATE INDEX IF NOT EXISTS record_documents_day ON record_documents (day);

CREATE TABLE IF NOT EXISTS record_fact_checks (
  id              text PRIMARY KEY,              -- the record's own random id
  document_id     text REFERENCES record_documents (id),
  day             date NOT NULL,                 -- the day it ended (UTC)
  path            text NOT NULL,                 -- readers | trial | standby
  claim           text NOT NULL,                 -- the claim as tested
  model           text,
  effort          text,
  requested       text,                          -- the model asked first, when the standby answered
  prompt_version  text,                          -- the evaluation prompt's version (its fingerprint's first characters)
  verdict         text,
  confidence      integer,
  conclusion      text,
  entry           text,                          -- the entry as written
  reasoning       text,                          -- its thinking summary
  sources         jsonb,
  trail           jsonb,                         -- its searches and pages
  searches        integer,
  pages           integer,
  usd             numeric(14,6),
  priced          boolean,
  measures        jsonb,                         -- its cost line's figures: tokens, times (waiting, thinking, writing), queries
  failure         text                           -- a failure's code; null when delivered
);
CREATE INDEX IF NOT EXISTS record_fact_checks_day ON record_fact_checks (day);
CREATE INDEX IF NOT EXISTS record_fact_checks_document ON record_fact_checks (document_id);
