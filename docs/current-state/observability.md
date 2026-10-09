# Observability — current state (audit 2026-10-09)

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


## 18. Observability (real values)

- Spend month-to-date: **$7.00** of a $30 target ($36 ceiling).
- J6 success 29/54 (0.537), p50 22.8 s. M01 5/12. AX steps 21/30.
- `interaction_metrics_daily`: **no rows after 2026-10-05.** Real use since then (#117 over iMessage) does not create interactions.
- `cost_usd` is **null in every interaction row.** The code (ADR-075) attributes `llm_call.request_id = task id`, but no chat-initiated J6 task has completed since that deploy. Status: **LIVE UNVERIFIED** (not proven broken, not proven working).
- p50 acknowledgement = 0 s by construction (the row is created synchronously), so it is not informative.
- Helper: 24 reconnects; last outage 2026-10-09 10:35 UTC, 656 s.


## 19. Failure mining

Recorded failure classes: `model_parse` (#115, fixed in bfad3be), verifier false negatives (#113, fixed in ac984e7), stuck approvals (#104/#113, open), Oct 4 "unknown" class 5/9 failed (pre-telemetry), #107 failed after 13,391 s, #80 failed after 17,015 s. **No automated failure mining.** It is manual: I read the metrics and the ADRs.

