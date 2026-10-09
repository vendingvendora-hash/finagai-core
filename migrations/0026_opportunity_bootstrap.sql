-- 0026_opportunity_bootstrap.sql
-- Phase 3C/4 (ADR-079): a pipeline record for opportunities (jobs first, not job-specific) linked into
-- AREA → OBJECTIVE → PROJECT, and staged bootstrap proposals that Julian approves before anything is written.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE opportunity (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  kind            text NOT NULL DEFAULT 'job' CHECK (kind IN ('job','client','vendor','other')),
  area_id         uuid REFERENCES area (id) ON DELETE SET NULL,
  project_id      uuid REFERENCES project (id) ON DELETE SET NULL,
  org             text NOT NULL,                     -- company
  title           text NOT NULL,                     -- role
  url             text,
  location        text,
  work_mode       text,
  salary          text,
  eligibility     text,
  status          text NOT NULL DEFAULT 'discovered'
                  CHECK (status IN ('discovered','analyzed','shortlisted','preparing','ready_for_review','applied','interviewing','offer','rejected','withdrawn','closed')),
  fit_score       integer CHECK (fit_score BETWEEN 0 AND 100),
  fit_notes       text,
  resume_ref      text,                              -- which resume version was used/prepared
  contact         text,                              -- recruiter / hiring contact if known
  next_action     text,
  next_action_at  timestamptz,
  applied_at      timestamptz,
  source          text NOT NULL,                     -- e.g. 'career_copilot:k989rg', 'gmail', 'manual'
  dedupe_key      text NOT NULL,                     -- normalized org|title or canonical URL
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  classification  classification_level NOT NULL DEFAULT 'internal',
  CONSTRAINT ck_opportunity_not_prohibited CHECK (classification <> 'prohibited')
);
CREATE UNIQUE INDEX uq_opportunity_dedupe ON opportunity (kind, dedupe_key) WHERE archived_at IS NULL;
CREATE INDEX ix_opportunity_status ON opportunity (status) WHERE archived_at IS NULL;

CREATE TABLE bootstrap_proposal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- what Julian says: "apply bootstrap 3"
  created_at  timestamptz NOT NULL DEFAULT now(),
  area        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','discarded')),
  payload     jsonb NOT NULL,
  applied_at  timestamptz
);

GRANT SELECT, INSERT, UPDATE ON opportunity, bootstrap_proposal TO finagai_app;
COMMIT;
