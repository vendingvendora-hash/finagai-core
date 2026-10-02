-- 0002_schema_v0.sql
-- Finagai Core, Schema v0 (approved 2026-10-01, with amendments ADR-019 to ADR-026).
-- 20 tables in five groups: audit/operations, work state, knowledge, governance, capture/review.
-- Every rule expressible as a constraint is one (ADR-014, C26).

BEGIN;
SET search_path = finagai, public;

-- ===================================================================
-- Audit and operations
-- ===================================================================

CREATE TABLE event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor         event_actor NOT NULL,
  action        text NOT NULL,                 -- create, update, archive, status_change, conflict_open, ...
  entity_type   text,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  reason        text,
  capture_id    uuid,
  request_id    uuid,
  client        text,                          -- claude_ai, admin_cli, scheduler, approval_page, eval
  approval_id   uuid,                          -- governance_request.id when executed via approval (ADR-019)
  principal     text,                          -- authenticated identity-provider subject, never a tool argument
  CONSTRAINT ck_event_approval_has_principal
    CHECK (approval_id IS NULL OR principal IS NOT NULL)
);
CREATE INDEX ix_event_entity   ON event (entity_type, entity_id, id);
CREATE INDEX ix_event_time     ON event (occurred_at);
CREATE INDEX ix_event_request  ON event (request_id);
CREATE TRIGGER trg_event_append_only
  BEFORE UPDATE OR DELETE ON event
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
CREATE TRIGGER trg_event_no_truncate
  BEFORE TRUNCATE ON event
  FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();

CREATE TABLE llm_call (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  called_at          timestamptz NOT NULL DEFAULT now(),
  pipeline           text NOT NULL CHECK (pipeline IN ('j2', 'j3', 'seed', 'eval_grader')),
  step               text NOT NULL,
  model              text NOT NULL,
  prompt_version     text NOT NULL,
  input_tokens       integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cost_usd           numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  latency_ms         integer,
  retries            integer NOT NULL DEFAULT 0,
  status             text NOT NULL CHECK (status IN ('ok', 'error', 'schema_invalid', 'guard_rejected', 'budget_blocked')),
  capture_id         uuid,
  review_id          uuid,
  request_id         uuid
);
CREATE INDEX ix_llm_call_month ON llm_call (called_at);

CREATE TABLE job_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job            text NOT NULL,                -- weekly_review, missed_run_check, staleness_sweep, nightly_backup
  scheduled_for  timestamptz NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  error          text,
  CONSTRAINT uq_job_run_once UNIQUE (job, scheduled_for)   -- idempotent dispatch from the 15-minute scheduler
);

-- ===================================================================
-- Governance (charter, procedures, preferences)
-- ===================================================================

CREATE TABLE charter (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        integer NOT NULL UNIQUE CHECK (version > 0),
  body           text NOT NULL,
  effective_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Written only by migrations. finagai_app receives SELECT only (see 0003).

CREATE TABLE proposal (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  classification     classification_level NOT NULL DEFAULT 'internal',
  version            integer NOT NULL DEFAULT 1,
  last_event_id      bigint REFERENCES event (id),
  kind               text NOT NULL CHECK (kind IN ('preference_change', 'procedure_change', 'classification_lowering', 'entity_merge')),
  target_type        text,
  target_id          uuid,
  current_text       text,
  proposed_text      text NOT NULL,
  rationale          text NOT NULL,
  source_capture_id  uuid,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  decided_at         timestamptz,
  decision_note      text,
  CONSTRAINT ck_proposal_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_proposal_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive'),
  CONSTRAINT ck_proposal_decided CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL))
);

CREATE TABLE procedure (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  classification        classification_level NOT NULL DEFAULT 'internal',
  last_event_id         bigint REFERENCES event (id),
  name                  text NOT NULL,
  version               integer NOT NULL CHECK (version > 0),
  body                  text NOT NULL,
  approved_proposal_id  uuid NOT NULL REFERENCES proposal (id),   -- G08: only via approved proposal
  CONSTRAINT uq_procedure_version UNIQUE (name, version),
  CONSTRAINT ck_procedure_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_procedure_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive')
);

