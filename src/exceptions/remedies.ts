/**
 * Phase 7 (ADR-086) — Finagai-owned remedies. Each only re-runs Finagai's own internal machinery; none sends,
 * submits, approves, spends or touches credentials. Returns a one-line result for the exception record.
 */
import type pg from "pg";
import { inTx, lifecycleTick } from "../cos/opportunities.js";
import type { Detected } from "./detectors.js";

type Remedy = (pool: pg.Pool, now: Date, d: Detected) => Promise<string>;

/** Requeue dead-lettered events whose workflow has succeeded since they gave up (the cause is gone). */
const requeueDeadEvents: Remedy = async (pool) => {
  const dead = (await pool.query(`SELECT id, routes, handled_at, received_at FROM inbound_event WHERE status = 'failed' AND attempts >= 5`)).rows;
  if (!dead.length) return "nothing to requeue";
  const lastOk = new Map<string, Date>();
  for (const t of (await pool.query(`SELECT started_at, stats FROM event_tick WHERE status = 'done' AND stats ? 'workflows' ORDER BY started_at DESC LIMIT 200`)).rows)
    for (const w of (t.stats.workflows ?? []) as Array<{ name: string; ok: boolean }>) if (w.ok && !lastOk.has(w.name)) lastOk.set(w.name, new Date(t.started_at));
  const ready = dead.filter((e) => (e.routes as Array<{ workflow: string }>).length > 0
    && (e.routes as Array<{ workflow: string }>).every((r) => { const ok = lastOk.get(r.workflow); return !!ok && ok > new Date(e.received_at); }));
  if (!ready.length) return `${dead.length} still dead: their workflow has not succeeded since`;
  await pool.query(`UPDATE inbound_event SET status = 'new', attempts = 0, reason = 'requeued: its workflow works again' WHERE id = ANY($1::uuid[])`, [ready.map((e) => e.id)]);
  return `requeued ${ready.length} of ${dead.length}`;
};

/** Re-run the Area's lifecycle reconciliation (gives every engaged item its next step, closes what should close). */
const reconcileArea: Remedy = async (pool, now, d) => {
  if (!d.areaId) return "no area";
  const r = await inTx(pool, false, (tx) => lifecycleTick(tx, now, { areaId: d.areaId! }));
  return `reconciled ${r.jobsChecked} item(s), ${r.changes.length} change(s)`;
};

export const REMEDIES: Record<string, Remedy> = { requeue_dead_events: requeueDeadEvents, reconcile_area: reconcileArea };
