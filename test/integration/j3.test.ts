/**
 * J3 against an isolated Postgres database (collection reads the whole state). The composer is
 * SCRIPTED: these tests verify J3's code guarantees (collection, must-mention, validation, rendering,
 * degraded paths, idempotent delivery). Model-quality evaluation of T11-T20 follows with the real API.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { BudgetBlockedError, type ModelRequest, type ModelResult } from "../../src/llm/types.js";
import { slotIdempotencyKey } from "../../src/jobs/dispatcher.js";
import { missedRunCheckHandler, weeklyReviewHandler } from "../../src/jobs/j3Handlers.js";
import { deliverReview, runReview, type J3Deps } from "../../src/pipelines/j3/review.js";
import { payloadHash, PROVIDER_DEDUP_WINDOW_MS, reviewEmailKey } from "../../src/notify/delivery.js";
import { MemoryDeliveryStore, ProviderDouble } from "../helpers/delivery.js";

const url = process.env.INTEGRATION_DATABASE_URL_J3;
const pool = url ? createPool(url) : undefined;
afterAll(async () => { await pool?.end(); });

const NOW = new Date("2026-10-12T11:00:00Z"); // Monday 07:00 New York
const DAY = 86_400_000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);

type Item = { id: string; section: string; must_mention: boolean; title: string; note: string | null };
type Composer = (items: Item[], attempt?: number) => object;

/** Faithful composer: one entry per item in its suggested section; one safe recommendation. */
const faithful: Composer = (items) => {
  const sections = new Map<string, object[]>();
  for (const i of items) {
    const list = sections.get(i.section) ?? [];
    list.push({ item_ids: [i.id], headline: i.title, why: null, urgency: i.must_mention ? "high" : "low", importance: i.must_mention ? "high" : "low", uncertainty: null });
    sections.set(i.section, list);
  }
  const act = items.find((i) => i.section === "requires_attention" && !(i.note ?? "").startsWith("disputed"));
  if (act) sections.set("recommended_actions", [{ item_ids: [act.id], headline: `Handle: ${act.title}`, why: null, urgency: "high", importance: "high", uncertainty: null }]);
  return { sections: [...sections].map(([section, entries]) => ({ section, entries })), nothing_material_changed: items.length === 0 };
};

