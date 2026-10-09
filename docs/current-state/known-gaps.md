# Known Gaps — current state (audit 2026-10-09)

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


## 28. Ranked technical debt

1. Browser page read is not real (`read_text` = first AXTextArea); there is no DOM channel.
2. `browserActiveTab` ignores the frontmost app, and Firefox is unsupported, so deictic answers are wrong with high confidence.
3. Employee layer (`src/cos`) is unreachable: no tools, no schedule.
4. Approval waits never expire; interaction ≠ task state (#104/#113 for 4 days).
5. iMessage-path tasks create no interaction, so telemetry stops at Oct 5.
6. Registry Mac probe key mismatch (`files`/`screen` vs `filesystem`/`screenCapture`).
7. "Waiting on" queries are keyword search, with no relevance or spam filtering.
8. Reconcile errors are swallowed (`.catch(() => {})`) at both call sites, which hides failures.
9. J6 success is 0.54; coordinate actions produce false completions.
10. No learning loop; procedures are never read by the executor.
11. Live state DB nearly empty (1 project), so state-based answers are vacuous.
12. Scheduler deployed SHA is not observable from /health.


## 27. 2-day delta (Oct 7–9)

No code, migration or helper change. The only state change is usage: #117 done, #118 (audit) done, a helper outage of 656 s on Oct 9 that auto-recovered. The Oct 5 changes are covered in the changelog in §1.


## Evidence that contradicts earlier capability claims

1. "Browser read" (registry `mac.browser` access=read): page text cannot actually be read (#118). Only URL/title for Chrome/Safari.
2. "Deterministic deictic resolution": wrong referent with high confidence when Firefox is frontmost (today).
3. "Mac boolean probes fixed" (ADR-075): accessibility is fixed, but filesystem/screen still show "unknown" because of key names.
4. "Interactions reconciled" (ADR-075): #104/#113 still "executing" after 4 days (tasks in `waiting_approval`).
5. "Cost attribution" (ADR-075): every `cost_usd` is still null. Unproven rather than disproven.
6. "Employee layer (ADR-060)": shipped as code, but unreachable from any tool or job.
7. "execution_metrics shows how Finagai performs": usage after Oct 5 is missing (the iMessage path is untracked).
