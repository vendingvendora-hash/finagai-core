/**
 * Phase 2 acceptance R01–R10 (ADR-074) on real Postgres: seeded Finagai state + live registry + fake Google.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { refreshRegistry, upsertCapability } from "../../src/resources/registry.js";
import { planResources, planAndTrace } from "../../src/resources/planner.js";
import { retrieve, traceRetrieval, retrievedBlock } from "../../src/resources/retrieve.js";
import { traceFor } from "../../src/resources/trace.js";
import { recordHeartbeat } from "../../src/mac/runtime.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;
const env = { googleConfigured: true, resendConfigured: true, models: {} };
const fakeGoogle = {
  calendar: async (t: string[]) => [{ name: "Altarum interview — Tue 10:00", path: "cal://1", text: `Interview loop for ${t.join(" ")}` }],
  gmail: async () => [{ name: "Re: Altarum next steps (Beth)", path: "gmail://1", text: "Beth: we'll confirm the panel by Friday." }],
  drive: async () => { throw new Error("drive quota exceeded"); },
};
const setHealth = (id: string, health: string) => pool!.query(`UPDATE capability SET health = $2, health_reason = 'test' WHERE id = $1`, [id, health]);

describe.skipIf(!pool)("resource planner R01–R10 (ADR-074)", () => {
  beforeAll(async () => {
    await pool!.query(`INSERT INTO area (name) SELECT 'Career' WHERE NOT EXISTS (SELECT 1 FROM area WHERE name = 'Career')`);
    await pool!.query(`INSERT INTO project (name, description) SELECT 'Altarum', 'Pricing analyst role process' WHERE NOT EXISTS (SELECT 1 FROM project WHERE name = 'Altarum')`);
    await pool!.query(`INSERT INTO entity (kind, name, purpose, source_visibility) SELECT 'person', 'Beth', 'recruiter at Altarum', 'non_public'
                         WHERE NOT EXISTS (SELECT 1 FROM entity WHERE name = 'Beth')`);
    await recordHeartbeat(pool!, { helperVersion: "runtime-test", startedAt: new Date().toISOString(),
      capabilities: { filesystem: "PASS", screenCapture: "PASS", accessibility: "PASS", browser: "PASS", activeWindow: "PASS" } });
    await refreshRegistry(pool!, env);
  });
  afterAll(async () => { await pool?.end(); });

  it("R01 known Finagai state → retrieved, never re-asked", async () => {
    const p = await planResources(pool!, "What's the status of Altarum?");
    expect(p.entities.map((e) => e.name)).toContain("Altarum");
    expect(p.use.map((u) => u.capabilityId)).toContain("state.projects");
    expect(p.askJulian).toBeNull();
  });

  it("R02 local Mac file without a path → Spotlight + parser, no path question", async () => {
    const p = await planResources(pool!, "Summarize the Degree of Leverage Analysis spreadsheet");
    const used = p.use.map((u) => u.capabilityId);
    expect(used).toEqual(expect.arrayContaining(["mac.filesystem", "mac.local_parser"]));
    expect(p.askJulian).toBeNull();
  });

  it("R03 'Prepare me for Altarum' → project + calendar + email + artifacts; Messages and screen skipped", async () => {
    const p = await planResources(pool!, "Prepare me for Altarum");
    const used = p.use.map((u) => u.capabilityId);
    expect(used).toEqual(expect.arrayContaining(["state.projects", "google.calendar", "google.gmail", "state.artifacts"]));
    expect(used).not.toContain("mac.imessage"); expect(used).not.toContain("mac.screen");
    const r = await retrieve(pool!, p, { google: fakeGoogle });
    expect(r.find((x) => x.capabilityId === "google.calendar")!.items[0]!.title).toMatch(/Altarum interview/);
    expect(r.find((x) => x.capabilityId === "state.projects")!.status).toBe("ok");
    expect(retrievedBlock(r)).toMatch(/do not ask Julian/);
  });

  it("R04 parser preferred over visual UI for a workbook", async () => {
    const p = await planResources(pool!, "Chart the Altarum_Pricing_Case_Template workbook");
    expect(p.use.map((u) => u.capabilityId)).toContain("mac.local_parser");
    expect(p.use.map((u) => u.capabilityId)).not.toContain("mac.keyboard_mouse");
  });

  it("R05 preferred source unhealthy → explicit fallback, recorded", async () => {
    await setHealth("google.calendar", "down");
    try {
      const p = await planResources(pool!, "When is my Altarum interview?");
      expect(p.authoritative.schedule).toBe("state.projects");
      expect(p.unavailable.some((u) => u.capabilityId === "google.calendar" && /using state\.projects instead/.test(u.why))).toBe(true);
    } finally { await setHealth("google.calendar", "unknown"); }
  });

  it("R06 trivial request → no retrieval at all", async () => {
    const p = await planResources(pool!, "What time is it?");
    expect(p.intent).toBe("trivial"); expect(p.use).toHaveLength(0);
  });

  it("R07 retrieve first; ask only for a slot no healthy source can fill", async () => {
    const ok = await planResources(pool!, "Send that chart to Beth");
    expect(ok.askJulian).toBeNull();
    expect(ok.use.map((u) => u.capabilityId)).toContain("mac.imessage");       // the messaging need IS detected (no vacuous pass)
    await setHealth("mac.imessage", "down");
    try {
      const blocked = await planResources(pool!, "Send that chart to Beth");
      expect(blocked.missing).toContain("messaging"); expect(blocked.askJulian).toMatch(/messaging/);
      expect(blocked.entities.map((e) => e.name)).toContain("Beth");          // Beth itself is never asked about
    } finally { await setHealth("mac.imessage", "healthy"); }
  });

  it("R08 a capability registered at runtime is used without code changes", async () => {
    await upsertCapability(pool!, { id: "mcp.notion", type: "external", scope: "Notion workspace pages and notes search", access: "read", operations: ["notion_search"], health: "healthy" });
    const p = await planResources(pool!, "Search my Notion pages for the pricing memo");
    expect(p.use.map((u) => u.capabilityId)).toContain("mcp.notion");
  });

  it("R09 authority: calendar beats project memory for schedule when both are healthy", async () => {
    const p = await planResources(pool!, "When is my Altarum interview?");
    expect(p.authoritative.schedule).toBe("google.calendar");
  });

  it("R10 the trace explains selection AND retrieval outcomes (including a failed source)", async () => {
    const taskId = (await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ('prepare me for Altarum (R10)', 'chat') RETURNING id`)).rows[0]!.id;
    const p = await planAndTrace(pool!, "Prepare me for Altarum and pull the Drive deck", { taskId });
    const r = await retrieve(pool!, p, { google: fakeGoogle });
    await traceRetrieval(pool!, { taskId, request: p.request }, r);
    const t = await traceFor(pool!, { taskId });
    expect(t.some((x) => x.decision === "used" && x.capability_id === "google.calendar")).toBe(true);
    expect(t.some((x) => x.decision === "skipped" && x.capability_id === "mac.imessage")).toBe(true);
    expect(t.some((x) => x.decision === "unavailable" && x.capability_id === "google.drive" && /drive quota exceeded/.test(x.reason))).toBe(true);
    expect(t.every((x) => x.reason.length > 0)).toBe(true);
    expect(p.use.find((u) => u.capabilityId === "google.drive")!.why).toMatch(/explicitly requested/);   // named source beats the bound
  });
});
