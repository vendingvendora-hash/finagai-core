# ADR-088 — Phase 8: continuous reliability on the Live State Stream

Status: Decided (builder, under Julian's 2026-10-09 Phase 0–8 mandate). Increment 1 shipped as hotfix 36.
Date: 2026-10-12

## Context
Phases 0–7 made Finagai do the work. Phase 8 makes it **keep working**, and makes "is it working?" a fact Finagai
checks continuously rather than something found in an audit.

ADR-087 (closed 2026-10-12) is the foundation. The event table is the one source of truth, and every state change is
a semantic event with its object, before/after, Area, unit of work and cause. Phase 8 therefore adds **no monitoring
store**:
- reliability is computed from the stream;
- reliability problems are Phase 7 operating exceptions, with owner, remedy and escalation;
- a future Command Center sees reliability the same way it sees everything else.

The live ADR-087 acceptance (canaries 1–3) left these known gaps:
- the self-check ran only when someone asked for it;
- scheduler job runs were invisible on the stream;
- the idle-Mac note flapped (opened and cleared about every hour while the Mac slept, two events per cycle, all night);
- `watch_rule_removed` had no Area;
- workflow-raised escalations never auto-resolve;
- detector-opened exceptions are causal roots;
- the career interpreter labels job history "analyzed→X".

## Decision

### Principles
1. **Measure from the stream.** Every reliability number can be re-derived by replaying events. The engine's own tick
   ledger (`event_tick`) is the one exception, because a stalled loop writes no events.
2. **Act through Phase 7.** A reliability failure is an `operating_exception`:
   - Finagai owns it and applies a remedy if one exists.
   - Julian hears about it only if it persists, as a judgment ("have it fixed").
   - It clears itself when the condition clears.
3. **One failure is a signal; a repeated failure is an exception.** Pending is never a failure.
4. **Noise is a reliability defect.** A condition that flaps is one ongoing note, not a stream of open/close events.

### Increment 1 (hotfix 36)
- **Continuous self-check.**
  - The event loop runs the full ADR-087 `live-acceptance` at most hourly, inside a real tick (never a preview).
  - It records the verdict on the stream as `reliability_checked` (`system.checked` / `system.check_failed`): allPass,
    failing, pending, passed count, Core version, duration. The tick's unit of work causes it.
  - The new `selfCheck` detector opens `reliability:<check>` when the same check FAILED in the two latest runs. It is
    Finagai-owned, warning, and escalated as judgment after 60 minutes.
  - A check that throws is recorded as the failure `selfCheck`.
- **Scheduled job runs on the stream.** `PgJobLedger.finish` appends `job_finished` (`workflow.completed`, `skipped` or
  `failed`). Its correlation id is the run id, which is also the correlation of everything the job did. It records job,
  slot, attempt, status, duration and failure detail. A finish after a lost lease records nothing.
- **Hysteresis for noted conditions.**
  - `CLEAR_AFTER_MIN` (`mac_offline`: 45 min): a Finagai-owned **info** note resolves only after its condition has been
    absent that long. 45 minutes is longer than the 30-minute re-detection after a brief wake.
  - It never applies to anything Julian owns or Finagai is actively working; those clear at once.
  - A note whose detector now reports a different condition (the Mac offline *with* work waiting) is superseded and
    resolves at once.
- **Object Area for rows that carry one.** Escalations, exceptions, watch rules and lessons have an `area_id` that is not
  semantic state. Their transition events are now filed under it. This closes the ADR-087 residual (`watch_rule_removed`
  had no Area).
- **Reliability report.** `finagai-job: reliability [days]` (read-only) gives a verdict of **healthy** or **degraded**,
  with the reasons, against an explicit budget (`RELIABILITY_BUDGET`). It covers:
  - event-loop ticks, failures and stalls (gap > 15 min, including "still stalled");
  - per-workflow success rate (≥ 90% over ≥ 3 runs);
  - tool-call failure rate (≤ 10%);
  - scheduled jobs by status;
  - notifications delivered, held for quiet hours, or failed;
  - exceptions opened and **flapping** (> 3 opens per key);
  - self-check runs and failures;
  - events not yet on the live stream.

### Increment 2 (next)
- **Workflow-raised escalations** auto-resolve when the workflow's next run no longer raises them, or when the object
  they are about reaches a state that makes them moot.
- **Detector-opened exceptions** cite the evidence that tripped them (the watcher failure, the failed workflow event,
  the stale heartbeat), instead of being causal roots.
- **The career interpreter's transition label** reflects the stored status, so it no longer says "analyzed→offer" for a
  job that was applied.
- **Daily reliability digest line** in the executive brief, from the report. Silent when healthy.
- **Synthetic canaries without Julian's mailbox.** A scheduled internal canary (a labeled test-Area object driven
  through the normal tool paths and cleaned up through them) proves the state-change path continuously. The external
  email path still needs a real email, so it stays a manual canary.

