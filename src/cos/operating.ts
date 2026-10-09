/**
 * Phase 3 (ADR-079) — the employee layer as Julian talks about it: names, never UUIDs.
 *
 *   AREA → OBJECTIVE → PROJECT → (work items / follow-ups = next actions)
 *
 * Existing records are linked, never duplicated: an existing project named "Altarum" is attached to Career; a
 * project is created only when none matches. "Waiting on" is STRUCTURED follow-up state (never an inbox keyword
 * search). Area health is green/yellow/red with the exact reasons, so "why is Career yellow?" has an answer.
 */
import type pg from "pg";
import { appendEvent, withTransaction } from "../db/index.js";
import { areaHealth } from "./areas.js";
import { sweepOverdue } from "./followups.js";

type Db = Pick<pg.Pool, "query">;
export type Color = "green" | "yellow" | "red";

const clean = (s: string) => s.trim().replace(/\s+/g, " ");

/** Resolve by name: exact (case-insensitive) → unique prefix/contains. Returns candidates when ambiguous. */
async function byName(db: Db, table: "area" | "project" | "objective", name: string, extra = ""): Promise<{ row: Record<string, unknown> | null; candidates: string[] }> {
  const n = clean(name);
  const live = table === "objective" ? "status <> 'abandoned'" : "archived_at IS NULL";
  const exact = await db.query(`SELECT * FROM ${table} WHERE ${live} AND lower(name) = lower($1) ${extra} LIMIT 2`, [n]);
  if (exact.rows.length === 1) return { row: exact.rows[0], candidates: [] };
  const like = await db.query(`SELECT * FROM ${table} WHERE ${live} AND name ILIKE $1 ${extra} ORDER BY length(name) LIMIT 5`, [`%${n}%`]);
  if (like.rows.length === 1) return { row: like.rows[0], candidates: [] };
  return { row: null, candidates: like.rows.map((r) => String(r.name)) };
}

export async function ensureArea(pool: pg.Pool, name: string, description?: string): Promise<{ id: string; name: string; created: boolean }> {
  const found = await byName(pool, "area", name);
  if (found.row && String(found.row.name).toLowerCase() === clean(name).toLowerCase()) return { id: String(found.row.id), name: String(found.row.name), created: false };
  return withTransaction(pool, async (tx) => {
    const r = await tx.query(`INSERT INTO area (name, description) VALUES ($1, $2) RETURNING id, name`, [clean(name).slice(0, 200), description ?? null]);
    await appendEvent(tx, { actor: "julian", action: "area_created", entityType: "area", entityId: r.rows[0].id, after: { name: r.rows[0].name } });
    return { id: r.rows[0].id, name: r.rows[0].name, created: true };
  });
}

/** The area named, or — when Julian names none — the only active area. */
export async function resolveArea(db: Db, name?: string | null): Promise<{ id: string; name: string } | { error: string }> {
  if (name) {
    const f = await byName(db, "area", name);
    if (f.row) return { id: String(f.row.id), name: String(f.row.name) };
    return { error: f.candidates.length ? `Which area: ${f.candidates.join(", ")}?` : `There is no area called "${name}" yet.` };
  }
  const all = (await db.query(`SELECT id, name FROM area WHERE archived_at IS NULL AND status = 'active' ORDER BY name`)).rows;
  if (all.length === 1) return { id: String(all[0].id), name: String(all[0].name) };
  return { error: all.length ? `Which area: ${all.map((a) => a.name).join(", ")}?` : "There are no areas yet — create one first (e.g. Career)." };
}

export async function setObjective(pool: pg.Pool, areaName: string | null, objective: string, targetDate?: string | null) {
  const a = await resolveArea(pool, areaName);
  if ("error" in a) return a;
  const dup = await byName(pool, "objective", objective, `AND area_id = '${a.id}'`);
  if (dup.row) return { area: a.name, objective: String(dup.row.name), created: false };
  return withTransaction(pool, async (tx) => {
    const r = await tx.query(`INSERT INTO objective (area_id, name, target_date) VALUES ($1, $2, $3) RETURNING id, name`, [a.id, clean(objective).slice(0, 300), targetDate ?? null]);
    await appendEvent(tx, { actor: "julian", action: "objective_set", entityType: "objective", entityId: r.rows[0].id, after: { area: a.name, name: r.rows[0].name } });
    return { area: a.name, objective: r.rows[0].name as string, created: true };
  });
}