CREATE TABLE preference (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  classification        classification_level NOT NULL DEFAULT 'internal',
  last_event_id         bigint REFERENCES event (id),
  key                   text NOT NULL,
  statement             text NOT NULL,
  scope                 text NOT NULL DEFAULT 'global',
  version               integer NOT NULL CHECK (version > 0),
  approved_proposal_id  uuid NOT NULL REFERENCES proposal (id),
  CONSTRAINT uq_preference_version UNIQUE (key, version),
  CONSTRAINT ck_preference_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_preference_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive')
);

-- ===================================================================
-- Capture and seeding
-- ===================================================================

CREATE TABLE seed_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'extracting', 'review', 'promoted', 'abandoned')),
  scope_note    text,
  promoted_at   timestamptz
);

CREATE TABLE capture (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at       timestamptz NOT NULL DEFAULT now(),
  idempotency_key   text NOT NULL UNIQUE,                 -- G12
  client            text NOT NULL,
  mode              text NOT NULL CHECK (mode IN ('inline', 'explicit', 'end_of_session', 'seeding', 'audit', 'eval')),
  source_type       text NOT NULL,
  source_text       text NOT NULL,                        -- stored after Prohibited/Highly Sensitive redaction (G09)
  redactions        integer NOT NULL DEFAULT 0,
  language          text,
  classification    classification_level NOT NULL DEFAULT 'internal',
  seed_batch_id     uuid REFERENCES seed_batch (id),
  status            text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'partially_applied', 'failed', 'dry_run')),
  pipeline_version  text NOT NULL,
  prompt_versions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
  request_id        uuid,
  CONSTRAINT ck_capture_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_capture_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive'),
  CONSTRAINT ck_capture_seed_mode CHECK ((mode = 'seeding') = (seed_batch_id IS NOT NULL))
);

-- ===================================================================
-- Work state
-- ===================================================================

CREATE TABLE project (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  archived_at                    timestamptz,
  classification                 classification_level NOT NULL DEFAULT 'internal',
  version                        integer NOT NULL DEFAULT 1,
  last_event_id                  bigint REFERENCES event (id),
  name                           text NOT NULL,
  description                    text,
  status                         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  priority                       smallint CHECK (priority BETWEEN 1 AND 4),   -- set by Julian only; null = unset
  is_unassigned_holding          boolean NOT NULL DEFAULT false,              -- G10 holding project
  stall_threshold_days           integer CHECK (stall_threshold_days > 0),   -- null = configured default (ADR-026)
  upcoming_window_days           integer CHECK (upcoming_window_days > 0),
  priority_upcoming_window_days  integer CHECK (priority_upcoming_window_days > 0),
  last_activity_at               timestamptz,
  source_capture_id              uuid REFERENCES capture (id),
  search                         tsvector GENERATED ALWAYS AS
                                   (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, ''))) STORED,
  CONSTRAINT ck_project_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_project_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive')
);
CREATE UNIQUE INDEX uq_project_single_holding ON project (is_unassigned_holding) WHERE is_unassigned_holding;
CREATE INDEX ix_project_search ON project USING gin (search);

CREATE TABLE entity (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  classification        classification_level NOT NULL DEFAULT 'internal',
  version               integer NOT NULL DEFAULT 1,
  last_event_id         bigint REFERENCES event (id),
  kind                  text NOT NULL CHECK (kind IN ('person', 'organization', 'place', 'other')),
  name                  text NOT NULL,
  aliases               text[] NOT NULL DEFAULT '{}',
  notes                 text,
  purpose               text NOT NULL,                     -- ADR-022: why Finagai holds this record
  source_visibility     text NOT NULL CHECK (source_visibility IN ('public', 'non_public')),
  retention_review_at   timestamptz,
  source_capture_id     uuid REFERENCES capture (id),
  search                tsvector GENERATED ALWAYS AS
                          (to_tsvector('simple', coalesce(name, '') || ' ' || immutable_join(aliases))) STORED,
  CONSTRAINT ck_entity_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_entity_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive'),
  CONSTRAINT ck_entity_confidential_needs_review
    CHECK (classification <> 'confidential' OR retention_review_at IS NOT NULL)
);
CREATE INDEX ix_entity_search ON entity USING gin (search);

