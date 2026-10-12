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
