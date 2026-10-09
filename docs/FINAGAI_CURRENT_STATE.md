# FINAGAI — CURRENT STATE (implementation-level audit)

> **Superseded** by `docs/FINAGAI_CURRENT_STATE_2026-10-09.md` (audit at live `94087a7`). Kept for history.
Generated 2026-10-04 from the repository at commit **45e80d0** (origin/main). Live Core: `a16c847` (verified `/health` 2026-10-04 ~18:40 EDT; `45e80d0` adds only the WO4 verification fix + control_result delivery mark and is **bundled, not yet pushed**). Mac helper: `runtime-6` installed and running on Julian's Mac (launchd). Companion appendices: `docs/current-state/architecture.md`, `mac-runtime.md`, `database.md`, `tools.md`, `tests.md`, `known-gaps.md`.

Legend: **LIVE** = deployed and observed working · **BUILT** = in repo, not deployed · **PARTIAL** · **DESIGNED** = ADR/schema only · **NONE** · **BROKEN** · **UNVERIFIED**.

## 1. Architecture — see `architecture.md` (flows A–H with live/not-live per flow).

## 2. Repository map
```
.github
.github/workflows
docs/adr
helper
migrations
scripts
src
src/admin
src/agent
src/approval
src/auth
src/backup
src/concierge
src/config
src/cos
src/db
src/google
src/governance
src/guards
src/jobs
src/llm
src/mac
src/notify
src/ops
src/pipelines
src/pipelines/j2
src/pipelines/j3
src/pipelines/j5
src/pipelines/j6
src/pipelines/seed
src/prompts
src/provision
src/provision/providers
src/server
src/tools
test
test/helpers
test/integration
test/unit
```
- `src/server/app.ts` — HTTP router: `/mcp`, `/health`, `/approve*`, `/control/*`, `/mac/*`, `/artifact/*`, `/interaction/*`, `/concierge/*` (prefix dispatch; regression `test/unit/mac-routing.test.ts`).
- `src/tools/server.ts` — the 25 MCP tools (see `tools.md`); `src/tools/queries.ts` read models; `j3Tools.ts` operating review.
- `src/concierge/control-routes.ts` — all helper-facing routes (task lifecycle, heartbeat, status, artifacts, charts). `interactions.ts` (WO2) · `interaction.ts` (artifacts + inbound idempotency) · `routes.ts` (J5).
- `src/mac/` — `runtime.ts` (heartbeat/claim/lease/lifecycle/sweep), `context.ts` (WO3 snapshot + resolver), `router.ts` (WO4/8 capability ladder), `xlsx.ts/analyze.ts/chart.ts/operator.ts` (M01 chart pipeline + evidence).
- `src/pipelines/j6/control.ts` — J6 planner (`planNext`), step model, `KNOWN_KINDS`, result/image; `j6/skills.ts` 10 playbooks (prompt text).
- `src/pipelines/j2` (capture memory), `j3` (reviews), `j5` (iMessage concierge), `seed` (cold-start).
- `src/cos/` — `areas.ts`, `followups.ts`, `brief.ts` (employee layer services; **no tools**).
- `src/jobs/` — `scheduler.ts` (cron entry), `schedule.ts` (slots), `dispatcher.ts` (leases), `handlers.ts`/`j3Handlers.ts`, `maintenance.ts`.
- `src/governance/` (stage/execute), `src/approval/` (OIDC, WebAuthn, session, routes), `src/auth/bearer.ts` (MCP OAuth + helper token), `src/guards/` (budget, extraction, output tiering, sensitive), `src/notify/` (Resend), `src/ops/preflight.ts`, `src/provision/` (Render/Neon/GitHub bootstrap), `src/backup/`.
- `helper/finagai-imessage.mjs` (daemon, ~1,000 lines), `mac-perception.mjs`, `mac-actions.mjs`, `finagai-doctor.mjs`, `setup.sh`, `google-auth.mjs`.
- `migrations/0001–0021`, `test/unit` (31), `test/integration` (17 incl. SQL protections), `docs/adr/0001–0070`, `.github/workflows/migrate.yml`, `render.yaml`.

## 3. Database — see `database.md` (all tables, migrations 0001–0021, lifecycles). **Source of truth:** Postgres rows; the Mac holds only artifacts and the helper config/log.

## 4. Conversational/MCP surface — see `tools.md`. Natural language → tools is **model-only selection** on the chat side; deterministic fast paths exist only for charts (M01) and iMessage self-thread routing; the J6 planner is model-mediated with a deterministic, health-aware **advisory** route hint.

## 5. Mac runtime — see `mac-runtime.md`. Tasks 33/34 root causes: **fixed, verified live** (three stacked causes; the decisive one was pickup gated on new iMessages).

