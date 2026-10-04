const RANK = { requested: 0, failed: 0, accepted: 1, outgoing_observed: 2, delivered: 3 };
export const IN_FLIGHT_MS = 45_000; // a 'requested' younger than this may still be executing on a live worker
export const MAX_ATTEMPTS = 3;
export function actionKey(requestRef, operation, artifactId, recipient) {
    return `${requestRef}:${operation}:${artifactId}:${recipient}`;
}
export async function claimAction(pool, a) {
    const key = actionKey(a.requestRef, a.operation, a.artifactId, a.recipient);
    const ins = await pool.query(`INSERT INTO outbound_action (idempotency_key, request_ref, operation, artifact_id, recipient) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, [key, a.requestRef, a.operation, a.artifactId, a.recipient]);
    if (ins.rows[0])
        return { decision: "execute", action: ins.rows[0] };
    const cur = (await pool.query(`SELECT * FROM outbound_action WHERE idempotency_key = $1`, [key])).rows[0];
    if (RANK[cur.state] >= 1)
        return { decision: "already_done", action: cur };
    if (cur.state === "failed") {
        if (cur.attempts >= MAX_ATTEMPTS)
            return { decision: "exhausted", action: cur };
        const re = await pool.query(`UPDATE outbound_action SET state = 'requested', attempts = attempts + 1, requested_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'failed' RETURNING *`, [cur.id]);
        return re.rows[0] ? { decision: "execute", action: re.rows[0] } : claimAction(pool, a);
    }
    // state 'requested': outcome unknown. Young → probably in flight; old → reconcile from evidence first.
    if (Date.now() - new Date(cur.requested_at).getTime() < IN_FLIGHT_MS)
        return { decision: "in_flight", action: cur };
    return { decision: "reconcile", action: cur };
}
/** Monotonic state report. A weaker state never overwrites a stronger one. */
export async function reportAction(pool, id, state, evidence = {}) {
    const col = state === "accepted" ? "accepted_at" : state === "outgoing_observed" ? "observed_at" : state === "delivered" ? "delivered_at" : null;
    const r = await pool.query(`UPDATE outbound_action SET
       state = CASE WHEN $2 = 'failed' AND state IN ('requested','failed') THEN 'failed'
                    WHEN (CASE state WHEN 'delivered' THEN 3 WHEN 'outgoing_observed' THEN 2 WHEN 'accepted' THEN 1 ELSE 0 END)
                       < (CASE $2 WHEN 'delivered' THEN 3 WHEN 'outgoing_observed' THEN 2 WHEN 'accepted' THEN 1 ELSE 0 END) THEN $2
                    ELSE state END,
       ${col ? `${col} = COALESCE(${col}, now()),` : ""}
       evidence = evidence || $3::jsonb, updated_at = now()
     WHERE id = $1 RETURNING *`, [id, state, JSON.stringify(evidence)]);
    return r.rows[0];
}
/** User-facing wording that never claims more than the evidence. */
export function sendWording(state, label) {
    switch (state) {
        case "delivered": return `✅ Delivered to ${label} (Messages delivery receipt).`;
        case "outgoing_observed": return `📤 Sent to ${label} — the outgoing message is recorded on this Mac; no delivery receipt yet.`;
        case "accepted": return `📤 Handed to Messages for ${label}, but I couldn't see the outgoing record yet — check the thread.`;
        case "failed": return `⚠️ Couldn't send to ${label}.`;
        default: return `⏳ Sending to ${label}…`;
    }
}
//# sourceMappingURL=actions.js.map