/**
 * J3 steps 1-2 (implementation plan section 10): deterministic queries decide what the review MUST
 * contain. Every item carries a record ID; dates, statuses, and names come from the database.
 *
 * Must-mention set (G16): every overdue item, every open conflict, every blocker, every governance
 * decision since the last review, and every item due within 7 days whose priority (item or project)
 * is 1-2.
 */
import type { Queryable } from "../../db/pool.js";
import type { ReviewInput, ReviewItem } from "./degraded.js";

export interface CollectOptions {
  now: Date;
  timezone: string;
  stallThresholdDays: number;
  upcomingWindowDays: number;
  priorityUpcomingWindowDays: number;
  budget: { monthToDateUsd: number; targetUsd: number; ceilingUsd: number };
}

export interface CollectedReview extends ReviewInput {
  watermarkEventId: number;
  previousWatermarkEventId: number | null;
  /** IDs of disputed work items, mapped to their open conflict IDs (J3 validator, rule V5). */
  disputed: Record<string, string[]>;
}

const DAY = 86_400_000;
const days = (ms: number) => Math.floor(ms / DAY);

export async function collectReviewInput(db: Queryable, o: CollectOptions): Promise<CollectedReview> {
  const watermark = Number((await db.query<{ id: string | null }>(`SELECT max(id) AS id FROM event`)).rows[0]?.id ?? 0);
  const prev = (await db.query<{ watermark_event_id: string | null; period_end: Date }>(
    `SELECT watermark_event_id, period_end FROM review WHERE kind IN ('weekly','baseline')
      ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const prevWatermark = prev?.watermark_event_id ? Number(prev.watermark_event_id) : null;
  const periodStart = prev?.period_end ?? new Date(o.now.getTime() - 7 * DAY);
  const items: ReviewItem[] = [];
  const base = (over: Partial<ReviewItem> & Pick<ReviewItem, "id" | "section" | "title">): ReviewItem => ({
    mustMention: false, project: null, status: null, dueAt: null, waitingOn: null, daysSinceActivity: null, note: null, ...over,
  });

  // Open work items with their project context.
  const open = (await db.query<{
    id: string; kind: string; title: string; status: string; due_at: Date | null; priority: number | null; disputed: boolean;
    updated_at: Date; project: string; project_priority: number | null; is_unassigned_holding: boolean;
    upcoming_window_days: number | null; priority_upcoming_window_days: number | null; waiting_on: string | null;
  }>(
    `SELECT w.id, w.kind, w.title, w.status, w.due_at, w.priority, w.disputed, w.updated_at,
            p.name AS project, p.priority AS project_priority, p.is_unassigned_holding,
            p.upcoming_window_days, p.priority_upcoming_window_days, e.name AS waiting_on
       FROM work_item w JOIN project p ON p.id = w.project_id LEFT JOIN entity e ON e.id = w.waiting_on_entity_id
      WHERE w.archived_at IS NULL AND w.status IN ('open','in_progress','waiting') AND p.archived_at IS NULL`)).rows;

  for (const w of open) {
    const prio = Math.min(w.priority ?? 9, w.project_priority ?? 9);
    const highPriority = prio <= 2;
    const window = (highPriority ? w.priority_upcoming_window_days ?? o.priorityUpcomingWindowDays
      : w.upcoming_window_days ?? o.upcomingWindowDays) * DAY;
    const common = { id: w.id, title: w.title, project: w.is_unassigned_holding ? "Unassigned" : w.project, status: w.status, dueAt: w.due_at };
    const disputedNote = w.disputed ? "disputed: an open conflict affects this item" : null;
    if (w.due_at && w.due_at < o.now) {
      items.push(base({ ...common, section: "requires_attention", mustMention: true, note: disputedNote ?? `overdue by ${days(o.now.getTime() - w.due_at.getTime())} days` }));
    } else if (w.kind === "blocker") {
      items.push(base({ ...common, section: "requires_attention", mustMention: true, note: disputedNote ?? "blocker" }));
    } else if (w.status === "waiting" || w.waiting_on) {
      items.push(base({ ...common, section: "waiting", waitingOn: w.waiting_on, daysSinceActivity: days(o.now.getTime() - w.updated_at.getTime()), note: disputedNote }));
    } else if (w.due_at && w.due_at.getTime() - o.now.getTime() <= window) {
      const soon = w.due_at.getTime() - o.now.getTime() <= 7 * DAY;
      items.push(base({ ...common, section: soon && highPriority ? "requires_attention" : "upcoming", mustMention: soon && highPriority, note: disputedNote }));
    } else if (w.is_unassigned_holding) {
      items.push(base({ ...common, section: "fyi", note: "needs a project" }));
    } else {
      items.push(base({ ...common, section: "fyi", note: disputedNote }));
    }
  }

  // Completed since the last review.
  const done = (await db.query<{ id: string; title: string; project: string; completed_at: Date }>(
    `SELECT w.id, w.title, p.name AS project, w.completed_at FROM work_item w JOIN project p ON p.id = w.project_id
      WHERE w.status = 'done' AND w.completed_at > $1 AND w.archived_at IS NULL`, [periodStart])).rows;
  for (const d of done) items.push(base({ id: d.id, section: "project_changes", title: d.title, project: d.project, status: "done", note: "completed since the last review" }));

  // Material changes since the last review, per project (counts only; detail is in the items above).
  const changes = (await db.query<{ project_id: string; name: string; n: number }>(
    `SELECT p.id AS project_id, p.name, count(*)::int AS n
       FROM event ev JOIN work_item w ON w.id = ev.entity_id JOIN project p ON p.id = w.project_id
      WHERE ev.id > $1 AND ev.entity_type = 'work_item' AND ev.action IN ('create','update','status_change')
      GROUP BY p.id, p.name`, [prevWatermark ?? 0])).rows;
  for (const c of changes) {
    if (done.some((d) => d.project === c.name) && c.n <= 1) continue;
    items.push(base({ id: c.project_id, section: "project_changes", title: c.name, project: c.name, note: `${c.n} change${c.n === 1 ? "" : "s"} since the last review` }));
  }

  // Open conflicts (must mention) and the disputed-item map used by the validator.
  const conflicts = (await db.query<{ id: string; existing_type: string; existing_id: string; field: string; explanation: string; title: string | null }>(
    `SELECT c.id, c.existing_type, c.existing_id, c.field, c.explanation,
            coalesce(w.title, k.claim) AS title
       FROM conflict c LEFT JOIN work_item w ON w.id = c.existing_id LEFT JOIN knowledge_item k ON k.id = c.existing_id
      WHERE c.status = 'open'`)).rows;
  const disputed: Record<string, string[]> = {};
  for (const c of conflicts) {
    items.push(base({ id: c.id, section: "risks_conflicts", mustMention: true, title: `Conflict: ${c.title ?? c.existing_type}`, note: `open conflict on ${c.field}: ${c.explanation}` }));
    (disputed[c.existing_id] ??= []).push(c.id);
  }

  // Governance decisions since the last review (must mention).
  const decisions = (await db.query<{ id: string; action: string; status: string }>(
    `SELECT id, action, status FROM governance_request WHERE decided_at > $1 AND status IN ('executed','rejected')`, [periodStart])).rows;
  for (const g of decisions) items.push(base({ id: g.id, section: "project_changes", mustMention: true, title: `Governance decision: ${g.action.replace("_", " ")}`, status: g.status }));

  // Stalled projects and projects with no next action.
  const projects = (await db.query<{ id: string; name: string; last_activity_at: Date | null; created_at: Date; stall_threshold_days: number | null; open_items: number }>(
    `SELECT p.id, p.name, p.last_activity_at, p.created_at, p.stall_threshold_days,
            (SELECT count(*)::int FROM work_item w WHERE w.project_id = p.id AND w.archived_at IS NULL AND w.status IN ('open','in_progress','waiting')) AS open_items
       FROM project p WHERE p.archived_at IS NULL AND p.status = 'active' AND NOT p.is_unassigned_holding`)).rows;
  for (const p of projects) {
    const last = p.last_activity_at ?? p.created_at;
    const idle = days(o.now.getTime() - last.getTime());
    if (idle > (p.stall_threshold_days ?? o.stallThresholdDays)) {
      items.push(base({ id: p.id, section: "risks_conflicts", title: `Stalled: ${p.name}`, project: p.name, daysSinceActivity: idle, note: "no activity beyond the project's stall threshold" }));
    } else if (p.open_items === 0) {
      items.push(base({ id: p.id, section: "risks_conflicts", title: `No next action: ${p.name}`, project: p.name, note: "active project with no open items" }));
    }
  }

  // Knowledge past its review date (stale assumptions).
  const stale = (await db.query<{ id: string; claim: string }>(
    `SELECT id, claim FROM knowledge_item WHERE archived_at IS NULL AND status = 'active' AND review_at IS NOT NULL AND review_at < $1 LIMIT 20`, [o.now])).rows;
  for (const k of stale) items.push(base({ id: k.id, section: "risks_conflicts", title: `Needs re-verification: ${k.claim.slice(0, 100)}`, note: "past its review date" }));

  // ADR-022: Confidential third-party records past their review date with no active linked project.
  const retention = (await db.query<{ id: string; name: string }>(
    `SELECT e.id, e.name FROM entity e
      WHERE e.archived_at IS NULL AND e.classification = 'confidential' AND e.retention_review_at < $1
        AND NOT EXISTS (SELECT 1 FROM relationship r JOIN project p ON p.id = r.to_id
                         WHERE r.from_type = 'entity' AND r.from_id = e.id AND r.to_type = 'project'
                           AND p.status = 'active' AND p.archived_at IS NULL)
      LIMIT 50`, [o.now])).rows;
  for (const e of retention) items.push(base({ id: e.id, section: "fyi", title: `Retention review: ${e.name}`, note: "eligible for archival; request it only if no longer needed" }));

  // ADR-038: deliveries whose outcome is unknown beyond the provider's dedup window need reconciliation.
  const uncertain = (await db.query<{ id: string; purpose: string }>(
    `SELECT id, purpose FROM outbound_delivery WHERE status = 'uncertain' AND first_ambiguous_at < $1::timestamptz - interval '20 hours'`, [o.now])).rows;
  for (const d of uncertain) items.push(base({ id: d.id, section: "risks_conflicts", mustMention: true, title: `Delivery outcome unknown: ${d.purpose}`,
    note: "the email may or may not have been sent; check your inbox before resending" }));

  // Pending proposals and approvals: visible, not must-mention.
  const proposals = (await db.query<{ id: string; kind: string; proposed_text: string }>(
    `SELECT id, kind, proposed_text FROM proposal WHERE status = 'pending' AND archived_at IS NULL`)).rows;
  for (const p of proposals) items.push(base({ id: p.id, section: "fyi", title: `Pending ${p.kind.replace("_", " ")}: ${p.proposed_text.slice(0, 100)}`, note: "awaiting your decision" }));

  const deferred = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM capture WHERE status = 'budget_deferred'`)).rows[0]?.n ?? 0;

  return { periodStart, periodEnd: o.now, timezone: o.timezone, items, deferredCaptures: deferred, budget: o.budget,
    watermarkEventId: watermark, previousWatermarkEventId: prevWatermark, disputed };
}
