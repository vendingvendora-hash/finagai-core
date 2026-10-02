/**
 * Autonomous-builder configuration (ADR-042). Every limit is configurable through FINAGAI_AGENT_* variables.
 * Defaults are deliberately bounded: a runaway agent stops, checkpoints, and reports.
 */
export interface AgentConfig {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTotalUsd: number;            // hard cap on the builder's own model spend, across all runs and resumes
  maxIterationUsd: number;        // cap per agent run (one query) before a checkpoint
  maxTurnsPerIteration: number;   // agentic turns per run before a checkpoint
  maxIterations: number;          // runs per launch
  maxProvisionRuns: number;       // provisioning attempts per launch (each is idempotent; this bounds loops)
  maxConsecutiveErrors: number;   // runtime errors in a row before stopping
  browser: boolean;               // Chrome DevTools MCP for navigation-only browser help
  sandbox: boolean;               // OS-level Bash sandbox when the platform supports it
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function loadAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
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
