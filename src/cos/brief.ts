/**
 * Executive brief (product mandate §15) + management-by-exception (§6). Compresses Julian's operational
 * world into: what changed, what Finagai completed, what needs attention, what needs Julian. Reads the
 * cos entities (areas, follow-ups) and recent events; makes no model call (deterministic, cheap, fast).
 */
import type pg from "pg";
import { areaHealth, listAreas } from "./areas.js";
import { openFollowups, sweepOverdue } from "./followups.js";

export interface ExecutiveBrief {
  generatedAt: string;
  completed: Array<{ what: string; at: string }>;        // what Finagai did recently (from events)
  needsAttention: string[];                               // exceptions Finagai surfaces (overdue, no next action)
  needsJulian: Array<{ what: string; ref?: string }>;     // decisions/approvals reserved for Julian
  areaHealth: Array<{ name: string; healthy: boolean; breaches: string[] }>;
}

/** Build the brief. Sweeps overdue follow-ups first so the picture is current. */
export async function executiveBrief(pool: pg.Pool): Promise<ExecutiveBrief> {
  await sweepOverdue(pool);

  // What Finagai completed recently (cos/j6 actions that represent finished work), last 24h, capped.
  const completedRows = (await pool.query(
    `SELECT action, entity_type, occurred_at FROM event
     WHERE actor IN ('cos','j6') AND action IN ('followup_done','control_task_done','area_created','followup_created')
       AND occurred_at > now() - interval '24 hours'
     ORDER BY occurred_at DESC LIMIT 20`)).rows;
  const completed = completedRows.map((r) => ({ what: `${String(r.action).replace(/_/g, " ")} (${r.entity_type})`, at: new Date(r.occurred_at).toISOString() }));

  // Needs attention: overdue follow-ups + area service-level breaches.
  const needsAttention: string[] = [];
  const overdue = (await openFollowups(pool)).filter((f) => f.state === "overdue");
  for (const f of overdue.slice(0, 20)) needsAttention.push(`Overdue: ${f.summary}${f.counterparty ? ` (waiting on ${f.counterparty})` : ""}`);

  const health: ExecutiveBrief["areaHealth"] = [];
  for (const a of await listAreas(pool)) {
    const h = await areaHealth(pool, a.id);
    if (!h) continue;
    health.push({ name: h.name, healthy: h.healthy, breaches: h.breaches });
    for (const b of h.breaches) needsAttention.push(`${h.name}: ${b}`);
  }

  // Needs Julian: pending governance requests + pending control-step approvals (reserved decisions).
  const needsJulian: ExecutiveBrief["needsJulian"] = [];
  const gov = (await pool.query(`SELECT id, action FROM governance_request WHERE status = 'pending' LIMIT 20`)).rows;   // was "kind" (no such column), hidden by a catch
  for (const g of gov) needsJulian.push({ what: `Approve ${String(g.action).replace(/_/g, " ")}`, ref: String(g.id) });
  const steps = (await pool.query(`SELECT code FROM control_step WHERE status = 'proposed' LIMIT 20`).catch(() => ({ rows: [] }))).rows;
  for (const s of steps) needsJulian.push({ what: `Approve Mac step ${s.code} (reply ok ${s.code})` });

  return { generatedAt: new Date().toISOString(), completed, needsAttention, needsJulian, areaHealth: health };
}

/** Render the brief as the message Julian reads (iMessage / chat). */
export function renderBrief(b: ExecutiveBrief): string {
  const lines: string[] = ["📋 Executive brief"];
  lines.push(`\nWhat Finagai completed (24h): ${b.completed.length}`);
  for (const c of b.completed.slice(0, 8)) lines.push(`  • ${c.what}`);
  lines.push(`\nWhat needs attention: ${b.needsAttention.length}`);
  for (const n of b.needsAttention.slice(0, 10)) lines.push(`  ⚠ ${n}`);
  lines.push(`\nWhat needs you: ${b.needsJulian.length}`);
  b.needsJulian.slice(0, 10).forEach((j, i) => lines.push(`  ${i + 1}. ${j.what}`));
  if (!b.needsAttention.length && !b.needsJulian.length) lines.push("\nAll areas healthy; nothing needs you right now.");
  return lines.join("\n");
}
