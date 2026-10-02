-- 0006_hardening.sql
-- M2 hardening (Julian's review, 2026-10-01). Forward-only; 0001-0005 are unchanged.
--   1. job_run: at-least-once dispatch with leases, attempts, and recovery
--   2. idempotent side effects: review slot keys, outbound delivery ledger
--   3. governance referential integrity: request -> WebAuthn credential -> execution event
--   4. llm_call budget reservations (atomic spend-cap enforcement)

BEGIN;
SET search_path = finagai, public;

-- -------------------------------------------------------------------
-- 1. Job leases
-- -------------------------------------------------------------------
-- A slot is complete only when status is 'succeeded' or 'skipped'; those never run again.
-- 'running' with an expired lease, or 'failed' below max attempts, may be reclaimed.
ALTER TABLE job_run
  ADD COLUMN attempt            integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  ADD COLUMN max_attempts       integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  ADD COLUMN lease_expires_at   timestamptz,
  ADD COLUMN last_heartbeat_at  timestamptz,
  ADD COLUMN lease_owner        text,            -- random per scheduler process; heartbeats must match
  ADD CONSTRAINT ck_job_run_running_has_lease
    CHECK (status <> 'running' OR lease_expires_at IS NOT NULL),
  ADD CONSTRAINT ck_job_run_attempts CHECK (attempt <= max_attempts);

-- -------------------------------------------------------------------
-- 2. Idempotent side effects
-- -------------------------------------------------------------------
-- J3 generation is keyed by its scheduled slot: a retried weekly review reuses the same row.
ALTER TABLE review
  ADD COLUMN slot_key text,
  ADD CONSTRAINT uq_review_slot_key UNIQUE (slot_key),
  ADD CONSTRAINT ck_review_weekly_slot CHECK (kind <> 'weekly' OR slot_key IS NOT NULL);

-- Every externally visible send goes through this ledger, keyed by a stable idempotency key
-- (for example 'review-email:<review_id>'). A 'sent' row is never sent again.
CREATE TABLE outbound_delivery (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key      text NOT NULL UNIQUE,
  channel              text NOT NULL CHECK (channel IN ('email')),
  purpose              text NOT NULL,                     -- weekly_review, missed_run_alert, budget_alert, ...
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  last_error           text,
  review_id            uuid REFERENCES review (id),
  CONSTRAINT ck_delivery_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

-- -------------------------------------------------------------------
-- 3. Governance referential integrity (ADR-019, ADR-030)
-- -------------------------------------------------------------------
-- Replace the free-text credential column from 0005 with a foreign key to the internal UUID.
-- The composite key also proves the signing credential belongs to the deciding principal.
ALTER TABLE webauthn_credential
  ADD CONSTRAINT uq_webauthn_credential_principal UNIQUE (id, principal_subject);

ALTER TABLE governance_request
  DROP CONSTRAINT ck_governance_signed_approval,
  DROP COLUMN passkey_credential_id,
  ADD COLUMN approval_credential_id uuid,
  ADD COLUMN challenge_used_at timestamptz,         -- single-use challenge marker
  ADD CONSTRAINT fk_governance_credential_principal
    FOREIGN KEY (approval_credential_id, decided_by_principal)
    REFERENCES webauthn_credential (id, principal_subject),
  ADD CONSTRAINT ck_governance_signed_approval
    CHECK (status NOT IN ('approved', 'executed') OR approval_credential_id IS NOT NULL);

-- A revoked credential can never be attached to a decision.
CREATE FUNCTION reject_revoked_credential() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approval_credential_id IS NOT NULL
     AND NEW.approval_credential_id IS DISTINCT FROM OLD.approval_credential_id
     AND EXISTS (SELECT 1 FROM finagai.webauthn_credential
                 WHERE id = NEW.approval_credential_id AND revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'revoked WebAuthn credential cannot approve a governance request'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_governance_credential_active
  BEFORE UPDATE OF approval_credential_id ON governance_request
  FOR EACH ROW EXECUTE FUNCTION reject_revoked_credential();

-- Execution events must point at a real governance request.
ALTER TABLE event
  ADD CONSTRAINT fk_event_approval FOREIGN KEY (approval_id) REFERENCES governance_request (id);

-- -------------------------------------------------------------------
-- 4. Budget reservations (G20)
-- -------------------------------------------------------------------
ALTER TABLE llm_call
  ADD COLUMN reserved_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  ADD COLUMN purpose text;
ALTER TABLE llm_call DROP CONSTRAINT llm_call_status_check;
ALTER TABLE llm_call ADD CONSTRAINT llm_call_status_check
  CHECK (status IN ('reserved', 'ok', 'error', 'schema_invalid', 'guard_rejected', 'budget_blocked'));
ALTER TABLE llm_call ADD CONSTRAINT ck_llm_call_reservation
  CHECK ((status = 'reserved') = (reserved_usd > 0));

-- -------------------------------------------------------------------
-- Privileges for the new table
-- -------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON outbound_delivery TO finagai_app;
REVOKE DELETE, TRUNCATE ON outbound_delivery FROM finagai_app;

COMMIT;
