/** Phase 2A/2B/2F — capability registry discovery, evidence rules and traces on real Postgres (migration 0023). */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { CATALOG, refreshRegistry, listCapabilities, upsertCapability, configureRegistry } from "../../src/resources/registry.js";
import { writeTrace, routeTraceRows, traceFor } from "../../src/resources/trace.js";
import { route } from "../../src/mac/router.js";
import { recordHeartbeat } from "../../src/mac/runtime.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;
const env = { googleConfigured: false, resendConfigured: true, models: { planner: "m" } };

describe.skipIf(!pool)("capability registry (ADR-073)", () => {
  afterAll(async () => { await pool?.end(); });

  it("refresh writes every catalog capability; Mac offline → mac.* down with the reason; Google unconfigured → not_configured", async () => {
    await pool!.query(`UPDATE mac_runtime SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = 'primary'`);
    const n = await refreshRegistry(pool!, env);
    expect(n).toBe(CATALOG.length);
    const caps = await listCapabilities(pool!);
    const by = Object.fromEntries(caps.map((c) => [c.id, c]));
    expect(by["mac.filesystem"]!.health).toBe("down"); expect(by["mac.filesystem"]!.health_reason).toMatch(/Mac offline/);
    expect(by["google.gmail"]!.health).toBe("not_configured");
    expect(by["state.projects"]!.health).toBe("healthy");
  });

  it("fresh heartbeat + helper probes → mac capabilities healthy; a failed probe → that capability down", async () => {
    await recordHeartbeat(pool!, { helperVersion: "runtime-test", startedAt: new Date().toISOString(),
      capabilities: { filesystem: "PASS", screenCapture: "PASS", accessibility: "PASS", browser: "FAIL", activeWindow: "PASS" } });
    await refreshRegistry(pool!, env);
    const by = Object.fromEntries((await listCapabilities(pool!, { type: "mac" })).map((c) => [c.id, c]));
    expect(by["mac.filesystem"]!.health).toBe("healthy");
    expect(by["mac.browser"]!.health).toBe("down"); expect(by["mac.browser"]!.health_reason).toMatch(/browser=FAIL/);
  });

  it("empirical reliability is withheld below 5 samples and computed at >= 5 (no anecdote routing)", async () => {
    await refreshRegistry(pool!, env);
    const before = (await listCapabilities(pool!, { type: "agent" })).find((x) => x.id === "agent.m01_chart")!;
    if (before.samples < 5) expect(before.reliability).toBeNull();                 // too little evidence → no number
    for (let i = 0; i < 4; i++) await pool!.query(`INSERT INTO control_task (request, origin, status) VALUES ('mac_chart:REGTEST${i}', 'chat', 'done')`);
    await pool!.query(`INSERT INTO control_task (request, origin, status) VALUES ('mac_chart:REGTEST9', 'chat', 'failed')`);
    await refreshRegistry(pool!, env);
    const after = (await listCapabilities(pool!, { type: "agent" })).find((x) => x.id === "agent.m01_chart")!;
    expect(after.samples).toBe(before.samples + 5);
    expect(after.samples).toBeGreaterThanOrEqual(5);
    expect(Number(after.reliability)).toBeGreaterThan(0); expect(Number(after.reliability)).toBeLessThan(1);   // 1 failure is counted
  });

  it("a capability registered at runtime is immediately queryable (basis for R08 'new capability discovered')", async () => {
    await upsertCapability(pool!, { id: "mcp.test_connector", type: "external", scope: "test connector", access: "read", operations: ["search"], health: "healthy", reason: "probe ok" });
    expect((await listCapabilities(pool!)).some((c) => c.id === "mcp.test_connector" && c.health === "healthy")).toBe(true);
  });

  it("resource trace records used / considered / unavailable with reasons", async () => {
    const r = route("open https://example.com and fill the contact form", { filesystem: "PASS", browser: "FAIL", accessibility: "PASS", screenCapture: "PASS" });
    const taskId = (await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ('trace test', 'chat') RETURNING id`)).rows[0]!.id;
    await writeTrace(pool!, { taskId, request: "trace test" }, routeTraceRows(r));
    const t = await traceFor(pool!, { taskId });
    expect(t.find((x) => x.decision === "used")!.capability_id).toBe("mac.accessibility");
    expect(t.find((x) => x.decision === "unavailable")!.capability_id).toBe("mac.browser");
  });

  it("configureRegistry default env is used when none is passed", async () => {
    configureRegistry({ googleConfigured: true, resendConfigured: true, models: {} });
    await refreshRegistry(pool!);
    expect((await listCapabilities(pool!)).find((c) => c.id === "google.calendar")!.health).toBe("unknown");   // configured, not probed — never claimed healthy
  });
});