## 6. General computer use (J6) — LIVE, model-mediated
- Perception per step: downscaled screenshot (1600px), visible page text (browser), AX tree (front window, truncated 4k chars), WO3 context line, WO4 route line, last step result.
- Planner: `planNext` (claude-sonnet-5-5; extended thinking per ADR-055) → one `Step {kind, params, risk, summary, done?}`; `KNOWN_KINDS` enforced server-side; unknown kind → `ask`. Loop guard: `MAX_STEPS_PER_TASK=80`, repeated-step detection (ADR-054). Timeouts: helper 45s wait in `make_mac_chart`, 40s re-poll in `control_result`; lease 120s; sweep 10/30 min.
- Execution: `runControlStep` (coordinates, keys, open_*, run, file ops, **WO4 AX actions**). Verification: WO4 actions return verified/unverified against intended outcome; `done` is **planner-asserted** (no task-level acceptance) — PARTIAL.
- Successes observed: Google Calendar week view screenshot (Chrome), TextEdit AX task #77, Gmail draft-to-Lyft (per Messages history, unsent), multiple chart tasks. Never completed: unknown-app task, multi-display, dialogs — **UNVERIFIED**. Failure rate: not measured. Deterministic bypass: M01 charts never enter J6.

## 7. Browser — PARTIAL
Chrome/Safari/Arc: active tab (URL/title) via AppleScript; page text via `browserReadPage` (JS `document.body.innerText` through AppleScript, Chrome/Safari); navigation via `open_url` (Chrome). **No DOM click/fill, no CDP, no extension, no session/login handling, no download/upload.** Interaction in pages = AX tree + coordinates. (Claude-in-Chrome in this chat is *Claude's* tool, not Finagai's.) Verification of browser actions: page-text/AX re-observation only.

## 8. Interaction ownership — LIVE (see `database.md` interaction/control_task)
Message → (`control_mac`/`make_mac_chart`) → `interaction` (request_key dedup ≤30 min, reuse in-flight task) → `control_task` (code, lease, progress) → terminal → `completeForTask` → `final_response_status=pending` → delivered via same-turn re-poll, `finishedWhileYouWereAway` on the next tool call, `pending_results`, `control_result`, **and** automatic iMessage to the self thread. Core restart: durable (W3 test). Worker restart: lease expiry → reclaim (F/G tests; `restartCount` live). Retry of the same request: returns the existing interaction/task (W1 live: `control_mac` reuse). **"check again" is no longer required** (tool text forbids it; live tasks 74/77 completed in-turn). Callbacks/push: none exist (MCP has no server→chat push).

## 9. Artifacts — LIVE, local storage
`artifact` table (kind, storage_ref, conversation, task_id, sent_to); files live on the Mac (`~/.finagai/out/`); images also stored base64 in `control_task.result_image_b64` / `interaction.result_image_b64` (survive Core restart; Mac path survives helper restart). `resolveRecentArtifact(conversation, 24h)`; "send that/last chart" from iMessage self thread → `/artifact/recent` → iMessage attachment (ADR-064.5). From chat: `resolve_reference` resolves to the artifact; delivery needs a J6 task (no `send_artifact` tool) — PARTIAL. Verification: WO9 aspect gate for charts; none for screenshots.

## 10. Employee layer — PARTIAL (services + schema, not conversational)
Tables `area/objective/followup` (0016); services `createArea/listAreas/areaHealth/createFollowup/markWaiting/closeFollowup/sweepOverdue/openFollowups/executiveBrief`; integration test `cos.test.ts`. **No MCP tools, no scheduler hook, no "waiting state" UI.** "Create Career as an Area" / "What am I waiting on?" / "Why is Career yellow?" / "executive brief": **do not work from conversation.** Projects/milestones: J2 `project`/`work_item` tables exist for captured state; not linked to areas.

## 11. Event-driven behavior — mainly prompt/schedule-driven
Sources consumed automatically: iMessage (helper poll, ~15s, idempotent via `inbound_message`), Mac heartbeat context, Render cron (15 min). Gmail/Calendar/Drive: **on-demand read-only search** inside J5 only. No webhooks, no file watchers, no follow-up deadline events (`sweepOverdue` unscheduled). WO5: NONE.

## 12. Memory / learning
A. Factual/state (J2): `capture → knowledge_item/work_item/entity/project` with provenance (capture id + verbatim quote), confidence, review dates, conflicts; retrieval `search_state/get_project/get_item`; dedup via conflicts; retention policies (`RETENTION_*`). LIVE.
B. Episodic: `event` audit + `control_task/control_step/interaction` history. LIVE (not summarized).
C. **Procedural: NONE** (`procedure` table exists, no writer; J6 "skills" are static prompt playbooks).
D. Preferences: `preference` table via approved proposals (`get_charter`). LIVE, governance-gated.
E. Decision history: `governance_request`, `proposal`, `review`. LIVE.
F. Failure/recovery history: `control_task.result_summary`, interaction `failed`, helper log. No classification. NONE as a system.
G. Tool/model performance: `llm_call` (tokens/cost) only; no reliability stats. NONE.
Does Finagai learn from successful work? **No.** Corrections do not change future behavior; faster strategies are not preferred; repeated mistakes are not tracked; procedures are not saved; tool reliability is not learned. Only the health matrix (live probes) influences routing.

