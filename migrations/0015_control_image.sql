-- 0015_control_image.sql
-- A J6 task can produce a final image (a chart or screenshot). Stored so the chat can show it and it can
-- also go to iMessage (ADR-058). Kept small; base64 PNG, capped.
BEGIN;
SET search_path = finagai, public;

ALTER TABLE control_task ADD COLUMN result_image_b64 text;      -- base64 PNG of the final artifact
ALTER TABLE control_task ADD CONSTRAINT ck_control_image_len CHECK (result_image_b64 IS NULL OR length(result_image_b64) <= 8000000);

COMMIT;
