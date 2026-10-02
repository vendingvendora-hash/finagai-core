# ADR-033: At-least-once job dispatch with leases and idempotent handlers

- **Date:** 2026-10-01 · **Status:** decided · **Category:** reversible technical choice (requested by Julian's M2 review)

## Problem

The M2 ledger inserted a permanent `(job, scheduled_for)` row before running a handler. A crash between claim and finish left the slot claimed forever: at-most-once, with silent loss.

## Decision

At-least-once dispatch plus idempotent execution:

- A claim takes a **lease** (5 minutes) on the slot; the dispatcher **heartbeats** every lease/3 while the handler runs.
- A later tick may reclaim a slot whose lease expired (`running`, `lease_expires_at < now()`), or whose last attempt failed, while `attempt < max_attempts` (3). An expired lease at the final attempt becomes a terminal `failed` row.
- `succeeded` and `skipped` slots never run again.
- Only the lease owner can heartbeat or finish; a crashed process that resumes cannot overwrite the recovered outcome.
- Handlers receive a stable `idempotencyKey` per slot (`<job>:<scheduledFor ISO>`) and an `AbortSignal` fired on lease loss.

Side-effect idempotency:

| Handler | Idempotency mechanism |
| --- | --- |
| weekly_review | `review.slot_key` unique; retries reuse the row. Delivery via `deliverOnce()` keyed `review-email:<review_id>` |
| missed_run_check | Recovery, not only alerting: re-runs weekly_review with the same slot key if the review was not delivered, then alerts via `deliverOnce()` keyed by slot |
| nightly_backup | Object key derived from the slot; a retry overwrites the same object |
| staleness_sweep | Naturally idempotent |

`deliverOnce()` uses `outbound_delivery` (unique key; `sent` rows never resend) and passes the same key to the provider's idempotency header, covering a crash between a successful send and `markSent`. **To verify at M2 deploy:** Resend's `Idempotency-Key` header behavior and retention window.

## Recovery bounds

A slot stays due for 120 minutes; ticks run every 15. After a crash, the slot is reclaimed at the first tick after its lease expires (within 5 to 20 minutes). Recovery inside the window is automatic. If the platform runs no tick at all for the rest of the window, the 09:00 missed-run check recovers the weekly review; other jobs recover at their next daily slot. Detection (alert) remains as a second layer, not the only one.

## Evidence

`test/unit/dispatcher.test.ts` (scenarios 1-6 plus retry and stale-owner) and `test/integration/db.test.ts` (lease expiry, concurrent claims, retry limit, terminal failure, delivery once) against Postgres 16.

## Addendum (2026-10-01): delivery idempotency, clarified by Julian

- `outbound_delivery` is the **authoritative** idempotency mechanism. Resend's idempotency key is defense in depth only, because the provider retains keys for a limited time.
- Keys are deterministic and tied to the logical delivery (weekly review: `review-email:<review_id>`); a retry never generates a new key and must carry the identical payload (SHA-256 payload hash stored per key).
- A different payload under an existing key is always a conflict, even after a successful send. A provider-reported payload mismatch (HTTP 409 `invalid_idempotent_request`) marks the delivery `conflict` and stops it for investigation; no replacement key is generated. Resend's concurrent-request 409 is transient and retried with the same key.
- Concurrent attempts are serialized by an atomic claim with a 2-minute sending lease; only one sends.
- Evidence: `test/unit/delivery.test.ts` (retry inside provider retention, retry after retention, mutated payload before and after send, provider conflict, concurrent attempts) and a Postgres race test in `test/integration/db.test.ts`.
