/**
 * Delivery idempotency (ADR-033, clarified by Julian): the local ledger is authoritative;
 * the provider's idempotency key is defense in depth with limited retention.
 */
import { describe, expect, it } from "vitest";
import {
  deliverOnce, DeliveryConflictError, payloadHash, PROVIDER_DEDUP_WINDOW_MS, reviewEmailKey, type DeliveryStore, type EmailSender,
} from "../../src/notify/delivery.js";
import { ResendSender } from "../../src/notify/resend.js";
import { MemoryDeliveryStore, ProviderDouble } from "../helpers/delivery.js";

const HOUR = 3_600_000;
const msg = { subject: "Finagai weekly review: week of 2026-10-05", text: "Requires attention: ..." };
const key = reviewEmailKey("5f0c1d2e-0000-4000-8000-000000000001");

/** Wraps a store so markSent "crashes" once: the provider accepted the email, the ledger never heard. */
function crashOnMarkSent(store: MemoryDeliveryStore): DeliveryStore {
  let crashed = false;
  return {
    claim: store.claim.bind(store), markFailed: store.markFailed.bind(store), markConflict: store.markConflict.bind(store),
    markUncertain: store.markUncertain.bind(store),
    markSent: async (k, t, id) => { if (!crashed) { crashed = true; throw new Error("process crashed"); } return store.markSent(k, t, id); },
  };
}

describe("deterministic keys", () => {
  it("derives the weekly-review key from the review identity only", () => {
    expect(reviewEmailKey("abc")).toBe("review-email:abc");
    expect(payloadHash(msg)).toBe(payloadHash({ ...msg }));
  });
});

describe("1. provider retry inside its retention window", () => {
  it("a crash after the provider accepted the email yields one email: the provider replays the key", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock);
    await expect(deliverOnce(crashOnMarkSent(store), provider, key, "weekly_review", msg)).rejects.toThrow("process crashed");
    clock.now += 3 * 60_000; // after the 2-minute sending lease, well inside provider retention
    expect(await deliverOnce(store, provider, key, "weekly_review", msg)).toBe("sent");
    expect(provider.inbox).toHaveLength(1);
  });
});

describe("2. retry after the provider's retention window", () => {
  it("Core's ledger alone prevents the duplicate once the delivery is recorded as sent", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock);
    expect(await deliverOnce(store, provider, key, "weekly_review", msg)).toBe("sent");
    clock.now += 30 * 24 * HOUR; // provider has long forgotten the key
    expect(await deliverOnce(store, provider, key, "weekly_review", msg)).toBe("already_sent");
    expect(provider.inbox).toHaveLength(1);
  });
});

describe("3. same key with a mutated payload", () => {
  it("is refused by Core before contacting the provider, and no new key is generated", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock);
    await expect(deliverOnce(crashOnMarkSent(store), provider, key, "weekly_review", msg)).rejects.toThrow();
    clock.now += 3 * 60_000;
    await expect(deliverOnce(store, provider, key, "weekly_review", { ...msg, text: "edited" })).rejects.toBeInstanceOf(DeliveryConflictError);
    expect(provider.inbox).toHaveLength(1);
  });

  it("is refused even after the original delivery was sent", async () => {
    const store = new MemoryDeliveryStore();
    const provider = new ProviderDouble();
    await deliverOnce(store, provider, key, "weekly_review", msg);
    await expect(deliverOnce(store, provider, key, "weekly_review", { ...msg, subject: "changed" })).rejects.toBeInstanceOf(DeliveryConflictError);
    expect(provider.inbox).toHaveLength(1);
  });

  it("a provider-reported payload conflict blocks the delivery for investigation", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock);
    await provider.send({ ...msg, text: "something else" }, key); // key already used upstream with other content
    await expect(deliverOnce(store, provider, key, "weekly_review", msg)).rejects.toBeInstanceOf(DeliveryConflictError);
    expect(store.rows.get(key)?.status).toBe("conflict");
    clock.now += 48 * HOUR;
    await expect(deliverOnce(store, provider, key, "weekly_review", msg)).rejects.toBeInstanceOf(DeliveryConflictError);
    expect(provider.inbox).toHaveLength(1);
  });
});

describe("4. concurrent send attempts", () => {
  it("only one of several simultaneous attempts sends", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock, 0); // provider dedup disabled: the ledger must do it alone
    const results = await Promise.all(Array.from({ length: 5 }, () => deliverOnce(store, provider, key, "weekly_review", msg)));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === "in_progress")).toHaveLength(4);
    expect(provider.inbox).toHaveLength(1);
  });
});

describe("5. lease ownership: a stale worker cannot change a reclaimed delivery", () => {
  it("A claims, A's lease expires, B reclaims with a new token, A is powerless, B completes", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const a = await store.claim(key, "weekly_review", payloadHash(msg), 120_000, PROVIDER_DEDUP_WINDOW_MS);
    expect(a.kind).toBe("claimed");
    clock.now += 121_000; // A's provider call is delayed past its lease
    const b = await store.claim(key, "weekly_review", payloadHash(msg), 120_000, PROVIDER_DEDUP_WINDOW_MS);
    expect(b.kind).toBe("claimed");
    const tokenA = (a as { token: string }).token, tokenB = (b as { token: string }).token;
    expect(tokenB).not.toBe(tokenA);
    expect(await store.markSent(key, tokenA, "late-A")).toBe(false);
    expect(await store.markFailed(key, tokenA, "late-A")).toBe(false);
    expect(await store.markConflict(key, tokenA, "late-A")).toBe(false);
    expect(store.rows.get(key)?.status).toBe("sending");
    expect(await store.markSent(key, tokenB, "B")).toBe(true);
    expect(store.rows.get(key)?.status).toBe("sent");
  });
});

