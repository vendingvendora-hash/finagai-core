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
       AND (state NOT IN ('failed','superseded')) ORDER BY created_at DESC LIMIT 1`, [key, opts.conversation]);
    if (ex.rows[0])
        return { interaction: map(ex.rows[0]), reused: true };
    const r = await pool.query(`INSERT INTO interaction (conversation, origin_message, request_key, task_class, acknowledged_at) VALUES ($1, $2, $3, $4, now()) RETURNING *`, [opts.conversation, opts.message.slice(0, 1000), key, taskClass(opts.message)]);
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
    await pool.query(`UPDATE interaction i SET state = $2, result_summary = $3, result_image_b64 = COALESCE($4, result_image_b64),
       artifact_id = COALESCE($5, artifact_id), final_response_status = 'pending', updated_at = now(), completed_at = now(),
       failure_class = CASE WHEN $2 = 'failed' THEN COALESCE((SELECT failure_class FROM control_task WHERE id = $1), i.failure_class, 'failed') ELSE i.failure_class END,
       tool_calls = (SELECT count(*) FROM control_step s WHERE s.task_id = ANY(i.task_ids)),
       model_calls = (SELECT coalesce(sum(model_calls),0) FROM control_task t WHERE t.id = ANY(i.task_ids)),
       verification_attempts = GREATEST(i.verification_attempts, (SELECT coalesce(sum(verify_attempts),0) FROM control_task t WHERE t.id = ANY(i.task_ids)))
     WHERE $1 = ANY(task_ids) AND state NOT IN ('completed','failed','superseded')`, [taskId, outcome.ok ? "completed" : "failed", outcome.summary.slice(0, 1000), outcome.imageB64 ?? null, outcome.artifactId ?? null]);
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
//# sourceMappingURL=interactions.js.map