CREATE TABLE work_item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  classification         classification_level NOT NULL DEFAULT 'internal',
  version                integer NOT NULL DEFAULT 1,
  last_event_id          bigint REFERENCES event (id),
  project_id             uuid NOT NULL REFERENCES project (id),
  kind                   text NOT NULL CHECK (kind IN ('task', 'deadline', 'follow_up', 'decision', 'blocker', 'milestone')),
  title                  text NOT NULL,
  detail                 text,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting', 'done', 'cancelled')),
  priority               smallint CHECK (priority BETWEEN 1 AND 4),
  due_at                 timestamptz,
  due_precision          text CHECK (due_precision IN ('exact', 'day', 'approximate')),
  due_owner              text CHECK (due_owner IN ('finagai', 'native')),
  due_ref_id             uuid,                              -- external_ref when due_owner = 'native'
  waiting_on_entity_id   uuid REFERENCES entity (id),
  completed_at           timestamptz,
  rationale              text,
  origin                 text NOT NULL CHECK (origin IN ('user_stated', 'explicit_extraction')),   -- G03
  disputed               boolean NOT NULL DEFAULT false,   -- true while a conflict is open on this item
  source_capture_id      uuid REFERENCES capture (id),
  search                 tsvector GENERATED ALWAYS AS
                           (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(detail, ''))) STORED,
  CONSTRAINT ck_work_item_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_work_item_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive'),
  CONSTRAINT ck_work_item_due_fields CHECK ((due_at IS NULL) = (due_precision IS NULL) AND (due_at IS NULL) = (due_owner IS NULL)),
  CONSTRAINT ck_work_item_native_due_has_ref CHECK (due_owner IS DISTINCT FROM 'native' OR due_ref_id IS NOT NULL),
  CONSTRAINT ck_work_item_done_has_time CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT ck_work_item_rationale_decisions CHECK (rationale IS NULL OR kind = 'decision')
);
CREATE INDEX ix_work_item_project_status ON work_item (project_id, status) WHERE archived_at IS NULL;
CREATE INDEX ix_work_item_due ON work_item (due_at) WHERE archived_at IS NULL AND status NOT IN ('done', 'cancelled');
CREATE INDEX ix_work_item_search ON work_item USING gin (search);

CREATE TABLE relationship (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  last_event_id    bigint REFERENCES event (id),
  from_type        text NOT NULL CHECK (from_type IN ('project', 'work_item', 'entity', 'knowledge_item', 'external_ref')),
  from_id          uuid NOT NULL,
  to_type          text NOT NULL CHECK (to_type IN ('project', 'work_item', 'entity', 'knowledge_item', 'external_ref')),
  to_id            uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('depends_on', 'blocks', 'waiting_on', 'part_of', 'relates_to', 'evidence_for')),
  source_capture_id uuid REFERENCES capture (id),
  CONSTRAINT ck_relationship_not_self CHECK (NOT (from_type = to_type AND from_id = to_id)),
  CONSTRAINT uq_relationship UNIQUE (from_type, from_id, to_type, to_id, kind)
);
-- Endpoint existence across polymorphic types is enforced by Core's relationship writer (G05 family);
-- every relationship row is created inside the same transaction as its endpoints' checks.
CREATE INDEX ix_relationship_from ON relationship (from_type, from_id);
CREATE INDEX ix_relationship_to   ON relationship (to_type, to_id);

-- ===================================================================
-- Knowledge
-- ===================================================================

CREATE TABLE external_ref (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  classification    classification_level NOT NULL DEFAULT 'internal',
  version           integer NOT NULL DEFAULT 1,
  last_event_id     bigint REFERENCES event (id),
  provider          text NOT NULL,                      -- gdrive, gmail, gcal, url, other
  object_id         text,                               -- provider's stable ID when known
  title_hint        text,
  url_hint          text,
  as_of             timestamptz NOT NULL,
  verification      text NOT NULL DEFAULT 'user_provided_unverified'
                      CHECK (verification IN ('user_provided_unverified', 'verified')),
  last_verified_at  timestamptz,
  source_capture_id uuid REFERENCES capture (id),
  CONSTRAINT ck_external_ref_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_external_ref_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive'),
  CONSTRAINT ck_external_ref_verified_time CHECK ((verification = 'verified') = (last_verified_at IS NOT NULL)),
  CONSTRAINT ck_external_ref_locator CHECK (object_id IS NOT NULL OR url_hint IS NOT NULL OR title_hint IS NOT NULL)
);