/** "Altarum belongs under Career": link an existing project (or create it), optionally to an objective. */
export async function placeUnderArea(pool: pg.Pool, item: string, areaName: string, objectiveName?: string | null) {
  const a = await resolveArea(pool, areaName);
  if ("error" in a) return a;
  let objectiveId: string | null = null;
  if (objectiveName) {
    const o = await byName(pool, "objective", objectiveName, `AND area_id = '${a.id}'`);
    if (!o.row) return { error: `No objective "${objectiveName}" in ${a.name}${o.candidates.length ? ` (did you mean ${o.candidates.join(", ")}?)` : ""}.` };
    objectiveId = String(o.row.id);
  } else {
    const only = (await pool.query(`SELECT id FROM objective WHERE area_id = $1 AND status = 'open'`, [a.id])).rows;
    if (only.length === 1) objectiveId = String(only[0].id);
  }
  const p = await byName(pool, "project", item, "AND NOT is_unassigned_holding");
  if (!p.row && p.candidates.length > 1) return { error: `Which project: ${p.candidates.join(", ")}?` };
  return withTransaction(pool, async (tx) => {
    let id: string, created = false, name: string;
    if (p.row) { id = String(p.row.id); name = String(p.row.name); }
    else {
      const r = await tx.query(`INSERT INTO project (name, last_activity_at) VALUES ($1, now()) RETURNING id, name`, [clean(item).slice(0, 200)]);
      id = r.rows[0].id; name = r.rows[0].name; created = true;
      await appendEvent(tx, { actor: "julian", action: "create", entityType: "project", entityId: id, after: { name, via: "place_under_area" } });
    }
    await tx.query(`UPDATE project SET area_id = $2, objective_id = COALESCE($3, objective_id), updated_at = now(), version = version + 1 WHERE id = $1`, [id, a.id, objectiveId]);
    await tx.query(`UPDATE followup SET area_id = $2 WHERE project_id = $1 AND area_id IS NULL`, [id, a.id]);
    await appendEvent(tx, { actor: "julian", action: "project_placed", entityType: "project", entityId: id, after: { area: a.name, objectiveId } });
    return { project: name, area: a.name, projectCreated: created, linkedToObjective: !!objectiveId };
  });
}

/** Parse "2026-10-20", "tomorrow", "in 5 days", "next week", "friday". */
export function parseDue(text: string | null | undefined, now = new Date()): Date | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  const iso = Date.parse(t); if (/^\d{4}-\d{2}-\d{2}/.test(t) && !Number.isNaN(iso)) return new Date(iso);
  const day = 86_400_000;
  if (t === "today") return new Date(now.getTime());
  if (t === "tomorrow") return new Date(now.getTime() + day);
  const m = /^in (\d+) (day|days|week|weeks)$/.exec(t); if (m) return new Date(now.getTime() + Number(m[1]) * (m[2]!.startsWith("week") ? 7 : 1) * day);
  if (t === "next week") return new Date(now.getTime() + 7 * day);
  const wd = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(t.replace(/^(next|this) /, ""));
  if (wd >= 0) { const d = new Date(now); const diff = ((wd - d.getDay() + 7) % 7) || 7; return new Date(d.getTime() + diff * day); }
  return null;
}

/** "I'm waiting on Beth (about Altarum)". Default due: 5 days. Attaches to the project/area when named. */
export async function addWaiting(pool: pg.Pool, input: { counterparty: string; about?: string | null; project?: string | null; area?: string | null; due?: string | null; channel?: string | null; now?: Date }) {
  const now = input.now ?? new Date();
  let projectId: string | null = null, areaId: string | null = null, projectName: string | null = null;
  const projectHint = input.project ?? input.about ?? null;
  if (projectHint) {
    const p = await byName(pool, "project", projectHint, "AND NOT is_unassigned_holding");
    if (p.row) { projectId = String(p.row.id); projectName = String(p.row.name); areaId = (p.row.area_id as string) ?? null; }
  }
  if (input.area) { const a = await resolveArea(pool, input.area); if (!("error" in a)) areaId = a.id; }
  const due = parseDue(input.due, now) ?? new Date(now.getTime() + 5 * 86_400_000);
  const summary = `Waiting on ${clean(input.counterparty)}${input.about ? ` — ${clean(input.about)}` : projectName ? ` — ${projectName}` : ""}`;
  return withTransaction(pool, async (tx) => {
    const r = await tx.query(`INSERT INTO followup (summary, counterparty, channel, state, due_at, last_action_at, area_id, project_id)
       VALUES ($1, $2, $3, 'waiting', $4, now(), $5, $6) RETURNING id, summary, due_at`, [summary.slice(0, 2000), clean(input.counterparty), input.channel ?? null, due, areaId, projectId]);
    await appendEvent(tx, { actor: "julian", action: "followup_created", entityType: "followup", entityId: r.rows[0].id, after: { summary, counterparty: input.counterparty, due } });
    return { summary, counterparty: clean(input.counterparty), project: projectName, due: due.toISOString().slice(0, 10), linkedToArea: !!areaId };
  });
}

