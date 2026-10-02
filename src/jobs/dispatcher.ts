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
import { dueJobs, type DueJob, type JobName, type ScheduleConfig } from "./schedule.js";

export interface JobOutcome {
  status: "succeeded" | "skipped" | "failed";
  detail?: string;
}

export interface JobContext extends DueJob {
  attempt: number;
  /** Stable across attempts of the same slot, e.g. "weekly_review:2026-03-09T11:00:00.000Z". */
  idempotencyKey: string;
  /** Aborted if the lease is lost; handlers must stop before further side effects. */
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export interface Claim {
  runId: string;
  attempt: number;
}

export interface JobLedger {
  /**
   * Take the lease for (job, scheduledFor) if the slot is new, its previous lease expired, or its
   * previous attempt failed below max_attempts. Returns null if another tick holds a live lease
   * or the slot is complete.
   */
  claim(job: JobName, scheduledFor: Date, owner: string, leaseMs: number): Promise<Claim | null>;
  /** Extend the lease; false if this owner no longer holds it. */
  heartbeat(runId: string, owner: string, leaseMs: number): Promise<boolean>;
  /** Record the outcome; false if the lease was lost (the result is then discarded). */
  finish(runId: string, owner: string, outcome: JobOutcome): Promise<boolean>;
}

export interface DispatchDeps {
  cfg: ScheduleConfig;
  openLedger: () => Promise<JobLedger>;
  handlers: Record<JobName, JobHandler>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  leaseMs?: number;
  owner?: string;
}

export interface DispatchResult {
  due: number;
  ran: Array<{ job: JobName; attempt: number; scheduledFor: Date; outcome: JobOutcome }>;
  notClaimed: JobName[];
}

export const DEFAULT_LEASE_MS = 5 * 60_000;
/** Must match job_run.max_attempts (migration 0006). */
export const MAX_JOB_ATTEMPTS = 3;

export function slotIdempotencyKey(job: JobName, scheduledFor: Date): string {
  return `${job}:${scheduledFor.toISOString()}`;
}

export async function dispatch(now: Date, deps: DispatchDeps): Promise<DispatchResult> {
  const due = dueJobs(now, deps.cfg);
  const result: DispatchResult = { due: due.length, ran: [], notClaimed: [] };
  if (due.length === 0) return result;

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
        .then((held) => { if (!held) abort.abort(new Error("lease lost")); })
        .catch(() => abort.abort(new Error("heartbeat failed")));
    }, Math.max(1_000, Math.floor(leaseMs / 3)));

    let outcome: JobOutcome;
    try {
      outcome = await deps.handlers[job.job]({
        ...job,
        attempt: claim.attempt,
        idempotencyKey: slotIdempotencyKey(job.job, job.scheduledFor),
        signal: abort.signal,
      });
    } catch (err) {
      outcome = { status: "failed", detail: err instanceof Error ? err.message : "unknown error" };
    } finally {
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
