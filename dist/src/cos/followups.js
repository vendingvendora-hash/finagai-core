import { appendEvent, withTransaction } from "../db/index.js";
/** The next state given the current one and whether it is now past due. Pure. */
export function nextState(state, now, dueAt) {
    if (state === "done" || state === "cancelled")
        return state;
    if (dueAt && now.getTime() > dueAt.getTime())
        return "overdue";
    return state;
}
export async function createFollowup(pool, input) {
    return withTransaction(pool, async (tx) => {
        const r = await tx.query(`INSERT INTO followup (summary, counterparty, channel, due_at, area_id, project_id, state, last_action_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open',now()) RETURNING *`, [input.summary.slice(0, 2000), input.counterparty ?? null, input.channel ?? null, input.dueAt ?? null, input.areaId ?? null, input.projectId ?? null]);
        const row = r.rows[0];
        await appendEvent(tx, { actor: "cos", action: "followup_created", entityType: "followup", entityId: row.id,
            after: { summary: row.summary, dueAt: row.due_at } });
        return mapRow(row);
    });
}
/** Mark that we acted on it and are now waiting for a response, optionally setting/extending the due date. */
export async function markWaiting(pool, id, dueAt) {
    await withTransaction(pool, async (tx) => {
        await tx.query(`UPDATE followup SET state='waiting', last_action_at=now(), due_at=COALESCE($2,due_at), updated_at=now()
      WHERE id=$1 AND state NOT IN ('done','cancelled')`, [id, dueAt ?? null]);
        await appendEvent(tx, { actor: "cos", action: "followup_waiting", entityType: "followup", entityId: id, after: { dueAt: dueAt ?? null } });
    });
}
export async function closeFollowup(pool, id, outcome, cancelled = false) {
    await withTransaction(pool, async (tx) => {
        await tx.query(`UPDATE followup SET state=$2, outcome=$3, closed_at=now(), updated_at=now() WHERE id=$1`, [id, cancelled ? "cancelled" : "done", outcome.slice(0, 2000)]);
        await appendEvent(tx, { actor: "cos", action: cancelled ? "followup_cancelled" : "followup_done", entityType: "followup", entityId: id, after: { outcome: outcome.slice(0, 200) } });
    });
}
/** Sweep: flip past-due open/waiting follow-ups to 'overdue'. Returns how many changed. Idempotent. */
export async function sweepOverdue(pool, now = new Date()) {
    const r = await pool.query(`UPDATE followup SET state='overdue', updated_at=now()
     WHERE state IN ('open','waiting') AND due_at IS NOT NULL AND due_at < $1 RETURNING id`, [now]);
    return r.rowCount ?? 0;
}
/** Open follow-ups, overdue first, then soonest due. For the brief + exception view. */
export async function openFollowups(pool, areaId) {
    const r = await pool.query(`SELECT * FROM followup WHERE state IN ('open','waiting','overdue') ${areaId ? "AND area_id = $1" : ""}
     ORDER BY (state='overdue') DESC, due_at NULLS LAST, created_at`, areaId ? [areaId] : []);
    return r.rows.map(mapRow);
}
function mapRow(row) {
    return {
        id: String(row.id), summary: String(row.summary), counterparty: row.counterparty ?? null,
        channel: row.channel ?? null, state: row.state,
        dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
        lastActionAt: row.last_action_at ? new Date(row.last_action_at).toISOString() : null,
        closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
        outcome: row.outcome ?? null, areaId: row.area_id ?? null, projectId: row.project_id ?? null,
    };
}
//# sourceMappingURL=followups.js.map