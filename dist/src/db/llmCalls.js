import { startOfZonedMonth } from "../jobs/time.js";
import { decideReservation, } from "../llm/metered.js";
import { withTransaction } from "./pool.js";
/** Reservations older than this are ignored: a crashed caller cannot pin budget forever. */
export const RESERVATION_TTL_MINUTES = 10;
const SPEND_SQL = `
  SELECT coalesce(sum(cost_usd), 0)
       + coalesce(sum(reserved_usd) FILTER (WHERE status = 'reserved'
                                             AND called_at > now() - interval '${RESERVATION_TTL_MINUTES} minutes'), 0)
         AS total
    FROM llm_call WHERE called_at >= $1`;
/** Persists metering and enforces the spend cap atomically (ADR-034). */
export class PgLlmCallRecorder {
    pool;
    timezone;
    constructor(pool, timezone) {
        this.pool = pool;
        this.timezone = timezone;
    }
    async reserve(r) {
        return withTransaction(this.pool, async (tx) => {
            // One budget lock serializes every reservation; it is held only for this short transaction.
            await tx.query(`SELECT pg_advisory_xact_lock(hashtext('finagai.llm_budget'))`);
            const spent = await tx.query(SPEND_SQL, [startOfZonedMonth(r.now, this.timezone)]);
            const decision = decideReservation(Number(spent.rows[0]?.total ?? 0), r.reservedUsd, r.limits, r.purpose);
            const ids = [r.captureId ?? null, r.reviewId ?? null, r.requestId ?? null];
            if (!decision.allowed) {
                await tx.query(`INSERT INTO llm_call (pipeline, step, model, prompt_version, purpose, status, capture_id, review_id, request_id)
           VALUES ($1,$2,$3,$4,$5,'budget_blocked',$6,$7,$8)`, [r.pipeline, r.step, r.model, r.promptVersion, r.purpose, ...ids]);
                return { allowed: false, decision };
            }
            const ins = await tx.query(`INSERT INTO llm_call (pipeline, step, model, prompt_version, purpose, status, reserved_usd, capture_id, review_id, request_id)
         VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9) RETURNING id`, [r.pipeline, r.step, r.model, r.promptVersion, r.purpose, r.reservedUsd, ...ids]);
            return { allowed: true, reservationId: ins.rows[0].id, decision };
        });
    }
    async settle(id, s) {
        await this.pool.query(`UPDATE llm_call SET status = $2, reserved_usd = 0, input_tokens = $3, output_tokens = $4,
              cache_read_tokens = $5, cache_write_tokens = $6, cost_usd = $7, latency_ms = $8, retries = $9
        WHERE id = $1 AND status = 'reserved'`, [id, s.status, s.usage.inputTokens, s.usage.outputTokens, s.usage.cacheReadTokens, s.usage.cacheWriteTokens,
            s.costUsd, s.latencyMs, s.retries]);
    }
    async monthToDateUsd(now) {
        const res = await this.pool.query(SPEND_SQL, [startOfZonedMonth(now, this.timezone)]);
        return Number(res.rows[0]?.total ?? 0);
    }
}
//# sourceMappingURL=llmCalls.js.map