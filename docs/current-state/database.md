# Database — current state (audit 2026-10-09)

Source of truth: `docs/FINAGAI_CURRENT_STATE_2026-10-09.md`. Code at `94087a7` (live). Rewritten from code and live evidence; supersedes earlier versions of this file.

| Label | Meaning |
|---|---|
| **LIVE VERIFIED** | Exercised against production (Render + Neon + Julian's Mac) with observed output, today or in a recorded live run |
| **LIVE UNVERIFIED** | Deployed, but no live run observed that proves it works |
| **BUILT** | Code + tests exist; not wired into a live path, or never exercised live |
| **PARTIAL** | Works for a subset of the stated scope; the gap is named |
| **DESIGNED** | ADR/doc only |
| **ABSENT** | Nothing exists |
| **BROKEN** | Exists and produces a wrong result, with evidence |


## 13. Memory types

| Type | Store | Status |
|---|---|---|
| Structured state (projects, work items, knowledge, entities) | Postgres (0002) | BUILT. Live state is **nearly empty**: 1 project ("Unassigned"), 0 open items |
| Preferences | `preference` table, versioned, proposal-gated | BUILT; read only by `get_charter` |
| Procedures | `procedure` table, proposal-gated | BUILT; **never read by the J6 executor** |
| Contact notes (J5) | `concierge_contact.notes` | LIVE VERIFIED earlier |
| Artifacts / interactions | `interaction`, artifacts | LIVE VERIFIED |
| Episodic task memory reused across tasks | — | ABSENT |
| Current Mac context | heartbeat snapshot, ephemeral | LIVE VERIFIED |


## 21. Deployment / recovery

- Migrate-before-deploy race: **eliminated, LIVE VERIFIED** (release #6 ran migrate 0023, gated, then deploy, then the SHA check). Render auto-deploy is off. Migrations are frozen by checksum test.
- Live SHA matches origin/main (`94087a7`).
- Backup/restore drill: integration test passes (restore into a fresh DB with matching checksums). A live restore has not been run (LIVE UNVERIFIED).
- Helper recovery: KeepAlive restart LIVE VERIFIED. The independent heartbeat survives long tasks.


## Migrations

- `0001_foundation.sql`
- `0002_schema_v0.sql`
- `0003_privileges.sql`
- `0004_bootstrap_rows.sql`
- `0005_webauthn_credentials.sql`
- `0006_hardening.sql`
- `0007_budget_deferral_delivery.sql`
- `0008_concurrency_tokens.sql`
- `0009_capture_leases_sensitive_uncertain.sql`
- `0010_approval_page_seeding.sql`
- `0011_concierge.sql`
- `0012_control.sql`
- `0013_control_requester.sql`
- `0014_control_result.sql`
- `0015_control_image.sql`
- `0016_areas_of_responsibility.sql`
- `0017_interaction_artifacts.sql`
- `0018_mac_runtime.sql`
- `0019_mac_runtime_health.sql`
- `0020_interaction.sql`
- `0021_mac_context.sql`
- `0022_acceptance_telemetry.sql`
- `0023_capability_registry.sql`

Latest applied live: 0023 (capability, resource_trace). The `event` table is an append-only audit log. `interaction_metrics_daily` is a view (0022).
