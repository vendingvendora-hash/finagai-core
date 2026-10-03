const num = (v, d) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export function loadAgentConfig(env) {
    const effort = env.FINAGAI_AGENT_EFFORT;
    return {
        model: env.FINAGAI_AGENT_MODEL ?? "claude-opus-5-5",
        effort: effort === "low" || effort === "medium" || effort === "xhigh" || effort === "max" ? effort : "high",
        maxTotalUsd: num(env.FINAGAI_AGENT_MAX_USD, 60),
        maxIterationUsd: num(env.FINAGAI_AGENT_MAX_RUN_USD, 8),
        maxTurnsPerIteration: num(env.FINAGAI_AGENT_MAX_TURNS, 200),
        maxIterations: num(env.FINAGAI_AGENT_MAX_RUNS, 30),
        maxProvisionRuns: num(env.FINAGAI_AGENT_MAX_PROVISION_RUNS, 6),
        maxConsecutiveErrors: num(env.FINAGAI_AGENT_MAX_ERRORS, 3),
        browser: env.FINAGAI_AGENT_BROWSER !== "off",
        sandbox: env.FINAGAI_AGENT_SANDBOX !== "off",
    };
}
export const COMPLETION_MARKER = "FINAGAI READY FOR COLD-START SEEDING";
//# sourceMappingURL=config.js.map