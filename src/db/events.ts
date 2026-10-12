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

/**
 * ADR-087 (hotfix 34): kinds of object whose events are STATE changes (src/db/state-events.ts STATE_TABLES maps every
 * state table onto one of these). A state-change event with no more specific cause cites the unit of work it happened
 * in (recorded once, lazily, as `work_invoked`); audit/telemetry events (tool calls, MCP traffic) never create one.
 */
export const STATE_ENTITY_TYPES = new Set(["area", "objective", "project", "work_item", "followup", "opportunity", "employer", "entity", "relationship", "knowledge_item",
  "conflict", "proposal", "governance_request", "escalation", "operating_exception", "watch_rule", "lesson", "control_task", "artifact", "review", "webauthn_credential"]);

/** Non-state objects whose events still read as work on the stream (a Mac task's steps, its artifacts' delivery). */
export const CAUSED_ENTITY_TYPES = new Set(["control_step", "control_task", "interaction", "artifact", "concierge_draft", "concierge_message"]);

/** The cause of a change made here: the unit of work's cause (e.g. its workflow run) ▸ the unit of work itself. */
export async function causeHere(db: Queryable): Promise<number[]> {
  const ctx = currentCause();
  if (ctx?.causeIds?.length) return ctx.causeIds;
  const root = ctx?.root;
  if (!root) return [];
  root.id ??= appendEvent(db, { actor: root.actor, action: "work_invoked", causeIds: [], after: { what: root.what, ...(root.detail ?? {}) } });
  return [await root.id];
}

export async function appendEvent(db: Queryable, e: NewEvent): Promise<number> {
  const ctx = currentCause();
  // ADR-087 / Phase 8: an event ABOUT something, appended inside a unit of work, cites that unit of work when it has no
  // more specific cause. Live (2026-10-12 21:04Z): Mac step proposals (entity control_step, shown on the stream as
  // task / authority events) carried no cause because only state-table entities were rooted — the hourly self-check
  // caught it. Tool-call audit rows (entity "tool") stay unrooted: a read-only tool call leaves no trace.
  if (e.causeIds === undefined && !ctx?.causeIds?.length && ctx?.root && e.entityType && (STATE_ENTITY_TYPES.has(e.entityType) || CAUSED_ENTITY_TYPES.has(e.entityType))) e = { ...e, causeIds: await causeHere(db) };
  const res = await db.query<{ id: string }>(
    `INSERT INTO finagai.event (actor, action, entity_type, entity_id, before, after, reason,
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
