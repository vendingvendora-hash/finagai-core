/**
 * Mac runtime as a first-class persistent worker (ADR-066).
 *
 * The product rule: a task is never "active" merely because a row exists. Its lifecycle is DERIVED from
 * evidence — a fresh worker heartbeat, a claim, a lease, and task progress timestamps:
 *
 *   queued           active, unclaimed, Mac heartbeat fresh      -> the worker will pick it up next tick
 *   waiting_for_mac  active, unclaimed, Mac heartbeat stale/none -> no Mac process is running; say so NOW
 *   executing        claimed, task progress fresh                -> real work is happening
 *   stalled          claimed, task progress stale                -> worker stopped mid-task; reclaimable
 *   waiting_approval / done / failed / cancelled                 -> as recorded
 */
import type pg from "pg";
import { normalizeCapabilities } from "./capabilities.js";

export const MAC_HEARTBEAT_FRESH_MS = 45_000;   // helper ticks every ~15s; 3 missed ticks = offline
export const TASK_PROGRESS_FRESH_MS = 90_000;   // a healthy step reports progress well within this
export const CLAIM_LEASE_MS = 120_000;

export type MacRuntime = {
  id: string; lastHeartbeatAt: Date; helperVersion: string | null; capabilities: Record<string, unknown>;
  frontmostApp: string | null; frontmostWindow: string | null; currentTaskId: string | null; startedAt: Date | null;
  reconnectCount: number; restartCount: number; lastSuccessAt: Date | null; lastSuccessCode: number | null;
};

export type Lifecycle = "queued" | "waiting_for_mac" | "executing" | "stalled" | "waiting_approval" | "done" | "failed" | "cancelled" | "paused";

export async function recordHeartbeat(pool: pg.Pool, hb: {
  helperVersion?: string | undefined; capabilities?: Record<string, unknown> | undefined; frontmostApp?: string | null | undefined;
  frontmostWindow?: string | null | undefined; currentTaskId?: string | null | undefined; startedAt?: string | null | undefined;
  reconnects?: number | undefined;
  /** Present only on the first successful heartbeat after an outage (helper runtime-10+). */
  reconnected?: { downSince?: string | null; downSeconds?: number } | null | undefined;
}): Promise<void> {
  // A new startedAt means the daemon process restarted (crash/launchd restart/manual kickstart).
  await pool.query(
    `UPDATE mac_runtime SET restart_count = restart_count + 1
       WHERE id = 'primary' AND started_at IS NOT NULL AND $1::timestamptz IS NOT NULL AND started_at <> $1::timestamptz`,
    [hb.startedAt ?? null]);
  await pool.query(
    `INSERT INTO mac_runtime (id, last_heartbeat_at, helper_version, capabilities, frontmost_app, frontmost_window, current_task_id, started_at, updated_at)
       VALUES ('primary', now(), $1, $2::jsonb, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       last_heartbeat_at = now(), helper_version = COALESCE(EXCLUDED.helper_version, mac_runtime.helper_version),
       capabilities = CASE WHEN EXCLUDED.capabilities = '{}'::jsonb THEN mac_runtime.capabilities ELSE EXCLUDED.capabilities END,
       frontmost_app = EXCLUDED.frontmost_app, frontmost_window = EXCLUDED.frontmost_window,
       current_task_id = EXCLUDED.current_task_id, started_at = COALESCE(EXCLUDED.started_at, mac_runtime.started_at),
       -- runtime-10+: a reconnect is an event (+1). Legacy helpers still report a per-process count (GREATEST).
       reconnect_count = CASE WHEN $8::boolean THEN mac_runtime.reconnect_count + 1 ELSE GREATEST(mac_runtime.reconnect_count, $7) END,
       updated_at = now()`,
    [hb.helperVersion ?? null, JSON.stringify(hb.capabilities ? normalizeCapabilities(hb.capabilities) : {}), hb.frontmostApp ?? null, hb.frontmostWindow ?? null,
     hb.currentTaskId ?? null, hb.startedAt ?? null, hb.reconnects ?? 0, !!hb.reconnected]);
  if (hb.reconnected) {
    await pool.query(`INSERT INTO event (actor, action, entity_type, after) VALUES ('system', 'mac_reconnected', 'mac_runtime', $1::jsonb)`,
      [JSON.stringify({ downSince: hb.reconnected.downSince ?? null, downSeconds: hb.reconnected.downSeconds ?? null })]);
  }
}

/** WO1-G: only the worker holding the live lease may complete a task. Unclaimed (legacy) tasks are open. */
export async function workerMayComplete(pool: pg.Pool, taskId: string, workerId: string | null): Promise<boolean> {
  const r = await pool.query<{ worker_id: string | null; lease_until: Date | null }>(
    `SELECT worker_id, lease_until FROM control_task WHERE id = $1`, [taskId]);
  const t = r.rows[0]; if (!t) return false;
  if (!t.worker_id) return true;                                   // never claimed: open
  if (workerId && t.worker_id === workerId) return true;            // the lease holder
  return false;                                                     // a stale/other worker
}

