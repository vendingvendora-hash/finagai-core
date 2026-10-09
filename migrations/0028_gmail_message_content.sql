-- 0028_gmail_message_content.sql
-- ADR-080 (live): exhaustive acquisition fetched every message body on every run and hit Gmail's per-user rate limit
-- (403 rateLimitExceeded). A Gmail message's content is immutable, so the extracted content is stored once per
-- (account, message id, extractor version) and reused; every run still enumerates ids exhaustively and re-verifies
-- presence, so this never hides a deletion. Content fetched by a run that later fails is kept, so acquisition converges.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE gmail_message_content (
  account            text NOT NULL,
  message_id         text NOT NULL,
  extractor_version  text NOT NULL,
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  record             jsonb NOT NULL,                 -- {id, threadId, internalDate, subject, from, snippet, body, templates}
  PRIMARY KEY (account, message_id, extractor_version)
);

GRANT SELECT, INSERT, UPDATE ON gmail_message_content TO finagai_app;
COMMIT;
