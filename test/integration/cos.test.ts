/**
 * Employee-level layer: Areas of Responsibility, closed-loop follow-ups, Area health, executive brief.
 * Exercises the real schema (migration 0016) and the cos modules end to end.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { createArea, areaHealth, listAreas } from "../../src/cos/areas.js";
import { createFollowup, markWaiting, closeFollowup, sweepOverdue, openFollowups, nextState } from "../../src/cos/followups.js";
import { executiveBrief, renderBrief } from "../../src/cos/brief.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;

describe.skipIf(!pool)("COS employee layer (ADR-060)", () => {
  afterAll(async () => { await pool?.end(); });

  it("nextState: past-due open/waiting becomes overdue; closed stays closed (pure)", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    expect(nextState("waiting", now, new Date("2026-01-01T00:00:00Z"))).toBe("overdue");
    expect(nextState("open", now, new Date("2026-03-01T00:00:00Z"))).toBe("open");
    expect(nextState("done", now, new Date("2020-01-01T00:00:00Z"))).toBe("done");
  });

  it("owns a follow-up through its whole loop and reflects it in Area health + brief", async () => {
    const area = await createArea(pool!, { name: `Career ${Date.now()}`, description: "finance job search",
      policy: { max_followups_overdue: 0, max_projects_without_next_action: 0 } });
    expect((await listAreas(pool!)).some((a) => a.id === area.id)).toBe(true);

    // a follow-up already past due -> should sweep to overdue -> breach the area's service level
    const f = await createFollowup(pool!, { summary: "follow up with Beth re pricing analyst role", counterparty: "Beth",
      channel: "email", areaId: area.id, dueAt: new Date(Date.now() - 3600_000) });
    const swept = await sweepOverdue(pool!);
    expect(swept).toBeGreaterThanOrEqual(1);

    let health = await areaHealth(pool!, area.id);
    expect(health!.followupsOverdue).toBeGreaterThanOrEqual(1);
    expect(health!.healthy).toBe(false);
    expect(health!.breaches.join(" ")).toMatch(/overdue/);

    // it shows up in the executive brief under "needs attention"
    const brief = await executiveBrief(pool!);
    expect(brief.needsAttention.some((n) => /Beth|overdue/i.test(n))).toBe(true);
    expect(renderBrief(brief)).toMatch(/needs attention/i);

    // act on it -> waiting (not overdue once future-dated) -> then close -> area healthy again
    await markWaiting(pool!, f.id, new Date(Date.now() + 86_400_000));
    await closeFollowup(pool!, f.id, "Beth replied; second interview scheduled");
    const open = await openFollowups(pool!, area.id);
    expect(open.find((x) => x.id === f.id)).toBeUndefined();        // closed, no longer open
    health = await areaHealth(pool!, area.id);
    expect(health!.followupsOverdue).toBe(0);
    expect(health!.healthy).toBe(true);                             // loop closed -> service level met
  });

  it("flags a project with no next action as an Area-health breach", async () => {
    const area = await createArea(pool!, { name: `Vendora ${Date.now()}`, policy: { max_projects_without_next_action: 0 } });
    // a project in the area with no open work_item and no follow-up = no next action
    await pool!.query(`INSERT INTO project (name, status, area_id) VALUES ($1,'active',$2)`, [`stale proj ${Date.now()}`, area.id]);
    const h = await areaHealth(pool!, area.id);
    expect(h!.projectsNoNextAction).toBeGreaterThanOrEqual(1);
    expect(h!.healthy).toBe(false);
    expect(h!.breaches.join(" ")).toMatch(/no next action/);
  });
});
