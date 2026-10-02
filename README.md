# finagai-core

Finagai Core is the durable center of Finagai: it owns state, rules, provenance, permissions, workflows, and audit history. Claude provides interpretation and conversation as a replaceable client (ADR-013). J2 (context capture) and J3 (operating review) are coded pipelines; Claude performs judgment, code enforces everything enforceable (ADR-014).

## Status

Local implementation of M0-M7 is complete (not deployed). **Start here: `./finagai`** launches the autonomous builder that provisions, deploys, evaluates, and verifies readiness (ADR-042, `docs/autonomous-builder.md`). Provisioning on its own: `npm run provision` (ADR-041). Implemented and tested:

- Schema v0 migrations 0001-0006, with database-level protections and governance referential integrity
- Typed configuration with placeholder rejection and secret redaction
- HTTP server: database-free `/health`, RFC 9728 metadata, bearer verification on `/mcp`, session-only `/approve`
- Model spend: $30 target, $36 hard ceiling enforced by atomic worst-case reservations with zero overshoot (ADR-025, ADR-034)
- Scheduler: DST-safe slots, at-least-once dispatch with leases and retries (ADR-033)
- Delivery: authoritative local idempotency ledger, payload hashing, atomic claims, Resend sender (ADR-033 addendum)
- J2 pipeline: sanitize-before-persist (ADR-038), processing leases with crash recovery, extraction, guards, dates, retrieval, classification, authority rules, post-extraction budget deferral and replay
- MCP tool layer: 15 tools over a stateless handler; governance tools only stage requests (ADR-019)
- J3: deterministic collection, compose, validation (G15-G17, V5, V6), rendering, slot-keyed weekly delivery, missed-run recovery, zero-model degraded review
- M5 approval page: OIDC sign-in, passkey enrollment, fresh WebAuthn approvals, atomic versioned execution (Gate 2 passed locally)
- M7 seeding: staging, consolidation, code-generated questions, answers, approval-gated promotion, baseline review
- Real-model evaluation: `npm run eval:j2` (12 J2 cases) and `npm run eval:j3` (10 J3 cases), each on a disposable local Postgres
- Operations: encrypted nightly backups and a monthly restore drill (GitHub Actions), daily maintenance, startup preflight, access logging, job-failure alerts, one-click `readiness` workflow (ADR-040); runbooks in `docs/runbooks/`
- Governance approval policy over SimpleWebAuthn (ADR-030, ADR-035)
- J2 guards: G01-G06, G09, G10, G11, G19, G21

Tests: 187 unit, 111 integration (real Postgres; the autonomous builder against the real Claude Code runtime; full-system simulation; bootstrapper against fake providers; Gate 2; seeding; restore drill; J3 case validation), 30 schema protection checks plus a positive control; startup verification of the built server.

## Known v1 scope limits

- Arbitrary relationship capture is deferred (ADR-037): extracted relationship candidates are rejected and reported, while Core-created links (entity or external reference to project) work.

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript strict typecheck |
| `npm test` | Unit tests (Vitest) |
| `npm run test:integration` | Starts a disposable Postgres, applies migrations, runs integration tests as `finagai_app` |
| `npm run migrate` | Applies pending migrations to `$MIGRATOR_DATABASE_URL`; in practice run only via the manual `migrate` GitHub workflow |
| `npm run eval:j2` | Real-model J2 evaluation (Gate 1); needs `ANTHROPIC_API_KEY` and local PostgreSQL binaries; report in `eval/reports/` |
| `npm run eval:j3` | Real-model J3 evaluation (T11-T20), fresh database per case; capped by `EVAL_MAX_SPEND_USD` |
| `./finagai` / `npm run finagai:build` | Autonomous builder: drives Finagai to readiness; `finagai:resume`, `finagai:status`, `finagai:fresh` |
| `npm run provision` | Idempotent bootstrapper: provisions every provider through its API, pausing only for human-only actions |
| `npm run verify:startup` | Builds and starts the server as Render will; proves correct start and refusal on unsafe configuration |
| `scripts/smoke-deployed.sh <base> <issuer>` | Credential-free checks of a deployed Core and its identity provider |
| `npm run admin -- enroll-code` | On Julian's machine only: one-time passkey enrollment code (migration role) |
| `npm run verify:migrations` | Applies all migrations to a disposable local Postgres and runs the 17 schema protection tests (needs local PostgreSQL binaries; no accounts) |

## Layout

See `docs/README.md`. Secrets never live in this repository: `.env.example` holds placeholders only, and real values are set directly in the Render dashboard.
