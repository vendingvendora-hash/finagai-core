/**
 * Durable interactions (WO2 / ADR-067). Once Finagai accepts a request it OWNS it until a terminal state,
 * regardless of how many Claude turns pass. The record links the originating conversation and message to
 * a stable logical request key, the underlying tasks, the execution owner, progress, the artifact/result, and
 * whether the final response has reached Julian.
 *
 * Async return: MCP has no server->chat push. The strongest supported mechanism is (1) same-turn re-polling,
 * (2) automatic iMessage delivery by the Mac runtime, and (3) surfacing every completed-but-undelivered
 * interaction on the NEXT tool call of any kind, so Julian never has to say "check again".
 */
import type pg from "pg";

export type InteractionState = "received" | "claimed" | "executing" | "waiting_on_tool" | "verifying" | "rendering"
  | "delivering" | "completed" | "awaiting_human" | "failed" | "superseded";

export type Interaction = {
  id: string; conversation: string; requestKey: string; state: InteractionState; taskIds: string[];
  resultSummary: string | null; resultImageB64: string | null; finalResponseStatus: "pending" | "delivered" | "not_needed";
  progressNote: string | null; createdAt: Date; retries: number;
};

/** Stable logical identity for a request: lowercase, collapse whitespace, strip punctuation + filler. */
export function requestKey(text: string): string {
  return text.toLowerCase().replace(/[“”"'`]/g, "").replace(/\b(please|finagai|can you|could you|for me|now)\b/g, "")
    .replace(/[^a-z0-9.:_ -]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function map(row: Record<string, unknown>): Interaction {
  return { id: String(row.id), conversation: String(row.conversation), requestKey: String(row.request_key),
    state: row.state as InteractionState, taskIds: (row.task_ids as string[]) ?? [],
    resultSummary: (row.result_summary as string) ?? null, resultImageB64: (row.result_image_b64 as string) ?? null,
    finalResponseStatus: row.final_response_status as Interaction["finalResponseStatus"],
    progressNote: (row.progress_note as string) ?? null, createdAt: new Date(row.created_at as string), retries: Number(row.retries ?? 0) };
}

/**
 * Open (or reuse) the interaction for a logical request. An equivalent open interaction from the last
 * 30 minutes is RETURNED, not duplicated — this is what prevents task #32 beside task #9.
 */
export async function openInteraction(pool: pg.Pool, opts: { conversation: string; message: string; key?: string }): Promise<{ interaction: Interaction; reused: boolean }> {
  const key = opts.key ?? requestKey(opts.message);
  const ex = await pool.query(
    `SELECT * FROM interaction WHERE request_key = $1 AND conversation = $2 AND created_at > now() - interval '30 minutes'
       AND (state NOT IN ('failed','superseded')) ORDER BY created_at DESC LIMIT 1`, [key, opts.conversation]);
  if (ex.rows[0]) return { interaction: map(ex.rows[0]), reused: true };
  const r = await pool.query(
    `INSERT INTO interaction (conversation, origin_message, request_key) VALUES ($1, $2, $3) RETURNING *`,
    [opts.conversation, opts.message.slice(0, 1000), key]);
  return { interaction: map(r.rows[0]), reused: false };
}

export async function linkTask(pool: pg.Pool, interactionId: string, taskId: string): Promise<void> {
  await pool.query(`UPDATE interaction SET task_ids = array_append(array_remove(task_ids, $2), $2), state = 'claimed', updated_at = now() WHERE id = $1`, [interactionId, taskId]);
  await pool.query(`UPDATE control_task SET interaction_id = $1 WHERE id = $2`, [interactionId, taskId]);
}

export async function setState(pool: pg.Pool, interactionId: string, state: InteractionState, note?: string): Promise<void> {
  await pool.query(`UPDATE interaction SET state = $2, progress_note = COALESCE($3, progress_note), updated_at = now() WHERE id = $1`, [interactionId, state, note ?? null]);
}

/** Called when the underlying task reaches a terminal state. Result becomes pending delivery. */
export async function completeForTask(pool: pg.Pool, taskId: string, outcome: { ok: boolean; summary: string; imageB64?: string | null; artifactId?: string | null }): Promise<void> {
  await pool.query(
    `UPDATE interaction SET state = $2, result_summary = $3, result_image_b64 = COALESCE($4, result_image_b64),
       artifact_id = COALESCE($5, artifact_id), final_response_status = 'pending', updated_at = now()
     WHERE $1 = ANY(task_ids) AND state NOT IN ('completed','failed','superseded')`,
    [taskId, outcome.ok ? "completed" : "failed", outcome.summary.slice(0, 1000), outcome.imageB64 ?? null, outcome.artifactId ?? null]);
}

/** Completed/failed interactions whose result has NOT yet reached this conversation. */
export async function undelivered(pool: pg.Pool, conversation: string, limit = 3): Promise<Interaction[]> {
  const r = await pool.query(
    `SELECT * FROM interaction WHERE conversation = $1 AND state IN ('completed','failed') AND final_response_status = 'pending'
       AND created_at > now() - interval '24 hours' ORDER BY updated_at DESC LIMIT $2`, [conversation, limit]);
  return r.rows.map(map);
}

export async function markDelivered(pool: pg.Pool, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await pool.query(`UPDATE interaction SET final_response_status = 'delivered', delivered_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
}

export async function getInteraction(pool: pg.Pool, id: string): Promise<Interaction | null> {
  const r = await pool.query(`SELECT * FROM interaction WHERE id = $1`, [id]);
  return r.rows[0] ? map(r.rows[0]) : null;
}
