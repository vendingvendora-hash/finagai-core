const notYet = (milestone) => async () => ({
    status: "skipped",
    detail: `not implemented until ${milestone}`,
});
export function placeholderHandlers() {
    return {
        weekly_review: notYet("M6 (J3 pipeline)"),
        missed_run_check: notYet("M6 (J3 delivery)"),
        daily_maintenance: notYet("wired in scheduler.ts"),
    };
}
//# sourceMappingURL=handlers.js.map