## Consequences
- The ADR-087 guarantees are now checked every hour in production, not just when asked. A regression surfaces as an
  exception within about two hours, and reaches Julian as a judgment only if it persists.
- Every unit of work Finagai runs on its own (ticks, tool calls, scheduled jobs) is visible on the stream with its
  outcome.
- The idle-Mac note no longer produces open/close noise all night. Julian-owned Mac exceptions are unchanged.
- No schema change. No new tool on the MCP surface: the tool-list digest is unchanged, and the report is an operator
  command.

## Evidence (increment 1, pre-deploy)
- `test/integration/reliability.test.ts` (5 tests) covers:
  - the self-check runs in real ticks only and is due-gated;
  - its verdict is on the stream with a cause;
  - two consecutive failures open the exception, and a pass clears it;
  - a thrown check is recorded;
  - `job_finished` with run correlation;
  - one Mac-offline note across a brief wake, clearing after the hold;
  - rule events carry the rule's Area;
  - the report names a failed job, self-check failures and a flapping key.
- `test/integration/exceptions.test.ts` is updated for the new semantics. The idle note is superseded at once by the
  work exception, Julian's exception clears the moment the Mac is back, and the idle note clears after the hold.
- **Mutation checks.** Disabling the hold fails the flapping test; disabling the Area lookup fails the rule-Area test.
- **Full suites:** 521 unit, 281 integration, all passing.

## Increment 1 live acceptance (2026-10-12 20:31Z, Core `f66122059cf4`) and hotfix 37
**Verified live:**

| Item | Result | Evidence |
|---|---|---|
| The first hourly self-check ran in a real tick and recorded its verdict on the stream | Pass | `reliability_checked` 1972 / seq 1941 at 20:31:30Z: failing [], pending [emailToStateChain, escalationNotificationChain] (Core had just restarted), duration 2.6 s, version `f66122059cf4`. It cites the tick 1971 and shares its correlation |
| A pending check opens no exception | Pass | — |
| A run with no failures creates nothing for Julian | Pass | `exceptions`: "All normal — nothing is wrong."; needs-Julian is empty |
| Rule events carry the rule's Area | Pass | `watch_rule_added` 1975 and `watch_rule_removed` 1978 (rule #3, a labeled ADR-088 canary in Finagai Test, added and removed through the normal tools) are both filed under Finagai Test. 1978 also has before {status active, removed_at null}. Hotfix 35's 1959 had no Area |
| The reliability report reads the stream and finds real problems | Pass | Over the past 24 h it reported 298 ticks, 0 stalls (longest gap 5 min), career.sync 5/5, learning.run 1/1, 2 notifications delivered and 0 failed. The idle-Mac note **opened 7× in 24 h** (the flapping hotfix 36 removes, now measured) |

**Two defects found live, fixed in hotfix 37:**
1. **The stream hid the self-check's own verdict.**
   - *Symptom:* 1972 showed `allPass: "[redacted]"` and `passed: "[redacted]"`.
   - *Cause:* stream redaction matched the substring "pass".
   - *Fix:* redaction now matches whole secret **words** in a key (camelCase, snake_case or kebab-case split) plus key pairs like apiKey / private_key. Usage counts such as `inputTokens` are not treated as secrets. Unit tests cover what must and must not be redacted.
2. **Every `call_tool` was counted as a failed tool call.**
   - *Symptom:* the report showed 28/28 failures, a 27% failure rate, and a false "degraded".
   - *Cause:* call_tool's own audit record is a routing note with no outcome. The routed tool records its own outcome.
   - *Fix:* routing notes are classified `tool.routed`. The classification is applied when events are read, so history is corrected too. New routing notes carry `outcome: "routed"`, and the report excludes them.

**Waiting for real production occurrences** (nothing can be faked):
- the first `job_finished` (daily_maintenance at 07:00Z);
- a full night with the Mac asleep, which should give at most one idle-Mac note per sleep instead of hourly reopen/clear.

