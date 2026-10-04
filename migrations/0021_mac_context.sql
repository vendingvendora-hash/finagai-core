-- 0021_mac_context.sql
-- WO3: ephemeral current-context snapshot from the Mac runtime (frontmost app/window/document, selected
-- Finder items, active browser tab). Overwritten every heartbeat; never a history. Clipboard excluded.
BEGIN;
SET search_path = finagai, public;
ALTER TABLE mac_runtime ADD COLUMN context jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMIT;
