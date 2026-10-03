-- 0012_control.sql
-- J6 Mac control agent (ADR-050). Julian asks Finagai to do something on his Mac; Finagai plans steps;
-- the Mac helper runs read-only steps freely and QUEUES world-changing steps for Julian's one-tap
-- approval (same "ok <code>" channel as J5) before running them. Every step is recorded.

-- J6 is a new event actor (AR05). ALTER TYPE ... ADD VALUE cannot run inside a transaction block,
-- so it is applied before BEGIN; it is idempotent.
SET search_path = finagai, public;
ALTER TYPE event_actor ADD VALUE IF NOT EXISTS 'j6';

BEGIN;
SET search_path = finagai, public;

CREATE TABLE control_task (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,     -- Julian types "run 7" / "stop 7"
  request     text NOT NULL,                                  -- what Julian asked for, verbatim
  origin      text NOT NULL DEFAULT 'chat' CHECK (origin IN ('chat','imessage')),
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','waiting_approval','paused','done','cancelled','failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_control_request CHECK (length(request) BETWEEN 1 AND 4000)
);

CREATE TABLE control_step (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- Julian approves "ok <code>" one risky step
  task_id       uuid NOT NULL REFERENCES control_task (id),
  seq           integer NOT NULL,
  kind          text NOT NULL,                                -- screenshot, click, type, key, open_app, run, ...
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk          text NOT NULL CHECK (risk IN ('read','write')),  -- read runs freely; write needs approval
  summary       text NOT NULL,                                -- one human line shown to Julian for a write step
  status        text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','approved','rejected','running','done','failed','superseded')),
  result        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  ran_at        timestamptz,
  UNIQUE (task_id, seq),
  CONSTRAINT ck_control_summary CHECK (length(summary) BETWEEN 1 AND 500),
  -- A write step can never reach 'approved'/'running'/'done' without Julian's decision time recorded.
  CONSTRAINT ck_control_write_decided CHECK (risk = 'read' OR status NOT IN ('approved','running','done') OR decided_at IS NOT NULL)
);
CREATE INDEX ix_control_step_task ON control_step (task_id, seq);
CREATE INDEX ix_control_step_pending ON control_step (status) WHERE status IN ('proposed','approved');

GRANT SELECT, INSERT, UPDATE ON control_task, control_step TO finagai_app;
REVOKE DELETE, TRUNCATE ON control_task, control_step FROM finagai_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA finagai TO finagai_app;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'finagai.llm_call'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%pipeline%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE finagai.llm_call DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE llm_call ADD CONSTRAINT llm_call_pipeline_check CHECK (pipeline IN ('j2','j3','seed','eval_grader','j5','j6'));

COMMIT;