describe("6. stale owner at the deliverOnce level (Julian's sequence)", () => {
  it("A's provider call succeeds after its lease was reclaimed: A returns lease_lost, never sent", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock);
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => { releaseA = r; });
    const slowA: EmailSender = { send: async (m, k) => { await gate; return provider.send(m, k); } };
    const a = deliverOnce(store, slowA, key, "weekly_review", msg);   // A claims, then waits on the provider
    await new Promise((r) => setTimeout(r, 0));
    clock.now += 121_000;                                              // A's lease expires
    const b = await store.claim(key, "weekly_review", payloadHash(msg), 120_000, PROVIDER_DEDUP_WINDOW_MS); // B reclaims
    expect(b.kind).toBe("claimed");
    releaseA();
    expect(await a).toBe("lease_lost");                                // not "sent"
    expect(store.rows.get(key)?.status).toBe("sending");               // B still owns it
  });
});

describe("7. ambiguous provider outcomes", () => {
  it("inside the dedup window: the retry reuses the key and the provider replays, one email", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock);
    provider.timeoutAfterAccept = true;
    await expect(deliverOnce(store, provider, key, "weekly_review", msg)).rejects.toThrow(/timeout/);
    expect(store.rows.get(key)?.status).toBe("uncertain");
    clock.now += 3_600_000;
    expect(await deliverOnce(store, provider, key, "weekly_review", msg)).toBe("sent");
    expect(provider.inbox).toHaveLength(1);
  });

  it("beyond the dedup window: Core refuses to resend and asks for reconciliation", async () => {
    const clock = { now: 0 };
    const store = new MemoryDeliveryStore(clock);
    const provider = new ProviderDouble(clock);
    provider.timeoutAfterAccept = true;
    await expect(deliverOnce(store, provider, key, "weekly_review", msg)).rejects.toThrow();
    clock.now += PROVIDER_DEDUP_WINDOW_MS + 60_000;
    expect(await deliverOnce(store, provider, key, "weekly_review", msg)).toBe("needs_reconciliation");
    expect(provider.inbox).toHaveLength(1); // no possible duplicate was sent
  });
});

describe("Resend sender", () => {
  type Call = { url: string; headers: Record<string, string>; body: string };
  const fake = (status: number, body: object, calls: Call[]) => async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status, json: async () => body };
  };
  const cfg = { apiKey: "re_test_not_real", from: "Finagai <review@notify.example.test>", to: "julian@example.test", replyTo: "julian@example.test" };

  it("forwards the same idempotency key and fixed recipient on every attempt", async () => {
    const calls: Call[] = [];
    const s = new ResendSender(cfg, fake(200, { id: "em_1" }, calls));
    expect(await s.send(msg, key)).toBe("em_1");
    await s.send(msg, key);
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual([key, key]);
    expect(JSON.parse(calls[0]!.body).to).toEqual(["julian@example.test"]);
  });

  it("maps a provider payload-mismatch 409 to a conflict, never to a retry with a new key", async () => {
    const s = new ResendSender(cfg, fake(409, { name: "invalid_idempotent_request" }, []));
    const store = new MemoryDeliveryStore();
    await expect(deliverOnce(store, s, key, "weekly_review", msg)).rejects.toBeInstanceOf(DeliveryConflictError);
    expect(store.rows.get(key)?.status).toBe("conflict");
  });

  it("bounds the provider call with a timeout shorter than the sending lease", async () => {
    const hang = (_u: string, init: { signal?: AbortSignal }) => new Promise<never>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const s = new ResendSender(cfg, hang as never, 50);
    const store = new MemoryDeliveryStore();
    await expect(deliverOnce(store, s, key, "weekly_review", msg)).rejects.toThrow(/did not respond in time/);
    expect(store.rows.get(key)?.status).toBe("uncertain"); // outcome unknown; retried only with the SAME key
  });

  it("keeps the provider timeout well under the lease", async () => {
    const { PROVIDER_TIMEOUT_MS, SENDING_LEASE_MS } = await import("../../src/notify/delivery.js");
    expect(PROVIDER_TIMEOUT_MS * 3).toBeLessThanOrEqual(SENDING_LEASE_MS);
  });

  it("treats a concurrent-request 409 and 5xx as ambiguous (uncertain), and 429 as not accepted", async () => {
    for (const [status, body, expected] of [[409, { name: "concurrent_idempotent_requests" }, "uncertain"], [503, {}, "uncertain"], [429, {}, "failed"]] as const) {
      const store = new MemoryDeliveryStore();
      await expect(deliverOnce(store, new ResendSender(cfg, fake(status, body, [])), key, "weekly_review", msg)).rejects.toThrow();
      expect(store.rows.get(key)?.status).toBe(expected);
    }
  });
});
