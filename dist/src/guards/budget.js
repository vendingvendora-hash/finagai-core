const RESTRICTED_BLOCKS = new Set(["shadow", "on_demand_review", "eval"]);
export function validateLimits(l) {
    if (!(l.targetUsd > 0))
        throw new Error("budget target must be positive");
    if (!(l.ceilingUsd >= l.targetUsd))
        throw new Error("hard ceiling must be at least the budget target");
}
export function decideBudget(projectedUsd, limits, purpose) {
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
//# sourceMappingURL=budget.js.map