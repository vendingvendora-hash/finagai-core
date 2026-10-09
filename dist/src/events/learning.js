/**
 * Phase 6 (ADR-085): learning is woken by the event engine like any other workflow — once a day a `learning.due`
 * event runs one learning pass (Area-independent). Pending learned changes surface as authorization escalations
 * (stateNeeds), so the same "only what needs Julian" channel carries them.
 */
import { runLearning } from "../learning/index.js";
export const LEARNING_EVERY_MS = 24 * 3_600_000;
export const learningWatcher = {
    name: "learning", everyMs: LEARNING_EVERY_MS,
    async poll(ctx) {
        const day = ctx.now.toISOString().slice(0, 10);
        return { events: [{ source: "learning", kind: "learning.due", externalId: `learning:${day}`, occurredAt: ctx.now.toISOString(), summary: `Daily learning pass (${day})`, payload: { day } }],
            cursors: [{ scope: "", cursor: ctx.now.toISOString() }], problems: [] };
    },
};
export const learningModule = {
    watchers: [learningWatcher],
    subscriptions: [{ id: "learning.daily", area: "*", workflow: "learning.run", async match(e) { return e.kind === "learning.due" ? "the daily learning pass is due" : null; } }],
    workflows: [{
            name: "learning.run",
            async run(ctx) {
                const r = await runLearning(ctx.pool, { dryRun: ctx.dryRun, now: ctx.now });
                if (r.learnerProblems.length && !r.candidates)
                    throw new Error(`every learner failed: ${r.learnerProblems.join("; ")}`);
                return { changes: [...r.learned.map((x) => `learned ${x}`), ...r.proposed.map((x) => `proposed (needs Julian's approval): ${x}`), ...r.retired.map((x) => `retired: ${x}`), ...r.decided.map((x) => `Julian ${x}`)],
                    escalations: [] }; // pending proposals are escalated from state (engine.stateNeeds)
            },
        }],
};
//# sourceMappingURL=learning.js.map