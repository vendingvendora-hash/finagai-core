-- 0025_delegation_envelope.sql
-- Phase 2 (ADR-078): bounded delegation. A task carries the envelope derived from Julian's own request, and every
-- step records its deterministic authority class and the authorization decision.
BEGIN;
SET search_path = finagai, public;

ALTER TABLE control_task ADD COLUMN envelope jsonb;              -- null = no delegation (contact request / legacy)
ALTER TABLE control_step
  ADD COLUMN authority_class text CHECK (authority_class IN ('OBSERVE','PREPARATORY','EXTERNAL_COMMITMENT','HIGH_RISK')),
  ADD COLUMN authority_decision text CHECK (authority_decision IN ('auto','approve','refuse'));
COMMIT;
