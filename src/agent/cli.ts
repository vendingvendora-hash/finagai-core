/**
 * Entry point. `npm run finagai:build` starts or continues; `finagai:resume` continues the saved session;
 * `finagai:status` prints the checkpoint; `finagai:fresh` starts a new agent session (keeping all state).
 */
import { join } from "node:path";
import { StateFile } from "../provision/state.js";
import { STEPS } from "../provision/steps.js";
import { loadAgentConfig } from "./config.js";
import { runBuilder } from "./launch.js";
import { TerminalOperator } from "./operator.js";
import { AgentStateFile } from "./state.js";

const repoDir = process.cwd();
const cmd = (process.argv[2] ?? "build") as "build" | "resume" | "status" | "fresh";
const op = new TerminalOperator();

if (cmd === "status") {
  const s = new AgentStateFile(join(repoDir, ".finagai", "agent-state.json")).data;
  const p = new StateFile(join(repoDir, ".finagai", "provision-state.json")).data;
  op.say(`Builder: ${s.status}; runs ${s.iterations}; spent $${s.totalCostUsd.toFixed(2)}; session ${s.sessionId ?? "none"}`);
  if (s.pendingHuman) op.say(`Waiting on you: ${s.pendingHuman.title}${s.pendingHuman.url ? ` (${s.pendingHuman.url})` : ""}`);
  if (s.lastVerification) op.say(`Last verification: ${s.lastVerification.ok ? "PASSED" : `not yet: ${s.lastVerification.failures.join("; ")}`}`);
  if (s.stopReason) op.say(`Stopped because: ${s.stopReason}`);
  for (const m of s.milestones.slice(-10)) op.say(`  milestone ${m.at.slice(0, 16)}  ${m.note}`);
  for (const st of STEPS) op.say(`  provision ${(p.steps[st.id]?.status ?? "pending").padEnd(7)} ${st.title}`);
  process.exit(0);
}

const state = new AgentStateFile(join(repoDir, ".finagai", "agent-state.json"));
process.on("SIGINT", () => {
  state.update((s) => { s.status = "checkpointed"; s.stopReason = "interrupted by Julian (Ctrl-C)"; });
  op.say("\nCheckpointed. Run `npm run finagai:resume` to continue exactly where this stopped.");
  process.exit(130);
});

const result = await runBuilder(cmd, { repoDir, cfg: loadAgentConfig(process.env), op, env: process.env });
process.exit(result.status === "complete" ? 0 : result.status === "checkpointed" ? 0 : 1);
