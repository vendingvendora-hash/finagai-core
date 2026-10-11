-- 0035_live_stream_archive_only.sql
-- ADR-087 fix: 0034 granted the app role DELETE on live_event for retention pruning. That breaks Finagai's
-- archive-only invariant (the app role holds no DELETE anywhere; Core's preflight refuses to start otherwise — the
-- 2026-10-11 release #43 was refused exactly for this). Retention is enforced by READ window instead (a cursor older
-- than the window is told to re-snapshot); the index rows are tiny and simply stay.
BEGIN;
SET search_path = finagai, public;
REVOKE DELETE ON live_event FROM finagai_app;
COMMIT;
