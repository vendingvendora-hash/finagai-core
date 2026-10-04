# Known failures, gaps, technical debt (Core 45e80d0) — ranked

| # | Severity | Item | Evidence / root cause | Live state | Regression |
|---|---|---|---|---|---|
| 1 | HIGH | Employee layer unreachable from conversation | `src/cos/*` services + tables exist; **zero MCP tools, zero scheduler hooks** | Broken-by-absence: "Create Career as an Area", "What am I waiting on?", "executive brief" do nothing | cos.test (services only) |
| 2 | HIGH | No event-driven behavior | Only iMessage polling + 15-min cron; no Gmail/Calendar/file watchers | NOT IMPLEMENTED | — |
| 3 | HIGH | No learning of any kind | `procedure`/`preference` tables exist (0002) with no write path; no tool-reliability or failure records | NOT IMPLEMENTED | — |
| 4 | MED | Migrate-before-deploy race | Render auto-deploys on push; preflight fails until the GitHub `migrate` workflow is approved → manual "Deploy latest commit" needed (hit 3× on 2026-10-04) | Live friction, every migration | none |
| 5 | MED | Rasterizer rung uncertainty | NSImage rung produced nothing on Julian's Mac (cause not captured); Chrome rung works | Chrome-first live (task #74 full width) | aspect gate live-proven; no unit test |
| 6 | MED | J6 write-step approvals via iMessage only | `await_approval` → "ok N" in Messages; a chat-initiated task can stall waiting for an iMessage reply | by design (ADR-051) but surprising from chat | — |
| 7 | MED | Verification is per-action, not per-task | WO4 actions verify intended outcome; J6 `done` still trusts the planner's claim (no task-level acceptance criteria) | live | partial |
| 8 | MED | Multi-display, dialogs/sheets, unlabeled icon buttons | `ax_click` searches front window only; capture = main display | NOT VERIFIED | — |
| 9 | LOW | Chart trend line across regime change | single OLS trend over two-regime series (task #74) misleads | live | — |
| 10 | LOW | Helper log not visible to Core | failures like "nsimage raster failed" live only in `~/.finagai/imessage-helper.log` | live | — |
| 11 | LOW | `pending_results` marks text-only results delivered on `helpers.ok` but image results only when fetched | can resurface once | live | interactions W2 |
| 12 | INFO | Observability: no metrics, no p50/p95, no dashboards; only `event`, `llm_call`, Render logs | measured values below are from single runs | — | — |

Measured today (single runs, not aggregates): round-trip ping 11.1s; chart task 69/70/72/73/74: 12–45s; TextEdit AX task #77: ~60s, 6 steps, 0 interventions; false completions caught: 1 (cropped chart, #73); false completions delivered: 1 before gate (#72).