/** Close the open follow-up(s) with this counterparty (Beth replied / done). */
export async function resolveWaiting(pool: pg.Pool, counterparty: string, outcome: string) {
  const rows = (await pool.query(`SELECT id, summary FROM followup WHERE state IN ('open','waiting','overdue') AND (counterparty ILIKE $1 OR summary ILIKE $1) ORDER BY created_at`, [`%${clean(counterparty)}%`])).rows;
  if (!rows.length) return { error: `Nothing open is waiting on "${counterparty}".` };
  await withTransaction(pool, async (tx) => {
    for (const r of rows) {
      await tx.query(`UPDATE followup SET state = 'done', outcome = $2, closed_at = now(), updated_at = now() WHERE id = $1`, [r.id, outcome.slice(0, 2000)]);
      await appendEvent(tx, { actor: "julian", action: "followup_done", entityType: "followup", entityId: r.id, after: { outcome: outcome.slice(0, 200) } });
    }
  });
  return { closed: rows.map((r) => r.summary as string) };
}

/** What Julian is waiting on — structured state only. */
export async function waitingOn(pool: pg.Pool, areaName?: string | null, now = new Date()) {
  await sweepOverdue(pool, now);
  let areaId: string | null = null;
  if (areaName) { const a = await resolveArea(pool, areaName); if ("error" in a) return a; areaId = a.id; }
  const rows = (await pool.query(
    `SELECT f.summary, f.counterparty, f.state, f.due_at, f.last_action_at, f.created_at, p.name AS project, a.name AS area
       FROM followup f LEFT JOIN project p ON p.id = f.project_id LEFT JOIN area a ON a.id = COALESCE(f.area_id, p.area_id)
      WHERE f.state IN ('open','waiting','overdue') AND ($1::uuid IS NULL OR COALESCE(f.area_id, p.area_id) = $1)
      ORDER BY (f.state = 'overdue') DESC, f.due_at NULLS LAST`, [areaId])).rows;
  const day = 86_400_000;
  return {
    source: "Finagai follow-ups (structured state; not an inbox search)",
    count: rows.length,
    items: rows.map((r) => ({
      waitingOn: r.counterparty, about: r.summary, project: r.project, area: r.area, state: r.state,
      // Authority model: a wait is Finagai's to watch; Julian acts only on overdue items or ones that need his decision.
      watchedBy: "Finagai",
      sinceDays: Math.floor((now.getTime() - new Date(r.last_action_at ?? r.created_at).getTime()) / day),
      due: r.due_at ? new Date(r.due_at).toISOString().slice(0, 10) : null,
      overdueDays: r.state === "overdue" && r.due_at ? Math.floor((now.getTime() - new Date(r.due_at).getTime()) / day) : 0,
    })),
    note: rows.length ? null : "Nothing is tracked as waiting. Tell me who you're waiting on (\"I'm waiting on Beth about Altarum\") and I'll track it.",
  };
}

