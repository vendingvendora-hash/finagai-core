import { currentCause } from "./live-context.js";
/**
 * ADR-087 (hotfix 34): kinds of object whose events are STATE changes (src/db/state-events.ts STATE_TABLES maps every
 * state table onto one of these). A state-change event with no more specific cause cites the unit of work it happened
 * in (recorded once, lazily, as `work_invoked`); audit/telemetry events (tool calls, MCP traffic) never create one.
 */
export const STATE_ENTITY_TYPES = new Set(["area", "objective", "project", "work_item", "followup", "opportunity", "employer", "entity", "relationship", "knowledge_item",
    "conflict", "proposal", "governance_request", "escalation", "operating_exception", "watch_rule", "lesson", "control_task", "artifact", "review", "webauthn_credential"]);
/** The cause of a change made here: the unit of work's cause (e.g. its workflow run) ▸ the unit of work itself. */
export async function causeHere(db) {
    const ctx = currentCause();
    if (ctx?.causeIds?.length)
        return ctx.causeIds;
    const root = ctx?.root;
    if (!root)
        return [];
    root.id ??= appendEvent(db, { actor: root.actor, action: "work_invoked", causeIds: [], after: { what: root.what, ...(root.detail ?? {}) } });
    return [await root.id];
}
export async function appendEvent(db, e) {
    const ctx = currentCause();
    if (e.causeIds === undefined && !ctx?.causeIds?.length && ctx?.root && e.entityType && STATE_ENTITY_TYPES.has(e.entityType))
        e = { ...e, causeIds: await causeHere(db) };
    const res = await db.query(`INSERT INTO finagai.event (actor, action, entity_type, entity_id, before, after, reason,
                        capture_id, request_id, client, approval_id, principal, correlation_id, cause_ids, area_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`, [
        e.actor, e.action, e.entityType ?? null, e.entityId ?? null,
        e.before === undefined || e.before === null ? null : JSON.stringify(e.before), // absent means SQL NULL, never JSON null
        e.after === undefined || e.after === null ? null : JSON.stringify(e.after),
        e.reason ?? null, e.captureId ?? null, e.requestId ?? null, e.client ?? null,
        e.approvalId ?? null, e.principal ?? null,
        e.correlationId ?? ctx?.correlationId ?? null,
        (e.causeIds ?? ctx?.causeIds)?.length ? (e.causeIds ?? ctx.causeIds) : null,
        e.areaId !== undefined ? e.areaId : ctx?.areaId ?? null,
    ]);
    const id = res.rows[0]?.id;
    if (id === undefined)
        throw new Error("event insert returned no id");
    return Number(id);
}
//# sourceMappingURL=events.js.map