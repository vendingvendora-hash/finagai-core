/**
 * J3 degraded review (ADR-025 clarified, ADR-034). Used when the hard model-spend ceiling blocks
 * composition, and as the fallback after a failed validation repair. Zero model calls: every line
 * is rendered by code from the collected database state, so it cannot fabricate or misstate items.
 */
import { BudgetBlockedError } from "../../llm/types.js";
export const SECTION_TITLES = {
    requires_attention: "Requires attention",
    upcoming: "Upcoming",
    waiting: "Waiting / follow-up",
    project_changes: "Project changes",
    risks_conflicts: "Risks / conflicts",
    recommended_actions: "Recommended next actions",
    fyi: "Lower priority / FYI",
};
function fmtDate(d, tz) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "short", day: "numeric" }).format(d);
}
const ORDER = ["requires_attention", "upcoming", "waiting", "project_changes", "risks_conflicts", "recommended_actions", "fyi"];
export function renderDegradedReview(input, reason) {
    const tz = input.timezone;
    const lines = [];
    lines.push(reason === "budget_ceiling"
        ? "DEGRADED REVIEW - model-spend limit reached. No AI composition was used; every item below comes directly from Finagai's records, without prioritization or recommendations."
        : "DEGRADED REVIEW - the composed review failed validation. No AI composition is shown; every item below comes directly from Finagai's records.");
    if (reason === "budget_ceiling") {
        lines.push(`Model spend this month: $${input.budget.monthToDateUsd.toFixed(2)} of a $${input.budget.ceilingUsd.toFixed(2)} hard ceiling (target $${input.budget.targetUsd.toFixed(2)}). Raising the ceiling requires your explicit decision.`);
    }
    lines.push(`Period: ${fmtDate(input.periodStart, tz)} to ${fmtDate(input.periodEnd, tz)}`);
    if (input.deferredCaptures > 0) {
        lines.push(`Captures waiting for budget: ${input.deferredCaptures}. They are stored safely and will be processed when budget is available.`);
    }
    const sections = [];
    // Must-mention items first within each section; then by due date; then title. No model ranking.
    for (const section of ORDER) {
        // Recommendations require judgment, so the degraded review never invents them.
        if (section === "recommended_actions")
            continue;
        const items = input.items.filter((i) => i.section === section).sort((a, b) => Number(b.mustMention) - Number(a.mustMention) ||
            (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || a.title.localeCompare(b.title));
        if (items.length === 0)
            continue;
        lines.push("", `## ${SECTION_TITLES[section]}`);
        for (const i of items) {
            const facts = [
                i.project ? `project: ${i.project}` : null,
                i.status ? `status: ${i.status}` : null,
                i.dueAt ? `due: ${fmtDate(i.dueAt, tz)}` : null,
                i.waitingOn ? `waiting on: ${i.waitingOn}` : null,
                i.daysSinceActivity !== null ? `no activity for ${i.daysSinceActivity} days` : null,
                i.note,
            ].filter(Boolean).join("; ");
            lines.push(`- ${i.title}${facts ? ` (${facts})` : ""} [${i.id}]`);
        }
        sections.push({ section, itemIds: items.map((i) => i.id) });
    }
    if (sections.length === 0)
        lines.push("", "No open items, deadlines, or changes were found in Finagai's records for this period.");
    const rendered = lines.join("\n");
    const missing = input.items.filter((i) => i.mustMention && !rendered.includes(`[${i.id}]`)).map((i) => i.id);
    return {
        content: { degraded: true, degradedReason: reason, modelInvoked: false, sections },
        rendered,
        validation: { mustMentionCovered: missing.length === 0, missing },
    };
}
/**
 * J3 composition entry: try the model; at the hard ceiling, fall back to the zero-model review.
 * Any other error propagates (the repair path handles validation failures separately).
 */
export async function composeOrDegrade(input, compose) {
    try {
        return { kind: "composed", value: await compose() };
    }
    catch (err) {
        if (err instanceof BudgetBlockedError && err.level === "ceiling") {
            return { kind: "degraded", review: renderDegradedReview(input, "budget_ceiling") };
        }
        throw err;
    }
}
//# sourceMappingURL=degraded.js.map