/**
 * Phase 8 (ADR-088) — the reliability report, computed from the Live State Stream (ADR-087: the event table is the one
 * source of truth) plus the engine's own tick ledger. Read-only. No separate metrics store: every number here can be
 * re-derived by replaying the stream, and every problem it names points at events Julian (or a Command Center) can
 * open.
 */
import type pg from "pg";
import { mineFailures, NOT_A_DEFECT, PROCESS_STARTED_AT, RECURRING } from "./failures.js";

type Db = Pick<pg.Pool, "query">;

/** What "healthy" means, numerically. Exceeding one makes the report "degraded" and names why. */
export const RELIABILITY_BUDGET = {
  /** the event loop runs every 5 min; a gap longer than this means it stalled */
  maxLoopGapMin: 15,
  /** per workflow, with at least `minRuns` runs in the window */
  minWorkflowSuccess: 0.9,
  minRuns: 3,
  /** tool calls (Julian's chats → Core) */
  maxToolFailureRate: 0.1,
  /** an exception that opened more than this often in the window is flapping (noise, not information) */
  maxOpensPerKey: 3,
} as const;

/**
 * `since` evaluates behaviour after a given moment (e.g. a deploy) separately from the rolling window, so history that
 * predates a fix is preserved in the stream but does not stand in for the fixed behaviour.
 */
