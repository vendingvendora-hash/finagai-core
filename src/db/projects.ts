import type { Queryable } from "./pool.js";

export interface ProjectRow {
  id: string;
  name: string;
  status: "active" | "paused" | "completed";
  priority: number | null;
  is_unassigned_holding: boolean;
  version: number;
}

/** The G10 holding project, created by migration 0004. */
export async function getUnassignedProject(db: Queryable): Promise<ProjectRow> {
  const res = await db.query<ProjectRow>(
    `SELECT id, name, status, priority, is_unassigned_holding, version
       FROM project WHERE is_unassigned_holding AND archived_at IS NULL`,
  );
  const row = res.rows[0];
  if (!row) throw new Error("Unassigned holding project is missing; run migrations");
  return row;
}
