-- 0022_acceptance_telemetry.sql
-- Phase 1 (ADR-072): task acceptance contracts + independent verification, false_completion classification,
-- and per-interaction execution telemetry with queryable aggregates.
BEGIN;
SET search_path = finagai, public;

ALTER TABLE control_task
  ADD COLUMN acceptance    jsonb,                 -- derived contract (objective, expected_outcome, evidence, strategy...)
  ADD COLUMN verification  jsonb,                 -- last verifier result {verdict, reason, strategy, at}
  ADD COLUMN verify_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN model_calls   integer NOT NULL DEFAULT 0,
  ADD COLUMN failure_class text;                  -- normalized taxonomy (false_completion, stalled, abandoned, ...)

ALTER TABLE interaction
  ADD COLUMN task_class            text,
  ADD COLUMN failure_class         text,
  ADD COLUMN user_interventions    integer NOT NULL DEFAULT 0,
  ADD COLUMN clarifications        integer NOT NULL DEFAULT 0,
  ADD COLUMN tool_calls            integer NOT NULL DEFAULT 0,
  ADD COLUMN model_calls           integer NOT NULL DEFAULT 0,
  ADD COLUMN verification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN false_completion      boolean NOT NULL DEFAULT false,
  ADD COLUMN cost_usd              numeric(10,4),
  ADD COLUMN acknowledged_at       timestamptz,
  ADD COLUMN completed_at          timestamptz,
  ADD COLUMN resources_considered  jsonb,
  ADD COLUMN resources_used        jsonb;

-- Phase 1B (corrected): idempotency is scoped to the LOGICAL ACTION, not a time window. A retry/replay of the
-- same request never causes a second external send; a NEW explicit request to send the same thing is allowed.
-- States follow evidence strength: requested -> accepted (local send call returned) -> outgoing_observed
-- (outgoing record seen in the Messages DB) -> delivered (only with a delivery receipt) | failed.
CREATE TABLE outbound_action (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  idempotency_key  text NOT NULL UNIQUE,
  request_ref      text NOT NULL,                 -- interaction id or inbound message guid (one explicit request)
  operation        text NOT NULL,                 -- 'send_artifact', ...
  artifact_id      uuid,
  recipient        text,
  state            text NOT NULL DEFAULT 'requested'
                   CHECK (state IN ('requested','accepted','outgoing_observed','delivered','failed')),
  attempts         integer NOT NULL DEFAULT 1,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  accepted_at      timestamptz,
  observed_at      timestamptz,
  delivered_at     timestamptz,
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_outbound_action_artifact ON outbound_action (artifact_id, recipient);
GRANT SELECT, INSERT, UPDATE ON outbound_action TO finagai_app;

-- Phase 1 recovery accounting (bounded recovery instead of "two rejections -> fail").
ALTER TABLE control_task
  ADD COLUMN completion_claims        integer NOT NULL DEFAULT 0,
  ADD COLUMN verification_rejections  integer NOT NULL DEFAULT 0,
  ADD COLUMN recovery_attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN recovery_strategy_changed boolean NOT NULL DEFAULT false,
  ADD COLUMN last_claim_summary       text,
  ADD COLUMN terminal_reason          text;
ALTER TABLE interaction
  ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN terminal_reason   text;

-- Queryable aggregates (Phase 1D). p50/p95 via percentile_cont; one row per day and task class.
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
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (completed_at - created_at))) AS p95_complete_s
FROM interaction
GROUP BY 1, 2;

GRANT SELECT ON interaction_metrics_daily TO finagai_app;
COMMIT;
