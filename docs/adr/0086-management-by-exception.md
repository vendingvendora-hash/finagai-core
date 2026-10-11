# ADR-086 — Phase 7: management by exception

Status: Decided (builder, under Julian's 2026-10-09 mandate)
Date: 2026-10-11

## Context
The audit (§17) scored management by exception at 0:
- Nothing applied thresholds to Areas or follow-ups.
- There was no "only tell me when X goes wrong" rule.
- Nobody was alerted when tasks #104 and #113 sat stuck for four days.

Phase 5 escalates what needs Julian's judgment, authorization or a principal-reserved action. Nothing watched for
*things going wrong*: a failing watcher, a dead workflow, events that gave up, the budget, undelivered notices, an Area
in breach, an unreachable Mac, a stuck task, or the event loop itself.

Julian's authority model still holds. Finagai must not put routine work on his plate; it tells him only what only he
can clear.

## Decision
**Exceptions** (`operating_exception`, migration 0033; `src/exceptions/`).
- **Detection.** On every event-engine tick, deterministic detectors read state and report what is wrong now. A
  condition that stops being reported resolves itself. A detector that *fails* never resolves anything.
- **Detectors:**

| Detector | Owner | Fires when | Response |
|---|---|---|---|
| `watcher_failing` | Julian, for an auth failure | 3 consecutive failed polls | **principal-reserved:** only he can re-authorize the account |
| `watcher_failing` | Finagai, otherwise | 3 consecutive failed polls | Finagai keeps retrying |
| `workflow_failing` | Finagai | the last 3 runs failed | its events are kept and retried |
| `dead_letter` | Finagai | events gave up after 5 attempts | remedy: requeue them once their workflow has succeeded since |
| `budget` | Finagai | spend ≥ 80% of the ceiling | watched only |
| `budget` | Julian | spend ≥ 95% of the ceiling | **principal-reserved:** only he can raise the ceiling (read-only meter; never learned or automated) |
| `delivery_failing` | Finagai | notices to Julian failed or are stuck | critical; shown wherever he looks |
| `area_breach` | Finagai | an Area's projects have no next step | remedy: lifecycle reconcile. Overdue follow-ups are not counted here; they are already escalated one by one to their owner |
| `mac_offline` | Finagai | Mac unreachable, no work waiting | noted only |
| `mac_offline` | Julian | Mac unreachable with Mac work waiting | **principal-reserved:** waking it is physical |
| `stuck_task` | Finagai | a task makes no progress for 60 min | watched |
| `review_backlog` | Julian | an unverifiable result waits more than 24 h | judgment |

- **Remedies first.** Finagai-owned exceptions get their remedy at most 3 times, at least 30 minutes apart. Each
  attempt and its result are recorded.
- **What reaches Julian.** Exactly two kinds of exception, as escalations, on the existing once-only, quiet-hours-aware
  digest:
  - one only he can clear, with what it needs;
  - a Finagai-owned one that outlived its remedies (`escalateAfterMin`: 6–24 h), as a judgment call: "Finagai couldn't
    clear this itself in N h: …, tell it to keep trying, or have it fixed".

  A recurring condition counts as a new occurrence and may be escalated again.

**"Tell me when …" rules** (`watch_rule`): Julian's own words, over a closed registry.
- *Metrics:* model spend, open escalations, overdue follow-ups, Area health, jobs in a status, applications in the last
  7 days, open exceptions, Mac offline minutes.
- *Events:* an opportunity reaching a status.
- *Firing:* edge-triggered. A rule fires once when its condition becomes true and re-arms only after it clears; a rule
  already true when created waits. Event rules use an event-id high-water mark, not timestamps.
- *Delivery:* firings travel as `requested` escalations, labelled "you asked to be told (nothing to do)". They are never
  listed as decisions or as "what needs me", and resolve once delivered.
- *A rule only observes.* It cannot act, change policy or create a task, and a test enforces this.

**Dead-man check.** The event loop cannot report its own death. The scheduler service (Render cron, every 15 min)
checks that the loop ticked within 30 minutes:
- A stall opens a critical `loop:stalled` exception.
- It sends **one** alert per outage through the idempotent ledger, outside quiet hours.
- The loop's next tick resolves it.

**Surfaces:**
- **Brief:** "Nothing needs you right now — all normal", or "… Finagai is handling N exception(s) itself". A red Area is
  Finagai's to reconcile, so it appears as a risk, not as Julian's blocked work. Cleared problems are compressed into one
  line.
- **Tools:** `exceptions` (read-only: what is wrong, who owns it, the remedy and its tries, what cleared recently, his
  rules), `tell_me_when`, `stop_telling_me`.
- **Operator channel:** `exceptions`.

## Authority
- Detectors only read.
- Remedies re-run only Finagai's own internal machinery: the requeue of its event queue, and the lifecycle reconcile.
  None sends, submits, approves, spends or touches credentials.
- Rules write only their own rows.
- The watchdog writes only its exception and sends its one alert through the delivery ledger.
- `src/exceptions` imports nothing from governance, approval, auth, LLM, Mac or learning.

All of the above is tested structurally (`test/unit/exceptions-structure.test.ts`).

## Evidence
`test/integration/exceptions.test.ts`, 10 tests on a fresh database:
- When nothing is wrong, nothing is sent and the brief says all normal.
- A preview writes nothing.
- Account re-authorization is escalated once, in one email, and resolves when polls succeed.
- A Finagai-owned watcher failure stays off Julian's plate until 25 h, then becomes a judgment, then clears.
- Dead letters are requeued by the remedy and then clear.
- Budget: at 83% it is watched only; at 96% it is principal-reserved and clears when spend drops. A process without
  the meter never "clears" it.
- Mac: offline and idle is only noted; offline with work waiting is principal-reserved; both clear when the Mac is back.
- Rules: validation errors; an interview fires once, as "asked to be told", never as a decision, and the rule changes
  nothing; removal.
- Edge-triggering: fires once, never repeats while true, re-arms after clearing.
- Watchdog: one alert per outage, held in quiet hours, cleared by the next tick.

Phase 5's integration test now also shows a real gap Phase 7 closes. Closing Beth's wait left the Altarum project
without a next step. The area remedy reconciled it at once, and the lifecycle's step (a nudge that goes out as Julian)
was escalated immediately, instead of waiting for some later deadline to wake the lifecycle.
