import { randomUUID } from "node:crypto";
/** outbound_delivery as the authoritative idempotency ledger (ADR-033, clarified). */
export class PgDeliveryStore {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async claim(key, purpose, payloadHash, leaseMs, uncertainWindowMs, reviewId) {
        const token = randomUUID();
        const inserted = await this.pool.query(`INSERT INTO outbound_delivery (idempotency_key, channel, purpose, review_id, payload_sha256, status, sending_until, sending_token, attempts)
       VALUES ($1, 'email', $2, $3, $4, 'sending', now() + ($5 * interval '1 millisecond'), $6, 1)
       ON CONFLICT (idempotency_key) DO NOTHING`, [key, purpose, reviewId ?? null, payloadHash, leaseMs, token]);
        if (inserted.rowCount === 1)
            return { kind: "claimed", token };
        // Existing logical delivery: reclaim only if not sent, not blocked, payload identical, lease free.
        const reclaimed = await this.pool.query(`UPDATE outbound_delivery
          SET status = 'sending', sending_until = now() + ($3 * interval '1 millisecond'), sending_token = $4,
              attempts = attempts + 1
        WHERE idempotency_key = $1 AND payload_sha256 = $2
          AND (status IN ('pending', 'failed')
               OR (status = 'sending' AND sending_until < now()
                   AND (first_ambiguous_at IS NULL OR first_ambiguous_at > now() - ($5 * interval '1 millisecond')))
               OR (status = 'uncertain' AND first_ambiguous_at > now() - ($5 * interval '1 millisecond')))`, [key, payloadHash, leaseMs, token, uncertainWindowMs]);
        if (reclaimed.rowCount === 1)
            return { kind: "claimed", token };
        const row = (await this.pool.query(`SELECT status, payload_sha256, (sending_until < now() AND first_ambiguous_at IS NOT NULL) AS stale
         FROM outbound_delivery WHERE idempotency_key = $1`, [key])).rows[0];
        if (!row)
            return { kind: "in_progress" };
        // A different payload for the same logical delivery is always a defect to investigate,
        // even after a successful send.
        if (row.payload_sha256 !== payloadHash)
            return { kind: "payload_conflict" };
        if (row.status === "sent")
            return { kind: "already_sent" };
        if (row.status === "conflict")
            return { kind: "conflict_blocked" };
        if (row.status === "uncertain" || (row.status === "sending" && row.stale))
            return { kind: "needs_reconciliation" };
        return { kind: "in_progress" };
    }
    async markSent(key, token, providerMessageId) {
        const r = await this.pool.query(`UPDATE outbound_delivery SET status = 'sent', sent_at = now(), sending_until = NULL, sending_token = NULL,
              provider_message_id = $3, last_error = NULL
        WHERE idempotency_key = $1 AND sending_token = $2 AND status = 'sending'`, [key, token, providerMessageId]);
        return r.rowCount === 1;
    }
    async markUncertain(key, token, error) {
        const r = await this.pool.query(`UPDATE outbound_delivery SET status = 'uncertain', sending_until = NULL, sending_token = NULL, last_error = $3,
              first_ambiguous_at = coalesce(first_ambiguous_at, now())
        WHERE idempotency_key = $1 AND sending_token = $2 AND status = 'sending'`, [key, token, error.slice(0, 500)]);
        return r.rowCount === 1;
    }
    async markFailed(key, token, error) {
        const r = await this.pool.query(`UPDATE outbound_delivery SET status = 'failed', sending_until = NULL, sending_token = NULL, last_error = $3
        WHERE idempotency_key = $1 AND sending_token = $2 AND status = 'sending'`, [key, token, error.slice(0, 500)]);
        return r.rowCount === 1;
    }
    async markConflict(key, token, error) {
        const r = await this.pool.query(`UPDATE outbound_delivery SET status = 'conflict', sending_until = NULL, sending_token = NULL, last_error = $3
        WHERE idempotency_key = $1 AND sending_token = $2 AND status = 'sending'`, [key, token, error.slice(0, 500)]);
        return r.rowCount === 1;
    }
}
//# sourceMappingURL=deliveries.js.map