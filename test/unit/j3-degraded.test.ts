import { describe, expect, it } from "vitest";
import { composeOrDegrade, renderDegradedReview, type ReviewInput, type ReviewItem } from "../../src/pipelines/j3/degraded.js";
import { BudgetBlockedError } from "../../src/llm/types.js";

const item = (over: Partial<ReviewItem>): ReviewItem => ({
  id: "00000000-0000-4000-8000-000000000000", section: "fyi", mustMention: false, title: "Item", project: null, status: null,
  dueAt: null, waitingOn: null, daysSinceActivity: null, note: null, ...over,
});

const input: ReviewInput = {
  periodStart: new Date("2026-10-05T11:00:00Z"), periodEnd: new Date("2026-10-12T11:00:00Z"), timezone: "America/New_York",
  deferredCaptures: 3, budget: { monthToDateUsd: 35.97, targetUsd: 30, ceilingUsd: 36 },
  items: [
    item({ id: "a1", section: "requires_attention", mustMention: true, title: "Send proposal to The Rustic Bar", project: "Vendora outreach", status: "open", dueAt: new Date("2026-10-09T03:59:00Z") }),
    item({ id: "a2", section: "risks_conflicts", mustMention: true, title: "Conflicting due date: insurance renewal", note: "open conflict: 2026-10-15 vs 2026-10-20" }),
    item({ id: "a3", section: "waiting", title: "Reply from Bar Q owner", waitingOn: "Bar Q owner", daysSinceActivity: 9 }),
    ...Array.from({ length: 12 }, (_, n) => item({ id: `f${n}`, section: "fyi", title: `Low priority ${n}` })),
  ],
};

describe("J3 degraded review at the hard ceiling (zero model calls)", () => {
  const r = renderDegradedReview(input, "budget_ceiling");

  it("includes every must-mention item and validates coverage", () => {
    expect(r.validation).toEqual({ mustMentionCovered: true, missing: [] });
    expect(r.rendered).toContain("[a1]");
    expect(r.rendered).toContain("[a2]");
  });

  it("renders factual dates in Julian's timezone from code", () => {
    // 2026-10-09T03:59Z is Thursday Oct 8 in New York.
    expect(r.rendered).toContain("due: Thu, Oct 8, 2026");
  });

  it("clearly marks itself as a degraded budget-limit review and records that no model was invoked", () => {
    expect(r.rendered.split("\n")[0]).toMatch(/^DEGRADED REVIEW - model-spend limit reached/);
    expect(r.content).toMatchObject({ degraded: true, degradedReason: "budget_ceiling", modelInvoked: false });
    expect(r.rendered).toContain("$35.97 of a $36.00 hard ceiling");
  });

  it("surfaces deferred captures and never invents recommendations", () => {
    expect(r.rendered).toContain("Captures waiting for budget: 3");
    expect(r.content.sections.map((s) => s.section)).not.toContain("recommended_actions");
  });

  it("says so plainly when nothing is open", () => {
    const empty = renderDegradedReview({ ...input, items: [], deferredCaptures: 0 }, "budget_ceiling");
    expect(empty.rendered).toContain("No open items");
    expect(empty.validation.mustMentionCovered).toBe(true);
  });

  it("falls back only on a hard-ceiling block; other errors propagate", async () => {
    const degraded = await composeOrDegrade(input, async () => { throw new BudgetBlockedError("ceiling", "ceiling"); });
    expect(degraded.kind).toBe("degraded");
    await expect(composeOrDegrade(input, async () => { throw new Error("schema invalid"); })).rejects.toThrow("schema invalid");
    expect((await composeOrDegrade(input, async () => "composed")).kind).toBe("composed");
  });
});