export async function reliabilityReport(db: Db, opts: { days?: number; now?: Date; since?: Date; startedAt?: Date } = {}) {
  const now = opts.now ?? new Date();
  const days = Math.min(Math.max(opts.days ?? 1, 1), 30);
  const from = opts.since && !Number.isNaN(opts.since.getTime()) ? opts.since : new Date(now.getTime() - days * 86_400_000);
  const q = async <T extends Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query(sql, [from, now, ...p])).rows as T[];

  // the event loop — from its own ledger (each tick is a row, finished or failed)
  const ticks = await q<{ started_at: Date; status: string }>(`SELECT started_at, status FROM event_tick WHERE started_at BETWEEN $1 AND $2 ORDER BY started_at`);
  let longestGapMin = 0; const gaps: string[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const gap = (new Date(ticks[i]!.started_at).getTime() - new Date(ticks[i - 1]!.started_at).getTime()) / 60_000;
    longestGapMin = Math.max(longestGapMin, gap);
    if (gap > RELIABILITY_BUDGET.maxLoopGapMin) gaps.push(`${new Date(ticks[i - 1]!.started_at).toISOString().slice(0, 16)}Z → ${Math.round(gap)} min`);
  }
  if (ticks.length) {
    const tail = (now.getTime() - new Date(ticks.at(-1)!.started_at).getTime()) / 60_000;
    if (tail > RELIABILITY_BUDGET.maxLoopGapMin) gaps.push(`since ${new Date(ticks.at(-1)!.started_at).toISOString().slice(0, 16)}Z → ${Math.round(tail)} min (still)`);
    longestGapMin = Math.max(longestGapMin, tail);
  }
  const loop = { ticks: ticks.length, failed: ticks.filter((t) => t.status === "failed").length, longestGapMin: Math.round(longestGapMin), stalls: gaps };

  // workflows (engine workflows + their failures)
  const wf = await q<{ name: string; ok: number; failed: number }>(`SELECT after->>'workflow' AS name,
      count(*) FILTER (WHERE action = 'workflow_completed')::int AS ok, count(*) FILTER (WHERE action = 'workflow_failed')::int AS failed
      FROM event WHERE action IN ('workflow_completed','workflow_failed') AND occurred_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`);
  const workflows = wf.map((w) => ({ name: w.name, completed: w.ok, failed: w.failed, successRate: w.ok + w.failed ? Math.round((w.ok / (w.ok + w.failed)) * 1000) / 1000 : null }));

  // tools Julian calls
  // A call is its ok/error record. call_tool's routing record is not a call outcome (the routed tool records its own),
  // and neither is a tool's legacy second record of its domain result (resolve_reference "none", "mac_offline" — live
  // 2026-10-13: resolve_reference showed 3/6 failing with zero errors). Only "error" is a failure.
  const tl = await q<{ tool: string; calls: number; failed: number }>(`SELECT after->>'tool' AS tool, count(*)::int AS calls, count(*) FILTER (WHERE after->>'outcome' = 'error')::int AS failed
      FROM event WHERE action = 'tool_called' AND occurred_at BETWEEN $1 AND $2 AND after->>'routedTo' IS NULL AND after->>'outcome' IN ('ok','error') GROUP BY 1 ORDER BY 3 DESC, 2 DESC`);
  const calls = tl.reduce((n, t) => n + t.calls, 0), toolFailed = tl.reduce((n, t) => n + t.failed, 0);
  const tools = { calls, failed: toolFailed, failureRate: calls ? Math.round((toolFailed / calls) * 1000) / 1000 : null, failing: tl.filter((t) => t.failed).map((t) => `${t.tool}: ${t.failed}/${t.calls}`) };

  // scheduled jobs (on the stream since hotfix 36)
  const jb = await q<{ job: string; status: string; n: number }>(`SELECT after->>'job' AS job, after->>'status' AS status, count(*)::int AS n
      FROM event WHERE action = 'job_finished' AND occurred_at BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY 1, 2`);
  const jobs: Record<string, Record<string, number>> = {};
  for (const j of jb) (jobs[j.job] ??= {})[j.status] = j.n;

  // notifications
  const nt = await q<{ action: string; reason: string | null; result: string | null; n: number }>(`SELECT action, after->>'reason' AS reason, after->>'result' AS result, count(*)::int AS n
      FROM event WHERE action IN ('notification_delivered','notification_suppressed') AND occurred_at BETWEEN $1 AND $2 GROUP BY 1, 2, 3`);
  const notifications = { delivered: nt.filter((n) => n.action === "notification_delivered").reduce((a, n) => a + n.n, 0),
    heldForQuietHours: nt.filter((n) => n.action === "notification_suppressed" && /quiet hours/.test(n.reason ?? "")).reduce((a, n) => a + n.n, 0),
    failed: nt.filter((n) => n.action === "notification_suppressed" && !/quiet hours/.test(n.reason ?? "")).reduce((a, n) => a + n.n, 0) };

  // exceptions: what opened, and what keeps re-opening (flapping = noise on the stream and in "what's wrong")
  const ex = await q<{ key: string; opens: number }>(`SELECT after->>'key' AS key, count(*)::int AS opens FROM event WHERE action = 'exception_opened' AND occurred_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`);
  const exceptions = { opened: ex.reduce((a, e) => a + e.opens, 0), flapping: ex.filter((e) => e.opens > RELIABILITY_BUDGET.maxOpensPerKey).map((e) => `${e.key}: opened ${e.opens}×`),
    openNow: Number((await db.query(`SELECT count(*)::int AS n FROM operating_exception WHERE status = 'open'`)).rows[0].n) };

  // the continuous self-check (ADR-087 guarantees, hourly)
  const sc = await q<{ occurred_at: Date; after: { allPass?: boolean; failing?: string[]; pending?: string[]; version?: string } }>(`SELECT occurred_at, after FROM event WHERE action = 'reliability_checked' AND occurred_at BETWEEN $1 AND $2 ORDER BY id`);
  const failingRuns = sc.filter((r) => (r.after.failing ?? []).length);
  const selfCheck = { runs: sc.length, failingRuns: failingRuns.length,
    failures: [...new Set(failingRuns.flatMap((r) => r.after.failing ?? []))],
    last: sc.length ? { at: new Date(sc.at(-1)!.occurred_at).toISOString(), version: sc.at(-1)!.after.version ?? null, failing: sc.at(-1)!.after.failing ?? [], pending: sc.at(-1)!.after.pending ?? [] } : null };

  // the daily internal canary (increment 2)
  const cr = await q<{ after: { ok?: boolean; steps?: Array<{ step: string; ok: boolean }> } }>(`SELECT after FROM event WHERE action = 'canary_ran' AND occurred_at BETWEEN $1 AND $2 ORDER BY id`);
  const canary = { runs: cr.length, failed: cr.filter((r) => r.after.ok === false).length,
    failedSteps: [...new Set(cr.filter((r) => r.after.ok === false).flatMap((r) => (r.after.steps ?? []).filter((s) => !s.ok).map((s) => s.step)))] };

  // failure mining (increment 3): what keeps failing, by class — the report lists the top classes; a class of Finagai's
  // own machinery recurring on the running Core is a reason the platform is degraded
  const mined = await mineFailures(db, { from, now, startedAt: opts.startedAt ?? PROCESS_STARTED_AT });
  const failures = { recorded: mined.failures, classes: mined.classes.length,
    top: mined.classes.slice(0, 8).map((c) => ({ key: c.key, where: `${c.source}:${c.subject}`, count: c.count, last24h: c.last24h, status: c.status, example: c.example.slice(0, 120), ownedBy: c.ownedBy })) };
  const recurring = mined.classes.filter((c) => c.system && !NOT_A_DEFECT(c) && c.last24h >= RECURRING.minIn24h && c.sinceStart >= 1 && !c.ownedBy?.match(/^(workflow|watcher|reliability|canary|delivery):/));

  // the stream itself
  const unpublished = Number((await db.query(`SELECT count(*)::int AS n FROM event e WHERE NOT EXISTS (SELECT 1 FROM live_event l WHERE l.event_id = e.id) AND e.occurred_at < $1::timestamptz - interval '1 minute'`, [now])).rows[0].n);

  const why: string[] = [];
  if (loop.stalls.length) why.push(`event loop stalled: ${loop.stalls.join("; ")}`);
  if (loop.failed) why.push(`${loop.failed} event-loop tick(s) failed`);
  for (const w of workflows) if (w.completed + w.failed >= RELIABILITY_BUDGET.minRuns && (w.successRate ?? 1) < RELIABILITY_BUDGET.minWorkflowSuccess) why.push(`workflow ${w.name} succeeded ${Math.round((w.successRate ?? 0) * 100)}% of ${w.completed + w.failed} runs`);
  if ((tools.failureRate ?? 0) > RELIABILITY_BUDGET.maxToolFailureRate && calls >= RELIABILITY_BUDGET.minRuns) why.push(`tool calls failing ${Math.round((tools.failureRate ?? 0) * 100)}% (${tools.failing.join(", ")})`);
  for (const [job, s] of Object.entries(jobs)) if (s.failed) why.push(`scheduled job ${job} failed ${s.failed}×`);
  if (notifications.failed) why.push(`${notifications.failed} notification(s) could not be delivered`);
  if (exceptions.flapping.length) why.push(`flapping exceptions: ${exceptions.flapping.join(", ")}`);
  if (selfCheck.failingRuns) why.push(`self-check failed in ${selfCheck.failingRuns} of ${selfCheck.runs} runs (${selfCheck.failures.join(", ")})`);
  if (unpublished) why.push(`${unpublished} event(s) not yet on the live stream`);
  for (const c of recurring) why.push(`recurring failure: ${c.source.replace("_", " ")} ${c.subject} ${c.last24h}× in 24 h ("${c.signature.slice(0, 80)}")`);
  if (canary.failed) why.push(`internal canary failed in ${canary.failed} of ${canary.runs} runs (${canary.failedSteps.join(", ")})`);

  return { window: { from: from.toISOString(), to: now.toISOString(), days: opts.since ? Math.round(((now.getTime() - from.getTime()) / 86_400_000) * 100) / 100 : days }, verdict: why.length ? "degraded" : "healthy", why,
    budget: RELIABILITY_BUDGET, loop, workflows, tools, jobs, notifications, exceptions, selfCheck, canary, failures, stream: { unpublished } };
}
