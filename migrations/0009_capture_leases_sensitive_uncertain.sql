-- 0009_capture_leases_sensitive_uncertain.sql
-- (Revised before release: not yet applied to any shared environment.)
-- Julian's corrections (2026-10-01):
--   1. capture.source_text is NULL until the second classification layer has run; only a sanitized
--      body is ever persisted. New status 'budget_blocked_not_persisted' for captures that could not
--      be classified because the model ceiling was reached (body never stored).
--   2. Capture processing ownership: status 'processing' with a token, lease, and attempt count, so
--      crashes and transient failures are retried with the same idempotency key.
--   4. outbound_delivery 'uncertain' state for ambiguous provider outcomes, with the time it began.

BEGIN;
SET search_path = finagai, public;

ALTER TABLE capture ALTER COLUMN source_text DROP NOT NULL;
ALTER TABLE capture DROP CONSTRAINT capture_status_check;
ALTER TABLE capture ADD CONSTRAINT capture_status_check
  CHECK (status IN ('received', 'processing', 'processed', 'partially_applied', 'failed', 'dry_run',
                    'budget_deferred', 'budget_blocked_not_persisted'));
ALTER TABLE capture
  ADD COLUMN processing_token  uuid,
  ADD COLUMN processing_until  timestamptz,
  ADD COLUMN attempts          integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  ADD COLUMN sensitive_redactions integer NOT NULL DEFAULT 0 CHECK (sensitive_redactions >= 0),
  ADD COLUMN sanitized_at      timestamptz,      -- set only after BOTH classification layers ran
  ADD CONSTRAINT ck_capture_processing_lease
    CHECK ((status = 'processing') = (processing_token IS NOT NULL AND processing_until IS NOT NULL)),
  -- The core invariant: a body exists only if it was sanitized by both layers.
  ADD CONSTRAINT ck_capture_body_sanitized CHECK (source_text IS NULL OR sanitized_at IS NOT NULL),
  -- A capture that could not be classified never holds a body.
  ADD CONSTRAINT ck_capture_unclassified_no_body
    CHECK (status NOT IN ('budget_blocked_not_persisted', 'received') OR source_text IS NULL),
  -- A deferred capture must hold its sanitized body, or it could never be replayed.
  ADD CONSTRAINT ck_capture_deferred_has_body CHECK (status <> 'budget_deferred' OR source_text IS NOT NULL);

ALTER TABLE outbound_delivery DROP CONSTRAINT outbound_delivery_status_check;
ALTER TABLE outbound_delivery ADD CONSTRAINT outbound_delivery_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'conflict', 'uncertain'));
-- first_ambiguous_at survives reclaims: the provider's deduplication window counts from the FIRST
-- ambiguous attempt, so a retry is only safe while that window is open.
ALTER TABLE outbound_delivery
  ADD COLUMN first_ambiguous_at timestamptz,
  ADD CONSTRAINT ck_delivery_uncertain_time CHECK (status <> 'uncertain' OR first_ambiguous_at IS NOT NULL);

COMMIT;
