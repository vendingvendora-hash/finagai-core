-- 0033_management_by_exception.sql
-- Phase 7 (ADR-086): management by exception. Finagai watches its own operation and Julian's Areas for things going
-- wrong (operating_exception), fixes what it can itself, and reaches Julian only when his action is needed or a problem
-- outlives Finagai's own remedies. Julian can also state "tell me when …" rules (watch_rule): observation only —
-- a rule can notify, never act.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE operating_exception (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                      text NOT NULL UNIQUE,              -- deterministic: one condition = one row (reopened if it recurs)
  detector                 text NOT NULL,
  area_id                  uuid REFERENCES area (id) ON DELETE SET NULL,
  owner                    text NOT NULL CHECK (owner IN ('finagai','julian')),
  severity                 text NOT NULL CHECK (severity IN ('info','warning','critical')),
  needs                    text CHECK (needs IN ('judgment','authorization','principal_reserved')),
  summary                  text NOT NULL,
  detail                   text,
  status                   text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  first_seen_at            timestamptz NOT NULL,
  last_seen_at             timestamptz NOT NULL,
  resolved_at              timestamptz,
  resolution               text,
  remediation              text,                               -- the Finagai-owned remedy, if any
  remediation_attempts     integer NOT NULL DEFAULT 0,
  last_remediation_at      timestamptz,
  last_remediation_result  text,
  escalated_at             timestamptz,
  occurrences              integer NOT NULL DEFAULT 1,         -- how many times this condition has (re)opened
  CONSTRAINT ck_exception_resolved CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX ix_exception_open ON operating_exception (status, severity) WHERE status = 'open';

CREATE TABLE watch_rule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,  -- "stop rule 3"
  created_at       timestamptz NOT NULL DEFAULT now(),
  statement        text NOT NULL CHECK (length(statement) BETWEEN 3 AND 300),   -- Julian's words
  kind             text NOT NULL CHECK (kind IN ('metric','event')),
  metric           text NOT NULL,                             -- closed registry (src/exceptions/rules.ts)
  area_id          uuid REFERENCES area (id) ON DELETE SET NULL,
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,
  op               text CHECK (op IN ('>','>=','<','<=','=')),
  value            numeric,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  armed            boolean NOT NULL DEFAULT true,             -- edge-triggered: fires on false→true, re-arms when false
  last_value       numeric,
  last_checked_at  timestamptz,
  last_fired_at    timestamptz,
  fired_count      integer NOT NULL DEFAULT 0,
  removed_at       timestamptz,
  removed_reason   text
);
CREATE INDEX ix_watch_rule_active ON watch_rule (status) WHERE status = 'active';

-- A notification Julian asked for ("tell me when …") travels on the same once-only, quiet-hours-aware escalation
-- channel, labelled for what it is: not a decision, not a task.
ALTER TABLE escalation DROP CONSTRAINT escalation_needs_check;
ALTER TABLE escalation ADD CONSTRAINT escalation_needs_check CHECK (needs IN ('judgment','authorization','principal_reserved','requested'));

GRANT SELECT, INSERT, UPDATE ON operating_exception, watch_rule TO finagai_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA finagai TO finagai_app;
COMMIT;