## 13. Resource / capability awareness — PARTIAL
Usable now: Core DB, J2 memory, Mac (files/Spotlight/screen/AX/keys/apps), Chrome (open/read), Google read-only search (J5), Resend email, iMessage, Anthropic. Registry: `src/mac/router.ts` (static ladders) + `mac_runtime.capabilities` (live health). No discovery, no permissions/reliability/cost metadata, no pre-execution resource plan. Does it ask Julian for things it could fetch itself? Reduced (health gate forbids "upload the file"; chart failures list columns), but J6 `ask` is still model-judged.

## 14. Routing — hardcoded rules + health; no empirical reliability/latency/cost. Model choice is static per job (config). No specialists. Code: `src/mac/router.ts`, `make_mac_chart` (forced parser), helper self-thread routing.

## 15. Verification — PARTIAL
Chart: series sanity (index/constant/blank rejection), workbook evidence on failure, PNG aspect gate, title fit — LIVE. Mac AX actions: intended-outcome delta — BUILT (45e80d0). File ops / email / browser / DB updates / follow-ups / scheduled jobs: **tool success == task success.** No `false_completion` metric. Observed false completions: #72 (cropped chart, before gate).

## 16. Proactivity — weekly review email (Sun), missed-run check, daily maintenance 03:00, stale-task sweep (every heartbeat), iMessage auto-delivery of results, chart auto-delivery, helper auto-restart (launchd), reconnect. No scheduled brief, no follow-up sweep, no stale-project detection, no alerts, no learning.

## 17. Governance/security — deterministic: OAuth on `/mcp` (WorkOS; client allow-list env), helper bearer token, principal-only `/approve` with OIDC + WebAuthn passkey, staged `governance_request` with TTL, tiered output redaction (`filterByTier`), sensitive-capture guard, budget target/ceiling with deferral, append-only `event`, migration role never on Render, Mac write steps need "ok N" (except navigation class), file ops confined to `$HOME`, `open_url` http(s) only. Prompt-level only: planner instructions (hierarchy, "unverified = not done"), J5 drafting rules. Prompt-injection: Claude-in-Chrome rules apply to Claude; Finagai's J6 has no page-content injection guard beyond the planner prompt — **UNVERIFIED**.

## 18. Observability — Render logs (request lines incl. `/mac/heartbeat`), `event`, `llm_call`, `job_run`, helper JSON log (`~/.finagai/imessage-helper.log`), `mac_status` tool, doctor CLI. No metrics, traces, alerts, dashboards, or failure classification. p50/p95, completion rates, intervention rate: **not measured**.

## 19. Tests — see `tests.md` (31 unit files/304 tests green; 17 integration files on real Postgres; real-Mac via doctor + live tasks).

## 20. Deployment — Render web `finagai-core` (starter, Virginia) + cron `finagai-scheduler`; Neon Postgres; GitHub `vendingvendora-hash/finagai-core` (main; bundles pushed by Julian); migrations via Actions `migrate` (environment approval); preflight blocks start until migrations applied → **auto-deploy race** (manual redeploy needed after each migration); backups `src/backup` (restore drill: UNVERIFIED today); secrets in Render env group via provisioner; health `/health` returns version = git sha; WorkOS OAuth; Resend; Cloudflare: not used by Core (UNVERIFIED).

## 21. Cost/models — defaults `claude-sonnet-5-5` for J2/J3/J5/J6, `claude-opus-5-5` shadow + grader; pricing table `src/llm/pricing.ts`; budget target $30 / ceiling $36 per month (`guards/budget.ts`: reserve-before-call, defer captures over target, hard stop at ceiling). Builder cost: none tracked.

## 22. Known failures/debt — see `known-gaps.md` (ranked).