class ScriptedComposer {
  calls = 0;
  blocked = false;
  constructor(private compose: Composer = faithful) {}
  async complete(req: ModelRequest): Promise<ModelResult> {
    if (this.blocked) throw new BudgetBlockedError("hard model-spend ceiling reached", "ceiling");
    this.calls++;
    const items = JSON.parse(req.messages[0]!.content) as Item[];
    return { text: JSON.stringify(this.compose(items, req.messages.length > 1 ? 2 : 1)), model: req.model, stopReason: "end_turn",
      costUsd: 0.01, retries: 0, latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}

const deps = (model: ScriptedComposer, now = NOW): J3Deps => ({
  pool: pool!, model, modelId: "claude-sonnet-5-5", now: () => now,
  collect: { timezone: "America/New_York", stallThresholdDays: 14, upcomingWindowDays: 14, priorityUpcomingWindowDays: 30 },
  budget: async () => ({ monthToDateUsd: 3.21, targetUsd: 30, ceilingUsd: 36 }),
});

async function project(name: string, extra: { priority?: number; lastActivityDaysAgo?: number } = {}) {
  return (await pool!.query<{ id: string }>(
    `INSERT INTO project (name, priority, last_activity_at) VALUES ($1, $2, $3) RETURNING id`,
    [name, extra.priority ?? null, at(-(extra.lastActivityDaysAgo ?? 1))])).rows[0]!.id;
}
async function item(projectId: string, title: string, o: { dueInDays?: number; status?: string; kind?: string; priority?: number; completedDaysAgo?: number; updatedDaysAgo?: number } = {}) {
  const due = o.dueInDays === undefined ? null : at(o.dueInDays);
  const status = o.status ?? "open";
  return (await pool!.query<{ id: string }>(
    `INSERT INTO work_item (project_id, kind, title, status, due_at, due_precision, due_owner, priority, origin, completed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user_stated',$9,$10) RETURNING id`,
    [projectId, o.kind ?? "task", title, status, due, due ? "day" : null, due ? "finagai" : null, o.priority ?? null,
     status === "done" ? at(-(o.completedDaysAgo ?? 1)) : null, at(-(o.updatedDaysAgo ?? 0))])).rows[0]!.id;
}
const section = (rendered: string, title: string) => {
  const start = rendered.indexOf(`## ${title}`);
  if (start < 0) return "";
  const next = rendered.indexOf("\n## ", start + 3);
  return rendered.slice(start, next < 0 ? undefined : next);
};

describe.skipIf(!url)("J3 baseline T11-T20 (scripted composer, isolated database)", () => {
  it("T19: with nothing material, the review says so briefly", async () => {
    const r = await runReview(deps(new ScriptedComposer()), { kind: "on_demand" });
    expect(r.rendered).toContain("Nothing material changed since the last review.");
    expect(r.rendered.split("\n").length).toBeLessThan(8);
  });

  it("T11: several projects with different deadlines appear by window; dates come from code", async () => {
    const a = await project("Vendora route expansion");
    const b = await project("Job search");
    const soon = await item(a, "Confirm placement terms with Harbor Lights", { dueInDays: 3 });
    const mid = await item(b, "Submit application to Crestline Capital", { dueInDays: 10 });
    const far = await item(a, "Plan holiday restock", { dueInDays: 25 });
    const r = await runReview(deps(new ScriptedComposer()), { kind: "on_demand" });
    const upcoming = section(r.rendered, "Upcoming");
    expect(upcoming).toContain(`[${soon}]`);
    expect(upcoming).toContain(`[${mid}]`);
    expect(upcoming).not.toContain(`[${far}]`);
    expect(upcoming).toContain("due: Thu, Oct 15, 2026");
  });

  it("T12 and T17: overdue items and high-priority deadlines within 7 days must appear under Requires attention", async () => {
    const p = await project("Vendora compliance", { priority: 1 });
    const overdue = await item(p, "File county vending permit renewal", { dueInDays: -2 });
    const urgent = await item(p, "Sign insurance binder", { dueInDays: 5 });
    const r = await runReview(deps(new ScriptedComposer()), { kind: "on_demand" });
    const attention = section(r.rendered, "Requires attention");
    expect(attention).toContain(`[${overdue}]`);
    expect(attention).toContain("overdue by 2 days");
    expect(attention).toContain(`[${urgent}]`);
  });

  it("T13: a task completed since the last review is shown as completed, not active", async () => {
    const p = await project("Website refresh");
    const done = await item(p, "Publish new pricing page", { status: "done", completedDaysAgo: 2 });
    const r = await runReview(deps(new ScriptedComposer()), { kind: "on_demand" });
    expect(section(r.rendered, "Project changes")).toContain(`[${done}]`);
    expect(section(r.rendered, "Upcoming")).not.toContain(`[${done}]`);
    expect(section(r.rendered, "Requires attention")).not.toContain(`[${done}]`);
  });

  it("T14: an item waiting on someone appears under Waiting with time elapsed", async () => {
    const p = await project("Vendora supplier");
    const w = await item(p, "Supplier quote for snack restock", { status: "waiting", updatedDaysAgo: 9 });
    const r = await runReview(deps(new ScriptedComposer()), { kind: "on_demand" });
    expect(section(r.rendered, "Waiting / follow-up")).toMatch(new RegExp(`Supplier quote.*9 days without activity.*\\[${w}\\]`));
  });

  it("T15: an open conflict is must-mention, and no action may be based on the disputed item without the conflict", async () => {
    const p = await project("Harborview lease", { priority: 1 });
    const disputedItem = await item(p, "Harborview lease review", { dueInDays: 3 });
    await pool!.query(`UPDATE work_item SET disputed = true WHERE id = $1`, [disputedItem]);
    const cap = (await pool!.query<{ id: string }>(`INSERT INTO capture (idempotency_key, client, mode, source_type, source_text, sanitized_at, status, pipeline_version)
      VALUES ('j3-conf-${Date.now()}', 'test', 'eval', 'note', 'x', now(), 'processed', 't') RETURNING id`)).rows[0]!.id;
    const cand = (await pool!.query<{ id: string }>(`INSERT INTO capture_candidate (capture_id, item_type, payload, source_quote, outcome)
      VALUES ($1, 'deadline', '{}', 'x', 'conflict') RETURNING id`, [cap])).rows[0]!.id;
    const conflict = (await pool!.query<{ id: string }>(`INSERT INTO conflict (existing_type, existing_id, candidate_id, field, explanation)
      VALUES ('work_item', $1, $2, 'due_at', 'two different due dates') RETURNING id`, [disputedItem, cand])).rows[0]!.id;
    // A composer that first recommends acting on the disputed item; the validator forces a repair.
    const composer = new ScriptedComposer((items, attempt) => {
      const draft = faithful(items) as { sections: Array<{ section: string; entries: object[] }> };
      draft.sections = draft.sections.filter((s) => s.section !== "recommended_actions");
      draft.sections.push({ section: "recommended_actions", entries: [{
        item_ids: attempt === 1 ? [disputedItem] : [disputedItem, conflict],
        headline: attempt === 1 ? "Prepare for the lease review" : "Resolve the conflicting lease review date first",
        why: null, urgency: "high", importance: "high", uncertainty: null }] });
      return draft;
    });
    const r = await runReview(deps(composer), { kind: "on_demand" });
    expect(composer.calls).toBe(2);
    expect(r.degraded).toBe(false);
    expect(section(r.rendered, "Risks / conflicts")).toContain(`[${conflict}]`);
    expect(section(r.rendered, "Recommended next actions")).toContain("Resolve the conflicting lease review date first");
    await pool!.query(`UPDATE conflict SET status = 'keep_existing', resolved_at = now() WHERE id = $1`, [conflict]);
    await pool!.query(`UPDATE work_item SET disputed = false WHERE id = $1`, [disputedItem]);
  });

  it("T16: a project idle beyond its threshold is flagged as stalled", async () => {
    const p = await project("Bar association outreach", { lastActivityDaysAgo: 20 });
    await item(p, "Draft intro email to the association");
    const r = await runReview(deps(new ScriptedComposer()), { kind: "on_demand" });
    expect(section(r.rendered, "Risks / conflicts")).toMatch(new RegExp(`Stalled: Bar association outreach.*20 days without activity.*\\[${p}\\]`));
  });

  it("T18: one important item leads; many low-priority items stay in Lower priority", async () => {
    const p = await project("Admin backlog");
    for (let n = 0; n < 12; n++) await item(p, `Low priority chore ${n}`);
    const imp = await item(p, "Renew business license", { dueInDays: 2, priority: 1 });
    const r = await runReview(deps(new ScriptedComposer()), { kind: "on_demand" });
    expect(r.rendered.indexOf("## Requires attention")).toBeLessThan(r.rendered.indexOf("## Lower priority / FYI"));
    expect(section(r.rendered, "Requires attention")).toContain(`[${imp}]`);
    expect(section(r.rendered, "Lower priority / FYI")).toContain("Low priority chore 0");
  });

  it("T20: a recommendation may cite a newly captured decision that changes the next action", async () => {
    const p = await project("Vendora targeting");
    const decision = await item(p, "Decided: target bars instead of restaurants", { kind: "decision", dueInDays: 1, priority: 1 });
    const r = await runReview(deps(new ScriptedComposer()), { kind: "on_demand" });
    expect(section(r.rendered, "Recommended next actions")).toMatch(/Handle: /);
    expect(r.rendered).toContain(`[${decision}]`);
  });
});

describe.skipIf(!url)("J3 guarantees", () => {
  it("G15: a composer that fabricates items twice yields the degraded review, never the fabrication", async () => {
    const liar = new ScriptedComposer((items) => ({
      sections: [{ section: "requires_attention", entries: [{ item_ids: ["00000000-0000-4000-8000-0000000000ff"], headline: "Invented urgent task",
        why: null, urgency: "high", importance: "high", uncertainty: null }] },
        ...((faithful(items) as { sections: object[] }).sections)], nothing_material_changed: false }));
    const r = await runReview(deps(liar), { kind: "on_demand" });
    expect(liar.calls).toBe(2);
    expect(r.degraded).toBe(true);
    expect(r.rendered).not.toContain("Invented urgent task");
    expect(r.rendered).toMatch(/^DEGRADED REVIEW - the composed review failed validation/);
  });

  it("G16: a composer that omits a must-mention item is repaired, or the review degrades", async () => {
    let dropped = "";
    const omitter = new ScriptedComposer((items, attempt) => {
      const must = items.filter((i) => i.must_mention);
      dropped = must[0]?.id ?? "";
      return faithful(attempt === 1 ? items.filter((i) => i.id !== dropped) : items);
    });
    const r = await runReview(deps(omitter), { kind: "on_demand" });
    expect(omitter.calls).toBe(2);
    expect(r.degraded).toBe(false);
    expect(r.rendered).toContain(`[${dropped}]`);
  });

  it("at the hard ceiling the review runs with zero model calls and is marked degraded", async () => {
    const blocked = new ScriptedComposer();
    blocked.blocked = true;
    const r = await runReview(deps(blocked), { kind: "weekly", slotKey: `weekly_review:ceiling-${Date.now()}` });
    expect(blocked.calls).toBe(0);
    expect(r.degraded).toBe(true);
    const row = (await pool!.query(`SELECT model, degraded, content, validation_result FROM review WHERE id = $1`, [r.reviewId])).rows[0];
    expect(row).toMatchObject({ model: "none", degraded: true });
    expect(row.content).toMatchObject({ degradedReason: "budget_ceiling", modelInvoked: false });
    expect(row.validation_result.mustMentionCovered).toBe(true);
  });

  it("the weekly handler is idempotent per slot: one review, one email, across retries", async () => {
    const store = new MemoryDeliveryStore();
    const provider = new ProviderDouble({ now: 0 }, 0);
    const jd = { pool: pool!, j3: deps(new ScriptedComposer()), store, sender: provider, timezone: "America/New_York", weeklyReviewTime: "07:00" };
    const slot = new Date("2026-10-19T11:00:00Z");
    const ctx = { job: "weekly_review" as const, scheduledFor: slot, attempt: 1, idempotencyKey: slotIdempotencyKey("weekly_review", slot), signal: new AbortController().signal };
    expect((await weeklyReviewHandler(jd)(ctx)).status).toBe("succeeded");
    expect((await weeklyReviewHandler(jd)({ ...ctx, attempt: 2 })).status).toBe("succeeded");
    expect((await pool!.query(`SELECT count(*)::int AS n FROM review WHERE slot_key = $1`, [ctx.idempotencyKey])).rows[0].n).toBe(1);
    expect(provider.inbox).toHaveLength(1);
  });

  it("the missed-run check recovers an undelivered weekly review with the same slot key, and alerts once", async () => {
    const store = new MemoryDeliveryStore();
    const provider = new ProviderDouble({ now: 0 }, 0);
    let failFirst = true;
    const flaky = { send: async (m: { subject: string; text: string }, k: string) => {
      if (failFirst && m.subject.startsWith("Finagai weekly review")) { failFirst = false; throw new Error("provider down"); }
      return provider.send(m, k);
    } };
    const jd = { pool: pool!, j3: deps(new ScriptedComposer()), store, sender: flaky, timezone: "America/New_York", weeklyReviewTime: "07:00" };
    const weeklySlot = new Date("2026-10-26T11:00:00Z");
    const weeklyCtx = { job: "weekly_review" as const, scheduledFor: weeklySlot, attempt: 1,
      idempotencyKey: slotIdempotencyKey("weekly_review", weeklySlot), signal: new AbortController().signal };
    await expect(weeklyReviewHandler(jd)(weeklyCtx)).rejects.toThrow("provider down");
    const check = new Date("2026-10-26T13:00:00Z"); // 09:00 local
    const out = await missedRunCheckHandler(jd)({ job: "missed_run_check", scheduledFor: check, attempt: 1,
      idempotencyKey: slotIdempotencyKey("missed_run_check", check), signal: new AbortController().signal });
    expect(out.status).toBe("succeeded");
    expect(provider.inbox.map((m) => m.subject)).toEqual(["Finagai weekly review", "Finagai: weekly review was late and has now been sent"]);
    expect((await pool!.query(`SELECT count(*)::int AS n FROM review WHERE slot_key = $1`, [weeklyCtx.idempotencyKey])).rows[0].n).toBe(1);
  });

  it("deliverReview never marks a review delivered when this attempt lost its lease (stale owner, end to end)", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock);
    const r = await runReview(deps(new ScriptedComposer()), { kind: "weekly", slotKey: `weekly_review:stale-${Date.now()}` });
    let release!: () => void;
    const gate = new Promise<void>((x) => { release = x; });
    const slow = { send: async (m: { subject: string; text: string }, k: string) => { await gate; return provider.send(m, k); } };
    const a = deliverReview(pool!, store, slow, r.reviewId, r.rendered, r.degraded);   // A claims, provider stalls
    await new Promise((x) => setTimeout(x, 20));
    clock.now += 121_000;                                                              // A's lease expires
    const subject = r.degraded ? "Finagai weekly review (degraded)" : "Finagai weekly review";
    expect((await store.claim(reviewEmailKey(r.reviewId), "weekly_review", payloadHash({ subject, text: r.rendered }), 120_000, PROVIDER_DEDUP_WINDOW_MS)).kind).toBe("claimed");
    release();
    expect(await a).toBe("lease_lost");
    const row = (await pool!.query(`SELECT delivery_status, delivered_at FROM review WHERE id = $1`, [r.reviewId])).rows[0];
    expect(row).toEqual({ delivery_status: "pending", delivered_at: null });
  });
});
