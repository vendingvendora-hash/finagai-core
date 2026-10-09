# Tests — current state (audit 2026-10-09)

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


## 22. Tests

- Unit: **375 passed, 9 skipped, 39 files.** Integration: **186 passed, 20 files.** Total 561 executed cases (506 `it(` declarations).
- Largest suites: j2 (28), concierge (27), llm (20), acceptance (19), guards (18), resource-planner (17).
- **No eval for:** browser page reading, Firefox context, deictic correctness against the real frontmost app, "what am I waiting on" semantics, the employee layer via tools (none exist), approval-wait expiry, the iMessage-path telemetry, the multi-step web workflow, learning. The cos tests cover the services in isolation only.


## 23. Real E2E tests (today)

| # | Test | Result | Evidence |
|---|---|---|---|
| A | Current Mac context | **PASS with defect** | app=firefox, but browser=Chrome job-finder tab (wrong browser) |
| B | Local file find/summarize | **NOT RUN today** (would need J6 file search; last LIVE VERIFIED #116 move + verify on Oct 5) | — |
| C | Browser read | **FAIL** (honest) | #118: "Could not read the page text without acting… frontmost app is Firefox" |
| D | Browser operation on a benign site, no submit | **NOT RUN.** Julian was actively filling a LinkedIn application; operating the screen would have interfered | — |
| E | Cross-app | NOT RUN today; earlier native-app tasks #105/#106 completed (#106 a false completion) | metrics |
| F | Recovery | Evidence from logs only: #115 (3 recoveries → model_parse fail), #116 PASS after fixes | metrics |
| G | Employee layer ("What am I waiting on?") | **FAIL** | spam results, areas empty |
| H | Resource intelligence ("Prepare me for Altarum") | **PASS** | both accounts, full timeline, no next round |
| I | Learning | **NO LEARNING** | code (§14) |

