# Migrations

Plain SQL, applied in filename order by the migration role (`finagai_migrator`), never by the app role.

| File | Purpose |
| --- | --- |
| `0001_foundation.sql` | Schema `finagai`, shared types, helper and append-only functions |
| `0002_schema_v0.sql` | The 20 Schema v0 tables, constraints, indexes, triggers |
| `0003_privileges.sql` | Least-privilege grants for `finagai_app` (no DELETE anywhere; event insert-only; charter read-only) |
| `0004_bootstrap_rows.sql` | The Unassigned holding project |
| `0010_approval_page_seeding.sql` | Enrollment codes (insert reserved to the migration role), WebAuthn ceremonies, server-fixed approval challenge state, seeding answers |
| `0009_capture_leases_sensitive_uncertain.sql` | Capture body persisted only after second-layer classification; capture processing leases; `budget_blocked_not_persisted`; uncertain deliveries |
| `0008_concurrency_tokens.sql` | Capture payload hash (idempotency conflicts); delivery lease token (stale workers cannot mutate a reclaimed delivery) |
| `0007_budget_deferral_delivery.sql` | Budget-deferred capture envelopes; claimable, payload-hashed deliveries; `duplicate` candidate outcome |
| `0006_hardening.sql` | Job leases and retries; review slot keys and outbound delivery ledger; governance request → credential (UUID FK bound to principal) → event FK; budget reservations on `llm_call` |
| `0005_webauthn_credentials.sql` | ADR-030: public WebAuthn credential data and per-ceremony challenge fields on governance requests |

Rules:

- A released migration is never edited. Corrections are new migrations.
- Roles `finagai_migrator` and `finagai_app` are created outside migrations (see `docs/runbooks/provisioning.md`), because their passwords must never appear in the repository.
- Removing a v1 constraint such as `ck_*_v1_no_highly_sensitive` is an authority change (ADR-016) and requires Julian's approval and its own ADR.
- `scripts/verify-migrations.sh` applies all migrations to a disposable local database and runs the protection tests in `test/integration/schema_protections.sql`.
- `scripts/migrate.sh` applies pending migrations to Neon, records each file's SHA-256, and refuses to run if a released file changed. It runs only from the manual `migrate` workflow, behind a GitHub environment that requires Julian's approval.
