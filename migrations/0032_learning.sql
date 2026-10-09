-- 0032_learning.sql
-- Phase 6 (ADR-085): learning as a general capability. A lesson is something Finagai learned, with its provenance
-- (which records support it), basis (OBSERVED from Finagai's own records / STATED by Julian / INFERRED generalization),
-- support, confidence and freshness. Observed lessons may only steer within existing authority (advisory hints);
-- stated corrections are applied as stated; inferred lessons change behaviour ONLY through an approved proposal
-- (the existing preference/procedure governance path). Recomputed deterministically; never deleted.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE lesson (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key               text NOT NULL UNIQUE,            -- deterministic: the same learning is one row, updated in place
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  kind              text NOT NULL CHECK (kind IN ('resource_performance','recovery','procedure','correction','decision_pattern','outcome','preference')),
  basis             text NOT NULL CHECK (basis IN ('observed','stated','inferred')),
  area_id           uuid REFERENCES area (id) ON DELETE SET NULL,
  scope             text NOT NULL,                   -- e.g. 'j6.step:browser_click', 'workflow:career.sync', 'sender:dana@x.com'
  statement         text NOT NULL,                   -- human-readable, with the numbers
  effect            jsonb,                           -- validated, whitelisted effect (null = informational)
  support           integer NOT NULL DEFAULT 0,      -- supporting observations
  positives         integer,                         -- for rates: successes among support
  confidence        numeric(4,3) NOT NULL DEFAULT 0, -- 0..1 (Wilson lower bound for rates; 1 for stated)
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {source, query, sampleIds[≤20]}
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_evidence_at  timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed','approved','rejected','retired')),
  proposal_id       uuid REFERENCES proposal (id),
  retired_reason    text
);
CREATE INDEX ix_lesson_status ON lesson (status, kind);

GRANT SELECT, INSERT, UPDATE ON lesson TO finagai_app;
COMMIT;
