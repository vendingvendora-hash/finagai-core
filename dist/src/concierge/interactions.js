import { reportLifecycleError } from "../ops/lifecycle-errors.js";
/** Stable logical identity for a request: lowercase, collapse whitespace, strip punctuation + filler. */
export function requestKey(text) {
    return text.toLowerCase().replace(/[“”"'`]/g, "").replace(/\b(please|finagai|can you|could you|for me|now)\b/g, "")
        .replace(/[^a-z0-9.:_ -]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
function map(row) {
    return { id: String(row.id), conversation: String(row.conversation), requestKey: String(row.request_key),
        state: row.state, taskIds: row.task_ids ?? [],
        resultSummary: row.result_summary ?? null, resultImageB64: row.result_image_b64 ?? null,
        finalResponseStatus: row.final_response_status,
        progressNote: row.progress_note ?? null, createdAt: new Date(row.created_at), retries: Number(row.retries ?? 0) };
}
/**
 * Open (or reuse) the interaction for a logical request. An equivalent open interaction from the last
 * 30 minutes is RETURNED, not duplicated — this is what prevents task #32 beside task #9.
 */
export async function openInteraction(pool, opts) {
    const key = opts.key ?? requestKey(opts.message);
    const ex = await pool.query(`SELECT * FROM interaction WHERE request_key = $1 AND conversation = $2 AND created_at > now() - interval '30 minutes'
       AND (state NOT IN ('failed','superseded','expired','cancelled')) ORDER BY created_at DESC LIMIT 1`, [key, opts.conversation]);
    if (ex.rows[0])
        return { interaction: map(ex.rows[0]), reused: true };
    const r = await pool.query(`INSERT INTO interaction (conversation, origin_message, request_key, task_class, acknowledged_at, origin) VALUES ($1, $2, $3, $4, now(), $5) RETURNING *`, [opts.conversation, opts.message.slice(0, 1000), key, taskClass(opts.message), opts.origin ?? "chat"]);
    // Phase 0C: asking again for something that expired/was waiting supersedes the old record (one logical request).
    await pool.query(`UPDATE interaction SET state = 'superseded', superseded_by = $1, updated_at = now()
     WHERE request_key = $2 AND conversation = $3 AND id <> $1 AND state IN ('expired','awaiting_human','resumable') AND created_at > now() - interval '7 days'`, [r.rows[0].id, key, opts.conversation]);
    return { interaction: map(r.rows[0]), reused: false };
}
export async function linkTask(pool, interactionId, taskId) {
    await pool.query(`UPDATE interaction SET task_ids = array_append(array_remove(task_ids, $2), $2), state = 'claimed', updated_at = now() WHERE id = $1`, [interactionId, taskId]);
    await pool.query(`UPDATE control_task SET interaction_id = $1 WHERE id = $2`, [interactionId, taskId]);
}
export async function setState(pool, interactionId, state, note) {
    await pool.query(`UPDATE interaction SET state = $2, progress_note = COALESCE($3, progress_note), updated_at = now() WHERE id = $1`, [interactionId, state, note ?? null]);
}
/** Called when the underlying task reaches a terminal state. Result becomes pending delivery. */
/** Coarse task class for metrics (kept stable so difficulty mix stays visible). */
export function taskClass(message) {
    const m = message.toLowerCase();
    if (/^mac_chart:|\bchart\b/.test(m))
        return "chart";
    if (/^mac_ping/.test(m))
        return "ping";
    if (/\b(https?:\/\/|chrome|safari|browser|tab|website|gmail|calendar)\b/.test(m))
        return "browser";
    if (/\b(finder|file|folder|move|rename|trash|downloads)\b/.test(m))
        return "files";
    if (/\b(textedit|notes|pages|numbers|keynote|excel|word|messages|mail|app)\b/.test(m))
        return "native-app";
    return "general";
}
export async function completeForTask(pool, taskId, outcome) {
    const state = outcome.cancelled ? "cancelled" : outcome.ok ? "completed" : "failed";
    await pool.query(`UPDATE interaction i SET state = $2, result_summary = $3, result_image_b64 = COALESCE($4, result_image_b64),
       artifact_id = COALESCE($5, artifact_id), updated_at = now(), completed_at = now(),
       -- Phase 0D: chat results wait for the chat; iMessage/contact results ride the helper's reply in the same exchange.
       final_response_status = CASE WHEN i.conversation = 'chat' THEN 'pending' ELSE 'delivered' END,
       delivered_at = CASE WHEN i.conversation = 'chat' THEN i.delivered_at ELSE now() END,
       verification_status = CASE WHEN $2 = 'completed' THEN COALESCE($6, 'not_applicable') ELSE NULL END,
       waiting_human_s = waiting_human_s + COALESCE(extract(epoch FROM now() - i.awaiting_since), 0), awaiting_since = NULL,
       failure_class = CASE WHEN $2 = 'failed' THEN COALESCE((SELECT failure_class FROM control_task WHERE id = $1), i.failure_class, 'failed') ELSE i.failure_class END,
       tool_calls = (SELECT count(*) FROM control_step s WHERE s.task_id = ANY(i.task_ids)),
       model_calls = (SELECT coalesce(sum(model_calls),0) FROM control_task t WHERE t.id = ANY(i.task_ids)),
       verification_attempts = GREATEST(i.verification_attempts, (SELECT coalesce(sum(verify_attempts),0) FROM control_task t WHERE t.id = ANY(i.task_ids))),
       recovery_attempts = (SELECT coalesce(sum(recovery_attempts),0) FROM control_task t WHERE t.id = ANY(i.task_ids)),
       terminal_reason = (SELECT terminal_reason FROM control_task WHERE id = $1),
       cost_usd = (SELECT sum(cost_usd) FROM llm_call c WHERE c.request_id = ANY(i.task_ids))   -- ADR-075: was never written
     WHERE $1 = ANY(task_ids) AND state NOT IN ('completed','failed','superseded','cancelled')`, [taskId, state, outcome.summary.slice(0, 1000), outcome.imageB64 ?? null, outcome.artifactId ?? null, outcome.verification ?? null]);
    await pool.query(`UPDATE control_task SET verification_status = COALESCE(verification_status, $2) WHERE id = $1`, [taskId, outcome.ok && !outcome.cancelled ? (outcome.verification ?? "not_applicable") : null]);
}
/** Completed/failed interactions whose result has NOT yet reached this conversation. */
export async function undelivered(pool, conversation, limit = 3) {
    const r = await pool.query(`SELECT * FROM interaction WHERE conversation = $1 AND state IN ('completed','failed') AND final_response_status = 'pending'
       AND created_at > now() - interval '24 hours' ORDER BY updated_at DESC LIMIT $2`, [conversation, limit]);
    return r.rows.map(map);
}
export async function markDelivered(pool, ids) {
    if (!ids.length)
        return;
    await pool.query(`UPDATE interaction SET final_response_status = 'delivered', delivered_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
}
export async function getInteraction(pool, id) {
    const r = await pool.query(`SELECT * FROM interaction WHERE id = $1`, [id]);
    return r.rows[0] ? map(r.rows[0]) : null;
}
/** Phase 1D: aggregates for the operating review / scoreboard. */
export async function metricsSummary(pool, days = 7) {
    const r = await pool.query(`SELECT * FROM interaction_metrics_daily WHERE day > now() - ($1 || ' days')::interval ORDER BY day DESC, task_class`, [String(days)]);
    return r.rows;
}
/**
 * ADR-075 live fix: interactions #41/#80/#104/#107/#113 stayed "executing" for a day after their tasks had ended
 * (tasks were terminalized by paths that never called completeForTask). Reconcile every open interaction:
 *  - all linked tasks terminal  -> completed if the last one is done, else failed (via completeForTask)
 *  - no linked task and no update for 6 hours -> failed, failure_class 'abandoned'
 */
export async function reconcileInteractions(pool) {
    const open = `state NOT IN ('completed','failed','superseded','awaiting_human','expired','cancelled','resumable')`;
    let errors = 0;
    const done = await pool.query(`SELECT DISTINCT ON (i.id) t.id AS task_id, t.status, t.result_summary AS summary, t.verification_status
       FROM interaction i JOIN control_task t ON t.id = ANY(i.task_ids)
      WHERE i.${open} AND cardinality(i.task_ids) > 0
        AND NOT EXISTS (SELECT 1 FROM control_task x WHERE x.id = ANY(i.task_ids) AND x.status NOT IN ('done','failed','cancelled','expired'))
      ORDER BY i.id, t.updated_at DESC`);
    for (const r of done.rows) {
        try {
            if (r.status === "expired") {
                const { expireTask } = await import("./human-wait.js");
                await expireTask(pool, r.task_id, r.summary ?? "Expired waiting for Julian.");
            }
            else {
                await completeForTask(pool, r.task_id, { ok: r.status === "done", cancelled: r.status === "cancelled", verification: r.verification_status ?? undefined,
                    summary: r.summary ?? (r.status === "done" ? "task completed" : `task ${r.status}`) });
            }
        }
        catch (e) {
            errors++;
            await reportLifecycleError(pool, "reconcileInteractions.close", e, { taskId: r.task_id });
        }
    }
    // Phase 0C: an interaction whose task waits for Julian is awaiting_human, never "executing".
    const aw = await pool.query(`UPDATE interaction i SET state = 'awaiting_human', awaiting_since = COALESCE(i.awaiting_since, t.awaiting_since, t.updated_at), updated_at = now()
       FROM control_task t
      WHERE t.id = ANY(i.task_ids) AND t.status IN ('waiting_approval','paused') AND i.${open} RETURNING i.id`);
    const ab = await pool.query(`UPDATE interaction SET state = 'failed', failure_class = 'abandoned', terminal_reason = 'abandoned', completed_at = now(), updated_at = now(),
        result_summary = COALESCE(result_summary, 'Abandoned: no task was started for this request within 6 hours.'), final_response_status = 'pending'
      WHERE ${open} AND cardinality(task_ids) = 0 AND updated_at < now() - interval '6 hours' RETURNING id`);
    return { closed: done.rowCount ?? 0, abandoned: ab.rowCount ?? 0, awaiting: aw.rowCount ?? 0, errors };
}
//# sourceMappingURL=interactions.js.map