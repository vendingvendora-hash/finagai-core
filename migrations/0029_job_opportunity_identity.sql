-- 0029_job_opportunity_identity.sql
-- ADR-081: an opportunity is ONE job/application, never an employer. The employer becomes a shared entity; every job
-- opportunity keeps its own identity (requisition / title / location / alias keys / source ids), status, dates, contact,
-- project link and an append-only event history. Additive only; nothing existing is changed or removed.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE employer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  key         text NOT NULL UNIQUE,                  -- canonical normalized name
  name        text NOT NULL,                         -- as the evidence spells it (never hand-renamed)
  aliases     text[] NOT NULL DEFAULT '{}',
  party       text NOT NULL DEFAULT 'employer' CHECK (party IN ('employer','recruiter_or_staffing','job_board_or_recruiter')),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE opportunity
  ADD COLUMN employer_id        uuid REFERENCES employer (id) ON DELETE SET NULL,
  ADD COLUMN requisition_id     text,
  ADD COLUMN identity_basis     text,
  ADD COLUMN alias_keys         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN source_ids         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN first_evidence_at  timestamptz,
  ADD COLUMN last_evidence_at   timestamptz;
CREATE INDEX ix_opportunity_alias_keys ON opportunity USING gin (alias_keys);
CREATE INDEX ix_opportunity_employer ON opportunity (employer_id) WHERE archived_at IS NULL;

CREATE TABLE opportunity_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  opportunity_id  uuid NOT NULL REFERENCES opportunity (id),
  at              timestamptz NOT NULL,
  kind            text NOT NULL,
  source          text NOT NULL,
  source_id       text NOT NULL,
  summary         text,
  transition      text,
  CONSTRAINT uq_opportunity_event UNIQUE (opportunity_id, source, source_id)
);
CREATE INDEX ix_opportunity_event_opp ON opportunity_event (opportunity_id, at);

GRANT SELECT, INSERT, UPDATE ON employer, opportunity_event TO finagai_app;
COMMIT;
