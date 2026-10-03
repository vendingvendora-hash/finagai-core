-- 0017_interaction_artifacts.sql
-- Interaction reliability (product mandate): durable artifact registry + inbound idempotency ledger, so
-- "send Santiago" resolves the real last chart (even after restart), and the same inbound message never
-- executes or replies twice.
BEGIN;
SET search_path = finagai, public;

-- Durable registry of artifacts Finagai produces (charts, screenshots, files). Replaces the brittle
-- process/file "last chart" state. "send Santiago" / "send that" resolves against this.
CREATE TABLE artifact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  kind            text NOT NULL,                     -- chart | screenshot | file | pdf | report
  mime            text NOT NULL DEFAULT 'image/png',
  storage_ref     text NOT NULL,                     -- local path on the helper's Mac (or remote ref)
  summary         text,                              -- "Altarum pricing case trend chart"
  origin          text,                              -- contact label or 'julian' the artifact was made for/by
  conversation    text,                              -- thread/handle it belongs to (self, or a contact)
  task_code       integer,
  available_until timestamptz,                       -- lifecycle; null = keep
  state           text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','sent','expired'))
);
CREATE INDEX ix_artifact_recent ON artifact (conversation, created_at DESC) WHERE state = 'ready';

-- Inbound idempotency: every provider message (iMessage GUID) is recorded once. Processing is gated on a
-- successful INSERT; a duplicate delivery hits the unique constraint and is skipped.
CREATE TABLE inbound_message (
  guid         text PRIMARY KEY,                     -- stable provider identifier (iMessage GUID)
  received_at  timestamptz NOT NULL DEFAULT now(),
  handle       text,
  state        text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','done','failed','superseded')),
  claimed_at   timestamptz NOT NULL DEFAULT now(),   -- lease start; a dead worker's claim expires
  result       text
);
CREATE INDEX ix_inbound_state ON inbound_message (state, claimed_at);

GRANT SELECT, INSERT, UPDATE ON artifact, inbound_message TO finagai_app;

COMMIT;
