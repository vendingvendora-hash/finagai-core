import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ProviderError } from "../../src/provision/http.js";

describe("provider busy statuses (Neon 423 right after project creation)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (statuses: number[]) => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: "x" }), { status: statuses.shift() ?? 200 }));
    vi.stubGlobal("fetch", f);
    return f;
  };
  it("waits and retries a declared busy status", async () => {
    const f = respond([423, 423, 200]);
    const r = await api("Neon", "https://example.invalid/p", { busy: [423], busyDelayMs: 1 });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("gives up after bounded retries, and does not retry undeclared statuses", async () => {
    respond([423, 423, 423, 423, 423, 423, 423, 423]);
    await expect(api("Neon", "https://example.invalid/p", { busy: [423], busyDelayMs: 1 })).rejects.toThrow(/HTTP 423/);
    const f = respond([423, 200]);
    await expect(api("Other", "https://example.invalid/p")).rejects.toThrow(/HTTP 423/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
import { needsPlanUpgrade } from "../../src/provision/providers/neon.js";

describe("Neon plan-limit detection (ADR-028 needs Launch)", () => {
  it("treats Neon's Free-plan history-retention refusal as a billing action", () => {
    const msg = `HTTP 400 on /api/v2/projects: {"message":"requested history retention seconds exceeds allowed maximum; requested_history_retention_seconds:\\"604800\\", max:\\"21600\\""}`;
    expect(needsPlanUpgrade(new ProviderError("Neon", 400, msg))).toBe(true);
  });
  it("treats 402 and plan or billing messages as a billing action", () => {
    expect(needsPlanUpgrade(new ProviderError("Neon", 402, "payment required"))).toBe(true);
    expect(needsPlanUpgrade(new ProviderError("Neon", 403, "project limit reached for this plan"))).toBe(true);
  });
  it("does not hide other failures", () => {
    expect(needsPlanUpgrade(new ProviderError("Neon", 400, "invalid region_id"))).toBe(false);
    expect(needsPlanUpgrade(new ProviderError("Neon", 401, "unauthorized"))).toBe(false);
    expect(needsPlanUpgrade(new Error("socket hang up"))).toBe(false);
  });
});
