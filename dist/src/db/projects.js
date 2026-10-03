/** The G10 holding project, created by migration 0004. */
export async function getUnassignedProject(db) {
    const res = await db.query(`SELECT id, name, status, priority, is_unassigned_holding, version
       FROM project WHERE is_unassigned_holding AND archived_at IS NULL`);
    const row = res.rows[0];
    if (!row)
        throw new Error("Unassigned holding project is missing; run migrations");
    return row;
}
//# sourceMappingURL=projects.js.map