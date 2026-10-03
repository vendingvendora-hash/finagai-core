/** Non-secret execution state of the autonomous builder (.finagai/agent-state.json). Refuses secrets. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { containsSecret, redact } from "../provision/secret.js";
export class AgentStateFile {
    path;
    data;
    constructor(path) {
        this.path = path;
        this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8"))
            : { version: 2, status: "new", iterations: 0, totalCostUsd: 0, totalTurns: 0, provisionRuns: 0, consecutiveErrors: 0, milestones: [] };
        if (this.data.version === 1) {
            // Version 1 added each result's SESSION-cumulative cost per run, over-counting resumed sessions.
            // A version-1 state has one session, so its true total is the last reported session cost.
            const actual = this.data.lastResult?.costUsd ?? 0;
            this.data.version = 2;
            this.data.totalCostUsd = actual;
            this.data.sessionCostUsd = actual;
        }
    }
    update(fn) {
        fn(this.data);
        const text = JSON.stringify(this.data, null, 2);
        // Defense in depth: anything secret-looking is redacted rather than persisted.
        const safe = containsSecret(text) ? redact(text) : text;
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, safe);
        if (safe !== text)
            this.data = JSON.parse(safe);
    }
}
//# sourceMappingURL=state.js.map