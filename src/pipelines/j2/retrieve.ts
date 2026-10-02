/**
 * J2 step 5: retrieve up to 8 existing records per candidate with Postgres full-text search
 * ('simple' configuration, so Spanish and English are matched without English-only stemming).
 * Same project first. The returned IDs form the match set that G05 enforces.
 */
import type { Queryable } from "../../db/pool.js";
import type { Candidate } from "../../guards/extraction.js";

export interface MatchRow {
  id: string;
  table: "work_item" | "knowledge_item" | "entity" | "project";
  text: string;
  status: string | null;
  dueAt: Date | null;
  projectId: string | null;
  version: number;
}

const TABLE_FOR: Partial<Record<Candidate["item_type"], MatchRow["table"]>> = {
  task: "work_item", deadline: "work_item", follow_up: "work_item", decision: "work_item", blocker: "work_item",
  fact: "knowledge_item", correction: "knowledge_item", entity: "entity", project: "project",
};

export function tableFor(c: Candidate): MatchRow["table"] | null {
  return TABLE_FOR[c.item_type] ?? null;
}

/** OR-query of distinct word tokens (3+ characters), safe for to_tsquery. */
export function orQuery(text: string): string | null {
  const words = [...new Set((text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))].slice(0, 24);
  return words.length ? words.join(" | ") : null;
}

export function candidateSearchText(c: Candidate): string {
  return [c.fields.title, c.fields.claim, c.fields.name, c.fields.detail, c.source_quote].filter(Boolean).join(" ");
}

export async function retrieveMatches(db: Queryable, c: Candidate, projectId: string | null, limit = 8): Promise<MatchRow[]> {
  const table = tableFor(c);
  const q = orQuery(candidateSearchText(c));
  if (!table || !q) return [];
  const sql: Record<MatchRow["table"], string> = {
    work_item: `SELECT id, title AS text, status, due_at, project_id, version FROM work_item
                 WHERE archived_at IS NULL AND search @@ to_tsquery('simple', $1)
                 ORDER BY (project_id = $2) DESC NULLS LAST, ts_rank(search, to_tsquery('simple', $1)) DESC LIMIT $3`,
    knowledge_item: `SELECT id, claim AS text, status, NULL::timestamptz AS due_at,
                            CASE WHEN subject_type = 'project' THEN subject_id END AS project_id, version FROM knowledge_item
                      WHERE archived_at IS NULL AND status <> 'superseded' AND search @@ to_tsquery('simple', $1)
                      ORDER BY (subject_id = $2) DESC NULLS LAST, ts_rank(search, to_tsquery('simple', $1)) DESC LIMIT $3`,
    entity: `SELECT id, name AS text, NULL AS status, NULL::timestamptz AS due_at, NULL::uuid AS project_id, version FROM entity
              WHERE archived_at IS NULL AND search @@ to_tsquery('simple', $1) AND ($2::uuid IS NULL OR true)
              ORDER BY ts_rank(search, to_tsquery('simple', $1)) DESC LIMIT $3`,
    project: `SELECT id, name AS text, status, NULL::timestamptz AS due_at, id AS project_id, version FROM project
               WHERE archived_at IS NULL AND NOT is_unassigned_holding AND search @@ to_tsquery('simple', $1)
                 AND ($2::uuid IS NULL OR true)
               ORDER BY ts_rank(search, to_tsquery('simple', $1)) DESC LIMIT $3`,
  };
  const res = await db.query<{ id: string; text: string; status: string | null; due_at: Date | null; project_id: string | null; version: number }>(
    sql[table], [q, projectId, limit]);
  return res.rows.map((r) => ({ id: r.id, table, text: r.text, status: r.status, dueAt: r.due_at, projectId: r.project_id, version: r.version }));
}
