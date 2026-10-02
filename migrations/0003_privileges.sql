-- 0003_privileges.sql
-- Least-privilege grants for the running service (finagai_app). Database-level protections (Schema v0):
--   * no DELETE privilege on any table (archive only, ADR-004 / G14)
--   * event: SELECT and INSERT only, plus append-only trigger
--   * charter: SELECT only (written by migrations)

BEGIN;
SET search_path = finagai, public;

REVOKE ALL ON SCHEMA finagai FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA finagai FROM PUBLIC;

GRANT USAGE ON SCHEMA finagai TO finagai_app;

GRANT SELECT, INSERT, UPDATE ON
  project, entity, work_item, relationship,
  external_ref, knowledge_item,
  proposal, procedure, preference, conflict, governance_request,
  capture, capture_candidate, seed_batch, review,
  llm_call, job_run, capture_audit
TO finagai_app;

GRANT SELECT, INSERT ON event TO finagai_app;
GRANT SELECT ON charter TO finagai_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA finagai TO finagai_app;

-- Explicitly ensure no DELETE or TRUNCATE for the app role, even if a future grant is too broad.
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA finagai FROM finagai_app;

-- search_path is set per connection by Core's db module (options=-c search_path=finagai),
-- because altering roles requires CREATEROLE, which the migration role does not hold.

COMMIT;
