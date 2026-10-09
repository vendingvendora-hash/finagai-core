-- 0030_opportunity_lifecycle.sql
-- Phase 4 (ADR-082): the opportunity lifecycle Finagai owns. A follow-up can belong to one specific job opportunity and
-- says who created it (Julian, the bootstrap, or the lifecycle engine) and which lifecycle rule it implements, so the
-- engine only ever replaces its OWN next actions and never Julian's. A Mac task can be linked to the job it prepares,
-- so a verified, Julian-approved submit is recorded on exactly that job. Additive only.
BEGIN;
SET search_path = finagai, public;

ALTER TABLE followup
  ADD COLUMN opportunity_id  uuid REFERENCES opportunity (id) ON DELETE SET NULL,
  ADD COLUMN origin          text NOT NULL DEFAULT 'julian' CHECK (origin IN ('julian','bootstrap','lifecycle')),
  ADD COLUMN rule            text;                    -- lifecycle rule id, e.g. 'applied.awaiting_response'
CREATE INDEX ix_followup_opportunity ON followup (opportunity_id) WHERE state IN ('open','waiting','overdue');

-- Follow-ups written by the Career bootstrap (ADR-081 wording) are the bootstrap's, not Julian's.
UPDATE followup SET origin = 'bootstrap'
 WHERE summary LIKE 'Follow up with % — last evidence %, follow-up due %';
-- One job per bootstrap project: link its follow-ups to that job.
UPDATE followup f SET opportunity_id = o.id
  FROM opportunity o
 WHERE f.opportunity_id IS NULL AND f.project_id IS NOT NULL AND o.project_id = f.project_id AND o.archived_at IS NULL
   AND (SELECT count(*) FROM opportunity x WHERE x.project_id = f.project_id AND x.archived_at IS NULL) = 1;

ALTER TABLE control_task ADD COLUMN opportunity_id uuid REFERENCES opportunity (id) ON DELETE SET NULL;

COMMIT;
