-- 0008_concurrency_tokens.sql
-- Julian's concurrency fixes (2026-10-01):
--   * capture.payload_sha256: same idempotency key with a different payload is a conflict, not a replay.
--     The hash covers the REDACTED text plus source type, so no derivative of a secret is stored.
--   * outbound_delivery.sending_token: every claim or reclaim gets a fresh token; only the current
--     token holder can mark the delivery sent, failed, or in conflict.

BEGIN;
SET search_path = finagai, public;

ALTER TABLE capture ADD COLUMN payload_sha256 text;

ALTER TABLE outbound_delivery
  ADD COLUMN sending_token uuid,
  ADD CONSTRAINT ck_delivery_token CHECK ((status = 'sending') = (sending_token IS NOT NULL));

COMMIT;
