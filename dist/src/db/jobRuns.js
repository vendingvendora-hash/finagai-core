import { appendEvent } from "./events.js";
/**
 * Lease-based job ledger on finagai.job_run (ADR-033). Postgres row locking on the
 * (job, scheduled_for) unique key makes concurrent claims safe: at most one live lease per slot.
 */
export class PgJobLedger {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async claim(job, scheduledFor, owner, leaseMs) {
        // An expired lease at max attempts becomes a terminal failure (detected by the missed-run check).
        await this.pool.query(`UPDATE job_run SET status = 'failed', finished_at = now(),
              error = coalesce(error, 'lease expired at max attempts'), lease_owner = NULL
        WHERE job = $1 AND scheduled_for = $2 AND status = 'running'
          AND lease_expires_at < now() AND attempt >= max_attempts`, [job, scheduledFor]);
        const res = await this.pool.query(`INSERT INTO job_run (job, scheduled_for, status, attempt, lease_expires_at, lease_owner, last_heartbeat_at)
       VALUES ($1, $2, 'running', 1, now() + ($4 * interval '1 millisecond'), $3, now())
       ON CONFLICT (job, scheduled_for) DO UPDATE
          SET attempt = job_run.attempt + 1, status = 'running', started_at = now(), finished_at = NULL,
              error = NULL, lease_expires_at = EXCLUDED.lease_expires_at, lease_owner = EXCLUDED.lease_owner,
              last_heartbeat_at = now()
        WHERE job_run.attempt < job_run.max_attempts
          AND ((job_run.status = 'running' AND job_run.lease_expires_at < now())
               OR job_run.status = 'failed')
       RETURNING id, attempt`, [job, scheduledFor, owner, leaseMs]);
        const row = res.rows[0];
        return row ? { runId: row.id, attempt: row.attempt } : null;
    }
    async heartbeat(runId, owner, leaseMs) {
        const res = await this.pool.query(`UPDATE job_run SET lease_expires_at = now() + ($3 * interval '1 millisecond'), last_heartbeat_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'`, [runId, owner, leaseMs]);
        return res.rowCount === 1;
    }
    async finish(runId, owner, outcome) {
        const res = await this.pool.query(`UPDATE job_run SET status = $3, finished_at = now(), lease_expires_at = NULL, lease_owner = NULL,
              error = $4
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'
        RETURNING job, scheduled_for, attempt, started_at`, [runId, owner, outcome.status, outcome.status === "succeeded" ? null : outcome.detail ?? null]);
        const r = res.rows[0];
        // Phase 8 (ADR-088): every scheduled job run is on the Live State Stream, in the run's own unit of work (its id is
        // the correlation id of everything the job did), so reliability is measured from the stream like everything else.
        if (r)
            await appendEvent(this.pool, { actor: "system", action: "job_finished", correlationId: runId, causeIds: [],
                after: { job: r.job, scheduledFor: new Date(r.scheduled_for).toISOString(), attempt: Number(r.attempt), status: outcome.status,
                    durationMs: r.started_at ? Date.now() - new Date(r.started_at).getTime() : null, ...(outcome.status !== "succeeded" && outcome.detail ? { detail: outcome.detail.slice(0, 300) } : {}) } });
        return res.rowCount === 1;
    }
}
//# sourceMappingURL=jobRuns.js.map