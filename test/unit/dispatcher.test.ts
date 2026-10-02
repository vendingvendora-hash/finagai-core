/**
 * ADR-033 scenarios required by Julian's review:
 *  1 normal single execution          4 reclaim after lease expiry
 *  2 second tick during active lease  5 success prevents re-execution
 *  3 process crash after claim        6 retry does not duplicate an external side effect
 */
import { describe, expect, it } from "vitest";
import { dispatch, type Claim, type JobHandler, type JobLedger, type JobOutcome } from "../../src/jobs/dispatcher.js";
import { placeholderHandlers } from "../../src/jobs/handlers.js";
import type { JobName } from "../../src/jobs/schedule.js";
import { deliverOnce } from "../../src/notify/delivery.js";
import { MemoryDeliveryStore, ProviderDouble } from "../helpers/delivery.js";

const cfg = { FINAGAI_TIMEZONE: "America/New_York", WEEKLY_REVIEW_DAY: 1, WEEKLY_REVIEW_TIME: "07:00", MISSED_RUN_CHECK_TIME: "09:00" };
const LEASE = 5 * 60_000;

/** In-memory ledger with the same rules as PgJobLedger, driven by an explicit clock. */
class MemoryLedger implements JobLedger {
  rows = new Map<string, { id: string; status: string; attempt: number; owner: string | null; leaseUntil: number }>();
  constructor(public clock: { now: number }, private maxAttempts = 3) {}
  async claim(job: JobName, at: Date, owner: string, leaseMs: number): Promise<Claim | null> {
    const key = `${job}@${at.toISOString()}`;
    const r = this.rows.get(key);
    if (!r) {
      this.rows.set(key, { id: key, status: "running", attempt: 1, owner, leaseUntil: this.clock.now + leaseMs });
      return { runId: key, attempt: 1 };
    }
    const expired = r.status === "running" && r.leaseUntil < this.clock.now;
    if (r.attempt < this.maxAttempts && (expired || r.status === "failed")) {
      Object.assign(r, { status: "running", attempt: r.attempt + 1, owner, leaseUntil: this.clock.now + leaseMs });
      return { runId: key, attempt: r.attempt };
    }
    return null;
  }
  async heartbeat(id: string, owner: string, leaseMs: number) {
    const r = this.rows.get(id);
    if (!r || r.owner !== owner || r.status !== "running") return false;
    r.leaseUntil = this.clock.now + leaseMs;
    return true;
  }
  async finish(id: string, owner: string, outcome: JobOutcome) {
    const r = this.rows.get(id);
    if (!r || r.owner !== owner || r.status !== "running") return false;
    Object.assign(r, { status: outcome.status, owner: null });
    return true;
  }
}

const monday0700 = new Date("2026-03-09T11:00:00Z");
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

function deps(ledger: JobLedger, handlers: Partial<Record<JobName, JobHandler>>, owner: string) {
  return { cfg, owner, leaseMs: LEASE, log: () => {}, openLedger: async () => ledger,
    handlers: { ...placeholderHandlers(), ...handlers } };
}

