# Resources — current state (audit 2026-10-09)

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


## 11. Resource registry

23 capabilities (`src/resources/registry.ts` CATALOG), refreshed at startup, every 60 s on heartbeat and on `list_capabilities`. Reliability is null below 5 samples. **LIVE VERIFIED**: Google gmail/calendar/drive healthy for **both** accounts (vending.vendora@gmail.com, perez.julian@correounivalle.edu.co); j6_planner 0.537; m01_chart DEGRADED 0.4167; mac.accessibility 0.70; resend 1/1. **BROKEN**: mac.filesystem / mac.screen show "unknown" (key mismatch, §5). mac.browser access = "read" only.


## 12. Resource planning / retrieve-before-ask (real traces, today)

- **"Prepare me for Altarum"**: **LIVE VERIFIED, good.** Calendar (both accounts): phone screen 9/14, Ray Sasselli 9/21, panel 9/28 (Frank McKenna, Carley Kirk). Gmail: the Beth Young threads, the cancellation/reschedule, the Otter "Meeting Summary" mail. Drive: Career Copilot job history (fit score 88) and knowledge_base.json. Correctly says "no upcoming event is scheduled". askJulian = null.
  Gaps: the Otter item is the email body (tracking links), not the meeting summary content. There is no inferred status ("awaiting a decision after the 9/28 panel; 11 days without a reply"). The Mac file search is "delegated" and was not run.
- **"What am I waiting on?"**: **BROKEN.** It keyword-searched Gmail for "waiting" and returned spam (Robinhood, Quince, Shopify), a 2025 vendor email and a crime-alert newsletter. `state.areas` and `state.projects` are empty. There is no follow-up model behind it.
- **"Why is Career yellow?"**: **ABSENT.** No area exists; the planner selected zero sources.
- Retrieve-before-ask guard in J6 (one bounce per task): BUILT, LIVE VERIFIED in Phase 2 R-tests.

