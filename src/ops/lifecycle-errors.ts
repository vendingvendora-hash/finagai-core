/**
 * Phase 0E (ADR-076) — lifecycle failures are OBSERVABLE, never swallowed.
 *
 * The audit found `.catch(() => {})` on the reconciler, interaction completion and heartbeat sweeps, so a
 * failing reconciliation looked identical to "nothing to do". Every such path now reports through here:
 * a structured, sanitized console line plus an `event` row (action 'lifecycle_error'), surfaced by
 * execution_metrics. Reporting itself never throws and never blocks the user's work.
 */
import type pg from "pg";

type Db = Pick<pg.Pool, "query">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeError(err: unknown): string {
  const m = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return m.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/postgres(ql)?:\/\/\S+/gi, "postgres://[redacted]")
    .replace(/(token|secret|password|key)=\S+/gi, "$1=[redacted]").slice(0, 400);
}

export async function reportLifecycleError(db: Db, where: string, err: unknown, ref: { taskId?: string | null; interactionId?: string | null } = {}): Promise<void> {
  const detail = { where: where.slice(0, 80), error: sanitizeError(err), taskId: ref.taskId ?? null, interactionId: ref.interactionId ?? null };
  console.error(JSON.stringify({ level: "error", msg: "lifecycle_error", ...detail }));
  try {
    const entity = ref.taskId && UUID.test(ref.taskId) ? ref.taskId : ref.interactionId && UUID.test(ref.interactionId) ? ref.interactionId : null;
    await db.query(`INSERT INTO event (actor, action, entity_type, entity_id, after) VALUES ('system', 'lifecycle_error', $1, $2, $3::jsonb)`,
      [ref.taskId ? "control_task" : ref.interactionId ? "interaction" : "system", entity, JSON.stringify(detail)]);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "lifecycle_error_unrecorded", where, error: sanitizeError(e) }));
  }
}

/** `promise.catch(observed(pool, "where", ref))` — the replacement for `.catch(() => {})` on lifecycle paths. */
export function observed(db: Db, where: string, ref: { taskId?: string | null; interactionId?: string | null } = {}) {
  return (err: unknown) => reportLifecycleError(db, where, err, ref);
}

export async function recentLifecycleErrors(db: Db, hours = 24): Promise<Array<{ at: string; where: string; error: string; taskId: string | null }>> {
  const r = await db.query(`SELECT occurred_at, after FROM event WHERE action = 'lifecycle_error' AND occurred_at > now() - ($1 || ' hours')::interval ORDER BY occurred_at DESC LIMIT 20`, [String(hours)]);
  return r.rows.map((x: { occurred_at: Date; after: { where: string; error: string; taskId: string | null } }) =>
    ({ at: new Date(x.occurred_at).toISOString(), where: x.after.where, error: x.after.error, taskId: x.after.taskId }));
}
