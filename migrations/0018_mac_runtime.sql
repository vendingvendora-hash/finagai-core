-- 0018_mac_runtime.sql
-- Mac runtime as a first-class persistent worker (ADR-066). Root cause of tasks 33/34 sitting "active"
-- forever: control_task had no worker liveness at all — a row was "active" the moment it existed, and Core
-- could not tell "executing" from "no Mac process is running". This adds:
--   * mac_runtime: the helper's heartbeat, version, capability matrix, current app, current task.
--   * control_task claim/lease/progress columns so lifecycle is DERIVED from evidence, never assumed.
BEGIN;
SET search_path = finagai, public;

-- One row per Mac (Julian has one). The helper upserts this every tick.
CREATE TABLE mac_runtime (
  id                text PRIMARY KEY,                       -- 'primary'
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  helper_version    text,
  capabilities      jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {accessibility:bool, screen:bool, files:bool, browser:bool, ...}
  frontmost_app     text,
  frontmost_window  text,
  current_task_id   uuid,
  started_at        timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Worker claim + lease + progress on every Mac task. NULL claimed_at = nobody has picked it up.
ALTER TABLE control_task
  ADD COLUMN claimed_at       timestamptz,
  ADD COLUMN lease_until      timestamptz,
  ADD COLUMN last_progress_at timestamptz,
  ADD COLUMN worker_id        text,
  ADD COLUMN progress_note    text;

CREATE INDEX ix_control_task_active_unclaimed ON control_task (created_at) WHERE status = 'active' AND claimed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON mac_runtime TO finagai_app;

COMMIT;
