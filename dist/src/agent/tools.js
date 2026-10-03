/**
 * The builder's own tools (in-process MCP server "finagai", ADR-042). They run in the LAUNCHER process:
 * provisioning executes here with Julian's terminal for hidden prompts, so secrets never reach the agent.
 * Every result passes the redactor.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { redact } from "../provision/secret.js";
export class ProvisionRunner {
    makeCtx;
    steps;
    provState;
    maxRuns;
    running = false;
    current = null;
    lastError = null;
    log = [];
    runs = 0;
    constructor(makeCtx, steps, provState, maxRuns) {
        this.makeCtx = makeCtx;
        this.steps = steps;
        this.provState = provState;
        this.maxRuns = maxRuns;
    }
    start(only) {
        if (this.running)
            return "provisioning is already running; poll provision_status";
        if (this.runs >= this.maxRuns)
            return `provisioning run limit reached (${this.maxRuns} this launch); diagnose with provision_status, fix the cause, then relaunch`;
        this.runs++;
        this.running = true;
        this.lastError = null;
        const ctx = this.makeCtx((l) => { this.log.push(redact(l)); if (this.log.length > 200)
            this.log.shift(); });
        void (async () => {
            try {
                for (const s of this.steps) {
                    if (only && !only.includes(s.id))
                        continue;
                    this.current = s.id;
                    try {
                        const detail = await s.run(ctx);
                        this.provState.step(s.id, "done", detail);
                    }
                    catch (err) {
                        const msg = redact(err instanceof Error ? err.message : "failed");
                        this.provState.step(s.id, "failed", msg);
                        this.lastError = `${s.id}: ${msg}`;
                        return;
                    }
                }
            }
            finally {
                this.running = false;
                this.current = null;
            }
        })();
        return `provisioning started (run ${this.runs} of at most ${this.maxRuns}); hidden prompts and human actions appear in Julian's terminal`;
    }
    status() {
        return {
            running: this.running, currentStep: this.current, lastError: this.lastError,
            steps: this.steps.map((s) => ({ id: s.id, title: s.title, ...(this.provState.data.steps[s.id] ?? { status: "pending" }) })),
            recentLog: this.log.slice(-15),
        };
    }
}
const text = (v) => ({ content: [{ type: "text", text: redact(typeof v === "string" ? v : JSON.stringify(v, null, 2)) }] });
export function finagaiTools(d) {
    return createSdkMcpServer({
        name: "finagai",
        version: "1.0.0",
        tools: [
            tool("status", "Builder state: iterations, spend versus limits, milestones, pending human action, last verification.", {}, async () => {
                const s = d.state.data;
                return text({ ...s, limits: { maxTotalUsd: d.cfg.maxTotalUsd, maxIterations: d.cfg.maxIterations }, remainingUsd: Math.max(0, d.cfg.maxTotalUsd - s.totalCostUsd) });
            }),
            tool("provision_start", "Start (or resume) the idempotent provisioner in the launcher. Optional `steps` limits it to step ids. Returns at once; poll provision_status. Hidden prompts and human actions appear in Julian's terminal, never here.", { steps: z.array(z.string()).optional() }, async (a) => text(d.provision.start(a.steps))),
            tool("provision_status", "Provisioning progress: per-step status and detail, current step, last error, recent log (secrets redacted).", {}, async () => text(d.provision.status())),
            tool("request_human_action", "Ask Julian for a human-only action (login, CAPTCHA, MFA, passkey, billing, legal acceptance, OAuth authorization, principal approval). Give the exact page and the fewest steps. Returns an id; continue unrelated work and check human_action_status or wait_for_human.", { title: z.string().min(3).max(200), steps: z.array(z.string().min(1).max(300)).min(1).max(8), url: z.string().url().optional() }, async (a) => { const id = `h-${randomUUID().slice(0, 8)}`; void d.desk.begin(id, { title: a.title, steps: a.steps, ...(a.url ? { url: a.url } : {}) }); return text({ id, note: "Julian has been asked in his terminal." }); }),
            tool("human_action_status", "Whether a human action is still open.", { id: z.string() }, async (a) => text({ id: a.id, open: d.desk.isOpen(a.id) })),
            tool("wait_for_human", "Block up to `seconds` (max 600) for a human action to finish, when nothing else is unblocked. Saves turns compared with polling.", { id: z.string(), seconds: z.number().int().min(1).max(600) }, async (a) => {
                const end = Date.now() + a.seconds * 1000;
                while (d.desk.isOpen(a.id) && Date.now() < end)
                    await new Promise((r) => setTimeout(r, 500));
                return text({ id: a.id, open: d.desk.isOpen(a.id) });
            }),
            tool("record_milestone", "Record a milestone in the builder's checkpoint (non-secret text).", { note: z.string().min(3).max(500) }, async (a) => { d.state.update((s) => { s.milestones.push({ at: new Date().toISOString(), note: a.note }); }); return text("recorded"); }),
            tool("verify_completion", "Run the launcher's INDEPENDENT completion check (tests, provisioning, readiness workflow, deployed service). Only a passing check ends the work.", {}, async () => { const v = await d.verify(); d.state.update((s) => { s.lastVerification = { at: new Date().toISOString(), ...v }; }); return text(v); }),
        ],
    });
}
//# sourceMappingURL=tools.js.map