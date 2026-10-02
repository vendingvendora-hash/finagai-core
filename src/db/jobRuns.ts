import type pg from "pg";
import type { Claim, JobLedger, JobOutcome } from "../jobs/dispatcher.js";
import type { JobName } from "../jobs/schedule.js";

/**
 * Lease-based job ledger on finagai.job_run (ADR-033). Postgres row locking on the
 * (job, scheduled_for) unique key makes concurrent claims safe: at most one live lease per slot.
 */
export class PgJobLedger implements JobLedger {
  constructor(private readonly pool: pg.Pool) {}

  async claim(job: JobName, scheduledFor: Date, owner: string, leaseMs: number): Promise<Claim | null> {
    // An expired lease at max attempts becomes a terminal failure (detected by the missed-run check).
    await this.pool.query(
      `UPDATE job_run SET status = 'failed', finished_at = now(),
              error = coalesce(error, 'lease expired at max attempts'), lease_owner = NULL
        WHERE job = $1 AND scheduled_for = $2 AND status = 'running'
          AND lease_expires_at < now() AND attempt >= max_attempts`,
      [job, scheduledFor],
    );
    const res = await this.pool.query<{ id: string; attempt: number }>(
      `INSERT INTO job_run (job, scheduled_for, status, attempt, lease_expires_at, lease_owner, last_heartbeat_at)
       VALUES ($1, $2, 'running', 1, now() + ($4 * interval '1 millisecond'), $3, now())
       ON CONFLICT (job, scheduled_for) DO UPDATE
          SET attempt = job_run.attempt + 1, status = 'running', started_at = now(), finished_at = NULL,
              error = NULL, lease_expires_at = EXCLUDED.lease_expires_at, lease_owner = EXCLUDED.lease_owner,
              last_heartbeat_at = now()
        WHERE job_run.attempt < job_run.max_attempts
          AND ((job_run.status = 'running' AND job_run.lease_expires_at < now())
               OR job_run.status = 'failed')
       RETURNING id, attempt`,
      [job, scheduledFor, owner, leaseMs],
    );
    const row = res.rows[0];
    return row ? { runId: row.id, attempt: row.attempt } : null;
  }

  async heartbeat(runId: string, owner: string, leaseMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE job_run SET lease_expires_at = now() + ($3 * interval '1 millisecond'), last_heartbeat_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [runId, owner, leaseMs],
    );
    return res.rowCount === 1;
  }

  async finish(runId: string, owner: string, outcome: JobOutcome): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE job_run SET status = $3, finished_at = now(), lease_expires_at = NULL, lease_owner = NULL,
              error = $4
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [runId, owner, outcome.status, outcome.status === "succeeded" ? null : outcome.detail ?? null],
    );
    return res.rowCount === 1;
  }
}
