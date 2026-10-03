import { appendEvent } from "../db/index.js";
/** Register an artifact Finagai produced. Durable — this is what "send that" resolves against. */
export async function registerArtifact(pool, a) {
    const r = await pool.query(`INSERT INTO artifact (kind, mime, storage_ref, summary, origin, conversation, task_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [a.kind, a.mime ?? "image/png", a.storageRef, a.summary ?? null, a.origin ?? null, a.conversation ?? null, a.taskCode ?? null]);
    await appendEvent(pool, { actor: "cos", action: "artifact_registered", entityType: "artifact", entityId: r.rows[0].id, after: { kind: a.kind, summary: a.summary ?? null } });
    return mapArtifact(r.rows[0]);
}
/** The most recent ready artifact (optionally of a kind) for a conversation, else globally. For "send X". */
export async function resolveRecentArtifact(pool, opts = {}) {
    const where = ["state = 'ready'"];
    const args = [];
    if (opts.kind) {
        args.push(opts.kind);
        where.push(`kind = $${args.length}`);
    }
    // Prefer the given conversation, but fall back to any recent ready artifact (self-thread made it).
    const sql = `SELECT * FROM artifact WHERE ${where.join(" AND ")} ORDER BY (conversation = $${args.length + 1}) DESC NULLS LAST, created_at DESC LIMIT 1`;
    args.push(opts.conversation ?? null);
    const r = await pool.query(sql, args);
    return r.rows[0] ? mapArtifact(r.rows[0]) : null;
}
export async function markArtifactSent(pool, id) {
    await pool.query(`UPDATE artifact SET state = 'sent' WHERE id = $1`, [id]);
}
/**
 * Claim an inbound message for processing, idempotently. Returns:
 *  - { claim: true } if this worker won the claim and should process it;
 *  - { claim: false, state } if it was already handled (duplicate delivery) or claimed by a live worker.
 * A stale claim (older than leaseMs) is reclaimable, so a crashed worker's message is recovered.
 */
export async function claimInbound(pool, guid, handle, leaseMs = 120_000) {
    // Try to insert; if it already exists, decide based on its state/age.
    const ins = await pool.query(`INSERT INTO inbound_message (guid, handle) VALUES ($1,$2)
     ON CONFLICT (guid) DO NOTHING RETURNING guid`, [guid, handle]);
    if (ins.rowCount === 1)
        return { claim: true }; // fresh: we own it
    const cur = (await pool.query(`SELECT state, claimed_at FROM inbound_message WHERE guid = $1`, [guid])).rows[0];
    if (!cur)
        return { claim: true };
    if (cur.state === "done" || cur.state === "failed" || cur.state === "superseded")
        return { claim: false, state: cur.state };
    // state 'claimed': reclaim only if the lease has expired (previous worker likely died).
    const age = Date.now() - new Date(cur.claimed_at).getTime();
    if (age > leaseMs) {
        const re = await pool.query(`UPDATE inbound_message SET claimed_at = now() WHERE guid = $1 AND state = 'claimed' AND claimed_at < $2 RETURNING guid`, [guid, new Date(Date.now() - leaseMs)]);
        return { claim: re.rowCount === 1 };
    }
    return { claim: false, state: "claimed" };
}
export async function finishInbound(pool, guid, ok, result) {
    await pool.query(`UPDATE inbound_message SET state = $2, result = $3 WHERE guid = $1`, [guid, ok ? "done" : "failed", (result ?? "").slice(0, 500)]);
}
function mapArtifact(row) {
    return { id: String(row.id), kind: String(row.kind), mime: String(row.mime), storageRef: String(row.storage_ref),
        summary: row.summary ?? null, origin: row.origin ?? null, conversation: row.conversation ?? null,
        taskCode: row.task_code ?? null, state: String(row.state) };
}
//# sourceMappingURL=interaction.js.map