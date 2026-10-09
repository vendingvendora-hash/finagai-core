# Security Governance — current state (audit 2026-10-09)

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


## 20. Governance: CODE-ENFORCED vs PROMPT-ONLY

| Rule | Enforcement |
|---|---|
| Write steps on the Mac need Julian's approval | **CODE-ENFORCED** (`needsApproval`, the model's risk can only be raised) |
| Read-only commands auto-run | CODE-ENFORCED allow-list (`isReadOnlyCommand`) |
| Protected paths unreachable in read-only runs | CODE-ENFORCED (5e9b120) |
| Preference/procedure changes go through proposals | CODE-ENFORCED (J2) |
| Archival/conflict/seed/proposal decisions need WebAuthn approval | CODE-ENFORCED |
| Budget ceiling | CODE-ENFORCED (`BudgetBlockedError`) |
| Outbound idempotency | CODE-ENFORCED (`outbound_action`) |
| "Never send/reply unless the task says so" (Gmail skill) | **PROMPT-ONLY** (though any send through the UI is a write step, so it is approval-gated) |
| "Call plan_resources first", "never ask what you can retrieve" | **PROMPT-ONLY** in chat; J6 has a code guard (one bounce) |
| Tool selection | PROMPT-ONLY |
| Submitting applications / purchases are reserved for Julian | Effectively code-enforced through write approval; there is no explicit "principal-reserved" class |

