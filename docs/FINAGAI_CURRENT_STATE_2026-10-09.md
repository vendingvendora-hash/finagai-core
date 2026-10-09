# Finagai — Current State Audit (2026-10-09)

Audit only. No new features were built. Every claim carries one evidence label:

| Label | Meaning |
|---|---|
| **LIVE VERIFIED** | Exercised against production (Render + Neon + Julian's Mac) with observed output, today or in a recorded live run |
| **LIVE UNVERIFIED** | Deployed, but no live run observed that proves it works |
| **BUILT** | Code + tests exist; not wired into a live path, or never exercised live |
| **PARTIAL** | Works for a subset of the stated scope; the gap is named |
| **DESIGNED** | ADR/doc only |
| **ABSENT** | Nothing exists |
| **BROKEN** | Exists and produces a wrong result, with evidence |

Today's live tests were read-only. Julian was mid-way through a LinkedIn Easy Apply form during the audit (seen in task #118's screenshot), so no test operated the browser or the screen.

---

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

## 3. Repository map (exact paths)

- `src/tools/server.ts` (570 lines): MCP server and 25 tools. `src/tools/j3Tools.ts`: 3 J3 tools. `src/tools/queries.ts`: read queries.
- `src/pipelines/j6/control.ts` (501): J6 planner, parseStep, risk classification, loop guard, retrieve-before-ask. `src/pipelines/j6/skills.ts`: static skill playbooks.
- `src/mac/acceptance.ts` (161): acceptance contracts and verification (deterministic file ops + model grader). `src/mac/runtime.ts`: heartbeat, lifecycle, reconcile hook.
- `src/resources/{registry,planner,retrieve,trace}.ts`: capability registry (23 caps), planner, retrieval, traces.
- `src/concierge/{interaction,interactions,actions,routes,control-routes}.ts`: interaction lifecycle, reconcile, outbound actions, helper endpoints.
- `src/cos/{areas,followups,brief}.ts`: employee layer. **Imported by nothing in `src/`; only by `test/integration/cos.test.ts`.**
- `src/pipelines/{j2,j3,j5,seed}`: capture, weekly review, concierge, seeding. `src/governance/execute.ts`: approved-proposal execution.
- `src/jobs/{scheduler,dispatcher,schedule,handlers,j3Handlers,maintenance}.ts`: cron entry point and 3 job slots.
- `helper/{finagai-imessage,mac-perception,mac-actions,fs-ops,finagai-doctor,google-auth}.mjs`: Mac runtime (1,056 + 166 + 190 + 83 + 137 + 63 lines).
- `migrations/0001…0023` + `CHECKSUMS.json` (frozen-migration test). `.github/workflows/release.yml`: release gate.
- `docs/adr/` (through ADR-075), `docs/current-state/*.md` (17 files, rewritten by this audit).

## 4. MCP tools (28 registered)

See `docs/current-state/tools.md` for schemas and failure modes. Summary:

| Tool | R/W | Engine | Approval | Status |
|---|---|---|---|---|
| plan_resources | R | deterministic + Google API | none | LIVE VERIFIED |
| list_capabilities | R | deterministic + probes | none | LIVE VERIFIED (BROKEN: 2 Mac health fields, §5) |
| execution_metrics | R (runs reconcile) | SQL | none | LIVE VERIFIED (data gaps §18) |
| control_mac | W | J6 LLM planner | per write step over iMessage | LIVE VERIFIED |
| control_result | R | SQL | none | LIVE VERIFIED |
| pending_results | R + marks delivered | SQL | none | LIVE VERIFIED earlier |
| make_mac_chart | R on Mac | deterministic parse + model | none | LIVE VERIFIED, DEGRADED 5/12 |
| mac_status / mac_get_context | R | heartbeat snapshot | none | LIVE VERIFIED |
| resolve_reference | R | deterministic | none | PARTIAL (Firefox wrong, §8) |
| get_state_overview, search_state, get_item, get_project, get_charter, get_latest_review, list_open_conflicts, list_pending_proposals, get_approval_request | R | SQL | none | LIVE VERIFIED (overview today); the rest LIVE UNVERIFIED recently |
| capture | W (DB) | J2 LLM extraction | proposals for preference/procedure changes | BUILT, LIVE UNVERIFIED recently |
| request_proposal_decision, request_conflict_resolution, request_archival, request_seed_promotion | W | deterministic | creates an approval request (WebAuthn page) | BUILT |
| seed_questions, seed_answer, seed_add_source | W (DB) | seed pipeline | — | BUILT |
| operating_review | R | J3 | — | LIVE UNVERIFIED |

