# Events Proactivity — current state (audit 2026-10-09)

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


## 16. Events / proactivity

- The `event` table is **an audit log only** (`appendEvent`). There is no LISTEN/NOTIFY, no subscriber and no event-to-action rules.
- Proactive behaviour that exists: J3 weekly review + missed-run check + daily maintenance (time-based cron), and J5 concierge reacting to incoming iMessages. Nothing watches Gmail, Calendar, job boards or deadlines.
- **Event-driven proactivity: ABSENT.**


## 17. Management by exception

**ABSENT** as a system. There is no thresholding over areas or follow-ups and no "only tell me when X goes wrong" rule. The pieces that exist: Render deploy-failure emails (external), the budget ceiling (`budget_blocked`), and stalled-task detection in `mac_status`. Nobody is alerted about #104/#113 sitting for 4 days.

