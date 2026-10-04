-- 0020_interaction.sql
-- WO2: an accepted request is a durable interaction, owned until a terminal state, independent of any one
-- Claude turn. Links conversation -> logical request -> tasks -> artifact -> result -> delivery.
BEGIN;
SET search_path = finagai, public;

CREATE TABLE interaction (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  conversation          text NOT NULL,                 -- 'chat' | 'self' | contact label
  origin_message        text,                          -- Julian's words (truncated), for the record
  request_key           text NOT NULL,                 -- stable logical identity (normalized request)
  state                 text NOT NULL DEFAULT 'received'
                        CHECK (state IN ('received','claimed','executing','waiting_on_tool','verifying','rendering',
                                         'delivering','completed','awaiting_human','failed','superseded')),
  task_ids              uuid[] NOT NULL DEFAULT '{}',
  owner                 text,                          -- execution owner (worker id / 'core')
  progress_note         text,
  artifact_id           uuid,
  result_summary        text,
  result_image_b64      text,
  final_response_status text NOT NULL DEFAULT 'pending' CHECK (final_response_status IN ('pending','delivered','not_needed')),
  delivered_at          timestamptz,
  retries               integer NOT NULL DEFAULT 0,
  superseded_by         uuid
);
CREATE INDEX ix_interaction_open ON interaction (conversation, created_at DESC)
  WHERE state NOT IN ('completed','failed','superseded') OR final_response_status = 'pending';
CREATE INDEX ix_interaction_key ON interaction (request_key, created_at DESC);

ALTER TABLE control_task ADD COLUMN interaction_id uuid;

GRANT SELECT, INSERT, UPDATE ON interaction TO finagai_app;
COMMIT;