ALTER TABLE work_item
  ADD CONSTRAINT fk_work_item_due_ref FOREIGN KEY (due_ref_id) REFERENCES external_ref (id);

CREATE TABLE knowledge_item (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  classification       classification_level NOT NULL DEFAULT 'internal',
  version              integer NOT NULL DEFAULT 1,
  last_event_id        bigint REFERENCES event (id),
  subject_type         text NOT NULL CHECK (subject_type IN ('julian', 'project', 'entity')),
  subject_id           uuid,
  claim                text NOT NULL,
  epistemic_status     text NOT NULL CHECK (epistemic_status IN
                         ('fact', 'user_provided', 'documented_claim', 'inference', 'hypothesis', 'unknown')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'disputed')),
  source_visibility    text NOT NULL CHECK (source_visibility IN ('public', 'non_public')),
  purpose              text,
  as_of                timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  review_at            timestamptz,
  retention_review_at  timestamptz,
  supersedes_id        uuid REFERENCES knowledge_item (id),
  source_capture_id    uuid NOT NULL REFERENCES capture (id),   -- provenance is mandatory (C05, AR02)
  source_quote         text NOT NULL,
  search               tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(claim, ''))) STORED,
  CONSTRAINT ck_knowledge_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_knowledge_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive'),
  CONSTRAINT ck_knowledge_subject CHECK ((subject_type = 'julian') = (subject_id IS NULL)),
  -- ADR-022: third-party claims need a purpose; confidential third-party claims need a review date.
  CONSTRAINT ck_knowledge_third_party_purpose CHECK (subject_type <> 'entity' OR purpose IS NOT NULL),
  CONSTRAINT ck_knowledge_third_party_retention
    CHECK (NOT (subject_type = 'entity' AND classification = 'confidential') OR retention_review_at IS NOT NULL),
  -- ADR-021: non-public information about a person can never be stored as Public.
  CONSTRAINT ck_knowledge_visibility_tier
    CHECK (NOT (source_visibility = 'non_public' AND subject_type = 'entity' AND classification = 'public'))
);
CREATE INDEX ix_knowledge_subject ON knowledge_item (subject_type, subject_id) WHERE archived_at IS NULL;
CREATE INDEX ix_knowledge_review  ON knowledge_item (review_at) WHERE archived_at IS NULL AND status = 'active';
CREATE INDEX ix_knowledge_search  ON knowledge_item USING gin (search);

-- ===================================================================
-- Capture candidates, conflicts, governance requests, reviews
-- ===================================================================

CREATE TABLE capture_candidate (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id        uuid NOT NULL REFERENCES capture (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  item_type         text NOT NULL,
  payload           jsonb NOT NULL,
  source_quote      text NOT NULL,
  proposed_action   text CHECK (proposed_action IN ('new', 'duplicate', 'update', 'conflict', 'supersedes')),
  outcome           text NOT NULL CHECK (outcome IN
                      ('applied', 'proposal', 'conflict', 'temporary_discarded', 'guard_rejected', 'staged', 'dry_run')),
  target_type       text,
  target_id         uuid,
  guard_reasons     text[] NOT NULL DEFAULT '{}',
  confirmation      text CHECK (confirmation IN ('pending', 'confirmed', 'rejected')),   -- seeding only
  CONSTRAINT ck_candidate_guard_reason CHECK (outcome <> 'guard_rejected' OR cardinality(guard_reasons) > 0)
);
CREATE INDEX ix_candidate_capture ON capture_candidate (capture_id);

CREATE TABLE conflict (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  classification   classification_level NOT NULL DEFAULT 'internal',
  version          integer NOT NULL DEFAULT 1,
  last_event_id    bigint REFERENCES event (id),
  existing_type    text NOT NULL,
  existing_id      uuid NOT NULL,
  candidate_id     uuid NOT NULL REFERENCES capture_candidate (id),
  field            text NOT NULL,
  existing_value   jsonb,
  new_value        jsonb,
  explanation      text NOT NULL,
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'keep_existing', 'accept_new', 'both_valid', 'custom')),
  resolution_note  text,
  resolved_at      timestamptz,
  CONSTRAINT ck_conflict_not_prohibited CHECK (classification <> 'prohibited'),
  CONSTRAINT ck_conflict_v1_no_highly_sensitive CHECK (classification <> 'highly_sensitive'),
  CONSTRAINT ck_conflict_resolved CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE INDEX ix_conflict_open ON conflict (created_at) WHERE status = 'open';

