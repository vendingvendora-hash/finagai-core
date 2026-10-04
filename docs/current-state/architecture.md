# Architecture (as built, Core 45e80d0)

```
Claude (claude.ai chat / this Project)           Julian's iMessage (self thread + allow-listed contacts)
   │  MCP over HTTPS (OAuth/WorkOS bearer)              │ Messages.app SQLite (read) / osascript send
   ▼                                                    ▼
Finagai Core — Render web service "finagai-core" (Node 22, src/server/app.ts)   ◄── Mac helper (launchd, polls every 15s,
   ├─ /mcp  src/tools/server.ts (25 tools)                                        bearer token) helper/finagai-imessage.mjs
   ├─ /control/* /mac/* /artifact/* /interaction/* src/concierge/control-routes.ts
   ├─ /concierge/* (J5 iMessage concierge)  src/concierge/routes.ts
   ├─ /approve (OIDC + WebAuthn principal approvals)  src/approval/*
   └─ /health
Neon Postgres (schema finagai; roles finagai_app / migrator; migrations via GitHub Actions)
Render cron "finagai-scheduler" every 15 min → src/jobs/scheduler.ts (weekly_review, missed_run_check, daily_maintenance)
Anthropic API (sonnet-5-5 default; opus-5-5 shadow/grader) · Resend (email) · Google (read-only Drive/Gmail/Calendar search, J5) · WorkOS (OAuth)
Artifact storage: Julian's Mac filesystem (~/.finagai/out/<task>/...) + base64 copies in control_task/interaction rows (images).
```

## Request flows (as implemented)
**A. Conversational question** — Claude answers; if it calls any Finagai tool, `helpers.ok` appends `finishedWhileYouWereAway` for completed-undelivered interactions (WO2). No Finagai-side routing.

**B. Mac task** — Claude → `control_mac(request)` → health gate (`macOnline`? else immediate `waiting_for_mac` + remedy, no task) → `openInteraction` (dedup ≤30 min) → `INSERT control_task` → `linkTask` → route computed (`src/mac/router.ts`) → returns taskCode. Helper tick: `/control/pending` → `/control/claim` (lease) → `driveControl`: loop { screenshot+pageText+axTree+context → `/control/next` → `planNext` (Sonnet) returns step; read steps auto-run; write steps auto-run if navigation-class else `await_approval` via iMessage "ok N" } → step executed (`runControlStep`) → `/control/ran` → … → `done` → `completeForTask` (interaction pending delivery) + result image. Claude: `control_result(code)` (40s re-poll inside) → result + image; marks interaction delivered.

**C. Chart** — `make_mac_chart(filename)` → health gate → interaction (reuse) → coordinator (reuse in-flight/recent task ≤30 min) → `control_task request='mac_chart:<file>'` → helper: Spotlight → read xlsx bytes → POST `/mac/chart` → Core `analyzeWorkbookToChart` (`src/mac/{xlsx,analyze,chart,operator}.ts`: header-row inference, series detection, index/constant rejection, SVG) → helper rasterizes (Chrome → NSImage → QuickLook), **WO9 aspect verification** → `/mac/chart-done` (lease holder only) → `recordSuccess`, interaction completed → auto iMessage to self thread + chat delivery.

**D. Follow-up creation** — `src/cos/followups.ts createFollowup` exists; **no tool, no conversational path.** NOT reachable.

**E. Executive brief** — `src/cos/brief.ts executiveBrief` exists (areas + open/overdue follow-ups + stale); **no tool, no schedule.** NOT reachable.

**F. Scheduled task** — Render cron → `scheduler.ts` → `dueJobs` (weekly review Sun, missed-run check, daily maintenance 03:00) → `job_run` lease → handler (`j3Handlers`: collect → compose review (Sonnet) → shadow (Opus) → deliver by Resend email). Live and has run historically (reviews table).

**G. Event-driven** — Only: (1) iMessage polling (helper scans Messages DB every tick; new self/contact messages trigger J5/J6/M01); (2) Mac heartbeat context; (3) scheduler. **No email/calendar/file-change events.** NOT event-driven in the WO5 sense.

**H. Artifact forwarding** — helper self-thread "send it to Santiago" → `/artifact/recent` (conversation self, 24h) → `markArtifactSent` → iMessage attachment to contact. Chat path: `resolve_reference("the last chart")` resolves to the artifact; actual sending from chat goes through `control_mac`/J6 (no dedicated `send_artifact` tool).

## Workers / queues
- Mac helper = the only worker for `control_task`. Queue = `control_task` rows; `pending` orders mac_ping < mac_chart < J6, newest first, excludes live-leased.
- `job_run` = scheduler queue with leases (0006).
- Capture deferral queue for J2 under budget pressure (0007).