The 24-hour report stays "degraded" until the pre-fix idle-Mac flaps (all before 20:31Z) age out of its window. That is correct evidence, not a defect.

**Tests:** 522 unit and 281 integration, all passing.

## Increment 1: first hotfix-37 self-check (2026-10-12 21:34Z) — real failure caught, fixed in hotfix 38
- **Redaction and verdict proof.** `reliability_checked` 2019 (seq 1988), version `7de3917a501e`, cites tick 2018. On
  the stream it shows `passed: 9` and `allPass: false` (real values, no longer "[redacted]"), with
  `failing: ["stateEventQuality"]`. The redaction scan still PASSes over 1,991 envelopes.
- **The failure is genuine.**
  - At 21:04Z Julian ran a Mac task (task 88b9bb57…: reading the weekly-review email in Firefox).
  - Its step proposals (`control_step_proposed` 1994, 2002, 2008, 2012), shown on the stream as task / authority
    events, cited no cause. Only state-table entities were rooted in their unit of work (`mac:/control/next`), and
    `control_step` is not a state table.
  - No Mac task had run since the guards went live, so the self-check found this the first time one did.
  - Left unfixed, a second failing run would open `reliability:stateEventQuality`, which would reach Julian an hour
    later. The violations stay in the self-check's window until Core restarts.
- **Fix (hotfix 38, fix only).** An event about a non-state work object (`control_step`, `control_task`,
  `interaction`, `artifact`, concierge drafts and messages) appended inside a unit of work now cites that unit of
  work's root. Tool-call audit rows stay unrooted, so a read-only tool call still leaves no trace.
- **Tests.** The regression test checks that a step proposal in a `mac:/control/next` unit cites
  `work_invoked mac:/control/next`, that a read-only tool call creates no root, and that `stateEventQuality` PASSes.
  Removing the fix fails it. Full suites: 522 unit and 282 integration, all passing.
- Increment 2 is held; it becomes hotfix 39 once the fix is live and Increment 1 passes.