/** Last helper diagnostics (Phase 1E), newest first. */
/** Phase 1E: store one sanitized helper diagnostic. event.entity_id is a uuid → the Mac runtime is not an entity id. */
export async function recordDiagnostic(pool: pg.Pool, d: { kind: string; detail: string; taskId?: string | null; helperVersion?: string | null }): Promise<void> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  await pool.query(`INSERT INTO event (actor, action, entity_type, entity_id, after) VALUES ('system', 'mac_diag', 'mac_runtime', $1, $2::jsonb)`,
    [d.taskId && uuid.test(d.taskId) ? d.taskId : null,
     JSON.stringify({ kind: d.kind.slice(0, 60), detail: d.detail.replace(/Bearer\s+\S+/gi, "[token]").slice(0, 400), taskId: d.taskId ?? null, helperVersion: d.helperVersion ?? null })]);
}

/** Last helper diagnostics (Phase 1E), newest first. Errors propagate — an empty list must mean "none", not "query failed". */
export async function recentDiagnostics(pool: pg.Pool, n = 5): Promise<Array<{ at: string; kind: string; detail: string; taskId: string | null }>> {
  const r = await pool.query(`SELECT occurred_at, after FROM event WHERE action = 'mac_diag' ORDER BY occurred_at DESC LIMIT $1`, [n]);
  return r.rows.map((x: { occurred_at: Date; after: { kind: string; detail: string; taskId: string | null } }) => ({ at: new Date(x.occurred_at).toISOString(), kind: x.after.kind, detail: x.after.detail, taskId: x.after.taskId }));
}

export async function recordSuccess(pool: pg.Pool, taskId: string): Promise<void> {
  await pool.query(`UPDATE mac_runtime SET last_success_at = now(), last_success_code = (SELECT code FROM control_task WHERE id = $1) WHERE id = 'primary'`, [taskId]);
}

export async function getRuntime(pool: pg.Pool): Promise<MacRuntime | null> {
  const r = await pool.query(`SELECT * FROM mac_runtime WHERE id = 'primary'`);
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, lastHeartbeatAt: new Date(row.last_heartbeat_at), helperVersion: row.helper_version ?? null,
    capabilities: row.capabilities ?? {}, frontmostApp: row.frontmost_app ?? null, frontmostWindow: row.frontmost_window ?? null,
    currentTaskId: row.current_task_id ?? null, startedAt: row.started_at ? new Date(row.started_at) : null,
    reconnectCount: Number(row.reconnect_count ?? 0), restartCount: Number(row.restart_count ?? 0),
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at) : null, lastSuccessCode: row.last_success_code != null ? Number(row.last_success_code) : null };
}

export function macOnline(rt: MacRuntime | null, now = Date.now()): boolean {
  return !!rt && now - rt.lastHeartbeatAt.getTime() <= MAC_HEARTBEAT_FRESH_MS;
}

