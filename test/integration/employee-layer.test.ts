/** Phase 3 (ADR-079): structured waiting-on, green/yellow/red with reasons, exception-first brief. */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { addWaiting, areaStatus, ensureArea, executiveBriefV2, placeUnderArea, setObjective, waitingOn, parseDue } from "../../src/cos/operating.js";
import { planResources } from "../../src/resources/planner.js";
import { refreshRegistry } from "../../src/resources/registry.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;
afterAll(async () => { await pool?.end(); });

describe.skipIf(!pool)("employee layer (Phase 3)", () => {
  it("existing projects are linked, not duplicated", async () => {
    await pool!.query(`INSERT INTO project (name) VALUES ('Vendora PG County rollout')`);
    await ensureArea(pool!, "Vendora");
    const r = await placeUnderArea(pool!, "Vendora PG County rollout", "Vendora");
    expect(r).toEqual(expect.objectContaining({ projectCreated: false, area: "Vendora" }));
    expect((await pool!.query(`SELECT count(*)::int AS n FROM project WHERE name = 'Vendora PG County rollout'`)).rows[0].n).toBe(1);
  });

  it("yellow explains itself; red means a breached service level", async () => {
    await ensureArea(pool!, "Health Admin");
    const y = await areaStatus(pool!, "Health Admin");
    expect(y).toEqual(expect.objectContaining({ color: "yellow" }));
    expect((y as { warnings: string[] }).warnings.join(" ")).toMatch(/no open objective/);
    await setObjective(pool!, "Health Admin", "Renew insurance");
    await placeUnderArea(pool!, "Insurance renewal", "Health Admin");
    await addWaiting(pool!, { counterparty: "Broker", project: "Insurance renewal", due: "2020-01-01" });
    const r = await areaStatus(pool!, "Health Admin");
    expect((r as { color: string }).color).toBe("red");
    expect((r as { why: string }).why).toMatch(/follow-up\(s\) overdue/);
  });

  it("'What am I waiting on?' plans from structured state only — no Gmail keyword search", async () => {
    await refreshRegistry(pool!, { googleConfigured: true, resendConfigured: true, models: {} });
    const plan = await planResources(pool!, "What am I waiting on?");
    expect(plan.authoritative.commitments).toBe("state.areas");
    expect(plan.use.map((u) => u.capabilityId)).not.toContain("google.gmail");
    const w = await waitingOn(pool!);
    expect(w).toEqual(expect.objectContaining({ source: expect.stringMatching(/structured/) }));
  });

  it("brief leads with exceptions: decisions and blocked work before completed work", async () => {
    const b = await executiveBriefV2(pool!);
    expect(Object.keys(b)).toEqual(["generatedAt", "headline", "decisions", "blocked", "changes", "risks", "completed", "rest"]);
    expect(b.blocked.join(" ")).toMatch(/Overdue: Waiting on Broker/);
  });

  it("due-date parsing", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    expect(parseDue("in 5 days", now)!.toISOString().slice(0, 10)).toBe("2026-10-14");
    expect(parseDue("tomorrow", now)!.toISOString().slice(0, 10)).toBe("2026-10-10");
    expect(parseDue("2026-11-02", now)!.toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(parseDue("whenever", now)).toBeNull();
  });
});

import { applyBootstrap, proposeCareerBootstrap } from "../../src/cos/bootstrap.js";
describe.skipIf(!pool)("Career bootstrap (Phase 3C): propose → approve → apply", () => {
  const H = "Job ID,Date First Analyzed,Date Last Updated,Company,Title,Location,Work Mode,Employment Type,Posting URL,Eligibility Status,Eligibility Detail,Application Status,Overall Match Score,Fit Concerns Summary,Salary Range,Priority,Next Action,Next Action Date,Latest Resume Link,Latest Cover Letter Link,Job Folder Link";
  const google = {
    sheetCsv: async () => ({ name: "Vendora Career Copilot - Job History", modified: "2026-10-09T16:29:38Z", account: "vending.vendora@gmail.com", csv: [H,
      "mtdy30,,,Altarum,Pricing Analyst,\"Silver Spring, MD\",Hybrid,Full-time,https://www.linkedin.com/jobs/view/4462053616,No Restriction Identified,,Analyzed,88,,95000 105000 USD,Medium,,,,,",
      "m18usy,,,\"M.C. Dean, Inc.\",Financial Analyst,\"McLean, VA\",,Full-time,https://www.linkedin.com/jobs/view/4205880810/,No Restriction Identified,,Analyzed,92,,,Medium,,,,,",
      "k53b3a,,,Northrop Grumman,Program Cost Control Analyst,\"Linthicum Heights, MD\",,Full-time,https://www.linkedin.com/jobs/view/4445298534/,Active Security Clearance Required,,Analyzed,90,,,Medium,,,,,"].join("\n") }),
    gmail: async (t: string[]) => t[0] === "interview" ? [{ name: "Gmail: RE: Interview with Altarum / Julian - Pricing Analyst [u]", path: "g", modified: "2026-09-24T15:09:36.000Z", text: "From: Beth Young <Beth.Young@altarum.org>\n" }] : [],
    calendar: async () => [{ name: "Google Calendar [u]", path: "c", text: "2026-09-28T15:00:00-04:00 | Interview with Altarum / Julian - Pricing Analyst | |" }],
  };
  it("proposes without writing; flags the status conflict; shortlist excludes clearance-required roles", async () => {
    const before = (await pool!.query(`SELECT count(*)::int AS n FROM opportunity`)).rows[0].n;
    const p = await proposeCareerBootstrap(pool!, google as never, new Date("2026-10-09T16:00:00Z"));
    expect((await pool!.query(`SELECT count(*)::int AS n FROM opportunity`)).rows[0].n).toBe(before);   // nothing written yet
    expect(p.summary.activeProjects.map((a) => a.org)).toEqual(["Altarum"]);
    expect(p.summary.activeProjects[0]!.contact).toBe("Beth Young");
    expect(p.summary.activeProjects[0]!.proposedFollowup).toMatch(/Waiting on Beth Young/);
    expect(p.summary.conflicts.join(" ")).toMatch(/Altarum: the Career Copilot sheet still says "analyzed"/);
    expect(p.summary.pipeline.shortlist.map((s) => s.org)).toEqual(["M.C. Dean, Inc."]);
    const a = await applyBootstrap(pool!, p.code);
    expect(a).toEqual(expect.objectContaining({ area: "Career", opportunities: 3, activeProjects: ["Altarum"] }));
    const alt = (await pool!.query(`SELECT status, project_id IS NOT NULL AS linked, contact FROM opportunity WHERE org = 'Altarum'`)).rows[0];
    expect(alt).toEqual({ status: "interviewing", linked: true, contact: "Beth Young" });
    expect((await applyBootstrap(pool!, p.code)) as { error?: string }).toEqual({ error: expect.stringMatching(/already applied/) });
    const w = await waitingOn(pool!, "Career");
    expect(JSON.stringify(w)).toMatch(/Beth Young/);
  });
});