/** Green/yellow/red with every reason. Red = service-level breach; yellow = early warning; green = none. */
export async function areaStatus(pool: pg.Pool, areaName?: string | null, now = new Date()) {
  const a = await resolveArea(pool, areaName);
  if ("error" in a) return a;
  await sweepOverdue(pool, now);
  const h = (await areaHealth(pool, a.id))!;
  const day = 86_400_000;
  const warnings: string[] = [];
  const objectives = (await pool.query(`SELECT o.name, o.target_date,
      (SELECT count(*) FROM project p WHERE p.objective_id = o.id AND p.archived_at IS NULL AND p.status = 'active') AS projects
      FROM objective o WHERE o.area_id = $1 AND o.status = 'open'`, [a.id])).rows;
  if (!objectives.length) warnings.push("no open objective — what is this area trying to achieve?");
  for (const o of objectives) {
    if (Number(o.projects) === 0) warnings.push(`objective "${o.name}" has no active project behind it`);
    if (o.target_date && new Date(o.target_date).getTime() - now.getTime() < 14 * day) warnings.push(`objective "${o.name}" target date ${new Date(o.target_date).toISOString().slice(0, 10)} is within 14 days`);
  }
  const fus = (await pool.query(`SELECT f.counterparty, f.summary, f.state, f.due_at, f.last_action_at FROM followup f LEFT JOIN project p ON p.id = f.project_id
      WHERE COALESCE(f.area_id, p.area_id) = $1 AND f.state IN ('open','waiting')`, [a.id])).rows;
  for (const f of fus) {
    if (f.due_at && new Date(f.due_at).getTime() - now.getTime() < 2 * day) warnings.push(`waiting on ${f.counterparty ?? "someone"} is due ${new Date(f.due_at).toISOString().slice(0, 10)} (within 48h)`);
    else if (f.last_action_at && now.getTime() - new Date(f.last_action_at).getTime() > 7 * day) warnings.push(`no movement on "${f.summary}" for ${Math.floor((now.getTime() - new Date(f.last_action_at).getTime()) / day)} days`);
  }
  const color: Color = h.breaches.length ? "red" : warnings.length ? "yellow" : "green";
  return { area: a.name, color, breaches: h.breaches, warnings, objectives: objectives.map((o) => o.name), openProjects: h.openProjects, followupsOpen: h.followupsOpen, followupsOverdue: h.followupsOverdue,
    why: color === "green" ? "every service level is met and nothing is close to slipping" : [...h.breaches, ...warnings].join("; ") };
}

/**
 * Executive brief, management-by-exception order (Phase 3E / Phase 7):
 * 1 decisions for Julian · 2 blocked work · 3 important changes · 4 deadlines/risk · 5 what Finagai completed · 6 the rest, compressed.
 */