/** Worker claims a task: sets claim + lease + first progress. Idempotent for the same worker. */
export async function claimTask(pool: pg.Pool, taskId: string, workerId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE control_task SET claimed_at = COALESCE(claimed_at, now()), worker_id = $2,
       lease_until = now() + ($3 || ' milliseconds')::interval, last_progress_at = now()
     WHERE id = $1 AND status = 'active' AND (claimed_at IS NULL OR worker_id = $2 OR lease_until < now())
     RETURNING id`, [taskId, workerId, String(CLAIM_LEASE_MS)]);
  return r.rowCount === 1;
}

/** Worker reports progress on a claimed task (extends the lease). */
export async function taskProgress(pool: pg.Pool, taskId: string, note?: string): Promise<void> {
  await pool.query(
    `UPDATE control_task SET last_progress_at = now(), lease_until = now() + ($2 || ' milliseconds')::interval,
       progress_note = COALESCE($3, progress_note) WHERE id = $1`, [taskId, String(CLAIM_LEASE_MS), note ?? null]);
}

/** Derive the truthful lifecycle of a task from evidence. */
export function deriveLifecycle(task: {
  status: string; claimed_at: Date | string | null; last_progress_at: Date | string | null;
}, rt: MacRuntime | null, now = Date.now()): { lifecycle: Lifecycle; evidence: string } {
  if (task.status !== "active") return { lifecycle: task.status as Lifecycle, evidence: `recorded status ${task.status}` };
  const claimed = !!task.claimed_at;
  if (!claimed) {
    return macOnline(rt, now)
      ? { lifecycle: "queued", evidence: `Mac online (heartbeat ${Math.round((now - rt!.lastHeartbeatAt.getTime()) / 1000)}s ago), not yet claimed` }
      : { lifecycle: "waiting_for_mac", evidence: rt ? `no Mac heartbeat for ${Math.round((now - rt.lastHeartbeatAt.getTime()) / 1000)}s` : "no Mac runtime has ever connected" };
  }
  const prog = task.last_progress_at ? new Date(task.last_progress_at).getTime() : 0;
  const age = now - prog;
  return age <= TASK_PROGRESS_FRESH_MS
    ? { lifecycle: "executing", evidence: `claimed; progress ${Math.round(age / 1000)}s ago` }
    : { lifecycle: "stalled", evidence: `claimed but no progress for ${Math.round(age / 1000)}s` };
}

/** The status matrix Julian asked for. Real values, no guesses. */
export async function macStatus(pool: pg.Pool): Promise<Record<string, unknown>> {
  const rt = await getRuntime(pool);
  const now = Date.now();
  const online = macOnline(rt, now);
  const cur = rt?.currentTaskId
    ? await pool.query(`SELECT code, request, status, claimed_at, last_progress_at, progress_note FROM control_task WHERE id = $1`, [rt.currentTaskId])
    : null;
  const t = cur?.rows[0];
  const caps = normalizeCapabilities(rt?.capabilities as Record<string, unknown> | undefined);
  const pass = (k: keyof typeof caps) => caps[k] ?? "unknown";
  return {
    connected: online,
    lastHeartbeatSecondsAgo: rt ? Math.round((now - rt.lastHeartbeatAt.getTime()) / 1000) : null,
    helperVersion: rt?.helperVersion ?? null,
    screenCapture: pass("screenCapture"), accessibility: pass("accessibility"), filesystem: pass("filesystem"),
    browser: pass("browser"), clipboard: pass("clipboard"), activeWindow: pass("activeWindow"),
    browserDom: pass("browserDom"),   // Phase 1: a Finagai Operator extension is connected (structured browser control)
    currentApp: rt?.frontmostApp ?? null, currentWindow: rt?.frontmostWindow ?? null,
    reconnectCount: rt?.reconnectCount ?? 0, restartCount: rt?.restartCount ?? 0,
    lastSuccess: rt?.lastSuccessAt ? { at: rt.lastSuccessAt.toISOString(), taskCode: rt.lastSuccessCode } : null,
    runtimeStartedAt: rt?.startedAt?.toISOString() ?? null,
    recentDiagnostics: await recentDiagnostics(pool, 5).catch((e) => [{ at: new Date().toISOString(), kind: "diagnostics_query_failed", detail: String((e as Error)?.message ?? e).slice(0, 200), taskId: null }]),
    lastReconnect: await pool.query(`SELECT occurred_at, after FROM event WHERE action = 'mac_reconnected' ORDER BY occurred_at DESC LIMIT 1`)
      .then((r) => (r.rows[0] ? { at: new Date(r.rows[0].occurred_at).toISOString(), downSeconds: r.rows[0].after?.downSeconds ?? null } : null)),
    currentTask: t ? { code: Number(t.code), request: t.request, ...deriveLifecycle(t, rt, now), note: t.progress_note ?? null } : null,
    remedyIfOffline: online ? null :
      "The Finagai Mac runtime is not connected. On the Mac: `launchctl kickstart -k gui/$(id -u)/com.finagai.imessage` then `tail -5 ~/.finagai/imessage-helper.log` — it should log 'helper started' and heartbeats.",
  };
}


/**
 * WO1 stale-task sweep. Run on every heartbeat (cheap) and on demand. Terminalizes:
 *  - ABANDONED: active, never claimed, older than 30 min (no worker ever picked it up) -> failed
 *  - STALLED:   claimed, lease expired AND no progress for 10 min -> failed (reclaim window has passed)
 * Each gets a concrete reason so WO2 surfaces it as a failed interaction instead of leaving a zombie that
 * starves the queue (this is exactly how tasks #9/#32/#33/#34 blocked task #36).
 */
export async function sweepStaleTasks(pool: pg.Pool): Promise<{ abandoned: number; stalled: number; reconcileErrors?: number }> {
  const a = await pool.query(
    `UPDATE control_task SET status = 'failed', failure_class = 'abandoned', updated_at = now(),
       result_summary = 'Abandoned: no Mac worker claimed this task within 30 minutes (runtime was offline or the task was superseded). Ask again and it will run now.'
     WHERE status = 'active' AND claimed_at IS NULL AND created_at < now() - interval '30 minutes' RETURNING id`);
  const b = await pool.query(
    `UPDATE control_task SET status = 'failed', failure_class = 'stalled', updated_at = now(),
       result_summary = 'Stalled: the Mac worker stopped reporting progress and the lease was not reclaimed within 10 minutes.'
     WHERE status = 'active' AND claimed_at IS NOT NULL AND lease_until < now() AND last_progress_at < now() - interval '10 minutes' RETURNING id`);
  const { completeForTask, reconcileInteractions } = await import("../concierge/interactions.js");
  const { observed } = await import("../ops/lifecycle-errors.js");
  for (const r of [...a.rows, ...b.rows]) await completeForTask(pool, r.id, { ok: false, summary: "task did not complete on the Mac" }).catch(observed(pool, "sweep.complete", { taskId: r.id }));
  // Phase 0E: a failing reconciliation is recorded (event 'lifecycle_error'), never silent.
  const rec = await reconcileInteractions(pool).catch(async (e) => { await observed(pool, "sweep.reconcileInteractions")(e); return null; });
  return { abandoned: a.rowCount ?? 0, stalled: b.rowCount ?? 0, reconcileErrors: rec ? rec.errors : 1 };
}
