/**
 * At-least-once job dispatch with leases (ADR-033).
 *
 *  - A tick claims a due slot by taking a lease (default 5 minutes) and heartbeats while the
 *    handler runs. A crashed process stops heartbeating; once the lease expires, a later tick
 *    inside the slot's due window reclaims it as the next attempt.
 *  - Handler failures are retried on later ticks up to max_attempts (3).
 *  - A slot that finished 'succeeded' or 'skipped' is never run again.
 *  - Because a handler may run more than once, every externally visible side effect inside a
 *    handler must use a stable idempotency key (ctx.idempotencyKey or one derived from it).
 *
 * The database is opened only when a slot is due, so the 15-minute cron does not keep Neon awake.
 */
import { randomUUID } from "node:crypto";
import { dueJobs } from "./schedule.js";
export const DEFAULT_LEASE_MS = 5 * 60_000;
/** Must match job_run.max_attempts (migration 0006). */
export const MAX_JOB_ATTEMPTS = 3;
export function slotIdempotencyKey(job, scheduledFor) {
    return `${job}:${scheduledFor.toISOString()}`;
}
export async function dispatch(now, deps) {
    const due = dueJobs(now, deps.cfg);
    const result = { due: due.length, ran: [], notClaimed: [] };
    if (due.length === 0)
        return result;
    const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    const owner = deps.owner ?? randomUUID();
    const ledger = await deps.openLedger();
    for (const job of due) {
        const claim = await ledger.claim(job.job, job.scheduledFor, owner, leaseMs);
        if (!claim) {
            result.notClaimed.push(job.job);
            continue;
        }
        const abort = new AbortController();
        const beat = setInterval(() => {
            ledger.heartbeat(claim.runId, owner, leaseMs)
                .then((held) => { if (!held)
                abort.abort(new Error("lease lost")); })
                .catch(() => abort.abort(new Error("heartbeat failed")));
        }, Math.max(1_000, Math.floor(leaseMs / 3)));
        let outcome;
        try {
            outcome = await deps.handlers[job.job]({
                ...job,
                attempt: claim.attempt,
                idempotencyKey: slotIdempotencyKey(job.job, job.scheduledFor),
                signal: abort.signal,
            });
        }
        catch (err) {
            outcome = { status: "failed", detail: err instanceof Error ? err.message : "unknown error" };
        }
        finally {
            clearInterval(beat);
        }
        const recorded = await ledger.finish(claim.runId, owner, outcome);
        deps.log(recorded ? "job finished" : "job finished after lease was lost; outcome discarded", {
            job: job.job, scheduledFor: job.scheduledFor.toISOString(), attempt: claim.attempt, status: outcome.status,
        });
        result.ran.push({ job: job.job, attempt: claim.attempt, scheduledFor: job.scheduledFor, outcome });
    }
    return result;
}
//# sourceMappingURL=dispatcher.js.map