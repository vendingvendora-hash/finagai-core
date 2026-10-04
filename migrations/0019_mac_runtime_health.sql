-- 0019_mac_runtime_health.sql
-- WO1 health counters (ADR-066.1): Core must know reconnects, crash/restarts, and last successful execution.
BEGIN;
SET search_path = finagai, public;
ALTER TABLE mac_runtime
  ADD COLUMN reconnect_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN restart_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN last_success_at   timestamptz,
  ADD COLUMN last_success_code bigint;
COMMIT;
