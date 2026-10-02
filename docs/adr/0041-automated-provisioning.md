# ADR-041: Automated provisioning (`npm run provision`)

- **Date:** 2026-10-01 · **Status:** decided (Julian's direction: "I authenticate and authorize; the AI provisions") · **Category:** operations; no change to security or authority
- **Supersedes:** the manual 10-step provisioning checklist
- **Design:** "FINAGAI AUTOMATED PROVISIONING DESIGN" (https://claude.ai/code/artifact/9ddd59e7-97e0-4969-bc89-a674447b0506)

## Decision

An idempotent bootstrapper (`src/provision/`) runs on Julian's machine and provisions GitHub, Neon, Render, Resend, DNS (Cloudflare when available), and the WorkOS parts that have APIs, through each provider's official REST API. It pauses only for actions that inherently need Julian:
- accounts, billing, and the first API key per provider;
- the Anthropic Console keys (no creation API) and the $36 spend limit (no API for Console organizations);
- WorkOS dashboard-only settings and the OAuth application's secret;
- invitations and passkeys;
- GitHub device login, the Render GitHub-app install, and environment approvals;
- the claude.ai connector (no API).

## Why on Julian's machine

Provisioning from Claude's environment would require every provider credential to pass through the conversation. Locally, secrets travel provider -> process -> destination store and are discarded. The code is deterministic and tested; Julian starts it.

## Secret rules (enforced in code and tests)

- `Secret` objects print as `[secret]` (string, JSON, and inspection).
- The logger redacts registered values; the state file refuses them.
- GitHub secrets are sealed client-side with the environment's public key (libsodium).
- Generated values (the `finagai_app` password, session secret, backup key) never touch disk; the backup key is shown once in the terminal for Julian's password manager.
- The Resend full-access bootstrap key is deleted once the domain-scoped sending key is stored.
- Bootstrap provider keys live in memory for one run only.

## Idempotency

- Every step detects existing resources by name before creating anything.
- Variables are written only when they differ; Render redeploys only on change.
- `finagai_app`'s password is rotated only when a destination lacks it, and then written to both destinations together.
- The state file holds identifiers only and is safe to delete.

## Changes made to support it

- `finagai_app` is created by SQL as `finagai_migrator`, never by API or console, so it inherits no built-in privileges; the bootstrapper verifies it holds neither DELETE nor `pg_write_all_data`.
- Core records `mcp_client_observed` (an audit event) the first time it sees an unpinned client ID, so pinning needs no copying from logs.
- A Node migration runner shares the ledger with `scripts/migrate.sh`.
- `render.yaml` is now a valid reference Blueprint: Render rejects `sync: false` inside an environment group, which the previous file used. All secrets are set through the API.

## Evidence

`test/integration/provision.test.ts` runs the whole bootstrapper against fake provider APIs (with real sealed-box decryption) and a real Postgres standing in for Neon. It checks:
- every pause happens in the designed order;
- wrong keys are rejected by live validation;
- every secret lands in its destination and is absent from logs and state;
- the Render group satisfies Core's configuration schema;
- a second run creates, rotates, and redeploys nothing.

## Verified at the first live run

Field shapes of provider responses that were modeled from documentation (Render service fields, Neon endpoint fields, the WorkOS token-endpoint error codes). A mismatch stops that step with the provider's message; nothing partial is left unrecoverable, because every step re-detects.
