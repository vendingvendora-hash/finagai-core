# ADR-072 — Acceptance contracts, independent verification, false_completion, telemetry (Phase 1)
**Decided by:** Julian ("J6 done is planner-asserted — insufficient")

- Every `control_task` gets a derived `acceptance` contract at creation (`src/mac/acceptance.ts deriveContract`):
  objective, expected outcome, required evidence, strategy (deterministic | ui_state | artifact | model_graded),
  artifact requirements, allowed side effects, terminal conditions, and extracted expectations (app, quoted text).
- `planNext`: when the planner claims `done`, `verifyCompletion` runs first. ui_state checks the last `observe`
  (app frontmost, expected text present); artifact requires an image; any unverified/error AX write without a
  later observation blocks; model_graded calls the **grader model** (MODEL_EVAL_GRADER = Opus), never the planner.
- Rejection = `false_completion` (event + interaction flag); the next step becomes a mandatory re-observe carrying
  the verifier's reason; a second rejection fails the task with `failure_class='false_completion'`.
- Telemetry (migration 0022): per-interaction task_class, ack/complete timestamps, tool/model calls,
  verification attempts, false_completion, failure_class, cost; view `interaction_metrics_daily` (p50/p95 ack and
  completion, counts). Sweep sets failure_class abandoned/stalled.
- Helper diagnostics (Phase 1E): `/mac/diag` (sanitized, bounded) → audit `event` → `mac_status.recentDiagnostics`.
