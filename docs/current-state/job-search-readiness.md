# Job Search Readiness — current state (audit 2026-10-09)

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


## 24. Job-search acceptance case (21 steps)

| # | Step | Status |
|---|---|---|
| 1 | Know Julian's target roles/criteria | PARTIAL: lives in Drive (Career Copilot, knowledge_base.json), found by plan_resources; not in Finagai state |
| 2 | Find new postings autonomously (scheduled) | **ABSENT** (no job-board source, no schedule) |
| 3 | Find postings on request | PARTIAL: J6 could browse by screenshots; LIVE UNVERIFIED |
| 4 | Read a posting Julian has open | **BROKEN** in Firefox; Chrome = URL/title only + screenshot |
| 5 | Score fit vs. profile | PARTIAL: done by the external Career Copilot (Drive sheet, score 88), not Finagai |
| 6 | Deduplicate already-applied jobs | ABSENT in Finagai (LinkedIn shows "Applied") |
| 7 | Tailor resume | ABSENT as a Finagai capability (done in Claude chats) |
| 8 | Draft a cover letter | ABSENT as a capability (chat only) |
| 9 | Fill application fields | PARTIAL: coordinate typing with per-step approval; no DOM form fill; LIVE UNVERIFIED |
| 10 | Answer screening questions from known facts | PARTIAL: facts are in Drive knowledge_base; not wired to form fill |
| 11 | Upload resume file | ABSENT (no file-picker flow) |
| 12 | Stop before submit for review | CODE-ENFORCED (write approval) |
| 13 | Submit | **PRINCIPAL RESERVED** |
| 14 | Record the application (company, role, date, link) | ABSENT in Finagai |
| 15 | Track status / follow-ups | BUILT (`cos/followups.ts`) but not wired, so ABSENT live |
| 16 | Detect recruiter replies | PARTIAL: Gmail search on request; no watcher |
| 17 | Schedule/interview awareness | LIVE VERIFIED (Calendar, both accounts) |
| 18 | Interview prep pack | LIVE VERIFIED retrieval (Altarum); synthesis is done by chat Claude |
| 19 | Post-interview follow-up reminder | ABSENT |
| 20 | Pipeline summary ("where am I with all applications?") | ABSENT |
| 21 | Learn from outcomes | NO LEARNING |


## 25. Generalizing to other workflows

The reusable layers are the J6 operator (any Mac app, approval-gated), the resource planner (Gmail/Calendar/Drive/state), and charts from local spreadsheets. Each new workflow lacks the same three things: (1) a domain state model that is actually wired (areas/follow-ups), (2) triggers (events or schedules per workflow), and (3) DOM-level browser control. Financial-analyst work in Excel is the best-served domain today (M01 charts, document-path context).


## 26. "Virtual Julian" gap matrix (0–5)

| Dimension | Score | Evidence |
|---|---|---|
| Perception of current context | 3 | context and screenshots live; Firefox and page text missing |
| Desktop operation | 3 | J6 0.54 success; AX 0.70; file ops verified |
| Browser operation | 1 | no DOM, no Firefox, screenshot only |
| Information retrieval across accounts | 4 | both Google accounts, grouped search, Altarum PASS |
| Outcome verification | 3 | deterministic for files; model grader otherwise; false completions observed |
| Durable task ownership | 2 | interactions + reconcile; stuck approvals; iMessage path untracked |
| Employee layer (areas, follow-ups, briefs) | 1 | services built, not reachable |
| Proactivity / events | 1 | cron reviews only |
| Management by exception | 0 | none |
| Learning | 0 | NO LEARNING |
| Governance / safety | 4 | approval gates, WebAuthn, budget, release gate |
| Observability | 2 | metrics exist; cost null; post-Oct 5 usage invisible |
| Reliability of runtime | 4 | 4 days of uptime, auto-reconnect |

