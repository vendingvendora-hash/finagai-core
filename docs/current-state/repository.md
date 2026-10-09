# Repository — current state (audit 2026-10-09)

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

