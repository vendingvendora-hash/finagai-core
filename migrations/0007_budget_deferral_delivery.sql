-- 0007_budget_deferral_delivery.sql
-- Julian's clarifications (2026-10-01):
--   * J2 captures received at the hard model-spend ceiling are stored as sanitized
--     'budget_deferred' envelopes and replayed later with their original timestamps and keys.
--   * outbound_delivery: atomic claim ('sending' with a short lease) and payload hash, so concurrent
--     or mutated retries of one logical delivery cannot send twice or send different content.
--   * capture_candidate: explicit 'duplicate' outcome.

BEGIN;
SET search_path = finagai, public;

ALTER TABLE capture DROP CONSTRAINT capture_status_check;
ALTER TABLE capture ADD CONSTRAINT capture_status_check
  CHECK (status IN ('received', 'processed', 'partially_applied', 'failed', 'dry_run', 'budget_deferred'));
ALTER TABLE capture
  ADD COLUMN project_hint  text,
  ADD COLUMN deferred_at   timestamptz,
  ADD COLUMN replayed_at   timestamptz,
  ADD CONSTRAINT ck_capture_deferred_time CHECK ((status = 'budget_deferred') <= (deferred_at IS NOT NULL));
CREATE INDEX ix_capture_deferred ON capture (received_at) WHERE status = 'budget_deferred';

ALTER TABLE capture_candidate DROP CONSTRAINT capture_candidate_outcome_check;
ALTER TABLE capture_candidate ADD CONSTRAINT capture_candidate_outcome_check
  CHECK (outcome IN ('applied', 'duplicate', 'proposal', 'conflict', 'temporary_discarded', 'guard_rejected', 'staged', 'dry_run'));

ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_status_check;
ALTER TABLE outbound_delivery ADD CONSTRAINT outbound_delivery_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'conflict'));
ALTER TABLE outbound_delivery
  ADD COLUMN payload_sha256 text,
  ADD COLUMN sending_until  timestamptz,
  ADD CONSTRAINT ck_delivery_sending_lease CHECK ((status = 'sending') = (sending_until IS NOT NULL));

COMMIT;