CREATE TABLE governance_request (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- the approval ID (ADR-019)
  action                 text NOT NULL CHECK (action IN
                           ('resolve_conflict', 'decide_proposal', 'promote_seed_batch', 'archive_records')),
  target_refs            jsonb NOT NULL,          -- [{type, id, version_at_staging}]
  before_state           jsonb NOT NULL,
  proposed_after_state   jsonb NOT NULL,
  rationale              text NOT NULL,
  source_ref             jsonb,
  requesting_client      text NOT NULL,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  nonce_hash             text NOT NULL,           -- hash of single-use nonce; raw nonce never stored
  content_hash           text NOT NULL,           -- hash over before_state + proposed_after_state as displayed
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN
                           ('pending', 'approved', 'rejected', 'expired', 'superseded', 'executed', 'failed')),
  decided_at             timestamptz,
  decided_by_principal   text,                    -- from the authenticated browser session only
  passkey_credential_id  text,                    -- WebAuthn credential that signed the approval (pending sign-off)
  decision_note          text,
  executed_event_id      bigint REFERENCES event (id),
  CONSTRAINT ck_governance_expiry CHECK (expires_at > requested_at),
  CONSTRAINT ck_governance_decided
    CHECK ((status IN ('approved', 'rejected', 'executed', 'failed')) = (decided_at IS NOT NULL AND decided_by_principal IS NOT NULL)),
  CONSTRAINT ck_governance_executed CHECK ((status = 'executed') = (executed_event_id IS NOT NULL))
);
CREATE INDEX ix_governance_pending ON governance_request (requested_at) WHERE status = 'pending';

CREATE TABLE review (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  kind                 text NOT NULL CHECK (kind IN ('weekly', 'on_demand', 'baseline', 'shadow')),
  period_start         timestamptz NOT NULL,
  period_end           timestamptz NOT NULL,
  watermark_event_id   bigint REFERENCES event (id),
  model                text NOT NULL,
  prompt_version       text NOT NULL,
  content              jsonb NOT NULL,           -- validated ReviewDraft plus rendered facts
  rendered             text NOT NULL,
  validation_result    jsonb NOT NULL,
  degraded             boolean NOT NULL DEFAULT false,
  delivered_at         timestamptz,
  delivery_status      text CHECK (delivery_status IN ('pending', 'sent', 'failed', 'not_applicable')),
  cost_usd             numeric(12, 6) NOT NULL DEFAULT 0,
  CONSTRAINT ck_review_period CHECK (period_end >= period_start)
);

CREATE TABLE capture_audit (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  labeled_at            timestamptz NOT NULL DEFAULT now(),
  week_of               date NOT NULL,
  conversation_ref      text NOT NULL,
  should_have_captured  boolean NOT NULL,
  expected_items        integer NOT NULL DEFAULT 0 CHECK (expected_items >= 0),
  captured_correctly    integer NOT NULL DEFAULT 0 CHECK (captured_correctly >= 0),
  failure_category      text CHECK (failure_category IN (
                          'capture_not_invoked', 'information_omitted', 'wrong_classification',
                          'wrong_project_or_entity', 'duplicate', 'incorrect_update', 'incorrect_conflict_detection')),
  audit_capture_id      uuid REFERENCES capture (id),
  notes                 text,
  CONSTRAINT ck_capture_audit_counts CHECK (captured_correctly <= expected_items)
);

-- ===================================================================
-- Triggers: updated_at
-- ===================================================================
CREATE TRIGGER trg_touch_project        BEFORE UPDATE ON project        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_entity         BEFORE UPDATE ON entity         FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_work_item      BEFORE UPDATE ON work_item      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_external_ref   BEFORE UPDATE ON external_ref   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_knowledge_item BEFORE UPDATE ON knowledge_item FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_proposal       BEFORE UPDATE ON proposal       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_procedure      BEFORE UPDATE ON procedure      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_preference     BEFORE UPDATE ON preference     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_conflict       BEFORE UPDATE ON conflict       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_seed_batch     BEFORE UPDATE ON seed_batch     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
