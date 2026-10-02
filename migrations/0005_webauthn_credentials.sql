-- 0005_webauthn_credentials.sql
-- ADR-030: public verification data for Julian's WebAuthn credentials, and per-ceremony challenges
-- bound to governance requests. No private key material is ever stored; there is no column for it.

BEGIN;
SET search_path = finagai, public;

CREATE TABLE webauthn_credential (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  principal_subject   text NOT NULL,                  -- identity-provider subject the credential belongs to
  credential_id       text NOT NULL UNIQUE,           -- base64url credential ID
  public_key          bytea NOT NULL,                 -- COSE-encoded public key
  sign_count          bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports          text[] NOT NULL DEFAULT '{}',
  label               text,
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  enrolled_via        text NOT NULL CHECK (enrolled_via IN ('admin_enrollment_code', 'existing_credential'))
);

ALTER TABLE governance_request
  ADD COLUMN challenge_hash        text,             -- SHA-256 of the issued challenge; raw challenge never stored
  ADD COLUMN challenge_expires_at  timestamptz,
  ADD CONSTRAINT ck_governance_challenge_pair
    CHECK ((challenge_hash IS NULL) = (challenge_expires_at IS NULL)),
  -- An approved or executed request must name the credential that signed it (ADR-030).
  ADD CONSTRAINT ck_governance_signed_approval
    CHECK (status NOT IN ('approved', 'executed') OR passkey_credential_id IS NOT NULL);

GRANT SELECT, INSERT, UPDATE ON webauthn_credential TO finagai_app;
REVOKE DELETE, TRUNCATE ON webauthn_credential FROM finagai_app;

COMMIT;
