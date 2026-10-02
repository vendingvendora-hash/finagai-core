# ADR-037: Concurrency fixes, MCP tool layer, J3 implementation, evaluation harness

- **Date:** 2026-10-01 · **Status:** decided · **Category:** implementation details and reversible technical choices

## Concurrency fixes (requested in Julian's review)

1. **Deferred-queue bound is atomic.** count, decision, and status transition run under one Postgres advisory transaction lock (`finagai.deferred_capture_queue`). Concurrent captures can never exceed `MAX_DEFERRED_CAPTURES`; excess captures are refused with an explicit message; replay frees capacity. Alerts go through `DeferredQueueAlerts`, idempotent per threshold per month (message body fixed per key). Evidence: 20 concurrent deferrals racing the last 2 of 200 slots yield exactly 2 deferred, 18 refused, final count 200.
2. **Capture idempotency is atomic.** `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`; losers read the existing row. `capture.payload_sha256` (redacted text plus source type, so no derivative of a secret is stored) turns a reused key with different content into `idempotency_conflict`. Evidence: 6 concurrent identical requests produce one capture and five `already_captured` answers; a mutated payload is refused.
3. **Delivery leases have owners.** Every claim or reclaim issues a fresh `sending_token`; `markSent`, `markFailed`, and `markConflict` change the row only when key and token match. The provider call has a 30-second timeout (a quarter of the 2-minute lease); the provider idempotency key covers the ambiguous timeout case. Evidence: the stale-worker sequence (A claims, lease expires, B reclaims, A is powerless, B completes) in memory and on Postgres.

## MCP tool layer

- **SDK:** `@modelcontextprotocol/server` 2.2 with the stateless `createMcpHandler`: a fresh MCP server per request, all state in Postgres. Finagai moved from zod 3 to zod 4 to match the SDK (no behavior change; all tests pass).
- **Tools exposed now (15):** get_charter, capture, get_state_overview, get_project, search_state, get_item, list_open_conflicts, list_pending_proposals, request_conflict_resolution, request_proposal_decision, request_archival, request_seed_promotion, get_approval_request, operating_review, get_latest_review. The three seeding tools arrive in M7.
- Request tools only stage `governance_request` rows and return an approval link; the raw nonce travels only in the link and Core stores its hash. Every call writes a `tool_called` event (tool name and outcome, never arguments). Output passes the G19 tier filter and the G21 size cap.
- Bearer verification runs before the handler; token, client ID, and subject are passed as `authInfo`.

## J3

- Collection (steps 1-2) is pure SQL; must-mention covers overdue, blockers, open conflicts, governance decisions since the last review, and items due within 7 days at priority 1-2.
- Validation adds two rules to G15-G17: **V5**, a recommendation based on a disputed item must cite its conflict; **V6**, headlines may not state dates (code renders them). One repair attempt; then the degraded review.
- At the hard ceiling J3 makes zero model calls. On-demand reviews blocked at the $30 target return an explicit message instead of degrading silently.
- Weekly reviews are keyed by slot; delivery is keyed by review ID. The missed-run check re-runs an undelivered weekly review with the same slot key and sends one alert per outcome.

## Evaluation harness

- `npm run eval:j2` runs the 12 ready J2 cases (T01-T10, E01, E03) with the real model, 3 repetitions each, each in its own project, using the `eval` budget purpose. The report records unacceptable and costly failures separately and the evaluation's cost. A test verifies every assertion is valid SQL before any paid run.
- J3 real-model cases (T11-T20) need SQL fixtures in the same format; they follow the first J2 run.

## Explicit v1 deferral

**Arbitrary relationship capture is not implemented.** Extracted `relationship` candidates are rejected with `unsupported_type_v0` and reported to Julian. Core still creates specific relationships it controls (entity to project, external reference to project). This is a documented v1 scope limit, not a general relationship-capture capability, and is expanded only if J2 acceptance criteria require it.