describe("ADR-033 at-least-once dispatch", () => {
  it("1. runs a due job once in the normal case", async () => {
    const clock = { now: monday0700.getTime() };
    const ledger = new MemoryLedger(clock);
    let runs = 0;
    const r = await dispatch(monday0700, deps(ledger, { weekly_review: async () => { runs++; return { status: "succeeded" }; } }, "A"));
    expect(runs).toBe(1);
    expect(r.ran.find((x) => x.job === "weekly_review")).toMatchObject({ attempt: 1, outcome: { status: "succeeded" } });
  });

  it("2. a second tick cannot claim while the first lease is active", async () => {
    const clock = { now: monday0700.getTime() };
    const ledger = new MemoryLedger(clock);
    await ledger.claim("weekly_review", monday0700, "A", LEASE); // tick A holds the lease, still running
    clock.now = minutes(monday0700, 2).getTime();
    let runs = 0;
    const r = await dispatch(minutes(monday0700, 2), deps(ledger, { weekly_review: async () => { runs++; return { status: "succeeded" }; } }, "B"));
    expect(runs).toBe(0);
    expect(r.notClaimed).toContain("weekly_review");
  });

  it("3 and 4. after a crash post-claim, a later tick reclaims once the lease expires", async () => {
    const clock = { now: monday0700.getTime() };
    const ledger = new MemoryLedger(clock);
    // Process A claims and dies: no heartbeat, no finish.
    expect(await ledger.claim("weekly_review", monday0700, "A", LEASE)).toEqual({ runId: expect.any(String), attempt: 1 });

    clock.now = minutes(monday0700, 4).getTime(); // lease still live
    expect(await ledger.claim("weekly_review", monday0700, "B", LEASE)).toBeNull();

    const tick = minutes(monday0700, 15); // next cron tick, lease expired
    clock.now = tick.getTime();
    let runs = 0;
    const r = await dispatch(tick, deps(ledger, { weekly_review: async (ctx) => { runs++; expect(ctx.attempt).toBe(2); return { status: "succeeded" }; } }, "B"));
    expect(runs).toBe(1);
    expect(r.ran.find((x) => x.job === "weekly_review")?.attempt).toBe(2);
  });

  it("a crashed process cannot later overwrite the recovered outcome", async () => {
    const clock = { now: monday0700.getTime() };
    const ledger = new MemoryLedger(clock);
    const a = await ledger.claim("weekly_review", monday0700, "A", LEASE);
    clock.now = minutes(monday0700, 15).getTime();
    await ledger.claim("weekly_review", monday0700, "B", LEASE);
    expect(await ledger.finish(a!.runId, "A", { status: "failed" })).toBe(false); // stale owner rejected
  });

  it("5. a succeeded slot never runs again, even after its lease would have expired", async () => {
    const clock = { now: monday0700.getTime() };
    const ledger = new MemoryLedger(clock);
    let runs = 0;
    const handler = { weekly_review: async () => { runs++; return { status: "succeeded" as const }; } };
    await dispatch(monday0700, deps(ledger, handler, "A"));
    for (const m of [15, 30, 60, 105]) {
      clock.now = minutes(monday0700, m).getTime();
      await dispatch(minutes(monday0700, m), deps(ledger, handler, `T${m}`));
    }
    expect(runs).toBe(1);
  });

  it("retries a failed handler on later ticks, up to 3 attempts", async () => {
    const clock = { now: monday0700.getTime() };
    const ledger = new MemoryLedger(clock);
    const attempts: number[] = [];
    const handler = { weekly_review: async (ctx: { attempt: number }) => { attempts.push(ctx.attempt); throw new Error("transient"); } };
    for (const m of [0, 15, 30, 45]) {
      clock.now = minutes(monday0700, m).getTime();
      await dispatch(minutes(monday0700, m), deps(ledger, handler as never, `T${m}`));
    }
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("does not open the database when nothing is due", async () => {
    let opened = 0;
    const r = await dispatch(new Date("2026-03-04T20:00:00Z"), { cfg, handlers: placeholderHandlers(), log: () => {},
      openLedger: async () => { opened++; return new MemoryLedger({ now: 0 }); } });
    expect(r.due).toBe(0);
    expect(opened).toBe(0);
  });

  it("records placeholder jobs as skipped, never as succeeded", async () => {
    const clock = { now: monday0700.getTime() };
    const ledger = new MemoryLedger(clock);
    const r = await dispatch(monday0700, deps(ledger, {}, "A"));
    expect(r.ran.every((x) => x.outcome.status === "skipped")).toBe(true);
  });
});

describe("6. a job retried end to end produces one externally visible email", () => {
  it("handler fails after sending; the retried attempt does not send again", async () => {
    const clock = { now: monday0700.getTime() };
    const ledger = new MemoryLedger(clock);
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock, 0); // provider dedup off: Core's ledger alone must prevent it
    let crashOnce = true;
    const handler: JobHandler = async (ctx) => {
      await deliverOnce(store, provider, `review-email:${ctx.idempotencyKey}`, "weekly_review", { subject: "Weekly review", text: "..." });
      if (crashOnce) { crashOnce = false; throw new Error("failure after send"); }
      return { status: "succeeded" };
    };
    for (const m of [0, 15]) {
      clock.now = minutes(monday0700, m).getTime();
      await dispatch(minutes(monday0700, m), deps(ledger, { weekly_review: handler }, `T${m}`));
    }
    expect(provider.inbox.map((x) => x.subject)).toEqual(["Weekly review"]);
  });
});