## 23. Capability matrix
```
Capability                          Status          Evidence
Persistent Core                     PASS            Render live a16c847, uptime 18944s at check
Mac daemon                          PASS            doctor ALL PASS ×2; launchd pid
Mac auto-start                      PASS (partial)  RunAtLoad+KeepAlive; restartCount 3 after kills; login-boot not re-verified today
Mac heartbeat                       PASS            every 15s, Core sees 2–10s age
Mac filesystem                      PASS            Spotlight probe; Altarum found
Screen perception                   PASS            capture probe; J6 screenshots
Accessibility                       PASS            AX tree probe; ax_set_value read-back (#77)
Generic click/type                  PASS            keystrokes/clicks in J6 history
Browser DOM                         FAIL            no DOM actions; read-only text + open_url
Unknown app fallback                NOT VERIFIED    router path exists; never run
Current-context resolution          PASS (partial)  U2 live; U1/U3–U6 unit only
Async task ownership                PASS            interaction table; W1–W4; live 74/77
Automatic result delivery           PASS            finishedWhileYouWereAway live; iMessage auto-send
Artifact persistence                PARTIAL         local files + b64 in DB; no cloud
Areas                               PARTIAL         schema+service; no tool
Objectives                          PARTIAL         schema only + service list
Follow-ups                          PARTIAL         service; no tool/schedule
Executive brief                     PARTIAL         service; no tool/schedule
Event-driven actions                FAIL            iMessage poll + cron only
Resource discovery                  NOT IMPLEMENTED
Resource planning                   NOT IMPLEMENTED
Procedural learning                 NOT IMPLEMENTED  table exists, no writer
Correction learning                 NOT IMPLEMENTED
Tool-performance learning           NOT IMPLEMENTED
Verification                        PARTIAL         charts + AX actions; others tool==done
Management by exception             NOT IMPLEMENTED
Self-healing                        PARTIAL         launchd restart, lease reclaim, sweep
Failure mining                      NOT IMPLEMENTED
```

## 24. Demonstrations run today (real environment, from this Claude surface)
A. Altarum chart: tasks #69 (fail: no data, no evidence) → #70 (fail with evidence → header-row bug found) → #72 (done, cropped) → #73 (**refused** cropped artifact) → #74 (**PASS**: Actual cost by Month #, 12 points, full width, ~45s, 1 re-poll, 0 interventions).
B. "Analyze the spreadsheet I have open": resolver unit-tested (U1); **not run live** (Excel wasn't frontmost).
C. "Send that chart to Santiago": **not run** (would message a real person).
D. "What am I waiting on?": **FAIL — no tool exists.**
E. "Executive brief": **FAIL — no tool exists.**
F. "Look at my screen": `mac_get_context` live → app Claude, Chrome tab Outlook; `resolve_reference("summarize this page")` → Outlook URL, unambiguous (**PASS** for context; "what matters" analysis not attempted).
Extra: TextEdit AX task #77 PASS (6 steps, 0 interventions, recovered from app-switch interference).

## 25. Source appendix — the files themselves are the appendix; the most relevant excerpts are in `mac-runtime.md`. Not present in the codebase: interaction coordinator beyond `make_mac_chart` reuse logic, capability registry beyond `router.ts`, memory promotion, procedural learning, eval harness beyond vitest.

---
# FINAL SECTION — snapshot, no recommendations
1. **Live:** Core `a16c847` on Render; helper `runtime-6` on Julian's Mac; migrations 0001–0021 applied. **Bundled, not pushed:** `45e80d0` (WO4 intended-outcome verification; control_result delivery mark).
2. **Definitely working:** persistent Mac runtime (heartbeat/claim/lease/sweep/restart); task round-trip Claude→Core→Mac→Claude; durable interactions with dedup and automatic result surfacing; M01 charts on financial-model workbooks with evidence-bearing failures and cropped-artifact rejection; WO3 context + resolver; WO4 AX-first verified actions and health-aware route hints; J5 iMessage concierge; J2 capture memory; governance/approvals; weekly review.
3. **Definitely broken / absent:** employee layer from conversation (no tools, no schedule); any event-driven behavior beyond iMessage polling; all learning (procedural, correction, tool-reliability); browser DOM actions; task-level verification outside charts/AX; metrics.
4. **Only on paper:** `procedure`/`preference` learning tables; WO5–WO7, WO9 (full), WO10–WO14; unknown-app fallback (routed, unexercised); multi-display.
5. **Top unresolved risks:** migrate-before-deploy race; J6 `done` is planner-asserted; write-step approvals only via iMessage; helper-side failures invisible to Core; no false-completion metric; single Mac/worker with no second runtime.
6. **Inspect first:** `helper/finagai-imessage.mjs` (tick/pickup/driveControl/runMacChart), `src/mac/runtime.ts`, `src/concierge/control-routes.ts`, `src/concierge/interactions.ts`, `src/tools/server.ts` (make_mac_chart/control_mac/control_result/helpers.ok), `src/pipelines/j6/control.ts` (planNext/KNOWN_KINDS), `src/mac/{analyze,operator,router,context}.ts`, `helper/mac-actions.mjs`, `src/cos/*` (unexposed), `migrations/0018–0021`, `test/unit/helper-pickup.test.ts`, `test/integration/{mac-runtime,interactions}.test.ts`.
