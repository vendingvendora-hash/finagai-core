# ADR-085 — Phase 6: learning as a general capability (governed, with provenance)

Status: Decided (builder, under Julian's 2026-10-09 mandate)
Date: 2026-10-09

## Context
Through Phase 5, Finagai recorded everything it did but learned nothing from it. Julian asked for learning as a
general Finagai capability, not Career logic. Finagai should learn from:
- outcomes, corrections, repeated procedures and preferences
- tool and resource performance, failures and recoveries, and decisions

It must keep provenance, confidence and freshness, and it must tell learned facts apart from inference. Learning must
never weaken governance, authority boundaries or security. Career stays the golden test case.

## Decision
**Lesson** (`lesson` table, migration 0032). A lesson is one row per deterministic key, updated in place and never
deleted. Each row carries:
- **kind:** resource_performance, recovery, procedure, correction, decision_pattern, outcome or preference.
- **basis:**
  - **observed:** a fact computed from Finagai's own records.
  - **stated:** Julian said it.
  - **inferred:** a generalization.
- **support and positives:** the counts behind the lesson.
- **confidence:** the Wilson 95% lower bound for rates, so small samples are not trusted, or 1 for stated lessons.
- **evidence (provenance):** the source table, the time window and sample ids or task codes.
- **first_seen and last_evidence**, from which **freshness** is computed. Freshness has a 30-day half-life; below 0.25
  (about 60 days) an observed lesson stops applying and is retired. Stated lessons do not decay.
- **status:** active, proposed, approved, rejected or retired.

**Learners** (`src/learning/learners.ts`) are deterministic and read only records, never a model's opinion:
- **Resource performance:** verification rate per Mac step kind, success per event workflow, error rate per MCP tool.
- **Recoveries:** after a step fails to verify, which step worked next.
- **Procedures:** the same verified step sequence used for related requests (≥3 tasks with shared request words).
- **Decisions:** how Julian resolved each kind of escalation.
- **Outcomes, per Area:** answer latency (median and p80, with how many answers were rejections) and channel answer
  rates.
- **Corrections:** write steps Julian declined, and how he settles conflicts between new and stored facts.

**What learning may change** is a closed whitelist (`src/learning/guard.ts`), enforced in code at write time and again
at use:

| effect | from basis | applies | how |
|---|---|---|---|
| `planner_hint` | observed (n ≥ 3–5) or stated | at once, **advisory** | text in the Mac planner's percept, labeled as advisory, with the statement that authority, approval, verification and secrets rules are unchanged and take precedence |
| `routing_override` | stated only | at once | "ignore mail from X" silences the Areas' subscriptions for that sender, but waits and deadlines still see the mail; "route mail from X to <Area workflow>" wakes that workflow (whose own evidence rules decide what it records) |
| `procedure` | inferred only | **after Julian approves** | existing proposal → `procedure` row (governance/execute.ts, passkey); a commitment step inside becomes an explicit STOP |
| `policy_param` | inferred only | **after Julian approves** | existing proposal → `preference` row; only `responseDays` 7–45, `interviewDecisionDays` 3–21, `staleAppliedDays` 14–90, `julianActionDays` 1–7 and `nudgeWithContact` |

**Always refused,** whoever the source (Julian included):
- Hint or step wording that commits Julian externally: submit, send, pay, accept and similar (the same `COMMITMENT`
  rule as authority.ts).
- Wording that touches secrets: passwords, codes, tokens, credentials, account numbers.
- Wording that relaxes approval or verification.
- Any parameter outside the closed list. Authority classes, the delegation envelope, escalation categories, budgets and
  classification are not learnable.

**Inference reaches Julian only as authorization.** An inferred effect becomes a `proposal` (kind preference_change or
procedure_change, `target_type='lesson'`). The machine-readable effect travels in the text Julian approves, as a
`[finagai-effect]` trailer. The event engine's state-derived escalations add one **authorization** escalation per
pending learned change, resolved automatically when he decides or the proposal is withdrawn. What applies is read from
the **governed row** the approval created, never from the lesson row, and it is re-validated against the whitelist at
use.

Julian's decisions stand:
- A rejected lesson is never re-proposed.
- A forgotten lesson is never revived by a learner, only by Julian teaching it again.
- An approved change is re-proposed only when the evidence moves materially (≥5 days for a day parameter).

**Where lessons are used:**
- The J6 planner's percept, as advisory guidance. Prompt version j6-control-v5; each use is recorded as a
  `lesson_applied` event.
- Event routing, for Julian's stated overrides, applied before Area subscriptions.
- The lifecycle: `reconcileJob`, job views and the pipeline use `policyFor(area)`, which is the code defaults plus
  approved parameters.

**Running.** A generic `learning` watcher emits `learning.due` once a day, and the `learning.run` workflow does one pass
(advisory lock 85001; a failing learner does not block the others). It can also run on demand with `run_learning`
(preview by default; a preview writes nothing).

**Surfaces:**
- **MCP tools:**
  - `lessons` (read-only): basis, confidence, freshness, provenance, whether the lesson applies, and how often the
    planner used it.
  - `run_learning`.
  - `teach_finagai`: ignore_sender, route_sender or hint, in Julian's own words.
  - `forget_lesson`.
- **Brief:** "Finagai learned …" for new observed or stated lessons; pending inferences appear as decisions, not as
  changes.
- **Operator channel:** `lessons [n]`, `learning-preview`.

## Why learning cannot weaken governance
- **Structural:** a unit test walks the import closure of `src/governance`, `src/auth`, `src/approval`, `src/guards`,
  `src/llm` (metering and budgets) and `src/mac/acceptance.ts`, and fails if any of them reaches `src/learning`.
  A second test fails if `src/learning` ever inserts procedure, preference or approval rows, approves a proposal, or
  updates escalations, control steps or tasks.
- **Behavioural:** the only behaviour changes are the four whitelisted effects above. Two are advisory or narrow
  routing. The other two pass Julian's passkey approval through the existing path, so step authority, approvals,
  verification and the principal-reserved list are untouched.

## Evidence
- `test/unit/learning-guard.test.ts` (12 tests) covers:
  - The whitelist: commitment, secret and approval-relaxing wording is refused for observed and stated sources.
  - Basis restrictions and bounds.
  - A procedure's submit becomes a STOP.
  - Wilson confidence, freshness, and `nudgeWithContact`.
  - The structural import checks.
- `test/integration/learning.test.ts` (10 tests, fresh database) covers:
  - A preview writes nothing.
  - Each learner's lesson carries provenance and confidence.
  - Inferences become pending proposals, and nothing applies before approval.
  - Advisory guidance never includes an unapproved procedure.
  - A second pass is idempotent.
  - The engine wakes learning daily and escalates only as authorization.
  - Approval applies and rejection is never re-asked.
  - Stated corrections apply at once, and approval-relaxing, commitment and secret teachings are refused.
  - The engine applies routing overrides while waits still see the mail.
  - Freshness retirement, and forgetting restoring the default.

On the real 2026-10-09 evidence fixture, the first pass proposes a Career response window from observed answer
latencies. That is the intended behaviour: a proposal for Julian, not a change.

## Revision 2026-10-11 (after the first live passes; hotfix 23)
Julian rejected the outcome-selected response-time estimate: it dropped applications that were never answered, so it
could only shorten the window. Three defects found in the live acceptance were fixed.

1. **Censoring.** Time-to-answer now uses a Kaplan–Meier estimate (`src/learning/survival.ts`). Every application
   counts:
   - An answered application is an event at its first answer.
   - An unanswered one is censored at today, or earlier at a withdrawal or posting closure.

   The lesson reports the chance of any answer by day 7, 14 and 30 (95% Greenwood log-log intervals), how far follow-up
   reaches, and how often an application still silent at the current window was answered later.
   A window is proposed only when all of these hold:
   - ≥ 20 applications and ≥ 8 answers.
   - The smallest day d in 7–45 at which **≤ 10% of still-silent applications were answered later** (up to the
     follow-up horizon).
   - ≥ 10 applications still waiting at d, and ≥ 14 days of follow-up after d.
   - The result differs from the window in effect by ≥ 5 days.

   Otherwise there is no proposal, and the lesson says why. Answers later than the horizon cannot be seen, and the
   statement says so. The method assumes censoring is not informative; Julian's withdrawals are censored at their date.
2. **Confidence semantics.** Confidence is the 95% lower bound of the proportion the lesson's *claim* rests on. Every
   rate lesson also stores its 95% Wilson interval. Before the fix, a step verified 0/5 times showed confidence 0
   although its "unreliable" claim is fairly certain. Procedures count every attempt at similar requests, not only the
   successes.
3. **Freshness provenance.** Last-evidence timestamps were taken by sorting Date objects as strings ("Fri…" < "Wed…").
   They are now the true maximum, so freshness is correct.

The guard also refuses wording that overrides rules, authority or limits, touches budgets or step and token limits, or
asserts an outcome ("mark as verified") instead of checking it. Procedure names and triggers are checked too.

New acceptance tests:
- A lesson row hand-marked "approved" applies nothing.
- A governed row edited out of bounds, or naming a non-whitelisted parameter, applies nothing.
- A forgotten observed lesson is not revived while its evidence is fresh.
- Exact provenance (the step ids), confidence (the claim bound and interval) and freshness (half-life of the true newest
  evidence).
- A hand-computed Kaplan–Meier example.
- A case where dropping unanswered applications understates the window and censoring does not.

## Revision 2026-10-11b (hotfix 24): a window needs statistical support, not a point estimate
The first live censored preview proposed 7 days: after day 7, 9% of still-silent applications were answered later
(about 4 of 49). That met the 10% point rule, but a handful of late answers cannot rule out a much higher rate.

The rule is now:
- The point estimate must be ≤ 10%.
- **The 95% upper bound must be ≤ 20%.** The bound is a Wilson interval on k later answers among the applications
  still silent after day d. Applications censored inside (d, horizon) count as half-exposed (actuarial life-table
  adjustment).

Days rejected as too uncertain are named in the lesson.

Two more corrections:
- **"No answer yet by day t"** is reported as 0% with an exact 95% upper bound of 1 − 0.05^(1/n), not as a certain 0%.
- **The descriptive lesson's confidence** is the precision of its widest-horizon estimate.

**Previews** (`run_learning preview`, `learning-preview`) now return every recomputed lesson, with its statement,
provenance, confidence, freshness and resulting status. The transaction is then rolled back.

## Revision 2026-10-11c (hotfix 25): every candidate day is shown
The response-window lesson's provenance (`candidateDays`, plus the `rule` it was checked against) lists every day from
7 to 45 with:
- the number still at risk, the number still silent after the day, and those censored before the horizon;
- the effective sample size, the number of later answers, the Kaplan–Meier and life-table later-answer rates, and the
  95% upper bound;
- the follow-up remaining, and each rule the day fails. An empty list means the day passes.

The window is the first day that passes every rule. Nothing else changed.

## Revision 2026-10-11d (hotfix 25 live review → hotfix 26): parameters must be coherent together
The live day-by-day table found day 31 as the first statistically supported window. Day 31 is also past
`staleAppliedDays` (30), and the lifecycle closes a silent application once it is that stale. So a 31-day window would
silently remove the nudge-or-let-go decision for every application. Each parameter was within its own bounds; only the
combination was wrong.

`policyIncoherence()` now rejects any `responseDays ≥ staleAppliedDays`:
- **At proposal time:** the observed lesson records `proposalBlocked`, and no proposal is filed.
- **At use:** `policyFor` skips an approved parameter that would make the policy incoherent.

On the statistics: the 31-day result is the first day after the last observed late answer (around day 30). It rests on
4 late answers in all, and only 5 applications have been followed through day 55. Day 30 misses the 20% bound by one
point (21%). The data supports "no answers have been seen after about a month so far", not a precise 31-day policy.
