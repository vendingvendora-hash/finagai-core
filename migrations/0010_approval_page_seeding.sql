-- 0010_approval_page_seeding.sql
-- M5 (governance approval page) and M7 (seeding) support.

BEGIN;
SET search_path = finagai, public;

-- One-time passkey enrollment codes (ADR-030). INSERT is reserved to the migration role, used only by
-- the admin CLI on Julian's machine: neither the running app nor any model can mint a code.
CREATE TABLE webauthn_enrollment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_subject  text NOT NULL,
  code_hash          text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  CONSTRAINT ck_enrollment_expiry CHECK (expires_at > created_at)
);
GRANT SELECT, UPDATE ON webauthn_enrollment TO finagai_app;
REVOKE INSERT, DELETE, TRUNCATE ON webauthn_enrollment FROM finagai_app;

-- Registration and enrollment-authorization ceremonies (single use, short-lived).
CREATE TABLE webauthn_ceremony (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('enroll_auth', 'registration')),
  principal_subject  text NOT NULL,
  challenge          text NOT NULL,          -- public by nature (sent to the browser); stored to verify
  enrollment_id      uuid REFERENCES webauthn_enrollment (id),
  authorized_by_credential uuid REFERENCES webauthn_credential (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  CONSTRAINT ck_ceremony_registration_authorized
    CHECK (kind <> 'registration' OR enrollment_id IS NOT NULL OR authorized_by_credential IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE ON webauthn_ceremony TO finagai_app;
REVOKE DELETE, TRUNCATE ON webauthn_ceremony FROM finagai_app;

-- Approval ceremonies: the per-ceremony random and the decision are fixed server-side when the
-- challenge is issued, so the browser can neither choose nor change what the signature authorizes.
ALTER TABLE governance_request
  ADD COLUMN challenge_random   text,
  ADD COLUMN challenge_decision text CHECK (challenge_decision IN ('approve', 'reject')),
  ADD CONSTRAINT ck_governance_challenge_complete
    CHECK ((challenge_hash IS NULL) = (challenge_random IS NULL) AND (challenge_hash IS NULL) = (challenge_decision IS NULL));

-- Seeding answers (M7): Julian's corrections to a staged candidate, applied at promotion.
ALTER TABLE capture_candidate ADD COLUMN seed_overrides jsonb;

COMMIT;
