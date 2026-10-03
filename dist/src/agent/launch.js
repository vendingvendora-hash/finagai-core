/**
 * Finagai autonomous builder (ADR-042). Runtime: the official Claude Agent SDK (@anthropic-ai/claude-agent-sdk),
 * the engine behind Claude Code. Claude Cowork has no programmatic launch API, so the SDK is the supported path.
 *
 * Loop: each run resumes the same SDK session; between runs the launcher checkpoints, enforces limits, waits
 * for open human actions, and independently verifies any completion claim.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { makeLocalExec } from "../provision/exec.js";
import { redact, Secret } from "../provision/secret.js";
import { StateFile } from "../provision/state.js";
import { STEPS } from "../provision/steps.js";
import { COMPLETION_MARKER } from "./config.js";
import { buildBriefing } from "./context.js";
import { HumanDesk, provisionPrompter } from "./operator.js";
import { decide, DISALLOWED_TOOLS, PREAPPROVED_TOOLS } from "./permissions.js";
import { AgentStateFile } from "./state.js";
import { finagaiTools, ProvisionRunner } from "./tools.js";
import { defaultRunner, verifyCompletion } from "./verify.js";
/** Results report the SESSION's cumulative cost; charge only the increase (a fresh process may report per query). */
export function chargeFor(prevSessionCost, reported) {
    if (reported >= prevSessionCost)
        return { delta: reported - prevSessionCost, session: reported };
    return { delta: reported, session: prevSessionCost + reported };
}
/** Errors no retry can fix: stop at once and tell Julian. */
export function fatalApiProblem(text) {
    if (/credit balance is too low|insufficient.{0,20}(credit|balance|funds)|billing/i.test(text)) {
        return "The builder's Anthropic account is out of credits. Add credits in the Claude Console (Billing), then run npm run finagai:resume.";
    }
    if (/invalid (x-api-key|api key)|authentication_error|401\b|permission_error|api key.{0,20}(disabled|revoked|expired)/i.test(text)) {
        return "The builder's Anthropic API key was rejected. Create a new key, then run npm run finagai:resume and enter it.";
    }
    if (/rate_limit|overloaded/i.test(text))
        return null; // transient: the runtime retries
    return null;
}
/** The child runtime gets only what it needs: never provider credentials, never the builder's own key. */
const ENV_PASS = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TERM|TMPDIR|TMP|TEMP|TZ|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SystemRoot|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES)$/;
export function childEnv(env, extra = {}) {
    const out = {};
    for (const [k, v] of Object.entries(env))
        if (v !== undefined && ENV_PASS.test(k))
            out[k] = v;
    return { ...out, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", ...extra };
}
function installPreCommitHook(repoDir) {
    const hooks = join(repoDir, ".git", "hooks");
    if (!existsSync(hooks))
        return false;
    const hook = join(hooks, "pre-commit");
    writeFileSync(hook, "#!/bin/sh\n# Installed by the Finagai builder launcher: blocks secrets and state files.\nexec node dist/src/agent/secretScan.js --staged\n");
    chmodSync(hook, 0o755);
    return true;
}
const firstPrompt = `Begin. Your operating specification and a fresh startup briefing are in your system prompt.
Inspect the repository and current state yourself, decide the highest-priority unblocked work toward the completion
condition, and proceed. Use the finagai tools for provisioning, human actions, milestones, and the final verification.`;
function continuePrompt(last, failures) {
    return `Continue from the current state (the startup briefing in your system prompt was regenerated just now).
The previous run ended with: ${last}.${failures?.length ? `\nThe launcher's independent verification found these gaps:\n${failures.map((f) => `- ${f}`).join("\n")}` : ""}
Pick the highest-priority unblocked work toward the completion condition and continue.`;
}
export async function runBuilder(mode, d) {
    const { repoDir, cfg, op } = d;
    const state = new AgentStateFile(join(repoDir, ".finagai", "agent-state.json"));
    if (state.data.status === "complete")
        return { status: "complete", message: COMPLETION_MARKER };
    if (mode === "fresh")
        state.update((s) => { delete s.sessionId; s.sessionCostUsd = 0; });
    // The builder's own Anthropic key reaches the runtime through apiKeyHelper, never through the shell environment.
    const keyValue = d.env.FINAGAI_BUILDER_ANTHROPIC_KEY ?? d.env.ANTHROPIC_API_KEY
        ?? await op.askHidden("Anthropic API key for the BUILDER agent (Claude Console; a key separate from Finagai's runtime key)");
    const key = new Secret(keyValue);
    const keyDir = mkdtempSync(join(tmpdir(), "finagai-builder-"));
    chmodSync(keyDir, 0o700);
    const keyFile = join(keyDir, "key");
    writeFileSync(keyFile, key.reveal(), { mode: 0o600 });
    try {
        const hookInstalled = installPreCommitHook(repoDir);
        const spec = readFileSync(join(repoDir, "prompts", "finagai-autonomous-builder.md"), "utf8");
        const releasedMigrations = new Set(readdirSync(join(repoDir, "migrations")).filter((f) => f.endsWith(".sql")).map((f) => `migrations/${f}`));
        const desk = new HumanDesk(op, state);
        const policy = { repoDir, protectedPaths: [keyDir], humanTakeoverActive: () => desk.takeoverActive, releasedMigrations };
        const provState = new StateFile(join(repoDir, ".finagai", "provision-state.json"));
        const vault = new Map(); // provider secrets typed by Julian live here for this launch only
        const prompt = provisionPrompter(op, desk);
        const makeCtx = (log) => d.provisionCtx?.(log, prompt) ?? {
            state: provState, prompt, log: (l) => { log(l); op.say(`[provision] ${l}`); }, ep: {}, repoDir,
            exec: makeLocalExec(repoDir, (l) => op.say(l)), db: { ssl: true }, vault, pollMs: 10_000,
        };
        const provision = new ProvisionRunner(makeCtx, d.provisionSteps ?? STEPS, provState, cfg.maxProvisionRuns);
        const verify = d.verify ?? (() => verifyCompletion({ provState, run: defaultRunner(repoDir) }));
        const hook = async (input) => {
            const i = input;
            if (!i.tool_name)
                return {};
            const v = decide(policy, i.tool_name, i.tool_input ?? {});
            return v.allow ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Finagai policy: ${v.reason}` } };
        };
        const canUseTool = async (name, input) => {
            const v = decide(policy, name, input);
            return v.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `Finagai policy: ${v.reason}` };
        };
        const mcpServers = { finagai: finagaiTools({ state, desk, cfg, provision, verify }) };
        if (cfg.browser)
            mcpServers["chrome-devtools"] = { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] };
        op.say(`Finagai builder: model ${cfg.model} (effort ${cfg.effort}); limits $${cfg.maxTotalUsd} total, $${cfg.maxIterationUsd} per run, ` +
            `${cfg.maxTurnsPerIteration} turns per run, ${cfg.maxIterations} runs. Spent so far: $${state.data.totalCostUsd.toFixed(2)}. ` +
            `Secret-scan hook: ${hookInstalled ? "installed" : "pending (no git repository yet)"}.`);
        const q = d.query ?? sdkQuery;
        let lastEnd = state.data.lastResult?.subtype ?? "nothing yet";
        let lastText = "", sameNoProgress = 0;
        for (let iter = 0;; iter++) {
            const remaining = cfg.maxTotalUsd - state.data.totalCostUsd;
            const stop = (status, message) => {
                state.update((s) => { s.status = status === "complete" ? "complete" : status; s.stopReason = message; });
                op.say(`\n${message}`);
                return { status, message };
            };
            if (remaining <= 0.01)
                return stop("limit_reached", `Builder spending limit reached ($${cfg.maxTotalUsd}). Progress is checkpointed; raise FINAGAI_AGENT_MAX_USD deliberately and run npm run finagai:resume.`);
            if (iter >= cfg.maxIterations)
                return stop("checkpointed", `Run limit for this launch reached (${cfg.maxIterations}). Checkpointed; run npm run finagai:resume to continue.`);
            if (state.data.consecutiveErrors >= cfg.maxConsecutiveErrors)
                return stop("failed", `Stopped after ${state.data.consecutiveErrors} consecutive runtime errors. Checkpointed; see the log above, then npm run finagai:resume.`);
            const briefing = await buildBriefing(repoDir);
            const isFirst = !state.data.sessionId;
            state.update((s) => { s.status = "running"; });
            let resultText = "", subtype = "unknown", cost = 0, turns = 0, gotResult = false;
            try {
                for await (const m of q({
                    prompt: isFirst ? firstPrompt : continuePrompt(lastEnd, state.data.lastVerification?.ok === false ? state.data.lastVerification.failures : undefined),
                    options: {
                        cwd: repoDir, model: cfg.model, effort: cfg.effort,
                        maxTurns: cfg.maxTurnsPerIteration, maxBudgetUsd: Math.max(0.01, Math.min(cfg.maxIterationUsd, remaining)),
                        ...(state.data.sessionId ? { resume: state.data.sessionId } : {}),
                        systemPrompt: { type: "preset", preset: "claude_code", append: `${spec}\n\n${briefing}` },
                        permissionMode: "default", allowedTools: PREAPPROVED_TOOLS, disallowedTools: DISALLOWED_TOOLS, canUseTool,
                        hooks: { PreToolUse: [{ hooks: [hook] }] },
                        mcpServers, settingSources: ["project"],
                        settings: {
                            apiKeyHelper: `cat '${keyFile}'`,
                            ...(cfg.sandbox ? { sandbox: { enabled: true, failIfUnavailable: false, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
                                    filesystem: { denyRead: [keyDir, "~/.ssh", "~/.aws", "~/.config/gh", "~/.gnupg"] } } } : {}),
                        },
                        env: childEnv(d.env, d.runtimeEnv),
                        stderr: (s) => { if (/error/i.test(s))
                            op.say(`[runtime] ${redact(s.slice(0, 300))}`); },
                    },
                })) {
                    if (m.type === "system" && m.subtype === "init") {
                        if (m.session_id && m.session_id !== state.data.sessionId)
                            state.update((s) => { s.sessionId = m.session_id; s.sessionCostUsd = 0; });
                    }
                    else if (m.type === "assistant") {
                        for (const b of m.message.content) {
                            if (b.type === "text" && b.text.trim())
                                op.say(`[builder] ${b.text.trim().slice(0, 1500)}`);
                            if (b.type === "tool_use")
                                op.say(`[builder] → ${b.name}${b.name === "Bash" ? `: ${String(b.input.command ?? "").slice(0, 160)}` : ""}`);
                        }
                    }
                    else if (m.type === "result") {
                        gotResult = true;
                        subtype = m.subtype;
                        cost = m.total_cost_usd ?? 0;
                        turns = m.num_turns ?? 0;
                        resultText = m.subtype === "success" ? m.result : "";
                        if (m.is_error && !resultText)
                            resultText = JSON.stringify(m.errors ?? "");
                    }
                }
                state.update((s) => { s.consecutiveErrors = 0; });
            }
            catch (err) {
                // The SDK yields an error result (turn or budget limit) and then throws; that is a normal checkpoint.
                if (gotResult)
                    state.update((s) => { s.consecutiveErrors = 0; });
                else {
                    subtype = `runtime_error: ${redact(err instanceof Error ? err.message : "error").slice(0, 200)}`;
                    state.update((s) => { s.consecutiveErrors++; });
                }
            }
            const charge = chargeFor(state.data.sessionCostUsd ?? 0, cost);
            state.update((s) => {
                s.iterations++;
                s.totalCostUsd = Number((s.totalCostUsd + charge.delta).toFixed(6));
                s.sessionCostUsd = charge.session;
                s.totalTurns += turns;
                s.lastResult = { at: new Date().toISOString(), subtype, costUsd: cost, turns };
            });
            lastEnd = subtype;
            op.say(`[launcher] run ${state.data.iterations} ended: ${subtype}; $${charge.delta.toFixed(4)} this run, $${state.data.totalCostUsd.toFixed(2)} of $${cfg.maxTotalUsd} total.`);
            const fatal = fatalApiProblem(`${resultText} ${subtype}`);
            if (fatal)
                return stop("blocked", fatal);
            // The same short answer twice with no work done means the loop is not progressing: stop instead of spinning.
            const trimmed = resultText.trim();
            sameNoProgress = turns <= 1 && trimmed && trimmed === lastText ? sameNoProgress + 1 : 0;
            lastText = trimmed;
            if (sameNoProgress >= 1)
                return stop("blocked", `The builder is not making progress (it answered "${redact(trimmed).slice(0, 160)}" twice without working). Checkpointed; fix the cause above, then run npm run finagai:resume.`);
            if (resultText.includes(COMPLETION_MARKER)) {
                op.say("[launcher] the builder reports completion; running the independent verification...");
                const v = await verify();
                state.update((s) => { s.lastVerification = { at: new Date().toISOString(), ...v }; });
                if (v.ok)
                    return stop("complete", COMPLETION_MARKER);
                op.say(`[launcher] not yet: ${v.failures.join("; ")}`);
                lastEnd = "a completion claim that failed independent verification";
            }
            // Open human actions: the agent ended its run, so wait here instead of spending turns polling.
            while (desk.takeoverActive)
                await new Promise((r) => setTimeout(r, 1000));
        }
    }
    finally {
        rmSync(keyDir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=launch.js.map