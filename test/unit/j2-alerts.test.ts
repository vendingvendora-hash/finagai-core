import { describe, expect, it } from "vitest";
import { DeferredQueueAlerts } from "../../src/pipelines/j2/alerts.js";
import { MemoryDeliveryStore, ProviderDouble } from "../helpers/delivery.js";

describe("deferred-queue alerts are idempotent", () => {
  it("sends one email per threshold per month, however often it is called", async () => {
    let now = new Date("2026-10-15T15:00:00Z");
    const provider = new ProviderDouble({ now: 0 }, 0); // provider dedup off: the ledger alone dedupes
    const alerts = new DeferredQueueAlerts(new MemoryDeliveryStore(), provider, "America/New_York", () => now);
    await alerts.deferredQueue(80, 160, 200);
    await alerts.deferredQueue(80, 170, 200);
    await alerts.deferredQueue(100, 200, 200);
    await alerts.deferredQueue(100, 200, 200);
    expect(provider.inbox.map((m) => m.subject)).toEqual([
      "Finagai: deferred-capture queue at 80%", "Finagai: deferred-capture queue is full"]);
    now = new Date("2026-11-02T15:00:00Z");
    await alerts.deferredQueue(80, 165, 200);
    expect(provider.inbox).toHaveLength(3);
  });
});
