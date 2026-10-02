/** Non-secret execution state of the autonomous builder (.finagai/agent-state.json). Refuses secrets. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { containsSecret, redact } from "../provision/secret.js";

export interface PendingHuman { id: string; title: string; steps: string[]; url?: string; since: string }

export interface AgentState {
  version: 1;
  sessionId?: string;
  status: "new" | "running" | "waiting_human" | "checkpointed" | "limit_reached" | "failed" | "complete";
  iterations: number;
  totalCostUsd: number;
  totalTurns: number;
  provisionRuns: number;
  consecutiveErrors: number;
  milestones: Array<{ at: string; note: string }>;
  pendingHuman?: PendingHuman;
  lastResult?: { at: string; subtype: string; costUsd: number; turns: number };
  lastVerification?: { at: string; ok: boolean; failures: string[] };
  stopReason?: string;
}

export class AgentStateFile {
  data: AgentState;
  constructor(readonly path: string) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as AgentState
      : { version: 1, status: "new", iterations: 0, totalCostUsd: 0, totalTurns: 0, provisionRuns: 0, consecutiveErrors: 0, milestones: [] };
  }
  update(fn: (s: AgentState) => void): void {
    fn(this.data);
    const text = JSON.stringify(this.data, null, 2);
    // Defense in depth: anything secret-looking is redacted rather than persisted.
    const safe = containsSecret(text) ? redact(text) : text;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, safe);
    if (safe !== text) this.data = JSON.parse(safe) as AgentState;
  }
}
