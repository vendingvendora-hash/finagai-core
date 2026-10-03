-- 0013_control_requester.sql
-- J6 tasks can be requested by an allow-listed contact (ADR-051). The requester is recorded for context,
-- but approval of every write step still comes only from Julian in his own Messages thread.
BEGIN;
SET search_path = finagai, public;

ALTER TABLE control_task ADD COLUMN requester text;         -- NULL = Julian himself; else the contact label
ALTER TABLE control_task DROP CONSTRAINT control_task_origin_check;
ALTER TABLE control_task ADD CONSTRAINT control_task_origin_check CHECK (origin IN ('chat','imessage','contact'));

COMMIT;
