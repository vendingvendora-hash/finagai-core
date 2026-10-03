import { appendEvent, withTransaction } from "../db/index.js";
export async function createArea(pool, input) {
    return withTransaction(pool, async (tx) => {
        const r = await tx.query(`INSERT INTO area (name, description, policy) VALUES ($1,$2,$3) RETURNING *`, [input.name.slice(0, 200), input.description ?? null, JSON.stringify(input.policy ?? {})]);
        const row = r.rows[0];
        await appendEvent(tx, { actor: "cos", action: "area_created", entityType: "area", entityId: row.id, after: { name: row.name } });
        return { id: row.id, name: row.name, description: row.description, status: row.status, policy: row.policy };
    });
}
export async function listAreas(pool) {
    const r = await pool.query(`SELECT * FROM area WHERE status = 'active' ORDER BY name`);
    return r.rows.map((row) => ({ id: row.id, name: row.name, description: row.description, status: row.status, policy: row.policy }));
}
/** Compute health for one area against its service-level policy. Deterministic. */
export async function areaHealth(pool, areaId) {
    const a = (await pool.query(`SELECT id, name, policy FROM area WHERE id = $1`, [areaId])).rows[0];
    if (!a)
        return null;
    const policy = (a.policy ?? {});
    const openProjects = Number((await pool.query(`SELECT count(*) n FROM project WHERE area_id=$1 AND status='active' AND archived_at IS NULL`, [areaId])).rows[0].n);
    // "no next action" = active project in this area with no open task and no open follow-up
    const projectsNoNextAction = Number((await pool.query(`SELECT count(*) n FROM project p WHERE p.area_id=$1 AND p.status='active' AND p.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM work_item t WHERE t.project_id=p.id AND t.status IN ('open','in_progress','waiting'))
       AND NOT EXISTS (SELECT 1 FROM followup f WHERE f.project_id=p.id AND f.state IN ('open','waiting','overdue'))`, [areaId])).rows[0].n);
    const followupsOpen = Number((await pool.query(`SELECT count(*) n FROM followup WHERE area_id=$1 AND state IN ('open','waiting','overdue')`, [areaId])).rows[0].n);
    const followupsOverdue = Number((await pool.query(`SELECT count(*) n FROM followup WHERE area_id=$1 AND state='overdue'`, [areaId])).rows[0].n);
    const objectivesOpen = Number((await pool.query(`SELECT count(*) n FROM objective WHERE area_id=$1 AND status='open'`, [areaId])).rows[0].n);
    // service levels (configurable via area.policy); defaults encode the mandate's examples
    const maxOverdue = policy.max_followups_overdue ?? 0;
    const maxNoNextAction = policy.max_projects_without_next_action ?? 0;
    const breaches = [];
    if (followupsOverdue > maxOverdue)
        breaches.push(`${followupsOverdue} follow-up(s) overdue (limit ${maxOverdue})`);
    if (projectsNoNextAction > maxNoNextAction)
        breaches.push(`${projectsNoNextAction} project(s) with no next action (limit ${maxNoNextAction})`);
    return { areaId, name: a.name, openProjects, projectsNoNextAction, followupsOpen, followupsOverdue, objectivesOpen, healthy: breaches.length === 0, breaches };
}
//# sourceMappingURL=areas.js.map