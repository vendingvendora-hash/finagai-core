# ADR-034: Model-spend control: $30 target, $36 hard ceiling, atomic worst-case reservations

- **Date:** 2026-10-01 (revised the same day per Julian's clarification) · **Status:** decided
- **Category:** implementation of ADR-025 as clarified by Julian

## The guarantee

> **Normal target = $30/month. Absolute model-API ceiling = $36/month unless Julian explicitly changes it.**

No model call may start if it could take month-to-date model spend above $36. No purpose is exempt, including the weekly review. The earlier "$66 theoretical ceiling" is withdrawn: it is not an allowed outcome.

## Levels (projected = committed + live reservations + this call's worst case)

| Projected spend | Level | Behavior |
| --- | --- | --- |
| below $24 (80% of target) | normal | all calls allowed |
| $24 to below $30 | warning | all calls allowed; Julian notified once |
| $30 to $36 | restricted | shadow runs, on-demand reviews, evaluation paused (evaluation reports its expected incremental cost instead) |
| above $36 | ceiling | no model call starts; J3 produces its zero-model degraded review; J2 stores screened captures as `budget_deferred` |

## Mechanism

1. `worstCaseCostUsd()` bounds input tokens by UTF-8 bytes plus 64 tokens per message, priced at the cache-write rate, plus `max_tokens` at the output rate. Actual cost cannot exceed it, given correct prices. Calls whose worst case exceeds $1.00 are refused.
2. Under one Postgres advisory lock, the projected total is evaluated and either a `reserved` row or a `budget_blocked` row is written. Concurrent calls cannot pass on the same stale total.
3. After the call, the reservation settles to the actual cost (zero on failure). Reservations older than 10 minutes stop counting (the client's worst case is about 4.5 minutes).

## Behavior at the ceiling

- **J3** still runs on schedule, using the deterministic degraded path with zero model calls: every must-mention item, dates and statuses rendered by code, clearly marked as a degraded budget-limit review, `modelInvoked: false` recorded, no recommendations invented.
- **J2** screens the input (Prohibited and Highly Sensitive content redacted before persistence), stores the sanitized capture as `budget_deferred` with its original timestamp and idempotency key, extracts nothing, and reports the deferred count. Replay runs normal J2 in arrival order once budget exists or Julian raises the ceiling. The queue is bounded (`MAX_DEFERRED_CAPTURES`, default 200) with alerts at 80% and 100%; when full, a new capture is refused loudly, never silently dropped.

## Maximum overshoot

Zero above $36. The bound holds under concurrency, provided `MODEL_PRICES` matches Anthropic's prices (re-verified before the Capable promotion) and no call outlives the reservation TTL.

## Evidence

- Unit: thresholds, ceiling with no exemptions, in-flight reservation visibility, per-call ceiling (`test/unit/llm.test.ts`); degraded J3 (`test/unit/j3-degraded.test.ts`).
- Postgres: 25 concurrent reservations at the $30 boundary (shadow) and at the $36 boundary (capture and weekly review) never cross (`test/integration/db.test.ts`); J2 deferral, replay, queue bound and alerts (`test/integration/j2.test.ts`).
