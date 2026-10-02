import { randomUUID } from "node:crypto";
import type { ClaimResult, DeliveryStore, EmailMessage, EmailSender } from "../../src/notify/delivery.js";
import { AmbiguousSendError, ProviderIdempotencyConflictError } from "../../src/notify/delivery.js";

type Row = { status: string; hash: string; until: number; attempts: number; token: string | null; firstAmbiguousAt: number | null };

/** In-memory ledger with the same rules as PgDeliveryStore. */
export class MemoryDeliveryStore implements DeliveryStore {
  rows = new Map<string, Row>();
  constructor(public clock = { now: 0 }) {}
  async claim(key: string, _purpose: string, hash: string, leaseMs: number, windowMs: number): Promise<ClaimResult> {
    const r = this.rows.get(key);
    const token = randomUUID();
    if (!r) {
      this.rows.set(key, { status: "sending", hash, until: this.clock.now + leaseMs, attempts: 1, token, firstAmbiguousAt: null });
      return { kind: "claimed", token };
    }
    const inWindow = r.firstAmbiguousAt === null || this.clock.now - r.firstAmbiguousAt < windowMs;
    const reclaimable = r.status === "pending" || r.status === "failed"
      || (r.status === "sending" && r.until < this.clock.now && inWindow)
      || (r.status === "uncertain" && inWindow);
    if (r.hash === hash && reclaimable) {
      Object.assign(r, { status: "sending", until: this.clock.now + leaseMs, attempts: r.attempts + 1, token });
      return { kind: "claimed", token };
    }
    if (r.hash !== hash) return { kind: "payload_conflict" };
    if (r.status === "sent") return { kind: "already_sent" };
    if (r.status === "conflict") return { kind: "conflict_blocked" };
    if (r.status === "uncertain" || (r.status === "sending" && r.until < this.clock.now)) return { kind: "needs_reconciliation" };
    return { kind: "in_progress" };
  }
  private set(key: string, token: string, status: string): boolean {
    const r = this.rows.get(key);
    if (!r || r.status !== "sending" || r.token !== token) return false;
    Object.assign(r, { status, token: null });
    if (status === "uncertain" && r.firstAmbiguousAt === null) r.firstAmbiguousAt = this.clock.now;
    return true;
  }
  async markSent(key: string, token: string, _providerMessageId?: string | null) { return this.set(key, token, "sent"); }
  async markUncertain(key: string, token: string, _error?: string) { return this.set(key, token, "uncertain"); }
  async markFailed(key: string, token: string, _error?: string) { return this.set(key, token, "failed"); }
  async markConflict(key: string, token: string, _error?: string) { return this.set(key, token, "conflict"); }
}

/**
 * Provider double modeled on Resend: deduplicates by idempotency key for a limited retention
 * window, and rejects reuse of a retained key with a different payload.
 */
export class ProviderDouble implements EmailSender {
  inbox: EmailMessage[] = [];
  private keys = new Map<string, { at: number; body: string }>();
  /** When set, the provider ACCEPTS the next message but the caller sees an ambiguous timeout. */
  timeoutAfterAccept = false;
  constructor(public clock = { now: 0 }, public retentionMs = 24 * 3_600_000) {}
  async send(m: EmailMessage, key: string): Promise<string> {
    const body = JSON.stringify(m);
    const seen = this.keys.get(key);
    if (seen && this.clock.now - seen.at < this.retentionMs) {
      if (seen.body !== body) throw new ProviderIdempotencyConflictError("invalid_idempotent_request");
      return `msg-${key}`; // replayed response, no new email
    }
    this.keys.set(key, { at: this.clock.now, body });
    this.inbox.push(m);
    if (this.timeoutAfterAccept) { this.timeoutAfterAccept = false; throw new AmbiguousSendError("timeout after accept"); }
    return `msg-${key}`;
  }
}
