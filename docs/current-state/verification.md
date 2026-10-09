# Verification — current state (audit 2026-10-09)

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


## 10. Outcome verification per action class

| Class | Verification | Status |
|---|---|---|
| File move/trash | deterministic (exists/absent + sha256) | LIVE VERIFIED |
| AX actions | before/after delta, "verified/unverified" | LIVE VERIFIED (0.70) |
| Coordinate actions | screenshot + model grader | PARTIAL (false completions observed) |
| Read-only answers | model grader | PARTIAL |
| Chart | M01 acceptance checks (layout, series) | LIVE VERIFIED, 0.42 reliability |
| Outbound messages/email | idempotency key (`outbound_action`) | BUILT; no autonomous sends by design |
| Web form progress | none beyond the screenshot | ABSENT |


## 6. J6 deep-dive

- Loop: plan → parseStep (balanced JSON + `<invoke>` XML) → risk = the stricter of the model's declaration and the code classification → approval if write → act → observe → verify. **LIVE VERIFIED**.
- **Can the planner declare done by itself?** No. `done` triggers `verifyCompletion` against the acceptance contract. File ops are verified deterministically; anything else goes to a model grader. If the grader is unavailable, the task still completes, labelled "NOT independently verified" (a deliberate trade-off, PARTIAL).
- Recovery: `recoveryDecision` has a bounded budget. The loop guard exempts re-observes after a rejection. A step limit asks Julian to continue.
- Results (registry, all time): **29/54 succeeded (0.537)**, p50 22.8 s. Oct 5 metrics: files class 1 completed / 1 failed / 2 false completions; native-app 3/1/2.
- Today: #118 (read-only) **behaved correctly**. It could not read the page text, reported the conflict between the context (Chrome) and the screen (Firefox, LinkedIn), and stopped instead of guessing.
- **Defect: approval waits never expire.** Tasks #104 and #113 have sat in `waiting_approval` since Oct 5 (4+ days), and their interactions still say "executing" (§9).

