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