## Increment 1 final acceptance at 07:10Z (2026-10-13): two criteria failed, both fixed in hotfix 38
**Passed:**
- **Scheduled job on the stream.** `job_finished` 2099 (seq 2068) at 07:00:34Z: daily_maintenance, attempt 1,
  succeeded, 48 ms, correlation `96bdbd8a…` (the run's id).
- **call_tool routing.** Excluded from failures: 0 failures in 53 tool calls in the 24-hour report.
- **Redaction / verdict visible.** Every hourly `reliability_checked` from 21:34Z on (2019 … 2097) shows `passed: 9`
  and `allPass: false` as real values. The redaction scan PASSes.

**Failed:**
1. **stateEventQuality failed in every hourly self-check from 21:34Z** (10 of 11 runs).
   - Cause: the Mac step events from Julian's 21:04Z task cited no cause (see above). The fix was built by 21:45Z but
     **was not delivered to Julian** (builder error). The violations stayed in the self-check's window until the next
     restart.
   - The Finagai-owned `reliability:stateEventQuality` exception opened at 22:34Z. After an hour it was escalated
     (2047) and emailed (2048, 23:34Z) to Julian as a judgment.
   - This is exactly the behaviour designed for a guarantee that stays broken. It reached Julian only because the fix
     sat undelivered.
   - On deploy, Core restarts. The next self-check passes, and the exception and escalation resolve themselves.
2. **The idle-Mac note still opened and cleared twice in one night after the hysteresis fix:**
   - opened 2082 at 03:34Z;
   - cleared 2086 at 04:19Z;
   - opened 2093 at 05:34Z;
   - cleared 2098 at 06:34Z.

   - Cause: macOS dark wakes send a heartbeat every so often, so the Mac really is reachable between the gaps. Any
     30-minute gap reopened a note that never meant anything was wrong or that anyone had something to do.
   - Fix: a sleeping Mac with no Mac work waiting is **no longer an exception at all**.
   - Unchanged: the Mac offline **with work waiting** is still Julian's (principal-reserved). It clears the moment the
     Mac is back.
   - Julian can still ask to be told via the `mac_offline_minutes` rule metric.
   - The hold mechanism had no other use, so it was removed.

**Also fixed:** a Phase 7 integration test that sends a digest depended on the time of day and failed when run inside
quiet hours (03:20 ET). Its tick is now pinned to daytime.

**Tests:**
- Idle sleep / dark-wake / sleep writes no exception events. The same sleep **with** work opens Julian's exception,
  which clears when the Mac is back. Restoring the idle note fails the test.
- Full suites: 522 unit and 282 integration, all passing, including a night-time run.
## Increment 2 (built and tested off-production; held until Increment 1 passes live)
- **Daily internal canary** (`src/live/canary.ts`).
  - Once a day the event loop drives a labeled fixture job (`FINAGAI-CANARY-<stamp>`, Area "Finagai Test", source
    `canary`, actor `system`, never Julian) through the normal paths in four steps:
    1. track as applied;
    2. new evidence, which reschedules the follow-up;
    3. withdraw (follow-up done, project completed);
    4. archive the test job. The job is archived, never deleted.
  - After each step it checks **the stream's own envelopes**. Every state event must name its object, be shown under
    the object's Area, cite a cause, and carry a before-state if it is a transition. The expected events must exist.
  - The verdict is recorded as `canary_ran`. A new `canaryFailing` detector opens `canary:state_path` (Finagai-owned)
    when the two latest runs failed; the exception cites those runs and clears on the next pass.
  - The brief never shows test-Area activity.
- **Workflow-raised judgments no longer stay open forever.**
  - A workflow need can name its `subject`, which becomes part of the key (`…@opportunity:<id>`). career.sync names the
    job its decision is about.
  - The need resolves "moved on (<action>)" when a later event about that object arrives from another unit of work, and
    cites that event.
  - Otherwise it resolves "expired: no answer in 14 days", the same rule as every other wait on Julian.
- **Detector-opened exceptions cite their evidence.** The exception points at what showed the condition:
  - self-check and canary: their runs;
  - failing workflow: its `workflow_failed` events;
  - delivery failure: the failed notices;
  - stuck or unreviewed task: the task's latest event.
- **Career history label.** A new event on a job Finagai already holds is labelled against the stored status
  ("applied→offer", not "analyzed→offer"). An event that moves nothing carries no transition.
- **Reliability report `since <ISO time>`** evaluates behaviour after a moment (e.g. a deploy) separately from the
  rolling window. The report also covers the canary.
- **Brief.** One risk line, "Finagai reliability (last 24 h) is degraded: …", appears only when not healthy. It is never
  a decision, so a healthy platform adds nothing and a degraded one adds no task for Julian.
- **Tests:**
  - `test/integration/phase8-increment2.test.ts` (4 tests). Mutation checks: disabling the moved-on/expiry rule, or the
    evidence citation, fails them.
  - `test/unit/phase8.test.ts`.
  - Full suites: 525 unit, 285 integration, all passing. No migration; the MCP tool surface is unchanged.

## Increment 1: PASS (2026-10-13 16:33Z, hotfix 38, Core `fcf2d75a1f83`, started 16:03:31Z)
| Criterion | Live evidence |
|---|---|
| Hourly self-check passes, verdict readable | `reliability_checked` 2176 (seq 2145) at 16:33:36Z. Shows `passed: 10`, `allPass: false` (the two email chains are pending; that is not a failure) and `failing: []`. Version `fcf2d75a1f83`. Cites tick 2175. |
| stateEventQuality | PASS in the post-deploy window (live-acceptance at 16:05:57Z, 0 violations) |
| Mac step events carry their unit of work | Read-only canary task 136, run through the normal path. `control_step_proposed` 2164 cites 2162 (`work_invoked mac:/control/next`). `control_step_ran` 2166 cites 2165. `control_task_done` 2168 cites 2167. |
| The exception and escalation resolve themselves after the passing check | 2177 `exception_resolved` reliability:stateEventQuality ("condition cleared"). 2178 `escalation_resolved` exception:reliability:stateEventQuality:1 ("no longer needed", before {status open}). Both in the same tick. |
| Nothing waiting on Julian | needs-Julian is empty, and exceptions are 0 open |
| No idle-Mac exception | No mac_offline exception since the deploy. The Mac was online throughout, so a natural sleep has not occurred yet. Covered by the integration test, and by deploying the change (the detector no longer emits it). |
| Mac offline with work waiting | That path is unchanged and is covered by the integration test. It cannot be exercised live without making Julian's Mac unavailable while a task waits. |
| Scheduled-job visibility | `job_finished` 2099: daily_maintenance at 07:00Z, succeeded, correlation = its run id |
| `call_tool` exclusion | 0 failures in 53 calls in the report window |

Increment 2 is released as hotfix 39.
