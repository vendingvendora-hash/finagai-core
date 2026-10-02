/**
 * G20: model-spend control (ADR-025 as clarified, ADR-034).
 *
 *   Budget target        $30/month  normal Lean pilot budget
 *   Hard ceiling         $36/month  absolute; no model call may START if it could cross it,
 *                                   whatever its purpose, until Julian explicitly raises it
 *
 * Decisions use PROJECTED spend: committed + live reservations + this call's worst case.
 *
 *   projected < 80% of target      normal       all purposes
 *   80-100% of target              warning      all purposes; Julian notified once
 *   >= target, <= ceiling          restricted   shadow runs, on-demand reviews, evaluation paused
 *   > ceiling                      ceiling      nothing starts; J3 uses its zero-model degraded
 *                                               review and J2 defers captures (budget_deferred)
 */
export type CallPurpose = "capture" | "seed" | "weekly_review" | "on_demand_review" | "shadow" | "eval";
export type BudgetLevel = "normal" | "warning" | "restricted" | "ceiling";

export interface BudgetLimits {
  targetUsd: number;
  ceilingUsd: number;
}

export interface BudgetDecision {
  allowed: boolean;
  level: BudgetLevel;
  projectedUsd: number;
  reason?: string;
}

const RESTRICTED_BLOCKS: ReadonlySet<CallPurpose> = new Set(["shadow", "on_demand_review", "eval"]);

export function validateLimits(l: BudgetLimits): void {
  if (!(l.targetUsd > 0)) throw new Error("budget target must be positive");
  if (!(l.ceilingUsd >= l.targetUsd)) throw new Error("hard ceiling must be at least the budget target");
}

export function decideBudget(projectedUsd: number, limits: BudgetLimits, purpose: CallPurpose): BudgetDecision {
  validateLimits(limits);
  const projected = Math.max(0, projectedUsd);
  if (projected > limits.ceilingUsd) {
    return { allowed: false, level: "ceiling", projectedUsd: projected,
      reason: "hard model-spend ceiling reached; no model call may start until Julian raises the ceiling" };
  }
  const fraction = projected / limits.targetUsd;
  if (fraction >= 1) {
    if (RESTRICTED_BLOCKS.has(purpose)) {
      return { allowed: false, level: "restricted", projectedUsd: projected,
        reason: purpose === "eval"
          ? "budget target reached; evaluation needs Julian's approval of its expected incremental cost"
          : "budget target reached; non-essential model calls are paused" };
    }
    return { allowed: true, level: "restricted", projectedUsd: projected };
  }
  return { allowed: true, level: fraction >= 0.8 ? "warning" : "normal", projectedUsd: projected };
}