**How natural language is mapped to a tool:** there is no router. The claude.ai model picks a tool from the tool descriptions (for example, `plan_resources` says "Call FIRST…"). The only code-level routing is in `src/mac` (chart vs. control) and in J6's regex skill triggers. Tool choice is therefore prompt-only (§20).

## 5. Mac capability audit

| Capability | Status | Evidence |
|---|---|---|
| Runtime liveness (LaunchAgent, KeepAlive, 15 s heartbeat) | LIVE VERIFIED | heartbeat 5 s old; restart PASS (1 s), soak 20/20, reconnect +1 (Phase 1) |
| Screen capture | LIVE VERIFIED | #117/#118 screenshots |
| Active app/window | LIVE VERIFIED, but the window title is often null | context `window:null` for Firefox |
| Selected Finder files | LIVE VERIFIED | `sixsigma_cert.png` |
| Open document path | PARTIAL (Excel/Numbers/Preview/Pages/TextEdit/Keynote/Word/PowerPoint only) | `frontDocumentPath` |
| Accessibility actions (activate_app, menu_item, ax_click, ax_set_value) | LIVE VERIFIED, 21/30 verified steps (0.70) | registry |
| Coordinate click/type/key/hotkey/drag/scroll | BUILT / LIVE VERIFIED in earlier native-app tasks; outcome verification is weaker | metrics: 2 false completions (native-app) on Oct 5 |
| File ops (move_file, trash_file) with deterministic verification | LIVE VERIFIED (#116, sha256) | |
| Shell `run` | LIVE VERIFIED; read-only commands are auto-classified as read | `isReadOnlyCommand` |
| **Registry health for mac.filesystem / mac.screen** | **BROKEN** | the helper sends keys `files` and `screen`; `registry.ts:97` reads `filesystem` and `screenCapture`, so both always show "unknown" |
| Clipboard | BUILT (probe only; deliberately excluded from context) | |

## 6. J6 deep-dive

- Loop: plan → parseStep (balanced JSON + `<invoke>` XML) → risk = the stricter of the model's declaration and the code classification → approval if write → act → observe → verify. **LIVE VERIFIED**.
- **Can the planner declare done by itself?** No. `done` triggers `verifyCompletion` against the acceptance contract. File ops are verified deterministically; anything else goes to a model grader. If the grader is unavailable, the task still completes, labelled "NOT independently verified" (a deliberate trade-off, PARTIAL).
- Recovery: `recoveryDecision` has a bounded budget. The loop guard exempts re-observes after a rejection. A step limit asks Julian to continue.
- Results (registry, all time): **29/54 succeeded (0.537)**, p50 22.8 s. Oct 5 metrics: files class 1 completed / 1 failed / 2 false completions; native-app 3/1/2.
- Today: #118 (read-only) **behaved correctly**. It could not read the page text, reported the conflict between the context (Chrome) and the screen (Firefox, LinkedIn), and stopped instead of guessing.
- **Defect: approval waits never expire.** Tasks #104 and #113 have sat in `waiting_approval` since Oct 5 (4+ days), and their interactions still say "executing" (§9).

## 7. Browser: READ vs OPERATE

- **READ, active tab URL/title**: PARTIAL. Chrome and Safari only, through AppleScript. **Firefox is unsupported**, and Julian is using Firefox right now.
- **READ, page text**: **BROKEN as a browser read.** `read_text` returns the value of the first AXTextArea of the front window, not the DOM text. #118 got "(no readable text)" from LinkedIn in Firefox. Today the only real page read is a screenshot plus vision.
- **OPERATE**: PARTIAL. `open_url` plus coordinate click/type. There is no DOM-level action (no selectors, form fill or tab management). The `fill-a-form` skill relies on screen coordinates. Not exercised today (Julian was mid-application). **LIVE UNVERIFIED** for multi-step web flows.
- Gmail/Calendar/Drive are read through APIs (Core side), not the browser. **LIVE VERIFIED**.

## 8. Deictic references

- `resolve_reference("this page")` today → **resolved, wrongly, with "high" confidence**: it returned the Chrome tab `julianperezconsulting.webflow.io/job-finder` while the frontmost app was **Firefox** on a LinkedIn job page. Cause: `browserActiveTab` returns the first *running* supported browser, without checking which one is frontmost. **BROKEN** whenever Firefox is in front and Chrome is open in the background.
- "This file" with Finder files selected: LIVE VERIFIED (selected file returned). "The spreadsheet I have open": LIVE VERIFIED for Excel (WO3, Oct 4).

## 9. Durable interactions and task ownership

- An `interaction` row is created for chat-initiated tasks, with delivery tracking (`final_response_status`) and `pending_results`. **LIVE VERIFIED**.
- Reconciler (`reconcileInteractions`) runs on heartbeat and on `execution_metrics`. It closes interactions whose tasks are terminal and abandons ones with no task after 6 h. **LIVE VERIFIED partially.** It does **not** handle tasks stuck in `waiting_approval`, so #104/#113 are still "executing" after 4 days. Interaction state ≠ task state = **BROKEN** for that case.
- iMessage-started tasks (#117) create **no interaction row**, so they are invisible to metrics. **PARTIAL**.
- Ownership: there is no per-task owner, no SLA and no escalation. **ABSENT**.

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

## 11. Resource registry

23 capabilities (`src/resources/registry.ts` CATALOG), refreshed at startup, every 60 s on heartbeat and on `list_capabilities`. Reliability is null below 5 samples. **LIVE VERIFIED**: Google gmail/calendar/drive healthy for **both** accounts (vending.vendora@gmail.com, perez.julian@correounivalle.edu.co); j6_planner 0.537; m01_chart DEGRADED 0.4167; mac.accessibility 0.70; resend 1/1. **BROKEN**: mac.filesystem / mac.screen show "unknown" (key mismatch, §5). mac.browser access = "read" only.

## 12. Resource planning / retrieve-before-ask (real traces, today)

- **"Prepare me for Altarum"**: **LIVE VERIFIED, good.** Calendar (both accounts): phone screen 9/14, Ray Sasselli 9/21, panel 9/28 (Frank McKenna, Carley Kirk). Gmail: the Beth Young threads, the cancellation/reschedule, the Otter "Meeting Summary" mail. Drive: Career Copilot job history (fit score 88) and knowledge_base.json. Correctly says "no upcoming event is scheduled". askJulian = null.
  Gaps: the Otter item is the email body (tracking links), not the meeting summary content. There is no inferred status ("awaiting a decision after the 9/28 panel; 11 days without a reply"). The Mac file search is "delegated" and was not run.
- **"What am I waiting on?"**: **BROKEN.** It keyword-searched Gmail for "waiting" and returned spam (Robinhood, Quince, Shopify), a 2025 vendor email and a crime-alert newsletter. `state.areas` and `state.projects` are empty. There is no follow-up model behind it.
- **"Why is Career yellow?"**: **ABSENT.** No area exists; the planner selected zero sources.
- Retrieve-before-ask guard in J6 (one bounce per task): BUILT, LIVE VERIFIED in Phase 2 R-tests.

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

## 15. Employee layer

- Code: `src/cos/areas.ts` (61 lines), `followups.ts` (79), `brief.ts` (64), migration 0016; 3 integration tests pass.
- **Wiring: none.** These modules are imported by no route, tool or job. No MCP tool creates an area, lists follow-ups or produces a brief, and no scheduler slot runs them.
- Live data: `state.areas` empty.
- Conversational tests:
  - "Create Career as an Area": **ABSENT** (no tool; Claude could only `capture`, which goes to J2 extraction, not to `area`).
  - "What am I waiting on?": **BROKEN** (§12).
  - "Why is Career yellow?": **ABSENT**.
  - "Give me my executive brief": **ABSENT** (`brief.ts` is unreachable). `operating_review` (J3 weekly) is the nearest thing.
- Status: **BUILT, not wired.**

## 16. Events / proactivity

- The `event` table is **an audit log only** (`appendEvent`). There is no LISTEN/NOTIFY, no subscriber and no event-to-action rules.
- Proactive behaviour that exists: J3 weekly review + missed-run check + daily maintenance (time-based cron), and J5 concierge reacting to incoming iMessages. Nothing watches Gmail, Calendar, job boards or deadlines.
- **Event-driven proactivity: ABSENT.**

## 17. Management by exception

**ABSENT** as a system. There is no thresholding over areas or follow-ups and no "only tell me when X goes wrong" rule. The pieces that exist: Render deploy-failure emails (external), the budget ceiling (`budget_blocked`), and stalled-task detection in `mac_status`. Nobody is alerted about #104/#113 sitting for 4 days.

## 18. Observability (real values)

- Spend month-to-date: **$7.00** of a $30 target ($36 ceiling).
- J6 success 29/54 (0.537), p50 22.8 s. M01 5/12. AX steps 21/30.
- `interaction_metrics_daily`: **no rows after 2026-10-05.** Real use since then (#117 over iMessage) does not create interactions.
- `cost_usd` is **null in every interaction row.** The code (ADR-075) attributes `llm_call.request_id = task id`, but no chat-initiated J6 task has completed since that deploy. Status: **LIVE UNVERIFIED** (not proven broken, not proven working).
- p50 acknowledgement = 0 s by construction (the row is created synchronously), so it is not informative.
- Helper: 24 reconnects; last outage 2026-10-09 10:35 UTC, 656 s.

## 19. Failure mining

Recorded failure classes: `model_parse` (#115, fixed in bfad3be), verifier false negatives (#113, fixed in ac984e7), stuck approvals (#104/#113, open), Oct 4 "unknown" class 5/9 failed (pre-telemetry), #107 failed after 13,391 s, #80 failed after 17,015 s. **No automated failure mining.** It is manual: I read the metrics and the ADRs.

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

## 21. Deployment / recovery

- Migrate-before-deploy race: **eliminated, LIVE VERIFIED** (release #6 ran migrate 0023, gated, then deploy, then the SHA check). Render auto-deploy is off. Migrations are frozen by checksum test.
- Live SHA matches origin/main (`94087a7`).
- Backup/restore drill: integration test passes (restore into a fresh DB with matching checksums). A live restore has not been run (LIVE UNVERIFIED).
- Helper recovery: KeepAlive restart LIVE VERIFIED. The independent heartbeat survives long tasks.

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

## 27. 2-day delta (Oct 7–9)

No code, migration or helper change. The only state change is usage: #117 done, #118 (audit) done, a helper outage of 656 s on Oct 9 that auto-recovered. The Oct 5 changes are covered in the changelog in §1.

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

## 29. Source-code appendix (key excerpts)

`helper/finagai-imessage.mjs` (capability keys sent):
```js
if (n.includes("screen")) m.screen = c.ok;
...
else if (n.includes("filesystem") || n.includes("spotlight")) m.files = c.ok;
```
`src/resources/registry.ts:97` (keys read):
```ts
const macMap = { "mac.filesystem": "filesystem", "mac.screen": "screenCapture", ... }
```
`helper/mac-perception.mjs:77` (first running browser wins, frontmost not checked, no Firefox):
```js
for (const [appName, script] of [["Google Chrome", ...], ["Safari", ...]]) {
  const running = await osa(run, [`... (name of processes) contains "${appName}"`]);
  if (running !== "true") continue; ...
```
`helper/finagai-imessage.mjs:585` (the "page text" read):
```js
case "read_text": ... 'get value of (first text area of front window of (first process whose frontmost is true))' ... || "(no readable text)";
```
`src/concierge/interactions.ts:119` (reconcile ignores waiting_approval tasks):
```ts
AND NOT EXISTS (SELECT 1 FROM control_task x WHERE x.id = ANY(i.task_ids) AND x.status NOT IN ('done','failed','cancelled'))
```
`src/pipelines/j6/control.ts:198` (risk can only be raised):
```ts
const risk = classifyRisk(kind) === "write" || raw.risk === "write" ? "write" : "read";
```
`src/jobs/schedule.ts:54` (the only scheduled jobs):
```ts
{ job: "weekly_review" }, { job: "missed_run_check" }, { job: "daily_maintenance" }
```

## 30. Report files

This file plus `docs/current-state/{architecture, repository, tools, database, mac-runtime, browser, interaction-runtime, verification, resources, memory-learning, employee-layer, events-proactivity, observability, security-governance, tests, job-search-readiness, known-gaps}.md`.

## Evidence that contradicts earlier capability claims

1. "Browser read" (registry `mac.browser` access=read): page text cannot actually be read (#118). Only URL/title for Chrome/Safari.
2. "Deterministic deictic resolution": wrong referent with high confidence when Firefox is frontmost (today).
3. "Mac boolean probes fixed" (ADR-075): accessibility is fixed, but filesystem/screen still show "unknown" because of key names.
4. "Interactions reconciled" (ADR-075): #104/#113 still "executing" after 4 days (tasks in `waiting_approval`).
5. "Cost attribution" (ADR-075): every `cost_usd` is still null. Unproven rather than disproven.
6. "Employee layer (ADR-060)": shipped as code, but unreachable from any tool or job.
7. "execution_metrics shows how Finagai performs": usage after Oct 5 is missing (the iMessage path is untracked).
