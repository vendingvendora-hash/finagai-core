/**
 * Phase 5 (ADR-084) — the event engine's contracts. Generic: an Area plugs in watchers, subscriptions and workflows;
 * the engine owns recording, idempotency, routing, batching, escalation and notification.
 */
import type pg from "pg";
import type { GoogleSearch } from "../resources/retrieve.js";

export interface RawEvent {
  source: string;            // 'gmail' | 'calendar' | 'sheet' | 'deadline' | …
  kind: string;              // 'mail.received' | 'calendar.upcoming' | 'sheet.changed' | 'followup.due_soon' | 'followup.overdue'
  externalId: string;        // idempotency key within the source
  occurredAt: string;
  summary: string;
  payload: Record<string, unknown>;
}
export interface StoredEvent extends RawEvent { id: string; status: string }

export interface EngineCtx {
  pool: pg.Pool;
  google?: GoogleSearch | undefined;
  now: Date;
  dryRun: boolean;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface Watcher {
  name: string;
  /** Minimum interval between polls (the engine polls a watcher only when it is due). */
  everyMs: number;
  poll(ctx: EngineCtx, cursors: Map<string, string>): Promise<{ events: RawEvent[]; cursors: Array<{ scope: string; cursor: string }>; problems: string[] }>;
}

export interface Subscription {
  id: string;
  area: string;                // the Area that owns the reaction ('*' = whichever Area the item belongs to)
  workflow: string;
  /** Returns WHY this event concerns the subscription, or null. Deterministic; may read state. */
  match(e: StoredEvent, ctx: EngineCtx): Promise<string | null>;
}

/** Something only Julian can do — escalated once, resolved automatically when its source item closes. */
export interface EscalationNeed {
  key: string;
  /** 'requested' = a notification Julian asked for ("tell me when …"): not a decision, not a task */
  needs: "judgment" | "authorization" | "principal_reserved" | "requested";
  summary: string;
  detail?: string;
  areaId?: string | null;
  followupId?: string | null;
  dueAt?: string | null;
  /** ADR-087: the stored events that caused this need (resolved from the source item when omitted). */
  causeIds?: number[];
  /** Phase 8 (ADR-088): the object a workflow-raised need is about; the need resolves itself when that object moves on */
  subject?: { type: string; id: string } | null;
  /** ADR-089 hotfix 45: Julian was already prompted elsewhere (the Mac helper in Messages) — recorded as notified, never emailed again */
  prompted?: boolean;
}

export interface WorkflowResult { changes: string[]; escalations: EscalationNeed[] }
export interface Workflow {
  name: string;
  /** Runs ONCE per tick with every event routed to it (batching: ten new emails = one sync). */
  run(ctx: EngineCtx, events: StoredEvent[]): Promise<WorkflowResult>;
}

export interface AreaModule { watchers: Watcher[]; subscriptions: Subscription[]; workflows: Workflow[] }