export async function executiveBriefV2(pool: pg.Pool, now = new Date()) {
  await sweepOverdue(pool, now);
  const day = 86_400_000;
  const decisions: string[] = [];
  for (const t of (await pool.query(`SELECT code, awaiting_kind, awaiting_reason, expires_at FROM control_task WHERE status IN ('waiting_approval','paused') ORDER BY awaiting_since NULLS LAST LIMIT 10`)).rows)
    decisions.push(`Mac task ${t.code}: ${t.awaiting_reason ?? t.awaiting_kind ?? "waiting for you"}${t.expires_at ? ` (expires ${new Date(t.expires_at).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}`);
  for (const g of (await pool.query(`SELECT action, count(*)::int AS n FROM governance_request WHERE status = 'pending' AND expires_at > now() GROUP BY action`)).rows)
    decisions.push(`${g.n} pending approval(s): ${String(g.action).replace(/_/g, " ")}`);
  for (const p of (await pool.query(`SELECT count(*)::int AS n FROM proposal WHERE status = 'pending'`).catch(() => ({ rows: [{ n: 0 }] }))).rows) if (p.n) decisions.push(`${p.n} pending proposal(s) to review`);
  // Phase 4 (ADR-082): next steps the lifecycle assigned to Julian (decide on a nudge, answer an offer, finish an
  // application) and anything the last Career sync could not decide on its own.
  for (const f of (await pool.query(`SELECT summary, due_at FROM followup WHERE origin = 'lifecycle' AND state IN ('open','overdue')
      AND rule IN ('applied.nudge_or_let_go','interviewing.nudge','offer.respond','preparing.submit') ORDER BY due_at LIMIT 8`)).rows)
    decisions.push(`${f.summary} (by ${new Date(f.due_at).toISOString().slice(0, 10)})`);
  const sync = (await pool.query(`SELECT after FROM event WHERE action = 'career_synced' AND occurred_at > now() - interval '48 hours' AND (after->>'dryRun')::boolean IS NOT TRUE ORDER BY occurred_at DESC LIMIT 1`)).rows[0]?.after as { decisions?: string[] } | undefined;
  for (const d of (sync?.decisions ?? []).slice(0, 5)) decisions.push(`Career: ${d}`);

  const blocked: string[] = [];
  for (const f of (await pool.query(`SELECT counterparty, summary, due_at FROM followup WHERE state = 'overdue' ORDER BY due_at LIMIT 10`)).rows)
    blocked.push(`Overdue: ${f.summary} (due ${new Date(f.due_at).toISOString().slice(0, 10)})`);
  // Needs-review results are blocked work; expired waits are a CHANGE (compressed), not a decision — live: five
  // days-old test tasks crowded the brief as "5 things need you".
  for (const t of (await pool.query(`SELECT code, result_summary FROM control_task WHERE verification_status = 'needs_review' AND updated_at > now() - interval '3 days' LIMIT 5`)).rows)
    blocked.push(`Task ${t.code} needs your review: ${String(t.result_summary ?? "").slice(0, 140)}`);
  const exp = (await pool.query(`SELECT array_agg(code ORDER BY code) AS codes FROM control_task WHERE status = 'expired' AND updated_at > now() - interval '3 days'`)).rows[0]?.codes as string[] | null;
  const areas = (await pool.query(`SELECT name FROM area WHERE archived_at IS NULL AND status = 'active' ORDER BY name`)).rows;
  const health = [];
  for (const a of areas) { const s = await areaStatus(pool, a.name as string, now); if (!("error" in s)) health.push(s); }
  for (const s of health) if (s.color === "red") blocked.push(`${s.area} is RED: ${s.breaches.join("; ")}`);

  const changes: string[] = [];
  if (exp?.length) changes.push(`${exp.length} stale Mac task(s) expired unanswered (${exp.join(", ")}) — say "resume <code>" only if still wanted`);
  for (const e of (await pool.query(`SELECT action, after FROM event WHERE action IN ('followup_done','area_created','objective_set','project_placed') AND occurred_at > now() - interval '48 hours' ORDER BY occurred_at DESC LIMIT 8`)).rows)
    changes.push(`${String(e.action).replace(/_/g, " ")}${e.after?.outcome ? `: ${e.after.outcome}` : e.after?.name ? `: ${e.after.name}` : ""}`);
  // Job pipeline movement (evidence or Julian): status changes per job, and projects the lifecycle closed.
  for (const e of (await pool.query(`SELECT ev.before, ev.after, o.org, o.title, o.requisition_id FROM event ev JOIN opportunity o ON o.id = ev.entity_id
      WHERE ev.action = 'opportunity_status' AND ev.occurred_at > now() - interval '48 hours' ORDER BY ev.occurred_at DESC LIMIT 10`)).rows)
    changes.push(`${e.org} — ${e.title}${e.requisition_id ? ` (${e.requisition_id})` : ""}: ${e.before?.status ?? "?"} → ${e.after?.status ?? "?"}`);
  const closedProjects = (await pool.query(`SELECT count(*)::int AS n FROM event WHERE action = 'project_completed' AND occurred_at > now() - interval '48 hours'`)).rows[0]?.n ?? 0;
  if (closedProjects) changes.push(`${closedProjects} job project(s) closed by the lifecycle (rejected, withdrawn, or no response and nobody to nudge — they stay in the pipeline)`);

  const risks: string[] = [];
  for (const f of (await pool.query(`SELECT counterparty, summary, due_at FROM followup WHERE state IN ('open','waiting') AND due_at < now() + interval '3 days' ORDER BY due_at LIMIT 8`)).rows)
    risks.push(`${f.summary} due ${new Date(f.due_at).toISOString().slice(0, 10)}`);
  for (const s of health) if (s.color === "yellow") risks.push(`${s.area} is yellow: ${s.warnings.slice(0, 2).join("; ")}`);

  const completed = (await pool.query(`SELECT origin_message, verification_status FROM interaction WHERE state = 'completed' AND completed_at > now() - interval '24 hours' ORDER BY completed_at DESC LIMIT 6`)).rows
    .map((r) => `${String(r.origin_message ?? "").slice(0, 80)}${r.verification_status && r.verification_status !== "verified" ? ` (${r.verification_status})` : ""}`);

  const rest = { areas: health.map((s) => `${s.area}: ${s.color}`), waitingOpen: Number((await pool.query(`SELECT count(*)::int AS n FROM followup WHERE state IN ('open','waiting')`)).rows[0].n) };
  const headline = decisions.length + blocked.length === 0 ? "Nothing needs you right now." : `${decisions.length + blocked.length} thing(s) need you.`;
  return { generatedAt: now.toISOString(), headline, decisions, blocked, changes, risks, completed, rest };
}
