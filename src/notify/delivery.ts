/**
 * Idempotent delivery of externally visible messages (ADR-033, clarified).
 *
 * AUTHORITATIVE: finagai.outbound_delivery. One row per logical delivery, keyed by a deterministic
 * idempotency key derived from the immutable identity of what is delivered (for a weekly review:
 * "review-email:<review_id>"). A 'sent' row is never sent again, no matter how much later.
 *
 * DEFENSE IN DEPTH ONLY: the same key is passed to the provider (Resend Idempotency-Key), which
 * covers a crash between a successful send and markSent while the provider still retains the key.
 *
 * Rules: never generate a new key for a retry; retry with the identical payload (enforced by a
 * payload hash); a provider-reported payload conflict stops the delivery for investigation.
 * The recipient is never a parameter: it comes from configuration only (G18).
 */
import { createHash } from "node:crypto";

export interface EmailMessage {
  subject: string;
  text: string;
  html?: string;
}

export type ClaimResult =
  | { kind: "claimed"; token: string }   // fresh lease token; only its holder may finish the delivery
  | { kind: "already_sent" }
  | { kind: "in_progress" }          // another process holds a live sending lease
  | { kind: "payload_conflict" }     // same key, different payload: never send
  | { kind: "conflict_blocked" }     // previously stopped for investigation
  | { kind: "needs_reconciliation" }; // ambiguous outcome older than the provider's dedup window

export interface DeliveryStore {
  /** Reclaims an 'uncertain' delivery only while its first ambiguous attempt is within `uncertainWindowMs`. */
  claim(key: string, purpose: string, payloadHash: string, leaseMs: number, uncertainWindowMs: number, reviewId?: string): Promise<ClaimResult>;
  /** Each returns false (and changes nothing) unless `token` still holds the sending lease. */
  markSent(key: string, token: string, providerMessageId: string | null): Promise<boolean>;
  /** The provider may or may not have accepted the message (timeout, network error, 5xx). */
  markUncertain(key: string, token: string, error: string): Promise<boolean>;
  markFailed(key: string, token: string, error: string): Promise<boolean>;
  markConflict(key: string, token: string, error: string): Promise<boolean>;
}

export interface EmailSender {
  /** Must forward idempotencyKey to the provider. Returns the provider's message ID if any. */
  send(message: EmailMessage, idempotencyKey: string): Promise<string | null>;
}

/** The provider's outcome is unknown: it may have accepted the message. */
export class AmbiguousSendError extends Error {}

/** The provider says this key was already used with a different payload. */
export class ProviderIdempotencyConflictError extends Error {}
/** Core refused to send: same logical delivery, different payload. Needs investigation. */
export class DeliveryConflictError extends Error {}

/**
 * "sent" means Core recorded the send under its own lease. "lease_lost" means another attempt owns
 * the delivery now: this attempt must not report success. "needs_reconciliation" means an ambiguous
 * attempt is older than the provider's dedup window, so Core will not risk a duplicate and Julian
 * must reconcile. Core reports what it knows, not what it cannot know.
 */
export type DeliveryResult = "sent" | "already_sent" | "in_progress" | "lease_lost" | "needs_reconciliation";

export const SENDING_LEASE_MS = 2 * 60_000;
/** Provider HTTP timeout: comfortably shorter than the sending lease. */
export const PROVIDER_TIMEOUT_MS = 30_000;
/**
 * Retrying an ambiguous send is safe only while the provider still deduplicates its key. Resend
 * retains idempotency keys for a limited time (verified by Julian); Core uses a conservative
 * 20-hour window from the first ambiguous attempt.
 */
export const PROVIDER_DEDUP_WINDOW_MS = 20 * 3_600_000;

export function payloadHash(m: EmailMessage): string {
  return createHash("sha256").update(JSON.stringify([m.subject, m.text, m.html ?? null])).digest("hex");
}

/** Deterministic key for a weekly review email: tied to the immutable review row, never to time. */
export const reviewEmailKey = (reviewId: string) => `review-email:${reviewId}`;

export async function deliverOnce(
  store: DeliveryStore, sender: EmailSender, key: string, purpose: string, message: EmailMessage, reviewId?: string,
): Promise<DeliveryResult> {
  if (key.length === 0 || key.length > 256) throw new Error("idempotency key must be 1-256 characters");
  const claim = await store.claim(key, purpose, payloadHash(message), SENDING_LEASE_MS, PROVIDER_DEDUP_WINDOW_MS, reviewId);
  switch (claim.kind) {
    case "already_sent": return "already_sent";
    case "in_progress": return "in_progress";
    case "needs_reconciliation": return "needs_reconciliation";
    case "payload_conflict":
    case "conflict_blocked":
      throw new DeliveryConflictError(`delivery ${key} blocked: ${claim.kind}`);
    case "claimed": break;
  }
  const token = claim.token;
  let providerId: string | null;
  try {
    providerId = await sender.send(message, key);
  } catch (err) {
    if (err instanceof ProviderIdempotencyConflictError) {
      if (!(await store.markConflict(key, token, "provider reported idempotency payload conflict"))) return "lease_lost";
      throw new DeliveryConflictError(`delivery ${key} blocked: provider payload conflict`);
    }
    if (err instanceof AmbiguousSendError) {
      if (!(await store.markUncertain(key, token, err.message))) return "lease_lost";
      throw err;
    }
    if (!(await store.markFailed(key, token, err instanceof Error ? err.message : "send failed"))) return "lease_lost";
    throw err;
  }
  // The provider accepted the message, but if this attempt lost its lease meanwhile, another attempt
  // owns the row: do not report success (the provider idempotency key covers the overlap).
  return (await store.markSent(key, token, providerId)) ? "sent" : "lease_lost";
}
