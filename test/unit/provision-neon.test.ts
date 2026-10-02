import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/provision/http.js";
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
