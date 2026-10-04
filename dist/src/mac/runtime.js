export const MAC_HEARTBEAT_FRESH_MS = 45_000; // helper ticks every ~15s; 3 missed ticks = offline
export const TASK_PROGRESS_FRESH_MS = 90_000; // a healthy step reports progress well within this
export const CLAIM_LEASE_MS = 120_000;
export async function recordHeartbeat(pool, hb) {
    // A new startedAt means the daemon process restarted (crash/launchd restart/manual kickstart).
    await pool.query(`UPDATE mac_runtime SET restart_count = restart_count + 1
       WHERE id = 'primary' AND started_at IS NOT NULL AND $1::timestamptz IS NOT NULL AND started_at <> $1::timestamptz`, [hb.startedAt ?? null]);
    await pool.query(`INSERT INTO mac_runtime (id, last_heartbeat_at, helper_version, capabilities, frontmost_app, frontmost_window, current_task_id, started_at, updated_at)
       VALUES ('primary', now(), $1, $2::jsonb, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       last_heartbeat_at = now(), helper_version = COALESCE(EXCLUDED.helper_version, mac_runtime.helper_version),
       capabilities = CASE WHEN EXCLUDED.capabilities = '{}'::jsonb THEN mac_runtime.capabilities ELSE EXCLUDED.capabilities END,
       frontmost_app = EXCLUDED.frontmost_app, frontmost_window = EXCLUDED.frontmost_window,
       current_task_id = EXCLUDED.current_task_id, started_at = COALESCE(EXCLUDED.started_at, mac_runtime.started_at),
       reconnect_count = GREATEST(mac_runtime.reconnect_count, $7), updated_at = now()`, [hb.helperVersion ?? null, JSON.stringify(hb.capabilities ?? {}), hb.frontmostApp ?? null, hb.frontmostWindow ?? null,
        hb.currentTaskId ?? null, hb.startedAt ?? null, hb.reconnects ?? 0]);
}
/** WO1-G: only the worker holding the live lease may complete a task. Unclaimed (legacy) tasks are open. */
export async function workerMayComplete(pool, taskId, workerId) {
    const r = await pool.query(`SELECT worker_id, lease_until FROM control_task WHERE id = $1`, [taskId]);
    const t = r.rows[0];
    if (!t)
        return false;
    if (!t.worker_id)
        return true; // never claimed: open
    if (workerId && t.worker_id === workerId)
        return true; // the lease holder
    return false; // a stale/other worker
}
export async function recordSuccess(pool, taskId) {
    await pool.query(`UPDATE mac_runtime SET last_success_at = now(), last_success_code = (SELECT code FROM control_task WHERE id = $1) WHERE id = 'primary'`, [taskId]);
}
export async function getRuntime(pool) {
    const r = await pool.query(`SELECT * FROM mac_runtime WHERE id = 'primary'`);
    const row = r.rows[0];
    if (!row)
        return null;
    return { id: row.id, lastHeartbeatAt: new Date(row.last_heartbeat_at), helperVersion: row.helper_version ?? null,
        capabilities: row.capabilities ?? {}, frontmostApp: row.frontmost_app ?? null, frontmostWindow: row.frontmost_window ?? null,
        currentTaskId: row.current_task_id ?? null, startedAt: row.started_at ? new Date(row.started_at) : null,
        reconnectCount: Number(row.reconnect_count ?? 0), restartCount: Number(row.restart_count ?? 0),
        lastSuccessAt: row.last_success_at ? new Date(row.last_success_at) : null, lastSuccessCode: row.last_success_code != null ? Number(row.last_success_code) : null };
}
export function macOnline(rt, now = Date.now()) {
    return !!rt && now - rt.lastHeartbeatAt.getTime() <= MAC_HEARTBEAT_FRESH_MS;
}
/** Worker claims a task: sets claim + lease + first progress. Idempotent for the same worker. */
export async function claimTask(pool, taskId, workerId) {
    const r = await pool.query(`UPDATE control_task SET claimed_at = COALESCE(claimed_at, now()), worker_id = $2,
       lease_until = now() + ($3 || ' milliseconds')::interval, last_progress_at = now()
     WHERE id = $1 AND status = 'active' AND (claimed_at IS NULL OR worker_id = $2 OR lease_until < now())
     RETURNING id`, [taskId, workerId, String(CLAIM_LEASE_MS)]);
    return r.rowCount === 1;
}
/** Worker reports progress on a claimed task (extends the lease). */
export async function taskProgress(pool, taskId, note) {
    await pool.query(`UPDATE control_task SET last_progress_at = now(), lease_until = now() + ($2 || ' milliseconds')::interval,
       progress_note = COALESCE($3, progress_note) WHERE id = $1`, [taskId, String(CLAIM_LEASE_MS), note ?? null]);
}
/** Derive the truthful lifecycle of a task from evidence. */
export function deriveLifecycle(task, rt, now = Date.now()) {
    if (task.status !== "active")
        return { lifecycle: task.status, evidence: `recorded status ${task.status}` };
    const claimed = !!task.claimed_at;
    if (!claimed) {
        return macOnline(rt, now)
            ? { lifecycle: "queued", evidence: `Mac online (heartbeat ${Math.round((now - rt.lastHeartbeatAt.getTime()) / 1000)}s ago), not yet claimed` }
            : { lifecycle: "waiting_for_mac", evidence: rt ? `no Mac heartbeat for ${Math.round((now - rt.lastHeartbeatAt.getTime()) / 1000)}s` : "no Mac runtime has ever connected" };
    }
    const prog = task.last_progress_at ? new Date(task.last_progress_at).getTime() : 0;
    const age = now - prog;
    return age <= TASK_PROGRESS_FRESH_MS
        ? { lifecycle: "executing", evidence: `claimed; progress ${Math.round(age / 1000)}s ago` }
        : { lifecycle: "stalled", evidence: `claimed but no progress for ${Math.round(age / 1000)}s` };
}
/** The status matrix Julian asked for. Real values, no guesses. */
export async function macStatus(pool) {
    const rt = await getRuntime(pool);
    const now = Date.now();
    const online = macOnline(rt, now);
    const cur = rt?.currentTaskId
        ? await pool.query(`SELECT code, request, status, claimed_at, last_progress_at, progress_note FROM control_task WHERE id = $1`, [rt.currentTaskId])
        : null;
    const t = cur?.rows[0];
    const caps = (rt?.capabilities ?? {});
    const pass = (k) => caps[k] === true ? "PASS" : caps[k] === false ? "FAIL" : "unknown";
    return {
        connected: online,
        lastHeartbeatSecondsAgo: rt ? Math.round((now - rt.lastHeartbeatAt.getTime()) / 1000) : null,
        helperVersion: rt?.helperVersion ?? null,
        screenCapture: pass("screen"), accessibility: pass("accessibility"), filesystem: pass("files"),
        browser: pass("browser"), clipboard: pass("clipboard"), activeWindow: pass("activeWindow"),
        currentApp: rt?.frontmostApp ?? null, currentWindow: rt?.frontmostWindow ?? null,
        reconnectCount: rt?.reconnectCount ?? 0, restartCount: rt?.restartCount ?? 0,
        lastSuccess: rt?.lastSuccessAt ? { at: rt.lastSuccessAt.toISOString(), taskCode: rt.lastSuccessCode } : null,
        runtimeStartedAt: rt?.startedAt?.toISOString() ?? null,
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
export async function sweepStaleTasks(pool) {
    const a = await pool.query(`UPDATE control_task SET status = 'failed', updated_at = now(),
       result_summary = 'Abandoned: no Mac worker claimed this task within 30 minutes (runtime was offline or the task was superseded). Ask again and it will run now.'
     WHERE status = 'active' AND claimed_at IS NULL AND created_at < now() - interval '30 minutes' RETURNING id`);
    const b = await pool.query(`UPDATE control_task SET status = 'failed', updated_at = now(),
       result_summary = 'Stalled: the Mac worker stopped reporting progress and the lease was not reclaimed within 10 minutes.'
     WHERE status = 'active' AND claimed_at IS NOT NULL AND lease_until < now() AND last_progress_at < now() - interval '10 minutes' RETURNING id`);
    const { completeForTask } = await import("../concierge/interactions.js");
    for (const r of [...a.rows, ...b.rows])
        await completeForTask(pool, r.id, { ok: false, summary: "task did not complete on the Mac" }).catch(() => { });
    return { abandoned: a.rowCount ?? 0, stalled: b.rowCount ?? 0 };
}
//# sourceMappingURL=runtime.js.map