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

export const MAC_HEARTBEAT_FRESH_MS = 45_000;   // helper ticks every ~15s; 3 missed ticks = offline
export const TASK_PROGRESS_FRESH_MS = 90_000;   // a healthy step reports progress well within this
export const CLAIM_LEASE_MS = 120_000;

export type MacRuntime = {
  id: string; lastHeartbeatAt: Date; helperVersion: string | null; capabilities: Record<string, unknown>;
  frontmostApp: string | null; frontmostWindow: string | null; currentTaskId: string | null; startedAt: Date | null;
};

export type Lifecycle = "queued" | "waiting_for_mac" | "executing" | "stalled" | "waiting_approval" | "done" | "failed" | "cancelled" | "paused";

export async function recordHeartbeat(pool: pg.Pool, hb: {
  helperVersion?: string | undefined; capabilities?: Record<string, unknown> | undefined; frontmostApp?: string | null | undefined;
  frontmostWindow?: string | null | undefined; currentTaskId?: string | null | undefined; startedAt?: string | null | undefined;
}): Promise<void> {
  await pool.query(
    `INSERT INTO mac_runtime (id, last_heartbeat_at, helper_version, capabilities, frontmost_app, frontmost_window, current_task_id, started_at, updated_at)
       VALUES ('primary', now(), $1, $2::jsonb, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       last_heartbeat_at = now(), helper_version = COALESCE(EXCLUDED.helper_version, mac_runtime.helper_version),
       capabilities = CASE WHEN EXCLUDED.capabilities = '{}'::jsonb THEN mac_runtime.capabilities ELSE EXCLUDED.capabilities END,
       frontmost_app = EXCLUDED.frontmost_app, frontmost_window = EXCLUDED.frontmost_window,
       current_task_id = EXCLUDED.current_task_id, started_at = COALESCE(EXCLUDED.started_at, mac_runtime.started_at), updated_at = now()`,
    [hb.helperVersion ?? null, JSON.stringify(hb.capabilities ?? {}), hb.frontmostApp ?? null, hb.frontmostWindow ?? null,
     hb.currentTaskId ?? null, hb.startedAt ?? null]);
}

export async function getRuntime(pool: pg.Pool): Promise<MacRuntime | null> {
  const r = await pool.query(`SELECT * FROM mac_runtime WHERE id = 'primary'`);
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, lastHeartbeatAt: new Date(row.last_heartbeat_at), helperVersion: row.helper_version ?? null,
    capabilities: row.capabilities ?? {}, frontmostApp: row.frontmost_app ?? null, frontmostWindow: row.frontmost_window ?? null,
    currentTaskId: row.current_task_id ?? null, startedAt: row.started_at ? new Date(row.started_at) : null };
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
  const caps = (rt?.capabilities ?? {}) as Record<string, unknown>;
  const pass = (k: string) => caps[k] === true ? "PASS" : caps[k] === false ? "FAIL" : "unknown";
  return {
    connected: online,
    lastHeartbeatSecondsAgo: rt ? Math.round((now - rt.lastHeartbeatAt.getTime()) / 1000) : null,
    helperVersion: rt?.helperVersion ?? null,
    screenCapture: pass("screen"), accessibility: pass("accessibility"), filesystem: pass("files"),
    browser: pass("browser"), clipboard: pass("clipboard"), activeWindow: pass("activeWindow"),
    currentApp: rt?.frontmostApp ?? null, currentWindow: rt?.frontmostWindow ?? null,
    currentTask: t ? { code: Number(t.code), request: t.request, ...deriveLifecycle(t, rt, now), note: t.progress_note ?? null } : null,
    remedyIfOffline: online ? null :
      "The Finagai Mac runtime is not connected. On the Mac: `launchctl kickstart -k gui/$(id -u)/com.finagai.imessage` then `tail -5 ~/.finagai/imessage-helper.log` — it should log 'helper started' and heartbeats.",
  };
}
