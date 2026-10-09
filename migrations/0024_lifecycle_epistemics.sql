-- 0024_lifecycle_epistemics.sql
-- Phase 0 (ADR-076), from the 2026-10-09 audit:
--  0C  waiting for Julian is a first-class, expiring lifecycle state, not "executing" (tasks #104/#113 sat 4 days)
--  0D  every surface (chat, iMessage, contact) feeds the same interaction record (origin recorded)
--  0F  completion epistemics: verified / unverified / needs_review are distinct, queryable outcomes
--  P8  waiting-for-Julian time is measured separately from active execution time
BEGIN;
SET search_path = finagai, public;

-- ---- control_task: explicit, expiring human waits ---------------------------------------------------
ALTER TABLE control_task DROP CONSTRAINT control_task_status_check;
ALTER TABLE control_task ADD CONSTRAINT control_task_status_check
  CHECK (status IN ('active','waiting_approval','paused','done','cancelled','failed','expired'));

ALTER TABLE control_task
  ADD COLUMN awaiting_since       timestamptz,          -- when the task started waiting for Julian
  ADD COLUMN awaiting_kind        text CHECK (awaiting_kind IN ('approval','question','loop','step_limit','budget','rejected')),
  ADD COLUMN awaiting_reason      text,                 -- what exactly Julian is asked (one line)
  ADD COLUMN expires_at           timestamptz,          -- after this the wait expires (task -> 'expired', resumable)
  ADD COLUMN reminders_sent       integer NOT NULL DEFAULT 0,
  ADD COLUMN last_reminded_at     timestamptz,
  ADD COLUMN resumed_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN verification_status  text CHECK (verification_status IN ('verified','unverified','needs_review','not_applicable'));
CREATE INDEX ix_control_task_awaiting ON control_task (expires_at) WHERE awaiting_since IS NOT NULL;

ALTER TABLE control_step DROP CONSTRAINT control_step_status_check;
ALTER TABLE control_step ADD CONSTRAINT control_step_status_check
  CHECK (status IN ('proposed','approved','rejected','running','done','failed','superseded','expired'));

-- ---- interaction: lifecycle + origin + epistemics + waiting time ---------------------------------------
ALTER TABLE interaction DROP CONSTRAINT interaction_state_check;
ALTER TABLE interaction ADD CONSTRAINT interaction_state_check
  CHECK (state IN ('received','claimed','executing','waiting_on_tool','verifying','rendering','delivering',
                   'completed','awaiting_human','resumable','expired','cancelled','failed','superseded'));
ALTER TABLE interaction
  ADD COLUMN origin               text NOT NULL DEFAULT 'chat' CHECK (origin IN ('chat','imessage','contact','system')),
  ADD COLUMN verification_status  text CHECK (verification_status IN ('verified','unverified','needs_review','not_applicable')),
  ADD COLUMN awaiting_since       timestamptz,
  ADD COLUMN waiting_human_s      numeric(12,1) NOT NULL DEFAULT 0;

-- Backfill: tasks waiting today get an explicit wait that started at their last update (so the 4-day-old
-- waits of #104/#113 expire on the first sweep instead of being presented as "executing").
UPDATE control_task SET awaiting_since = updated_at,
       awaiting_kind = CASE WHEN status = 'paused' THEN 'rejected' ELSE 'approval' END,
       awaiting_reason = COALESCE((SELECT s.summary FROM control_step s WHERE s.task_id = control_task.id AND s.status = 'proposed' ORDER BY s.seq DESC LIMIT 1), 'waiting for Julian'),
       expires_at = updated_at + interval '24 hours'
 WHERE status IN ('waiting_approval','paused');
UPDATE interaction i SET state = 'awaiting_human', awaiting_since = t.updated_at
  FROM control_task t
 WHERE t.id = ANY(i.task_ids) AND t.status IN ('waiting_approval','paused')
   AND i.state NOT IN ('completed','failed','superseded');

-- Existing completed rows: verified only where the verifier recorded acceptance.
UPDATE control_task SET verification_status = CASE
    WHEN terminal_reason = 'verifier_unavailable' THEN 'unverified'
    WHEN verification ? 'accepted' THEN 'verified'
    ELSE 'not_applicable' END
 WHERE status = 'done';
UPDATE interaction i SET verification_status = t.verification_status
  FROM control_task t WHERE t.id = ANY(i.task_ids) AND i.state = 'completed' AND t.status = 'done';

-- ---- metrics: epistemics and waiting time are visible (columns appended; existing ones unchanged) ------
CREATE OR REPLACE VIEW interaction_metrics_daily AS
SELECT date_trunc('day', created_at) AS day,
       coalesce(task_class, 'unknown') AS task_class,
       count(*) AS interactions,
       count(*) FILTER (WHERE state = 'completed') AS completed,
       count(*) FILTER (WHERE state = 'failed') AS failed,
       count(*) FILTER (WHERE false_completion) AS false_completions,
       sum(user_interventions) AS user_interventions,
       sum(clarifications) AS clarifications,
       sum(tool_calls) AS tool_calls,
       sum(model_calls) AS model_calls,
       sum(verification_attempts) AS verification_attempts,
       sum(recovery_attempts) AS recovery_attempts,
       sum(cost_usd) AS cost_usd,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (acknowledged_at - created_at))) AS p50_ack_s,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (acknowledged_at - created_at))) AS p95_ack_s,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (completed_at - created_at))) AS p50_complete_s,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (completed_at - created_at))) AS p95_complete_s,
       count(*) FILTER (WHERE state = 'completed' AND verification_status = 'verified') AS completed_verified,
       count(*) FILTER (WHERE state = 'completed' AND verification_status = 'unverified') AS completed_unverified,
       count(*) FILTER (WHERE state = 'completed' AND verification_status = 'needs_review') AS needs_review,
       count(*) FILTER (WHERE state = 'expired') AS expired,
       count(*) FILTER (WHERE state = 'awaiting_human') AS awaiting_human,
       sum(waiting_human_s) AS waiting_human_s,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (completed_at - created_at)) - waiting_human_s) AS p50_active_s,
       count(*) FILTER (WHERE origin = 'imessage') AS from_imessage,
       count(*) FILTER (WHERE origin = 'chat') AS from_chat
FROM interaction
GROUP BY 1, 2;

GRANT SELECT ON interaction_metrics_daily TO finagai_app;
COMMIT;
