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

## ADR-072.2 — corrections before freezing 0022 (Julian's review)
1. **Idempotency scope = the logical action**, not a 24h window: `outbound_action.idempotency_key =
   <request ref>:<operation>:<artifact>:<recipient>` (request ref = inbound message guid / interaction id).
   Decisions: execute | in_flight | reconcile (unknown outcome → check evidence before resending) | already_done |
   exhausted. Monotonic states. A new explicit request ("send it to Santiago again") is a new key.
2. **Evidence-graded states and wording**: requested → accepted (send call returned) → outgoing_observed (outgoing
   row in Messages DB) → delivered (only `is_delivered = 1`). Copy never says "delivered/confirmed" without a receipt.
3. **Bounded recovery** replaces "two rejections → fail": rejection → re-observe step carrying the reason → planner
   diagnoses/revises. Terminal only on: repeated identical claim with no new evidence (loop guard), >4 rejections,
   >15 min, >24 recovery steps. Recorded: completion_claims, verification_rejections, recovery_attempts,
   recovery_strategy_changed, terminal_reason (also copied to interaction).
4. **Verified file ops** (`helper/fs-ops.mjs`): regular-file check, collision refusal unless overwrite, Finder
   folder semantics, sha256 ≤200 MB, atomic rename or partial-copy→verify→rename (no partial left), source gone;
   trash verified by source absence + a matching new item in ~/.Trash.
Migrations 0001–0022 are now pinned in `migrations/CHECKSUMS.json` (test `migrations-frozen.test.ts`).
