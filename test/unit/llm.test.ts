import { describe, expect, it } from "vitest";
import { decideBudget } from "../../src/guards/budget.js";
import { costUsd } from "../../src/llm/pricing.js";
import { withRetries } from "../../src/llm/retry.js";
import { classifyStatus } from "../../src/llm/anthropic.js";
import { decideReservation, MeteredModelClient, type LlmCallRecorder, type ReservationRequest, type ReservationResult, type Settlement } from "../../src/llm/metered.js";
import { maxInputTokens, worstCaseCostUsd } from "../../src/llm/estimate.js";
import {
  BudgetBlockedError, PermanentModelError, TransientModelError,
  type ModelProvider, type ModelRequest, type ProviderResult,
} from "../../src/llm/types.js";

const L = { targetUsd: 30, ceilingUsd: 36 };

describe("G20 budget target $30 and hard ceiling $36 (ADR-025 clarified)", () => {
  it("allows everything below 80% of target and in the warning band", () => {
    expect(decideBudget(10, L, "shadow")).toMatchObject({ allowed: true, level: "normal" });
    expect(decideBudget(25, L, "on_demand_review")).toMatchObject({ allowed: true, level: "warning" });
  });
  it("pauses shadow runs, on-demand reviews, and evaluation once projected spend reaches the target", () => {
    for (const p of ["shadow", "on_demand_review", "eval"] as const) {
      expect(decideBudget(30, L, p)).toMatchObject({ allowed: false, level: "restricted" });
    }
    expect(decideBudget(30, L, "capture").allowed).toBe(true);
    expect(decideBudget(30, L, "weekly_review").allowed).toBe(true);
  });
  it("reports blocked evaluation as needing approval of its incremental cost", () => {
    expect(decideBudget(31, L, "eval").reason).toMatch(/approval of its expected incremental cost/);
  });
  it("lets a call start only if its projected total stays at or below $36", () => {
    expect(decideBudget(36, L, "capture").allowed).toBe(true);
    expect(decideBudget(36.000001, L, "capture")).toMatchObject({ allowed: false, level: "ceiling" });
  });
  it("blocks the weekly review too at the ceiling: no purpose is exempt", () => {
    expect(decideBudget(36.01, L, "weekly_review")).toMatchObject({ allowed: false, level: "ceiling" });
  });
  it("rejects a ceiling below the target", () => {
    expect(() => decideBudget(1, { targetUsd: 30, ceilingUsd: 20 }, "capture")).toThrow();
  });
});

describe("pricing", () => {
  it("computes cost including cache reads and writes", () => {
    const c = costUsd("claude-sonnet-5-5", { inputTokens: 14_000, outputTokens: 2_500, cacheReadTokens: 10_000, cacheWriteTokens: 0 });
    // 14k*$2/M + 10k*$0.2/M + 2.5k*$10/M = 0.028 + 0.002 + 0.025
    expect(c).toBeCloseTo(0.055, 6);
  });
  it("refuses unknown models so the cap cannot be bypassed", () => {
    expect(() => costUsd("unknown-model", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toThrow();
  });
});

describe("retry policy", () => {
  const noSleep = async () => {};
  it("retries transient errors up to 3 times and reports the count", async () => {
    let n = 0;
    const { value, retries } = await withRetries(async () => {
      if (++n < 3) throw new TransientModelError("overloaded", 529);
      return "ok";
    }, { maxRetries: 3, baseDelayMs: 1, sleep: noSleep });
    expect(value).toBe("ok");
    expect(retries).toBe(2);
  });
  it("does not retry permanent errors", async () => {
    let n = 0;
    await expect(withRetries(async () => { n++; throw new PermanentModelError("bad request", 400); },
      { maxRetries: 3, baseDelayMs: 1, sleep: noSleep })).rejects.toBeInstanceOf(PermanentModelError);
    expect(n).toBe(1);
  });
  it("classifies HTTP statuses", () => {
    expect(classifyStatus(429)).toBe("transient");
    expect(classifyStatus(529)).toBe("transient");
    expect(classifyStatus(undefined)).toBe("transient");
    expect(classifyStatus(400)).toBe("permanent");
    expect(classifyStatus(401)).toBe("permanent");
  });
});

/** Memory recorder with the same reservation rules as PgLlmCallRecorder (single-threaded, so atomic). */
class MemoryRecorder implements LlmCallRecorder {
  rows: Array<{ id: string; status: string; reserved: number; cost: number; retries: number }> = [];
  constructor(private spentBefore = 0) {}
  async monthToDateUsd() {
    return this.spentBefore + this.rows.reduce((s, r) => s + r.cost + (r.status === "reserved" ? r.reserved : 0), 0);
  }
  async reserve(r: ReservationRequest): Promise<ReservationResult> {
    const decision = decideReservation(await this.monthToDateUsd(), r.reservedUsd, r.limits, r.purpose);
    const id = `r${this.rows.length}`;
    if (!decision.allowed) { this.rows.push({ id, status: "budget_blocked", reserved: 0, cost: 0, retries: 0 }); return { allowed: false, decision }; }
    this.rows.push({ id, status: "reserved", reserved: r.reservedUsd, cost: 0, retries: 0 });
    return { allowed: true, reservationId: id, decision };
  }
  async settle(id: string, st: Settlement) {
    const row = this.rows.find((x) => x.id === id)!;
    Object.assign(row, { status: st.status, reserved: 0, cost: st.costUsd, retries: st.retries });
  }
}

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  pipeline: "j2", step: "extract", purpose: "capture", model: "claude-sonnet-5-5", promptVersion: "test-1",
  system: "s", messages: [{ role: "user", content: "hello" }], maxTokens: 100, ...over,
});

