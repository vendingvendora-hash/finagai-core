# ADR-066 — Mac runtime as a first-class persistent worker

**Decided by:** Julian (product mandate: "Finagai must be able to use my Mac")

## Failure that forced this
Tasks 33/34 sat `active` while Claude polled ~15 times and nothing executed. Root cause: `control_task` had
no worker liveness — a row was "active" the moment it existed. Core could not tell *executing* from *no Mac
process is running*, so it polled a row, not a worker, and eventually told Julian to upload the file.

## Decision
1. **Heartbeat.** The helper POSTs `/mac/heartbeat` every tick (15s) with version, a real capability matrix
   (from `macDoctor`, refreshed every 10 min), frontmost app/window, and current task. `mac_runtime` holds it.
2. **Claim / lease / progress.** The worker claims a task (`/control/claim`, 120s lease) before executing and
   reports `/control/progress` at each stage. A live lease cannot be stolen; an expired one can be reclaimed.
3. **Derived lifecycle.** Never bare `active`: `queued` (Mac online, unclaimed) · `waiting_for_mac` (no fresh
   heartbeat) · `executing` (claimed, fresh progress) · `stalled` (claimed, no progress) · terminal statuses.
4. **Fail fast.** `make_mac_chart` / `control_mac` check Mac health BEFORE creating work; if offline they
   return `waiting_for_mac` + the one remedy immediately — no task, no polling, no "upload the file".
5. **Terminal failures.** The worker reports concrete failures (`/mac/chart-done {failed:true}`); a task never
   stays `active` after the worker gives up.
6. **`mac_status` tool** returns the real matrix (connected, heartbeat age, screen/accessibility/files/browser/
   clipboard/active-window PASS|FAIL, current app, current task lifecycle+evidence).
7. **Always-on.** LaunchAgent already has RunAtLoad+KeepAlive; added ThrottleInterval=10 so crash-loops restart
   in 10s, and setup.sh now installs `mac-perception.mjs` (its absence crashed the helper).

## Honest limits
Heartbeat makes the Mac's state *known*; it does not make a powered-off/asleep Mac reachable. Visual-fallback
control (mouse/keyboard on unknown apps) is the next build on this substrate.
