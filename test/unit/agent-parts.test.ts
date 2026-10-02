import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanDiff } from "../../src/agent/secretScan.js";
import { verifyCompletion } from "../../src/agent/verify.js";
import { chargeFor, childEnv, fatalApiProblem } from "../../src/agent/launch.js";
import { writeFileSync } from "node:fs";
import { AgentStateFile } from "../../src/agent/state.js";
import { loadAgentConfig } from "../../src/agent/config.js";
import { Secret } from "../../src/provision/secret.js";
import { StateFile } from "../../src/provision/state.js";
import { STEPS } from "../../src/provision/steps.js";

describe("pre-commit secret scan", () => {
  it("blocks state files, credential files, and secret-shaped lines; allows normal code and examples", () => {
    expect(scanDiff([".finagai/provision-state.json", ".env", "src/a.ts"], [])).toHaveLength(2);
    expect(scanDiff(["src/a.ts"], ["+const k = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345'"])).toEqual(["possible Anthropic key in a staged line"]);
    expect(scanDiff(["src/a.ts"], ["+url = 'postgres://finagai_app:S3cretPassw0rdLong@ep-x.neon.tech/finagai'"])).toEqual(["possible database URL with password in a staged line"]);
    expect(scanDiff(["src/a.ts"], ["+ANTHROPIC_API_KEY=sk-ant-api03-placeholder-not-real-xxxxxxxx", "+export const x = 1;"])).toEqual([]);
  });
});

describe("independent completion verification", () => {
  const prov = () => new StateFile(join(mkdtempSync(join(tmpdir(), "v-")), "s.json"));
  const okRun = async (cmd: string, args: string[]) => ({ code: 0, out: cmd === "git" && args[0] === "rev-list" ? "0\n" : "" });
  it("refuses completion while anything is missing", async () => {
    const v = await verifyCompletion({ provState: prov(), run: okRun, fetchFn: (async () => new Response("{}", { status: 503 })) as typeof fetch });
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual(expect.arrayContaining(["readiness workflow has not passed (Gates 1, 3, 4 and the J3 evaluation)", "no deployed service URL recorded",
      "Claude connector not connected and pinned", `provisioning step not done: ${STEPS[0]!.id}`]));
  });
  it("passes only when tests, git, provisioning, readiness, and the live service all check out", async () => {
    const p = prov();
    for (const s of STEPS) p.step(s.id, "done", s.id === "readiness" ? "backup: success; readiness: success (url)" : "ok");
    p.set("base_url", "https://finagai-core.onrender.com"); p.set("pinned_client_id", "claude");
    const fetchFn = (async (u: string) => new Response(JSON.stringify(u.endsWith("/health") ? { status: "ok" } : { resource: "https://finagai-core.onrender.com/mcp" }))) as typeof fetch;
    expect(await verifyCompletion({ provState: p, run: okRun, fetchFn })).toEqual({ ok: true, failures: [] });
    const dirty = async (cmd: string, args: string[]) => ({ code: 0, out: args[0] === "status" ? " M src/x.ts\n" : "0\n" });
    expect((await verifyCompletion({ provState: p, run: dirty, fetchFn })).failures).toEqual(["uncommitted changes in the repository"]);
  });
});

describe("runtime environment and state", () => {
  it("passes no credentials to the agent runtime", () => {
    const e = childEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "x", GITHUB_TOKEN: "y", DATABASE_URL: "z", RENDER_API_KEY: "w", LANG: "en" });
    expect(Object.keys(e).sort()).toEqual(["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "HOME", "LANG", "PATH"]);
  });
  it("never persists a registered secret in the builder state", () => {
    const s = new Secret("very-secret-token-value-123");
    const f = new AgentStateFile(join(mkdtempSync(join(tmpdir(), "a-")), "agent-state.json"));
    f.update((d) => { d.milestones.push({ at: "now", note: `token ${s.reveal()} rotated` }); });
    expect(readFileSync(f.path, "utf8")).not.toContain("very-secret-token-value-123");
  });
  it("has bounded defaults and honors explicit limits", () => {
    expect(loadAgentConfig({})).toMatchObject({ model: "claude-opus-5-5", maxTotalUsd: 60, maxIterations: 30, browser: true, sandbox: true });
    expect(loadAgentConfig({ FINAGAI_AGENT_MAX_USD: "15", FINAGAI_AGENT_BROWSER: "off", FINAGAI_AGENT_MAX_USD_BAD: "x" })).toMatchObject({ maxTotalUsd: 15, browser: false });
  });
});

describe("builder spend accounting and stop conditions", () => {
  it("charges only the increase in a resumed session's cumulative cost", () => {
    let session = 0, total = 0;
    for (const reported of [1.2926, 1.2926, 1.2926, 2.5]) { const c = chargeFor(session, reported); session = c.session; total += c.delta; }
    expect(total).toBeCloseTo(2.5, 6); // not 1.29 x 3 + 2.5
    expect(chargeFor(5, 0.4)).toEqual({ delta: 0.4, session: 5.4 }); // a fresh process reporting per query
  });
  it("treats billing and authentication failures as fatal, and transient errors as not", () => {
    expect(fatalApiProblem("Credit balance is too low")).toMatch(/out of credits/);
    expect(fatalApiProblem("authentication_error: invalid x-api-key")).toMatch(/rejected/);
    expect(fatalApiProblem("overloaded_error")).toBeNull();
    expect(fatalApiProblem("Implemented the J3 fix.")).toBeNull();
  });
  it("corrects a version-1 state that over-counted a resumed session", () => {
    const p = join(mkdtempSync(join(tmpdir(), "m-")), "agent-state.json");
    writeFileSync(p, JSON.stringify({ version: 1, status: "checkpointed", iterations: 30, totalCostUsd: 38.78, totalTurns: 0, provisionRuns: 0, consecutiveErrors: 0, milestones: [],
      lastResult: { at: "x", subtype: "success", costUsd: 1.2926, turns: 1 } }));
    const f = new AgentStateFile(p);
    expect(f.data).toMatchObject({ version: 2, totalCostUsd: 1.2926, sessionCostUsd: 1.2926 });
  });
});
