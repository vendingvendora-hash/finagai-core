-- 0011_concierge.sql
-- J5 ticket concierge (ADR-044). Messages from allow-listed iMessage contacts arrive through the Mac
-- helper; Core drafts replies in Julian's voice; nothing is sent until Julian replies "ok <code>".

BEGIN;
SET search_path = finagai, public;

CREATE TABLE concierge_contact (
  handle      text PRIMARY KEY,                    -- phone number or Apple ID email, as Messages stores it
  label       text NOT NULL,                       -- how Julian names the person (Mom, ...)
  notes       text NOT NULL DEFAULT '',            -- learned preferences (home airport, budget); ADR-022 third-party data
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_concierge_label CHECK (length(label) BETWEEN 1 AND 80),
  CONSTRAINT ck_concierge_notes CHECK (length(notes) <= 4000)
);

CREATE TABLE concierge_message (
  guid         text PRIMARY KEY,                   -- Messages' own GUID, so re-sync is idempotent
  handle       text NOT NULL REFERENCES concierge_contact (handle),
  from_me      boolean NOT NULL,
  body         text NOT NULL,
  sent_at      timestamptz NOT NULL,
  history      boolean NOT NULL DEFAULT false,     -- backfilled for style only; never triggers a draft
  received_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_concierge_body CHECK (length(body) <= 8000)
);
CREATE INDEX ix_concierge_message_thread ON concierge_message (handle, sent_at DESC);

CREATE TABLE concierge_draft (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- what Julian types: "ok 12"
  handle        text NOT NULL REFERENCES concierge_contact (handle),
  trigger_guid  text NOT NULL UNIQUE REFERENCES concierge_message (guid),
  body          text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'sent', 'failed')),
  final_body    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  sent_at       timestamptz,
  CONSTRAINT ck_concierge_draft_body CHECK (length(body) BETWEEN 1 AND 4000),
  CONSTRAINT ck_concierge_final CHECK (status NOT IN ('approved', 'sent') OR final_body IS NOT NULL)
);
CREATE INDEX ix_concierge_draft_pending ON concierge_draft (handle) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON concierge_contact, concierge_message, concierge_draft TO finagai_app;
REVOKE DELETE, TRUNCATE ON concierge_contact, concierge_message, concierge_draft FROM finagai_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA finagai TO finagai_app;

-- Model calls made by J5 are metered like every other pipeline (ADR-034).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'finagai.llm_call'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%pipeline%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE finagai.llm_call DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE llm_call ADD CONSTRAINT llm_call_pipeline_check CHECK (pipeline IN ('j2', 'j3', 'seed', 'eval_grader', 'j5'));

COMMIT;
