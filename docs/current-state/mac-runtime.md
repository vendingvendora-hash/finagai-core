# Mac runtime — deep dive (helper `runtime-6`, Core 45e80d0)

## What runs on the Mac
- **Process:** `node ~/.finagai/finagai-imessage.mjs` (ESM, Node 26). Modules: `mac-perception.mjs` (perception + `macDoctor`), `mac-actions.mjs` (WO4 AX actions), `finagai-doctor.mjs` (diagnostics CLI). Installed by `helper/setup.sh`.
- **LaunchAgent:** `~/Library/LaunchAgents/com.finagai.imessage.plist` — `RunAtLoad`, `KeepAlive`, `ThrottleInterval=10`. Starts at login, restarts after crash (observed: `restartCount 3` after three `kickstart -k` today; doctor `--probe-restart` scripted, **not yet run**).
- **Auth:** bearer token in `~/.finagai/imessage-helper.json` (`CONCIERGE_HELPER_TOKEN`); every Core call `POST` JSON with `Authorization: Bearer`. Core routes `/mac/*`, `/control/*`, `/artifact/*`, `/interaction/*`, `/concierge/*` through the helper-token auth (`src/server/app.ts` → `controlRoutes`).
- **Transport:** **polling, no push.** `setInterval(loop, 15s)`; no persistent socket. Reconnect = next tick succeeds; the helper counts a `coreDown→up` transition as a reconnect and reports it (`reconnects` in heartbeat; observed `reconnectCount 1`).

