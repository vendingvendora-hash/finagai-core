/**
 * The single event writer (AR05). Every change to Finagai's state is recorded through this
 * function, in the same transaction as the change. Events are append-only at the database level.
 */
import type { Queryable } from "./pool.js";
import { currentCause } from "./live-context.js";

export type EventActor = "julian" | "j2" | "j3" | "seed" | "job" | "migration" | "system" | "j6" | "cos";

export interface NewEvent {
  actor: EventActor;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  captureId?: string;
  requestId?: string;
  client?: string;
  /** Only set by the approval flow (ADR-019, ADR-030); requires principal. */
  approvalId?: string;
  principal?: string;
  /** ADR-087 causal context; defaults come from the surrounding withCause() (explicit values win). */
  correlationId?: string;
  causeIds?: number[];
  areaId?: string | null;
}

export async function appendEvent(db: Queryable, e: NewEvent): Promise<number> {
  const ctx = currentCause();
  const res = await db.query<{ id: string }>(
    `INSERT INTO event (actor, action, entity_type, entity_id, before, after, reason,
                        capture_id, request_id, client, approval_id, principal, correlation_id, cause_ids, area_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      e.actor, e.action, e.entityType ?? null, e.entityId ?? null,
      e.before === undefined || e.before === null ? null : JSON.stringify(e.before), // absent means SQL NULL, never JSON null
      e.after === undefined || e.after === null ? null : JSON.stringify(e.after),
      e.reason ?? null, e.captureId ?? null, e.requestId ?? null, e.client ?? null,
      e.approvalId ?? null, e.principal ?? null,
      e.correlationId ?? ctx?.correlationId ?? null,
      (e.causeIds ?? ctx?.causeIds)?.length ? (e.causeIds ?? ctx!.causeIds)! : null,
      e.areaId !== undefined ? e.areaId : ctx?.areaId ?? null,
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error("event insert returned no id");
  return Number(id);
}
