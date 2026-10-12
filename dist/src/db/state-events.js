/**
 * ADR-087 (hotfix 34): the authoritative-state model. Every table Finagai writes is either STATE (a change to it is a
 * meaningful, observable state transition and MUST be recorded as a semantic event) or OPERATIONAL (bookkeeping that is
 * not itself state the principal reasons about — each with the reason). test/unit/live-coverage.test.ts enforces that
 * every write path to a STATE table emits an event, and that every table written is classified here.
 *
 * recordTransition() is the generic way to emit such an event: it reads the row's semantic state AFTER the write,
 * compares it with the state captured before, and appends one event carrying the affected object, before/after, the
 * surrounding unit-of-work (correlation id) and its cause.
 */
import { appendEvent, causeHere } from "./events.js";
export { causeHere };
export const STATE_TABLES = {
    area: { entity: "area", semantic: ["name", "description", "status", "archived_at"] },
    objective: { entity: "objective", semantic: ["area_id", "name", "description", "status", "target_date"] },
    project: { entity: "project", semantic: ["name", "description", "status", "priority", "archived_at", "area_id", "objective_id"] },
    work_item: { entity: "work_item", semantic: ["project_id", "title", "status", "priority", "due_at", "completed_at", "archived_at", "disputed"] },
    followup: { entity: "followup", semantic: ["summary", "counterparty", "state", "due_at", "closed_at", "outcome", "area_id", "project_id", "opportunity_id"] },
    opportunity: { entity: "opportunity", semantic: ["org", "title", "status", "employer_id", "project_id", "area_id", "applied_at", "contact", "next_action", "next_action_at", "archived_at"] },
    opportunity_event: { entity: "opportunity", semantic: ["opportunity_id", "at", "kind", "source", "summary", "transition"] },
    employer: { entity: "employer", semantic: ["key", "name", "aliases", "party"] },
    entity: { entity: "entity", semantic: ["kind", "name", "aliases", "notes", "archived_at"] },
    relationship: { entity: "relationship", semantic: ["from_type", "from_id", "to_type", "to_id", "kind", "archived_at"] },
    knowledge_item: { entity: "knowledge_item", semantic: ["claim", "epistemic_status", "status", "supersedes_id", "archived_at"] },
    conflict: { entity: "conflict", semantic: ["status", "resolution_note", "resolved_at"] },
    proposal: { entity: "proposal", semantic: ["status", "decided_at", "proposed_text"] },
    governance_request: { entity: "governance_request", semantic: ["status", "decided_at"] },
    escalation: { entity: "escalation", semantic: ["needs", "summary", "status", "due_at", "notified_at", "resolved_at"] },
    operating_exception: { entity: "operating_exception", semantic: ["owner", "severity", "needs", "status", "remediation", "resolved_at"] },
    watch_rule: { entity: "watch_rule", semantic: ["statement", "status", "armed", "removed_at"] },
    lesson: { entity: "lesson", semantic: ["statement", "effect", "status", "confidence", "retired_reason"] },
    control_task: { entity: "control_task", semantic: ["status", "verification_status", "awaiting_kind", "terminal_reason", "failure_class"] },
    artifact: { entity: "artifact", semantic: ["state", "available_until"] },
    review: { entity: "review", semantic: ["delivered_at", "delivery_status"] },
    webauthn_credential: { entity: "webauthn_credential", semantic: ["credential_id", "label", "revoked_at"] },
};
/** Tables that hold bookkeeping, not state the principal reasons about. Each says why it needs no semantic event. */
export const OPERATIONAL_TABLES = {
    event: "the event log itself — written only by appendEvent()",
    live_event: "the stream's ordering index (ADR-087)",
    event_cursor: "watcher high-water marks",
    event_tick: "event-loop run ledger; each tick's work is evented under its correlation id",
    inbound_event: "raw input queue; arrival and routing are evented as evidence_observed / evidence_routed",
    job_run: "scheduler slot ledger (claim/lease/finish)",
    llm_call: "model metering ledger",
    outbound_delivery: "idempotent delivery ledger; the semantic outcome is notification_delivered / _suppressed",
    outbound_action: "idempotency ledger for outbound actions; their effects are evented by the caller",
    inbound_message: "iMessage intake dedupe ledger",
    webauthn_ceremony: "single-use passkey challenge records",
    webauthn_enrollment: "single-use passkey enrollment tokens (enrolment itself is passkey_enrolled)",
    diagnostic_job: "operator diagnostics run ledger",
    evidence_snapshot: "content-addressed evidence cache",
    evidence_acquisition: "evidence acquisition log",
    gmail_message_content: "mail body cache",
    resource_trace: "resource-planning trace",
    mac_runtime: "Mac heartbeat/lease row; reconnects are evented as mac_reconnected",
    capability: "resource registry cache (rebuilt from code)",
    external_ref: "dedupe keys for external objects",
    capture: "J2 intake record; what it changes is evented by apply (create/update/…)",
    capture_candidate: "J2 staging; becomes a proposal or a state change, each evented",
    seed_batch: "seeding session staging; promotion is evented",
    bootstrap_proposal: "staged bootstrap plan; applying it is evented per object",
    interaction: "conversation threading for the concierge; task outcomes are evented on control_task",
    control_step: "per-step execution log; decisions and results are evented (control_step_*)",
    concierge_contact: "contact directory for the concierge (evented on change)",
    concierge_message: "concierge message log",
    concierge_draft: "concierge drafts (evented on decision)",
    finagai_schema_migrations: "migration ledger",
};
/** The semantic state of one row (null when it does not exist). */
export async function rowState(db, table, id) {
    const t = STATE_TABLES[table];
    if (!t)
        throw new Error(`rowState: ${table} is not a state table`);
    const r = (await db.query(`SELECT ${t.semantic.map((c) => `"${c}"`).join(", ")} FROM finagai.${table} WHERE id = $1`, [id])).rows[0];
    return r ? Object.fromEntries(t.semantic.map((c) => [c, r[c] instanceof Date ? r[c].toISOString() : r[c] ?? null])) : null;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Only the fields that changed (both sides), so the event carries the semantic before/after, not the whole row. */
export function diffState(before, after) {
    if (!before || !after)
        return { before, after };
    const keys = Object.keys(after).filter((k) => !same(before[k], after[k]));
    return { before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: Object.fromEntries(keys.map((k) => [k, after[k]])) };
}
/** The latest event about an entity — the state this transition moves on from. */
async function lastEventOn(db, entityType, entityId) {
    const r = (await db.query(`SELECT id FROM finagai.event WHERE entity_type = $1 AND entity_id = $2::uuid ORDER BY id DESC LIMIT 1`, [entityType, entityId])).rows[0];
    return r ? [Number(r.id)] : [];
}
/**
 * Append the semantic event for one state transition. Returns the event id, or 0 when nothing semantic changed.
 * Cause: explicit causeIds ▸ the surrounding unit of work's cause (e.g. the workflow run) ▸ the entity's previous event.
 */
export async function recordTransition(db, t) {
    const table = STATE_TABLES[t.table];
    if (!table)
        throw new Error(`recordTransition: ${t.table} is not a state table`);
    const after = t.after !== undefined ? t.after : await rowState(db, t.table, t.id);
    const d = diffState(t.before, after);
    if (t.before && after && !Object.keys(d.after ?? {}).length)
        return 0;
    const entityId = t.table === "opportunity_event" ? String((after ?? t.before)?.opportunity_id ?? t.id) : t.id;
    let causeIds = t.causeIds?.length ? t.causeIds : await causeHere(db);
    if (!causeIds.length)
        causeIds = await lastEventOn(db, table.entity, entityId);
    return appendEvent(db, { actor: t.actor, action: t.action, entityType: table.entity, entityId,
        before: d.before, after: { ...(d.after ?? {}), ...(t.context ?? {}) }, ...(t.reason ? { reason: t.reason } : {}),
        ...(t.areaId !== undefined ? { areaId: t.areaId } : {}), causeIds });
}
/**
 * For set-based writes: `WITH prev AS (SELECT id, <cols> … FOR UPDATE) UPDATE … FROM prev WHERE t.id = prev.id
 * RETURNING t.id, prev.<col> AS "before.<col>"` — then this turns each returned row into its own transition event.
 */
export async function recordBulkTransitions(db, rows, t) {
    const out = [];
    for (const r of rows) {
        const before = Object.fromEntries(Object.entries(r).filter(([k]) => k.startsWith("before.")).map(([k, v]) => [k.slice(7), v instanceof Date ? v.toISOString() : v ?? null]));
        out.push(await recordTransition(db, { ...t, id: String(r.id), before }));
    }
    return out;
}
//# sourceMappingURL=state-events.js.map