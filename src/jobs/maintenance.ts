/**
 * Daily maintenance (03:00 America/New_York). Idempotent; safe to run more than once per slot.
 *   1. expire governance requests past their expiry (event per request; nothing else changes)
 *   2. replay budget-deferred captures in arrival order while budget allows (ADR-038)
 * Staleness, retention eligibility, and uncertain deliveries need no writes: J3 derives them from
 * dates on every review.
 */
import { recordBulkTransitions } from "../db/state-events.js";
import type pg from "pg";
import { appendEvent } from "../db/index.js";
import { replayDeferred, type J2Deps } from "../pipelines/j2/capture.js";
import type { JobHandler } from "./dispatcher.js";

export async function expireGovernanceRequests(pool: pg.Pool): Promise<number> {
  const expired = await pool.query<{ id: string }>(
    `WITH p AS (SELECT id, status, decided_at FROM governance_request WHERE status = 'pending' AND expires_at < now() FOR UPDATE)
     UPDATE governance_request g SET status = 'expired' FROM p WHERE g.id = p.id RETURNING g.id, p.status AS "before.status", p.decided_at AS "before.decided_at"`);
  await recordBulkTransitions(pool, expired.rows, { actor: "job", action: "governance_expired", table: "governance_request", audit: { client: "scheduler" } });
  return expired.rowCount ?? 0;
}

export function dailyMaintenanceHandler(pool: pg.Pool, j2: () => J2Deps): JobHandler {
  return async (ctx) => {
    const expired = await expireGovernanceRequests(pool);
    if (ctx.signal.aborted) return { status: "failed", detail: "lease lost" };
    const replay = await replayDeferred(j2(), 50);
    return { status: "succeeded", detail: `expired ${expired} requests; replayed ${replay.replayed}; ${replay.stillDeferred} still deferred` };
  };
}