const okProvider = (usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }): ModelProvider => ({
  async send(): Promise<ProviderResult> { return { text: "result", model: "claude-sonnet-5-5", stopReason: "end_turn", usage }; },
});

describe("worst-case estimate (ADR-034)", () => {
  it("bounds input tokens by UTF-8 bytes, including multibyte text", () => {
    const req = request({ system: "sistema", messages: [{ role: "user", content: "mañana — 会議" }] });
    expect(maxInputTokens(req)).toBe(Buffer.byteLength("sistema") + Buffer.byteLength("mañana — 会議") + 64 * 2);
  });
  it("is never below the actual cost for the same request", () => {
    const req = request({ maxTokens: 200, messages: [{ role: "user", content: "x".repeat(4000) }] });
    // Even if every byte were a token billed at the cache-write rate, and output hit max_tokens:
    const actual = costUsd("claude-sonnet-5-5", { inputTokens: 0, cacheWriteTokens: maxInputTokens(req), cacheReadTokens: 0, outputTokens: 200 });
    expect(worstCaseCostUsd(req)).toBeGreaterThanOrEqual(actual);
  });
});

describe("metered model client with reservations", () => {
  it("reserves, calls, and settles to the actual cost", async () => {
    const rec = new MemoryRecorder();
    const client = new MeteredModelClient(okProvider(), rec, { limits: L });
    const r = await client.complete(request({ captureId: "c1" }));
    expect(r.costUsd).toBeCloseTo(0.004, 6); // 1000*$2/M + 200*$10/M
    expect(rec.rows).toEqual([{ id: "r0", status: "ok", reserved: 0, cost: r.costUsd, retries: 0 }]);
    expect(await rec.monthToDateUsd()).toBeCloseTo(0.004, 6);
  });

  it("blocks a call whose worst case would cross its threshold, before calling the provider", async () => {
    let called = false;
    const provider: ModelProvider = { async send() { called = true; throw new Error("should not be called"); } };
    const req = request({ purpose: "shadow", maxTokens: 1000 });
    const rec = new MemoryRecorder(30 - worstCaseCostUsd(req) / 2); // below target now, but not after this call
    const client = new MeteredModelClient(provider, rec, { limits: L });
    await expect(client.complete(req)).rejects.toBeInstanceOf(BudgetBlockedError);
    expect(called).toBe(false);
    expect(rec.rows[0]?.status).toBe("budget_blocked");
  });

  it("counts in-flight reservations, so a second concurrent call sees the first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider: ModelProvider = { async send() { await gate; return okProvider().send(request()); } };
    const req = request({ purpose: "shadow", maxTokens: 1000 });
    const worst = worstCaseCostUsd(req);
    const rec = new MemoryRecorder(30 - 1.5 * worst); // room for exactly one worst-case call
    const client = new MeteredModelClient(provider, rec, { limits: L });
    const first = client.complete(req);
    await new Promise((r) => setTimeout(r, 0));
    await expect(client.complete(req)).rejects.toBeInstanceOf(BudgetBlockedError);
    release();
    await first;
  });

  it("never starts a weekly-review call that could cross the hard ceiling", async () => {
    let called = false;
    const provider: ModelProvider = { async send() { called = true; throw new Error("should not be called"); } };
    const req = request({ purpose: "weekly_review", maxTokens: 1000 });
    const rec = new MemoryRecorder(36 - worstCaseCostUsd(req) / 2);
    const client = new MeteredModelClient(provider, rec, { limits: L });
    const err = await client.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetBlockedError);
    expect((err as BudgetBlockedError).level).toBe("ceiling");
    expect(called).toBe(false);
  });

  it("refuses a request whose worst case exceeds the per-call ceiling", async () => {
    const rec = new MemoryRecorder();
    const client = new MeteredModelClient(okProvider(), rec, { limits: L });
    const huge = request({ model: "claude-opus-5-5", maxTokens: 60_000 }); // 60k * $20/M = $1.20
    await expect(client.complete(huge)).rejects.toThrow(/per-call ceiling/);
    expect(rec.rows).toHaveLength(0);
  });

  it("settles failed calls to zero cost and records retries", async () => {
    const provider: ModelProvider = { async send() { throw new TransientModelError("overloaded", 529); } };
    const rec = new MemoryRecorder();
    const client = new MeteredModelClient(provider, rec, { limits: L, baseDelayMs: 1, sleep: async () => {} });
    await expect(client.complete(request())).rejects.toBeInstanceOf(TransientModelError);
    expect(rec.rows[0]).toMatchObject({ status: "error", retries: 3, reserved: 0, cost: 0 });
  });

  it("refuses an unpriced model before anything is recorded", async () => {
    const rec = new MemoryRecorder();
    const client = new MeteredModelClient(okProvider(), rec, { limits: L });
    await expect(client.complete(request({ model: "not-a-model" }))).rejects.toThrow(/no price/);
    expect(rec.rows).toHaveLength(0);
  });
});
