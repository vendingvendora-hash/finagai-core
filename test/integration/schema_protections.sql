-- Runs as finagai_app. Each statement must FAIL; any success is a test failure (acceptance criterion A2).
\set ON_ERROR_STOP on
SET search_path = finagai;

CREATE FUNCTION pg_temp.expect_error(label text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  %  (%)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  % : statement succeeded but must be rejected', label;
END;
$$;

-- Fixtures created through allowed paths.
INSERT INTO capture (idempotency_key, client, mode, source_type, source_text, pipeline_version, status, sanitized_at)
VALUES ('test-1', 'eval', 'eval', 'note', 'fixture', 'test', 'processed', now());

SELECT pg_temp.expect_error('G14 no delete on work state',
  $q$DELETE FROM project$q$);
SELECT pg_temp.expect_error('G14 event is append-only (update)',
  $q$UPDATE event SET reason = 'x'$q$);
SELECT pg_temp.expect_error('G14 event is append-only (delete)',
  $q$DELETE FROM event$q$);
SELECT pg_temp.expect_error('Charter not writable by app',
  $q$INSERT INTO charter (version, body) VALUES (1, 'x')$q$);
SELECT pg_temp.expect_error('ADR-020 Prohibited never stored',
  $q$INSERT INTO project (name, classification) VALUES ('p', 'prohibited')$q$);
SELECT pg_temp.expect_error('ADR-016 Highly Sensitive rejected in v1',
  $q$INSERT INTO project (name, classification) VALUES ('p', 'highly_sensitive')$q$);
SELECT pg_temp.expect_error('G03 no inferred tasks',
  $q$INSERT INTO work_item (project_id, kind, title, origin)
     SELECT id, 'task', 't', 'inferred' FROM project LIMIT 1$q$);
SELECT pg_temp.expect_error('Done requires completed_at',
  $q$INSERT INTO work_item (project_id, kind, title, origin, status)
     SELECT id, 'task', 't', 'user_stated', 'done' FROM project LIMIT 1$q$);
SELECT pg_temp.expect_error('AR02 knowledge requires provenance',
  $q$INSERT INTO knowledge_item (subject_type, claim, epistemic_status, source_visibility, as_of, source_quote)
     VALUES ('julian', 'c', 'fact', 'non_public', now(), 'q')$q$);
SELECT pg_temp.expect_error('ADR-022 third-party claim needs purpose',
  $q$INSERT INTO knowledge_item (subject_type, subject_id, claim, epistemic_status, source_visibility, as_of, source_quote, source_capture_id)
     SELECT 'entity', gen_random_uuid(), 'c', 'user_provided', 'public', now(), 'q', id FROM capture LIMIT 1$q$);
SELECT pg_temp.expect_error('ADR-022 confidential third-party claim needs review date',
  $q$INSERT INTO knowledge_item (subject_type, subject_id, claim, epistemic_status, source_visibility, purpose, classification, as_of, source_quote, source_capture_id)
     SELECT 'entity', gen_random_uuid(), 'c', 'user_provided', 'non_public', 'outreach', 'confidential', now(), 'q', id FROM capture LIMIT 1$q$);
SELECT pg_temp.expect_error('ADR-021 non-public person info never Public',
  $q$INSERT INTO knowledge_item (subject_type, subject_id, claim, epistemic_status, source_visibility, purpose, classification, as_of, source_quote, source_capture_id)
     SELECT 'entity', gen_random_uuid(), 'c', 'user_provided', 'non_public', 'outreach', 'public', now(), 'q', id FROM capture LIMIT 1$q$);
SELECT pg_temp.expect_error('ADR-022 confidential entity needs review date',
  $q$INSERT INTO entity (kind, name, purpose, source_visibility, classification)
     VALUES ('person', 'n', 'outreach', 'non_public', 'confidential')$q$);
SELECT pg_temp.expect_error('ADR-019 approval event needs principal',
  $q$INSERT INTO event (actor, action, approval_id) VALUES ('julian', 'conflict_resolve', gen_random_uuid())$q$);
SELECT pg_temp.expect_error('ADR-019 decision needs authenticated principal',
  $q$INSERT INTO governance_request (action, target_refs, before_state, proposed_after_state, rationale,
       requesting_client, expires_at, nonce_hash, content_hash, status, decided_at)
     VALUES ('decide_proposal', '[]', '{}', '{}', 'r', 'claude_ai', now() + interval '1 day', 'n', 'c', 'approved', now())$q$);
SELECT pg_temp.expect_error('G12 idempotent capture',
  $q$INSERT INTO capture (idempotency_key, client, mode, source_type, source_text, pipeline_version, status, sanitized_at)
     VALUES ('test-1', 'eval', 'eval', 'note', 'dup', 'test', 'processed', now())$q$);
SELECT pg_temp.expect_error('Only one Unassigned holding project',
  $q$INSERT INTO project (name, is_unassigned_holding) VALUES ('Second holding', true)$q$);

SELECT pg_temp.expect_error('ADR-030 approval must name the signing credential',
  $q$INSERT INTO governance_request (action, target_refs, before_state, proposed_after_state, rationale,
       requesting_client, expires_at, nonce_hash, content_hash, status, decided_at, decided_by_principal)
     VALUES ('decide_proposal', '[]', '{}', '{}', 'r', 'claude_ai', now() + interval '1 day', 'n', 'c', 'approved', now(), 'user_test')$q$);
SELECT pg_temp.expect_error('ADR-030 credentials are never deleted',
  $q$DELETE FROM webauthn_credential$q$);

-- 0006: governance referential integrity
INSERT INTO webauthn_credential (principal_subject, credential_id, public_key, enrolled_via)
VALUES ('user_test', 'cred-active', '\x01', 'admin_enrollment_code'),
       ('user_other', 'cred-other', '\x02', 'admin_enrollment_code');
INSERT INTO webauthn_credential (principal_subject, credential_id, public_key, enrolled_via, revoked_at)
VALUES ('user_test', 'cred-revoked', '\x03', 'admin_enrollment_code', now());
INSERT INTO governance_request (id, action, target_refs, before_state, proposed_after_state, rationale,
       requesting_client, expires_at, nonce_hash, content_hash)
VALUES ('11111111-1111-1111-1111-111111111111', 'decide_proposal', '[]', '{}', '{}', 'r', 'claude_ai',
        now() + interval '1 day', 'n', 'c');

SELECT pg_temp.expect_error('ADR-030 credential must exist',
  $q$UPDATE governance_request SET status = 'approved', decided_at = now(), decided_by_principal = 'user_test',
       approval_credential_id = gen_random_uuid() WHERE id = '11111111-1111-1111-1111-111111111111'$q$);
SELECT pg_temp.expect_error('ADR-030 credential must belong to the deciding principal',
  $q$UPDATE governance_request SET status = 'approved', decided_at = now(), decided_by_principal = 'user_test',
       approval_credential_id = (SELECT id FROM webauthn_credential WHERE credential_id = 'cred-other')
     WHERE id = '11111111-1111-1111-1111-111111111111'$q$);
SELECT pg_temp.expect_error('ADR-030 revoked credential cannot approve',
  $q$UPDATE governance_request SET status = 'approved', decided_at = now(), decided_by_principal = 'user_test',
       approval_credential_id = (SELECT id FROM webauthn_credential WHERE credential_id = 'cred-revoked')
     WHERE id = '11111111-1111-1111-1111-111111111111'$q$);
SELECT pg_temp.expect_error('ADR-019 execution event must reference a real governance request',
  $q$INSERT INTO event (actor, action, approval_id, principal) VALUES ('julian', 'conflict_resolve', gen_random_uuid(), 'user_test')$q$);
SELECT pg_temp.expect_error('Outbound deliveries are never deleted',
  $q$DELETE FROM outbound_delivery$q$);
SELECT pg_temp.expect_error('Weekly reviews require a slot key',
  $q$INSERT INTO review (kind, period_start, period_end, model, prompt_version, content, rendered, validation_result)
     VALUES ('weekly', now(), now(), 'm', 'v', '{}', 'r', '{}')$q$);

-- Positive control: a valid approval with an active credential of the same principal succeeds.
UPDATE governance_request SET status = 'approved', decided_at = now(), decided_by_principal = 'user_test',
       approval_credential_id = (SELECT id FROM webauthn_credential WHERE credential_id = 'cred-active')
 WHERE id = '11111111-1111-1111-1111-111111111111';
\echo 'PASS  positive control: valid approval accepted'

SELECT pg_temp.expect_error('0009 a body without second-layer sanitization can never be stored',
  $q$INSERT INTO capture (idempotency_key, client, mode, source_type, source_text, pipeline_version, status, processing_token, processing_until)
     VALUES ('test-2', 'eval', 'eval', 'note', 'unclassified body', 'test', 'processing', gen_random_uuid(), now())$q$);
SELECT pg_temp.expect_error('0009 a budget-blocked capture can never hold a body',
  $q$INSERT INTO capture (idempotency_key, client, mode, source_type, source_text, pipeline_version, status)
     VALUES ('test-3', 'eval', 'eval', 'note', 'unclassified body', 'test', 'budget_blocked_not_persisted')$q$);
SELECT pg_temp.expect_error('0009 a deferred capture must hold its sanitized body',
  $q$INSERT INTO capture (idempotency_key, client, mode, source_type, pipeline_version, status, deferred_at)
     VALUES ('test-4', 'eval', 'eval', 'note', 'test', 'budget_deferred', now())$q$);

SELECT pg_temp.expect_error('0010 the app cannot mint passkey enrollment codes',
  $q$INSERT INTO webauthn_enrollment (principal_subject, code_hash, expires_at) VALUES ('user_test', 'h', now() + interval '1 hour')$q$);

\echo 'ALL SCHEMA PROTECTION TESTS PASSED'
