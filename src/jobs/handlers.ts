/**
 * Job handlers. Each is implemented in its milestone; until then it records an explicit
 * 'skipped' outcome rather than pretending to succeed (no phantom actions, R04).
 *
 * Idempotency contract for real handlers (ADR-033):
 *   weekly_review     review row keyed by review.slot_key = ctx.idempotencyKey; delivery via
 *                     deliverOnce() with key "review-email:<review_id>"
 *   missed_run_check  if the slot's review is not delivered, re-runs the weekly-review handler with
 *                     the SAME slot key (recovery), then alerts via deliverOnce() keyed by the slot
 *   daily_maintenance idempotent: expires overdue governance requests, replays budget-deferred
 *                     captures in arrival order (each under its own capture lease)
 */
import type { JobHandler } from "./dispatcher.js";
import type { JobName } from "./schedule.js";

const notYet = (milestone: string): JobHandler => async () => ({
  status: "skipped",
  detail: `not implemented until ${milestone}`,
});

export function placeholderHandlers(): Record<JobName, JobHandler> {
  return {
    weekly_review: notYet("M6 (J3 pipeline)"),
    missed_run_check: notYet("M6 (J3 delivery)"),
    daily_maintenance: notYet("wired in scheduler.ts"),
  };
}
