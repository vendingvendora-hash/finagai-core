# Architecture — current state (audit 2026-10-09)

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


## 1. Canonical version state

| Component | Value | Evidence |
|---|---|---|
| LOCAL HEAD (audit clone) | `94087a7` | `git log` |
| ORIGIN/MAIN | `94087a7` (2026-10-05 18:17 −04:00) "ADR-075 acceptance…" | `git log origin/main` |
| Bundle / unpushed | none. Julian pushed everything; the audit report commit is the only new commit (delivered as a bundle) | — |
| LIVE RENDER (web + MCP) | `94087a720bdd`, uptime 321,966 s (≈3.7 days, so started around 2026-10-05 22:20 UTC) | `GET /health` → `{"status":"ok","version":"94087a720bdd"}` |
| MCP SERVER | Same process as the web service (`src/tools/server.ts` mounted in Core), so it is `94087a7` too | code |
| SCHEDULER | Render cron `finagai-scheduler` (every 15 min, `src/jobs/scheduler.ts`) builds from the same repo. The audit could not see its deployed SHA: the GitHub/Render APIs are blocked from this session | LIVE UNVERIFIED |
| MAC HELPER | `runtime-12`, LaunchAgent `com.finagai.imessage`, running since 2026-10-05T03:30:34Z (no restart since then), heartbeat age 5 s, 24 reconnects in total, 11 restarts in total | `mac_status` |
| LATEST MIGRATION | `0023_capability_registry.sql`, applied through the gated release (#6) | repo + registry live |
| Tests | 375 unit passed / 9 skipped (39 files); 186 integration passed (20 files) | run today |

**2-day changelog (Oct 7–9): no code changes.** The last commits were on Oct 5:
`5e9b120 → 7fda4b8 → a51b2fb → 60e7a8f → ac984e7 → bfad3be → 185f11f → 3ae5a2e → dd3995d → 845101a → a918e0f → 94087a7`.
The only operational change was the `GOOGLE_REFRESH_TOKENS_EXTRA` env var (university Google account) on Oct 5. Activity since then is real usage: task #117 (Oct 9, the birthday message over iMessage) plus this audit's tests.


## 2. As-built architecture

```
claude.ai chat ──MCP (OAuth, WorkOS AuthKit)──▶ Finagai Core (Render web, Node/TS)
                                                 │  src/tools/server.ts (28 MCP tools)
iMessage (Julian) ◀──▶ Mac helper (runtime-12) ◀─┤  /mac/heartbeat · /concierge/sync · /mac/diag (HTTPS, poll)
   ~/.finagai/finagai-imessage.mjs                │  J6 planner (src/pipelines/j6/control.ts) ── Anthropic API
   mac-perception / mac-actions / fs-ops          │  Resource layer (src/resources/*) ── Google APIs (2 accounts)
                                                  │  Neon Postgres (migrations 0001–0023)
Render cron finagai-scheduler (15 min) ───────────┘  weekly_review · missed_run_check · daily_maintenance
GitHub Actions release.yml: detect → [migrate, gated by Julian] → deploy hook → /health SHA check
```

Sequence flows:
- **A. Chat request → Mac action**: Claude calls `control_mac`, which creates `control_task` + `interaction`. The helper polls and picks the task up. Each J6 step: plan (LLM) → classify risk → if write, `waiting_approval` and Julian approves over iMessage → act → observe → verify (acceptance contract) → `done`. Results come back through `control_result` / `pending_results`. **LIVE VERIFIED** (tasks 105, 112, 114, 116, 118).
- **B. iMessage request → J6**: the same flow, started from Messages. **LIVE VERIFIED** (#117 today). No `interaction` row is created on this path (see §18).
- **C. Resource planning**: `plan_resources` → knownEntities → slots → source selection (authority order, bound 6) → Core-side retrieval (Gmail/Calendar/Drive/state) → trace. **LIVE VERIFIED** (§12).
- **D. Deictic resolution**: `resolve_reference` uses the heartbeat context snapshot. **PARTIAL / BROKEN for Firefox** (§8).
- **E. Chart**: `make_mac_chart` (M01, deterministic parse plus a model step). **LIVE VERIFIED** historically, but the registry rates it DEGRADED (5/12).
- **F. Capture → proposals → governance**: J2 capture → proposals → `request_proposal_decision` → `governance/execute.ts`. **BUILT / LIVE UNVERIFIED** recently; the state is nearly empty (§13).
- **G. Weekly review (J3)**: scheduler slot → `operating_review`. **LIVE UNVERIFIED** (no review observed in this audit).
- **H. Concierge (J5)**: drafts replies for whitelisted contacts. **BUILT**; it ran live in early October.
- **I. Event-driven trigger → proactive action**: **ABSENT**.
- **J. Follow-up / area health loop**: **BUILT, not wired** (§15).
- **K. Learning loop (outcome → procedure update)**: **ABSENT** (§14).


## 21. Deployment / recovery

- Migrate-before-deploy race: **eliminated, LIVE VERIFIED** (release #6 ran migrate 0023, gated, then deploy, then the SHA check). Render auto-deploy is off. Migrations are frozen by checksum test.
- Live SHA matches origin/main (`94087a7`).
- Backup/restore drill: integration test passes (restore into a fresh DB with matching checksums). A live restore has not been run (LIVE UNVERIFIED).
- Helper recovery: KeepAlive restart LIVE VERIFIED. The independent heartbeat survives long tasks.

