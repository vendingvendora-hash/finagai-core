-- 0027_evidence_snapshot.sql
-- ADR-080: reproducible bootstrap. Acquisition is separated from interpretation: every acquisition run is recorded,
-- its frozen input is stored content-addressed (same evidence ⇒ same row), and every proposal names the exact
-- snapshot, interpreter version and output digests it was produced from, so any difference between two proposals
-- can be attributed to specific source records (or proven to be a defect). Read-only diagnostics jobs are recorded.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE evidence_snapshot (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  area                 text NOT NULL,
  digest               text NOT NULL,                  -- content digest of the evidence (records + sheet bytes + window)
  interpreter_version  text NOT NULL,
  acquired_at          timestamptz NOT NULL,           -- first acquisition that produced this content
  complete             boolean NOT NULL,
  record_count         integer NOT NULL,
  payload              jsonb NOT NULL,                 -- the frozen snapshot (records, sheet CSV, queries, paging, problems)
  CONSTRAINT uq_evidence_snapshot UNIQUE (area, digest)
);

CREATE TABLE evidence_acquisition (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  area            text NOT NULL,
  snapshot_id     uuid NOT NULL REFERENCES evidence_snapshot (id),
  acquired_at     timestamptz NOT NULL,
  complete        boolean NOT NULL,
  search_misses   integer NOT NULL DEFAULT 0,          -- previously seen records a search did not return (re-verified by id)
  problems        jsonb NOT NULL DEFAULT '[]'::jsonb,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb   -- per query/account: pages, ids, truncated, vanished
);
CREATE INDEX ix_evidence_acquisition_area ON evidence_acquisition (area, acquired_at DESC);

ALTER TABLE bootstrap_proposal
  ADD COLUMN snapshot_id             uuid REFERENCES evidence_snapshot (id),
  ADD COLUMN acquisition_id          uuid REFERENCES evidence_acquisition (id),
  ADD COLUMN snapshot_digest         text,
  ADD COLUMN interpretation_digest   text,
  ADD COLUMN opportunity_set_digest  text,
  ADD COLUMN interpreter_version     text;

CREATE TABLE diagnostic_job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  progress     jsonb NOT NULL DEFAULT '[]'::jsonb,
  result       jsonb,
  error        text,
  finished_at  timestamptz
);

GRANT SELECT, INSERT, UPDATE ON evidence_snapshot, evidence_acquisition, diagnostic_job TO finagai_app;
COMMIT;
