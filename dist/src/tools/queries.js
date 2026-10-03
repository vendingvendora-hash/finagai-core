import { orQuery } from "../pipelines/j2/retrieve.js";
import { startOfZonedMonth } from "../jobs/time.js";
export async function stateOverview(db, opts) {
    const projects = await db.query(`SELECT p.id, p.name, p.status, p.priority, p.is_unassigned_holding, p.last_activity_at, p.classification,
            count(w.id) FILTER (WHERE w.status IN ('open','in_progress','waiting'))::int AS open_items,
            count(w.id) FILTER (WHERE w.status IN ('open','in_progress','waiting') AND w.due_at < $1)::int AS overdue,
            min(w.due_at) FILTER (WHERE w.status IN ('open','in_progress','waiting') AND w.due_at >= $1) AS next_due
       FROM project p LEFT JOIN work_item w ON w.project_id = p.id AND w.archived_at IS NULL
      WHERE p.archived_at IS NULL AND p.status <> 'completed'
      GROUP BY p.id ORDER BY p.is_unassigned_holding, p.priority NULLS LAST, p.name`, [opts.now]);
    const counts = (await db.query(`SELECT (SELECT count(*)::int FROM conflict WHERE status = 'open') AS open_conflicts,
            (SELECT count(*)::int FROM proposal WHERE status = 'pending' AND archived_at IS NULL) AS pending_proposals,
            (SELECT count(*)::int FROM governance_request WHERE status = 'pending' AND expires_at > now()) AS pending_approvals,
            (SELECT count(*)::int FROM capture WHERE status = 'budget_deferred') AS deferred_captures`)).rows[0];
    const spend = (await db.query(`SELECT coalesce(sum(cost_usd),0) + coalesce(sum(reserved_usd) FILTER (WHERE status='reserved' AND called_at > now() - interval '10 minutes'),0) AS total
       FROM llm_call WHERE called_at >= $1`, [startOfZonedMonth(opts.now, opts.timezone)])).rows[0];
    return {
        projects: projects.rows,
        queues: counts,
        budget: { monthToDateUsd: Number(spend?.total ?? 0), targetUsd: opts.targetUsd, ceilingUsd: opts.ceilingUsd },
    };
}
export async function projectDetail(db, idOrName) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrName);
    const p = await db.query(`SELECT id, name, description, status, priority, is_unassigned_holding, stall_threshold_days, last_activity_at, classification, version
       FROM project WHERE archived_at IS NULL AND ${isUuid ? "id = $1" : "lower(name) = lower($1)"}`, [idOrName]);
    const project = p.rows[0];
    if (!project)
        return null;
    const items = await db.query(`SELECT id, kind, title, status, priority, due_at, disputed, completed_at, classification, version
       FROM work_item WHERE project_id = $1 AND archived_at IS NULL
      ORDER BY (status IN ('done','cancelled')), due_at NULLS LAST, created_at LIMIT 200`, [project.id]);
    const knowledge = await db.query(`SELECT id, claim, epistemic_status, status, as_of, classification FROM knowledge_item
      WHERE subject_type = 'project' AND subject_id = $1 AND archived_at IS NULL AND status <> 'superseded'
      ORDER BY as_of DESC LIMIT 50`, [project.id]);
    const events = await db.query(`SELECT id, occurred_at, actor, action, entity_type, entity_id FROM event
      WHERE entity_id = $1 OR entity_id IN (SELECT id FROM work_item WHERE project_id = $1)
      ORDER BY id DESC LIMIT 20`, [project.id]);
    return { project, items: items.rows, knowledge: knowledge.rows, recentEvents: events.rows };
}
export async function searchState(db, query, limit = 20) {
    const q = orQuery(query);
    if (!q)
        return [];
    const r = await db.query(`SELECT * FROM (
       SELECT 'work_item' AS type, id, title AS text, status, classification, ts_rank(search, to_tsquery('simple',$1)) AS rank
         FROM work_item WHERE archived_at IS NULL AND search @@ to_tsquery('simple',$1)
       UNION ALL
       SELECT 'knowledge_item', id, claim, status, classification, ts_rank(search, to_tsquery('simple',$1))
         FROM knowledge_item WHERE archived_at IS NULL AND search @@ to_tsquery('simple',$1)
       UNION ALL
       SELECT 'entity', id, name, NULL, classification, ts_rank(search, to_tsquery('simple',$1))
         FROM entity WHERE archived_at IS NULL AND search @@ to_tsquery('simple',$1)
       UNION ALL
       SELECT 'project', id, name, status, classification, ts_rank(search, to_tsquery('simple',$1))
         FROM project WHERE archived_at IS NULL AND search @@ to_tsquery('simple',$1)
     ) s ORDER BY rank DESC LIMIT $2`, [q, limit]);
    return r.rows.map(({ rank: _r, ...row }) => row);
}
const ITEM_TABLES = ["work_item", "knowledge_item", "entity", "project", "external_ref", "conflict", "proposal"];
export const isItemTable = (t) => ITEM_TABLES.includes(t);
/** A record with its provenance: the capture and verbatim quote that created it, and its events. */
export async function itemWithProvenance(db, table, id) {
    const row = (await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
    if (!row)
        return null;
    delete row.search;
    const captureId = row.source_capture_id ?? null;
    const capture = captureId ? (await db.query(`SELECT id, received_at, client, mode, source_type FROM capture WHERE id = $1`, [captureId])).rows[0] ?? null : null;
    const quote = captureId ? (await db.query(`SELECT source_quote FROM capture_candidate WHERE capture_id = $1 AND target_id = $2 LIMIT 1`, [captureId, id])).rows[0]?.source_quote ?? null : null;
    const events = (await db.query(`SELECT id, occurred_at, actor, action, reason, approval_id, principal FROM event WHERE entity_id = $1 ORDER BY id`, [id])).rows;
    return { record: row, provenance: { capture, sourceQuote: quote }, events };
}
export async function openConflicts(db) {
    return (await db.query(`SELECT c.id, c.created_at, c.existing_type, c.existing_id, c.field, c.existing_value, c.new_value, c.explanation,
            c.classification, c.version, cc.source_quote AS new_source_quote
       FROM conflict c JOIN capture_candidate cc ON cc.id = c.candidate_id
      WHERE c.status = 'open' ORDER BY c.created_at`)).rows;
}
export async function pendingProposals(db) {
    return (await db.query(`SELECT id, created_at, kind, target_type, target_id, current_text, proposed_text, rationale, classification, version
       FROM proposal WHERE status = 'pending' AND archived_at IS NULL ORDER BY created_at`)).rows;
}
export async function approvalStatus(db, id) {
    return (await db.query(`SELECT id, action, status, requested_at, expires_at, decided_at FROM governance_request WHERE id = $1`, [id])).rows[0] ?? null;
}
export async function currentCharter(db) {
    const charter = (await db.query(`SELECT version, body, effective_at FROM charter ORDER BY version DESC LIMIT 1`)).rows[0] ?? null;
    const prefs = (await db.query(`SELECT DISTINCT ON (key) key, statement, scope, version FROM preference WHERE archived_at IS NULL ORDER BY key, version DESC`)).rows;
    return { charter, preferences: prefs };
}
//# sourceMappingURL=queries.js.map