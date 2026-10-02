/**
 * The autonomous builder launcher (ADR-042) against the REAL Claude Code runtime (Agent SDK + native binary).
 * Only the model is scripted (test/helpers/mockClaude.ts); the launcher, permission hooks, MCP tools,
 * checkpoint files, and provisioning runner are the production code.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentConfig, type AgentConfig } from "../../src/agent/config.js";
import { runBuilder } from "../../src/agent/launch.js";
import type { Operator } from "../../src/agent/operator.js";
import { redact, Secret } from "../../src/provision/secret.js";
import { StateFile } from "../../src/provision/state.js";
import type { Step } from "../../src/provision/steps.js";
import { MockClaude, toolResults, type Reply } from "../helpers/mockClaude.js";

const BUILDER_KEY = "sk-ant-builder-test-key-0123456789";

class ScriptedJulian implements Operator {
  lines: string[] = [];
  hidden: string[] = [];
  doneDelayMs = 150;
  say(t: string) { this.lines.push(redact(t)); }
  async ask() { return "yes"; }
  async askHidden() { return this.hidden.shift() ?? ""; }
  async waitDone() { await new Promise((r) => setTimeout(r, this.doneDelayMs)); }
  async showOnce() {}
}

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "finagai-builder-ws-"));
  for (const p of ["prompts/finagai-autonomous-builder.md", "README.md", "docs/adr/index.md", "docs/runbooks/real-data-gate.md"]) {
    mkdirSync(join(ws, p, ".."), { recursive: true });
    cpSync(p, join(ws, p));
  }
  mkdirSync(join(ws, "migrations"));
  writeFileSync(join(ws, "migrations", "0001_foundation.sql"), "-- released\n");
  mkdirSync(join(ws, "src", "agent"), { recursive: true });
  writeFileSync(join(ws, "src", "agent", "permissions.ts"), "// guardrail\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  return ws;
}

const cfgWith = (over: Partial<AgentConfig>): AgentConfig => ({ ...loadAgentConfig({}), browser: false, sandbox: false, maxIterations: 1, ...over });
const env = { ...process.env, FINAGAI_BUILDER_ANTHROPIC_KEY: BUILDER_KEY, ANTHROPIC_API_KEY: "" };
let mock: MockClaude | undefined;
afterEach(() => mock?.stop());

function scripted(steps: Array<Reply | ((r: import("../helpers/mockClaude.js").MainRequest) => Reply)>) {
  return (r: import("../helpers/mockClaude.js").MainRequest): Reply => {
    const s = steps[Math.min(r.n, steps.length - 1)]!;
    return typeof s === "function" ? s(r) : s;
  };
}

describe("autonomous builder on the real Claude Code runtime", () => {
  it("starts the runtime with the spec and a repository briefing, works in the repository, and is refused forbidden actions", async () => {
    const ws = workspace();
    mock = await new MockClaude(scripted([
      { tool: "Read", input: { file_path: join(ws, "README.md") } },
      { tool: "Write", input: { file_path: join(ws, "notes", "agent.txt"), content: "written by the builder\n" } },
      { tool: "Bash", input: { command: "ls notes && git status --porcelain", description: "check" } },
      { tool: "Bash", input: { command: "node -e \"process.stdout.write('key-in-shell:' + String(Object.keys(process.env).some((k) => k.includes('KEY'))))\"", description: "probe" } },
      { tool: "Bash", input: { command: "printenv", description: "forbidden" } },
      { tool: "Read", input: { file_path: "/etc/hostname" } },
      { tool: "Write", input: { file_path: join(ws, "src", "agent", "permissions.ts"), content: "// weakened" } },
      { tool: "Bash", input: { command: "npm run provision", description: "forbidden route" } },
      { text: "Checkpoint reached." },
    ])).start();
    const julian = new ScriptedJulian();
    const res = await runBuilder("build", { repoDir: ws, cfg: cfgWith({}), op: julian, env, runtimeEnv: { ANTHROPIC_BASE_URL: mock.url } });

    expect(res.status).toBe("checkpointed");
    const first = mock.requests[0]!;
    expect(first.system).toContain("FINAGAI AUTONOMOUS BUILDER");
    expect(first.system).toContain("Your assignment is to produce a working Finagai system, not additional architecture documents.");
    expect(first.system).toContain("Startup briefing");
    expect(first.system).toMatch(/Branch: main/);
    expect(first.apiKey).toBe(BUILDER_KEY); // delivered through apiKeyHelper
    expect(mock.all.every((r) => r.apiKey === "" || r.apiKey === BUILDER_KEY)).toBe(true);

    expect(readFileSync(join(ws, "notes", "agent.txt"), "utf8")).toBe("written by the builder\n");
    const results = mock.requests.slice(1).map((r) => toolResults(r)[0]!);
    expect(results[0]!.text).toContain("Finagai"); // README content came back
    expect(results[2]!.text).toContain("agent.txt");
    expect(results[3]!.text).toContain("key-in-shell:false"); // the builder's key is not in the shell environment
    for (const i of [4, 5, 6, 7]) { expect(results[i]!.isError, `result ${i}`).toBe(true); expect(results[i]!.text).toMatch(/Finagai policy/); }
    expect(readFileSync(join(ws, "src", "agent", "permissions.ts"), "utf8")).toBe("// guardrail\n");
    expect(JSON.parse(readFileSync(join(ws, ".finagai", "agent-state.json"), "utf8"))).toMatchObject({ iterations: 1, status: "checkpointed" });
  }, 120_000);

  it("checkpoints at the turn limit, resumes the same session, and accepts completion only after independent verification", async () => {
    const ws = workspace();
    mock = await new MockClaude(scripted([
      { tool: "Bash", input: { command: "echo first-turn", description: "a" } },
      { tool: "Bash", input: { command: "echo second-turn", description: "b" } },
      { tool: "Bash", input: { command: "echo third-turn", description: "c" } },
    ])).start();
    const julian = new ScriptedJulian();
    const r1 = await runBuilder("build", { repoDir: ws, cfg: cfgWith({ maxTurnsPerIteration: 2 }), op: julian, env, runtimeEnv: { ANTHROPIC_BASE_URL: mock.url } });
    expect(r1.status).toBe("checkpointed");
    const saved = JSON.parse(readFileSync(join(ws, ".finagai", "agent-state.json"), "utf8"));
    expect(saved.sessionId).toMatch(/[0-9a-f-]{36}/);
    expect(saved.lastResult.subtype).toBe("error_max_turns");
    mock.stop();

    // A later `npm run finagai:resume`: same session, history intact; a false completion claim is caught.
    let verifyCalls = 0;
    mock = await new MockClaude(scripted([
      (r) => ({ text: JSON.stringify(r.body.messages).includes("first-turn") ? "Everything is done.\nFINAGAI READY FOR COLD-START SEEDING" : "HISTORY LOST" }),
      (r) => ({ text: JSON.stringify(r.body.messages).includes("independent verification found these gaps") ? "Fixed the gaps.\nFINAGAI READY FOR COLD-START SEEDING" : "NO FEEDBACK" }),
    ])).start();
    const r2 = await runBuilder("resume", { repoDir: ws, cfg: cfgWith({ maxIterations: 3 }), op: julian, env, runtimeEnv: { ANTHROPIC_BASE_URL: mock.url },
      verify: async () => (++verifyCalls === 1 ? { ok: false, failures: ["readiness workflow has not passed"] } : { ok: true, failures: [] }) });
    expect(r2).toEqual({ status: "complete", message: "FINAGAI READY FOR COLD-START SEEDING" });
    expect(verifyCalls).toBe(2);
    expect(JSON.parse(readFileSync(join(ws, ".finagai", "agent-state.json"), "utf8"))).toMatchObject({ status: "complete", sessionId: saved.sessionId });
  }, 180_000);

  it("supervises the provisioner: hidden prompts and the human pause happen in Julian's terminal, never in the model's context", async () => {
    const ws = workspace();
    const demo: Step = { id: "demo", title: "Demo provider", async run(ctx) {
      await ctx.prompt.act("demo_login", { title: "Sign in to Demo", steps: ["Log in and complete MFA."], url: "https://demo.example/login" });
      const key = await ctx.prompt.askSecret("demo_key", "Demo API key");
      ctx.state.set("demo_resource", "res_123");
      return `demo provisioned (key length ${key.reveal().length})`;
    } };
    mock = await new MockClaude(scripted([
      { tool: "mcp__finagai__provision_start", input: {} },
      { tool: "Bash", input: { command: "sleep 2", description: "let Julian act" } },
      { tool: "mcp__finagai__provision_status", input: {} },
      { text: "Provisioning step finished." },
    ])).start();
    const julian = new ScriptedJulian();
    julian.hidden.push("demo-secret-value-0123456789");
    const res = await runBuilder("build", { repoDir: ws, cfg: cfgWith({}), op: julian, env, runtimeEnv: { ANTHROPIC_BASE_URL: mock.url }, provisionSteps: [demo] });

    expect(res.status).toBe("checkpointed");
    expect(julian.lines.join("\n")).toMatch(/YOUR ACTION: Sign in to Demo[\s\S]*https:\/\/demo\.example\/login/);
    const status = toolResults(mock.requests[3]!)[0]!.text;
    expect(status).toMatch(/demo provisioned/);
    expect(new StateFile(join(ws, ".finagai", "provision-state.json")).get("demo_resource")).toBe("res_123");
    const everything = JSON.stringify(mock.requests.map((r) => r.body)) + julian.lines.join("\n") + readFileSync(join(ws, ".finagai", "provision-state.json"), "utf8");
    expect(everything).not.toContain("demo-secret-value-0123456789");
    expect(JSON.parse(readFileSync(join(ws, ".finagai", "agent-state.json"), "utf8")).pendingHuman).toBeUndefined();
  }, 120_000);

  it("stops cleanly at the configured spending limit, and redacts secrets that appear in the agent's output", async () => {
    const ws = workspace();
    const canary = new Secret("canary-secret-value-987654321");
    mock = await new MockClaude(scripted([
      { text: `I noticed ${canary.reveal()} in a file.` },
    ])).start();
    mock.usage = { input_tokens: 400_000, output_tokens: 50_000 };
    const julian = new ScriptedJulian();
    const res = await runBuilder("build", { repoDir: ws, cfg: cfgWith({ maxTotalUsd: 0.5, maxIterationUsd: 0.5, maxIterations: 5 }), op: julian, env, runtimeEnv: { ANTHROPIC_BASE_URL: mock.url } });
    expect(res.status).toBe("limit_reached");
    expect(res.message).toMatch(/spending limit reached/);
    expect(julian.lines.join("\n")).toContain("[secret]");
    expect(julian.lines.join("\n")).not.toContain("canary-secret-value-987654321");
    expect(readFileSync(join(ws, ".finagai", "agent-state.json"), "utf8")).not.toContain("canary-secret-value-987654321");
    expect(existsSync(join(ws, ".git", "hooks", "pre-commit"))).toBe(true);
  }, 120_000);

  it("stops at once when the builder's Anthropic account is out of credits, without counting refused calls as spend", async () => {
    const ws = workspace();
    mock = await new MockClaude(() => ({ apiError: { status: 400, type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } })).start();
    const julian = new ScriptedJulian();
    const res = await runBuilder("build", { repoDir: ws, cfg: cfgWith({ maxIterations: 30 }), op: julian, env, runtimeEnv: { ANTHROPIC_BASE_URL: mock.url } });
    expect(res.status).toBe("blocked");
    expect(res.message).toMatch(/out of credits/);
    const st = JSON.parse(readFileSync(join(ws, ".finagai", "agent-state.json"), "utf8"));
    expect(st.iterations).toBe(1);
    expect(st.totalCostUsd).toBe(0);
  }, 120_000);
});
