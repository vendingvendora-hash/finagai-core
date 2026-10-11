-- 0034_live_state_stream.sql
-- Live State / Visualization Contract (ADR-087). The append-only `event` table stays the ONE source of truth for what
-- happened; this migration only (1) lets each event carry its causal context (correlation, causing events, Area) and
-- (2) adds the stream's ordering index: `live_event` assigns a gap-free, commit-ordered sequence to events as they
-- become visible, so a subscriber can resume from a cursor without ever missing a transition (identity ids alone are
-- allocated at insert, not at commit, so a late-committing transaction can surface a LOWER id after a higher one).
BEGIN;
SET search_path = finagai, public;

-- No foreign keys on the new columns: `event` rows are immutable (append-only trigger), so ON DELETE actions that
-- would UPDATE an event are impossible; references are resolved at read time.
ALTER TABLE event
  ADD COLUMN correlation_id uuid,           -- one unit of work (an engine tick, a tool call, a Mac task …)
  ADD COLUMN cause_ids      bigint[],       -- the event(s) that directly caused this one
  ADD COLUMN area_id        uuid;           -- the Area it affected, when known at write time
CREATE INDEX ix_event_correlation ON event (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX ix_event_area ON event (area_id, id) WHERE area_id IS NOT NULL;

CREATE TABLE live_event (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- the stream cursor: monotonic, commit-ordered
  event_id      bigint NOT NULL UNIQUE REFERENCES event (id),
  published_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_live_event_published ON live_event (published_at);

-- Replayable window starts with the last 30 days of history (older history stays queryable via /live/history).
INSERT INTO live_event (event_id) SELECT id FROM event WHERE occurred_at > now() - interval '30 days' ORDER BY id;

-- DELETE only for retention pruning of the stream index (never of events).
GRANT SELECT, INSERT, DELETE ON live_event TO finagai_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA finagai TO finagai_app;
COMMIT;