## Tick order (helper, `tick()` ~line 725) — the fix for tasks 33/34
```
1. heartbeat(cfg)        → POST /mac/heartbeat (version, capability matrix, frontmost, context, reconnects, startedAt)
2. pickupTasks(cfg)      → POST /control/pending → for each (cheap-first, ≤1 J6 drive/tick): /control/claim → execute → /mac/chart-done or /control/next loop
3. iMessage backfill / new-message scan (Messages.app SQLite) → self-thread commands, contact concierge (/concierge/sync)
```
**Why tasks 33/34 sat "active" forever (three stacked causes, all fixed):**
1. No worker liveness at all: a row was `active` on insert; Core polled a row, not a worker (fixed: ADR-066 heartbeat/claim/lease/derived lifecycle).
2. `/control/pending` returned the 5 **oldest** active rows; zombies (#9/#32/#33/#34) occupied the window forever and no sweep existed (fixed: `sweepStaleTasks` + cheap-first newest-first ordering).
3. **The real one:** `tick()` returned early when no new iMessage had arrived, and the pickup block lived *after* that return — the Mac was an iMessage-triggered worker, not a task worker (found in Render's request log: heartbeats, zero `/control/pending`). Fixed by `pickupTasks` running unconditionally right after heartbeat; regression `test/unit/helper-pickup.test.ts` fails 4/4 on the old helper.
**Status: FIXED and verified live** (doctor round-trip tasks 39, 68 ≈11s; live tasks 69–77 from the Claude surface).

## Task state machine (Core, `src/mac/runtime.ts`)
Stored `status`: `active | done | failed | cancelled`. Derived `lifecycle` (`deriveLifecycle`): `queued` (active, unclaimed, Mac online) · `waiting_for_mac` (active, unclaimed, Mac offline) · `executing` (claimed, lease live, progress fresh) · `stalled` (claimed, lease expired or progress stale) · `terminal`. Lease 120s (`claimTask`: live lease cannot be stolen; expired → reclaim). **Only the lease holder may complete** (`workerMayComplete`; `/mac/chart-done` and `/control/next` return 409 otherwise). Progress via `/control/progress` (helper reports per stage). `awaiting_human` exists at the **interaction** level and as J6 `await_approval`, not as a control_task status.

## Capabilities (probed, not assumed — `macDoctor` in mac-perception.mjs; cached 10 min; sent in every heartbeat)
accessibility (System Events window enumeration) · activeWindow · screenCapture (`screencapture -x`) · filesystem (`mdfind`) · browser (active tab via AppleScript, Chrome/Safari/Arc/Firefox-limited) · AX tree (`entire contents` of front window) · clipboard. Observed on Julian's Mac 2026-10-04: **all PASS**; keyboard/mouse (System Events keystrokes) PASS for the daemon.

## Perception / control primitives actually used
- Screenshot: `screencapture` → downscale 1600px via `sips` (J6 each step).
- Context (WO3): frontmost app/window (`getFrontmost`), open document path via app scripting (Excel/Numbers/Preview/Pages/Word/PowerPoint), selected Finder items, active browser tab → `/mac/heartbeat.context` → `mac_runtime.context`.
- Actions (`runControlStep`): `click x,y` (cliclick-style via JXA/CGEvent), `double_click`, `right_click`, `drag`, `scroll`, `type`, `key`, `hotkey`, `open_app`, `open_url` (Chrome), `open_path`, `run`, `move_file`, `trash_file`; **WO4:** `activate_app`, `menu_item`, `ax_click` (by title/role), `ax_set_value` (read-back), `observe`.
- Multiple displays: `captureScreen` captures the main display only — **NOT VERIFIED on multi-display.**
- Unknown-app fallback: router sends unknown apps to AX → perception → mouse; **not yet exercised live** (Calculator test proposed).

## Representative code — pickup + claim (helper)
```js
async function pickupTasks(cfg) {
// J6: pick up any control tasks Julian started from a Claude chat, and drive them.
const pending = await core(cfg, "/control/pending", {}).catch(() => null);
// Cheap deterministic work first (ping, chart); at most ONE open-ended J6 drive per tick so a long
// task never starves the round-trip/heartbeat path.
const tasks = (pending?.tasks ?? []).slice().sort((a, b) => rank(a.request) - rank(b.request));
let drives = 0;
for (const t of tasks) {
  if (rank(t.request) === 2 && drives++ >= 1) break;
  taskCodeCache[t.id] = t.code;
  if (!(await claim(cfg, t.id))) { log("task already claimed elsewhere", { code: t.code }); continue; }
  RUNTIME.currentTaskId = t.id;
  try {
    if (typeof t.request === "string" && t.request.startsWith("mac_ping")) {
      await core(cfg, "/mac/chart-done", { taskId: t.id, workerId: WORKER_ID, done: true, summary: `pong from ${HELPER_VERSION} at ${new Date().toISOString()}` });
    } else if (typeof t.request === "string" && t.request.startsWith("mac_chart:")) {
      const spec = t.request.slice("mac_chart:".length);
      const [filename] = spec.split("::");
      await progress(cfg, t.id, "searching Mac for workbook");
      const r = await runMacChart(cfg, filename, t.id, (note) => progress(cfg, t.id, note));
      if (r && r.ok === false) {
        // Terminal failure with a concrete reason — never leave the task 'active'.
        await core(cfg, "/mac/chart-done", { taskId: t.id, workerId: WORKER_ID, failed: true, summary: r.message }).catch(() => {});
        await sendIMessage(cfg.selfHandles[0], `⚠️ ${r.message}`);
      }
    } else {
      await progress(cfg, t.id, "planning first step");
      await driveControl(cfg, t.id, (note) => progress(cfg, t.id, note));
```
## Representative code — claim/lease (Core, src/mac/runtime.ts)
See `claimTask`, `taskProgress`, `deriveLifecycle`, `workerMayComplete`, `sweepStaleTasks` (full file ~190 lines).

## Live observations (2026-10-04)
- Doctor: ALL PASS twice (pid 87104 / 93945), round-trip 11.1s. `mac_status` from Claude: connected, runtime-3→6, restarts 3, reconnects 1, lastSuccess task 68/74.
- Task #77 (WO4 TextEdit): activate → File>New → observe (Firefox had focus) → re-activate → ax_set_value read-back → observe; text confirmed; 0 coordinate clicks; one false "verified" on the menu step (fixed in 45e80d0: verification requires target app frontmost).
