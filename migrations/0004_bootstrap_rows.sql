-- 0004_bootstrap_rows.sql
-- Rows Core requires before first use. The charter itself is NOT seeded here:
-- Finagai's charter text is a later, separately approved deliverable.

BEGIN;
SET search_path = finagai, public;

WITH ev AS (
  INSERT INTO event (actor, action, entity_type, reason, client)
  VALUES ('migration', 'create', 'project', 'Bootstrap Unassigned holding project (G10)', 'migration')
  RETURNING id
)
INSERT INTO project (name, description, status, is_unassigned_holding, last_event_id)
SELECT 'Unassigned',
       'Holding project for captured items whose project could not be resolved. Items here are flagged in every review.',
       'active', true, ev.id
FROM ev;

COMMIT;
