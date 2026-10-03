-- 0014_control_result.sql
-- J6 tasks store their outcome so the Claude chat that started them can read the result (ADR-056),
-- instead of the answer only appearing in Julian's iMessage thread.
BEGIN;
SET search_path = finagai, public;

ALTER TABLE control_task ADD COLUMN result_summary text;        -- one-line outcome
ALTER TABLE control_task ADD COLUMN result_detail  text;        -- findings the agent gathered (read steps)
ALTER TABLE control_task ADD CONSTRAINT ck_control_result_len CHECK (result_detail IS NULL OR length(result_detail) <= 20000);

COMMIT;
