/**
 * Daily maintenance (03:00 America/New_York). Idempotent; safe to run more than once per slot.
 *   1. expire governance requests past their expiry (event per request; nothing else changes)
 *   2. replay budget-deferred captures in arrival order while budget allows (ADR-038)
 * Staleness, retention eligibility, and uncertain deliveries need no writes: J3 derives them from
 * dates on every review.
 */
import type pg from "pg";
import { appendEvent } from "../db/index.js";
import { replayDeferred, type J2Deps } from "../pipelines/j2/capture.js";
import type { JobHandler } from "./dispatcher.js";

export async function expireGovernanceRequests(pool: pg.Pool): Promise<number> {
  const expired = await pool.query<{ id: string }>(
    `UPDATE governance_request SET status = 'expired' WHERE status = 'pending' AND expires_at < now() RETURNING id`);
  for (const r of expired.rows) {
    await appendEvent(pool, { actor: "job", action: "governance_expired", entityType: "governance_request", entityId: r.id, client: "scheduler" });
  }
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
