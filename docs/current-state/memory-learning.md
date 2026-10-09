# Memory Learning — current state (audit 2026-10-09)

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


## 14. Learning

**NO LEARNING.** J6 skills are a static, regex-triggered array (`src/pipelines/j6/skills.ts`). Outcomes, failures and verifier verdicts are recorded (telemetry), but nothing reads them back to change plans, skills, source authority or prompts. The `procedure` table is written only through human-approved J2 proposals and is not read by J6. Registry reliability numbers are computed but do not affect planner choices beyond the DEGRADED label.

