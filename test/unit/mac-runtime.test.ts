/**
 * Mac runtime lifecycle (ADR-066). Locks the rule that caused tasks 33/34 to sit "active" forever:
 * a task's lifecycle is DERIVED from worker evidence, never assumed from a row existing.
 */
import { describe, it, expect } from "vitest";
import { deriveLifecycle, macOnline, MAC_HEARTBEAT_FRESH_MS, TASK_PROGRESS_FRESH_MS, type MacRuntime } from "../../src/mac/runtime.js";

const rt = (ageMs: number): MacRuntime => ({ id: "primary", lastHeartbeatAt: new Date(Date.now() - ageMs), helperVersion: "runtime-1",
  capabilities: {}, frontmostApp: null, frontmostWindow: null, currentTaskId: null, startedAt: null });

describe("Mac runtime lifecycle (ADR-066)", () => {
  it("unclaimed task + NO Mac heartbeat => waiting_for_mac (the tasks 33/34 failure, now named truthfully)", () => {
    const r = deriveLifecycle({ status: "active", claimed_at: null, last_progress_at: null }, null);
    expect(r.lifecycle).toBe("waiting_for_mac");
  });
  it("unclaimed task + stale heartbeat => waiting_for_mac", () => {
    const r = deriveLifecycle({ status: "active", claimed_at: null, last_progress_at: null }, rt(MAC_HEARTBEAT_FRESH_MS + 5000));
    expect(r.lifecycle).toBe("waiting_for_mac");
  });
  it("unclaimed task + fresh heartbeat => queued (worker will pick it up)", () => {
    const r = deriveLifecycle({ status: "active", claimed_at: null, last_progress_at: null }, rt(2000));
    expect(r.lifecycle).toBe("queued");
  });
  it("claimed + fresh progress => executing", () => {
    const r = deriveLifecycle({ status: "active", claimed_at: new Date(), last_progress_at: new Date() }, rt(1000));
    expect(r.lifecycle).toBe("executing");
  });
  it("claimed + stale progress => stalled (reclaimable), never silently 'active'", () => {
    const r = deriveLifecycle({ status: "active", claimed_at: new Date(Date.now() - 600_000), last_progress_at: new Date(Date.now() - TASK_PROGRESS_FRESH_MS - 1000) }, rt(1000));
    expect(r.lifecycle).toBe("stalled");
  });
  it("terminal statuses pass through", () => {
    expect(deriveLifecycle({ status: "done", claimed_at: null, last_progress_at: null }, null).lifecycle).toBe("done");
    expect(deriveLifecycle({ status: "failed", claimed_at: null, last_progress_at: null }, null).lifecycle).toBe("failed");
  });
  it("macOnline is false with no runtime and true with a fresh heartbeat", () => {
    expect(macOnline(null)).toBe(false);
    expect(macOnline(rt(1000))).toBe(true);
    expect(macOnline(rt(MAC_HEARTBEAT_FRESH_MS + 1))).toBe(false);
  });
});
