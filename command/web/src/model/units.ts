/**
 * Live Activity = units of work (spec §3.5): semantic events grouped by their unit of work (cause.correlationId),
 * titled by the most significant event in the unit, with low-value and internal traffic hidden (spec §14.2).
 * Pure functions; the wording comes from Core's own summaries — nothing is invented.
 */
import type { LiveEvent } from "./types";

export interface Unit {
  key: string;
  events: LiveEvent[];
  steps: LiveEvent[];
  firstAt: string; lastAt: string; firstId: number; lastId: number;
  area: { id: string; name: string | null } | null;
  title: string;
  yours: boolean;
  outcome: "failed" | "recovered" | null;
  rank: number;
}

/** Hidden by default (Meaningful mode): server low-value, routine traffic, Finagai's own checks. */
const HIDDEN_CLASSES = new Set(["workflow.invoked", "system.checked", "evidence.ignored", "capability.measured", "notification.suppressed"]);
export function hiddenEvent(e: LiveEvent): boolean {
  return e.lowValue || e.class.startsWith("tool.") || e.class.startsWith("source.") || HIDDEN_CLASSES.has(e.class) || e.action === "canary_ran" || e.action === "mcp_unknown_tool";
}

const RANK: Record<string, number> = {
  "escalation.opened": 100, "escalation.resolved": 90, "approval.requested": 88, "authority.boundary_encountered": 85, "entity.state_changed": 80,
  "exception.opened": 75, "exception.cleared": 70, "workflow.failed": 68, "task.recovered": 66, "task.failed": 65, "wait.expired": 60, "wait.resolved": 58,
  "wait.started": 55, "wait.cancelled": 54, "task.completed": 52, "task.created": 50, "task.state_changed": 50, "area.health_changed": 45, "rule.fired": 44, "lesson.learned": 42,
  "lesson.approved": 42, "lesson.rejected": 42, "lesson.proposed": 42, "procedure.discovered": 42, "evidence.attached": 40, "wait.updated": 35, "entity.created": 34,
  "entity.archived": 33, "project.state_changed": 32, "system.check_failed": 30, "evidence.classified": 15, "notification.delivered": 12, "escalation.notified": 10,
  "workflow.started": 5, "evidence.observed": 3,
};
export const SHOW_THRESHOLD = 20;
function rankOf(e: LiveEvent): number {
  if (e.class === "workflow.completed") return e.action === "job_finished" || hasChanges(e) ? 20 : 9;
  return RANK[e.class] ?? 8;
}
const hasChanges = (e: LiveEvent) => Array.isArray((e.after as { changes?: unknown } | null)?.changes) && ((e.after as { changes: unknown[] }).changes.length > 0);

/** Plain-language verbs (spec §12.6). */
const VERB: Record<string, string> = {
  "entity.state_changed": "Changed status", "entity.created": "Created", "entity.archived": "Archived", "entity.updated": "Updated",
  "wait.started": "Started waiting", "wait.resolved": "Wait closed", "wait.expired": "Passed its due date", "wait.cancelled": "Wait replaced", "wait.updated": "Wait updated",
  "escalation.opened": "Became your decision", "escalation.resolved": "No longer needs you", "escalation.notified": "You were emailed",
  "exception.opened": "Finagai found a problem", "exception.cleared": "Problem cleared", "exception.remediated": "Finagai applied a fix",
  "task.recovered": "Recovered and continued", "task.failed": "A step failed", "task.completed": "Task finished", "task.created": "Task started",
  "evidence.attached": "New evidence", "evidence.observed": "Noticed", "evidence.classified": "Routed", "lesson.updated": "Learning updated", "lesson.learned": "Learned",
  "system.check_failed": "Self-check failed", "workflow.started": "Started", "workflow.completed": "Finished", "workflow.failed": "Workflow failed",
  "area.health_changed": "Area health changed", "notification.delivered": "Notice sent", "rule.fired": "Rule fired", "approval.requested": "Approval requested",
  "project.state_changed": "Project changed", "relationship.changed": "Linked", "authority.boundary_encountered": "Needs your authority",
};
export const verbOf = (cls: string) => VERB[cls] ?? cls.split(".").pop()!.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Core's summary without its "<class>: " prefix. */
export function textOf(e: LiveEvent): string {
  const s = e.summary.startsWith(e.class) ? e.summary.slice(e.class.length).replace(/^:\s*/, "") : e.summary;
  const a = (e.after ?? {}) as Record<string, unknown>;
  return (s || String(a.summary ?? a.outcome ?? a.statement ?? "")).trim();
}
const firstClause = (s: string) => s.split(" — ")[0]!.trim();
const cleanChange = (s: string) => s.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/^status:\s*/, "").replace(/^event:\s*/, "").trim();
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const pretty = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Before → after for a transition, changed keys only (e.g. "status: applied → offer"). */
export function transitionOf(e: LiveEvent): string | null {
  if (!e.before || !e.after) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e.before)) {
    const w = (e.after as Record<string, unknown>)[k];
    if (w !== undefined && JSON.stringify(w) !== JSON.stringify(v) && (typeof v !== "object" || v === null) && (typeof w !== "object" || w === null))
      parts.push(`${k.replace(/_/g, " ")}: ${fmtVal(v)} → ${fmtVal(w)}`);
  }
  return parts.length ? parts.slice(0, 3).join(" · ") : null;
}
const fmtVal = (v: unknown) => (v === null || v === undefined ? "none" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : String(v));

function titleOf(top: LiveEvent, events: LiveEvent[]): string {
  const a = (top.after ?? {}) as Record<string, unknown>;
  const changes = events.flatMap((e) => (hasChanges(e) ? ((e.after as { changes: string[] }).changes) : []));
  switch (top.class) {
    case "escalation.opened": return `${firstClause(String(a.summary ?? textOf(top)))} — now your decision`;
    case "escalation.resolved": return `${firstClause(String(a.summary ?? textOf(top)))} — no longer needs you`;
    case "wait.expired": return `${String(a.summary ?? textOf(top))} — passed its due date`;
    case "exception.opened": return `Finagai found a problem: ${String(a.summary ?? textOf(top))}`;
    case "exception.cleared": return `Problem cleared: ${String(a.summary ?? textOf(top))}`;
    case "workflow.failed": return `${pretty(String(a.workflow ?? a.job ?? "A workflow"))} failed`;
    case "task.recovered": return `Recovered and continued — ${textOf(top)}`;
    case "task.created": return `Mac task${a.code ? ` ${String(a.code)}` : ""} started: ${clip(String(a.request ?? textOf(top)))}`;
    case "task.state_changed":
      if (a.status === "waiting_approval" || top.nextOwner === "julian") return `Mac task is waiting for your approval — ${clip(String(a.reason ?? textOf(top)).replace(/^step \d+:\s*/, ""))}`;
      return `Mac task ${pretty(String(a.status ?? "changed"))}${a.reason ? ` — ${clip(String(a.reason))}` : ""}`;
    case "area.health_changed": return `${top.area?.name ?? "Area"} health: ${String((top.before as Record<string, unknown> | null)?.color ?? "?")} → ${String(a.color ?? "?")}`;
    case "workflow.completed":
      if (top.action === "job_finished") return `${pretty(String(a.job ?? "Scheduled job"))} ${a.status === "failed" ? "failed" : "completed"}`;
      break;
  }
  if (changes.length && ["entity.state_changed", "evidence.attached", "wait.started", "wait.cancelled", "wait.updated", "workflow.completed", "entity.created"].includes(top.class))
    return cleanChange(changes[0]!) + (changes.length > 1 ? ` (+${changes.length - 1} more)` : "");
  const t = textOf(top);
  const tr = transitionOf(top);
  return `${verbOf(top.class)}${t ? `: ${t}` : tr ? `: ${tr}` : ""}`;
}

/** Business objects that can carry "internal" from one event to another (never ticks, Areas or tools, which are shared). */
const LINKABLE = new Set(["opportunity", "project", "followup", "escalation", "inbound_event", "lesson", "control_task"]);
const SUBJECT = /@([a-z_]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The business objects an event is about: its entity, a decision's subject (key `…@type:uuid`), and referenced objects. */
function objectsOf(e: LiveEvent): string[] {
  const out: string[] = [];
  if (e.entity.id && e.entity.type && LINKABLE.has(e.entity.type)) out.push(e.entity.id);
  for (const side of [e.after, e.before] as Array<Record<string, unknown> | null>) {
    if (!side) continue;
    const key = typeof side.key === "string" ? SUBJECT.exec(side.key) : null;
    if (key && LINKABLE.has(key[1]!)) out.push(key[2]!);
    for (const k of ["opportunity_id", "project_id", "followup_id"]) if (typeof side[k] === "string") out.push(side[k] as string);
  }
  return out;
}
const RUN_WIDE = new Set(["workflow.started", "workflow.completed", "workflow.invoked", "evidence.observed", "evidence.classified", "evidence.ignored", "notification.suppressed", "notification.delivered"]);
const isCanaryRun = (e: LiveEvent) => e.action === "canary_ran" || (e.action === "work_invoked" && String((e.after as Record<string, unknown> | null)?.what ?? "").startsWith("canary:"));

/**
 * Objects tied to Finagai's internal test Area: those an internal-Area event touched (plus the inbound evidence it came
 * from), then — to a fixed point — everything about them, such as a decision about an internal opportunity whose own row
 * carries no Area (rows Core created before it recorded one) and that decision's later resolution.
 */
export function internalLinks(events: LiveEvent[], internalAreaIds: Set<string>): Set<string> {
  const links = new Set<string>();
  for (const e of events) if (e.area && internalAreaIds.has(e.area.id)) {
    for (const id of objectsOf(e)) links.add(id);
    const src = (e.after as Record<string, unknown> | null)?.sourceId;
    if (typeof src === "string") links.add(src);
  }
  for (let pass = 0, grew = true; grew && pass < 5; pass++) {
    grew = false;
    for (const e of events) {
      const ids = objectsOf(e);
      if (ids.some((id) => links.has(id))) for (const id of ids) if (!links.has(id)) { links.add(id); grew = true; }
    }
  }
  return links;
}
/** An event that belongs to Finagai's internal testing (its Area, an object linked to it, or a canary run). */
export function internalEvent(e: LiveEvent, internalAreaIds: Set<string>, links: Set<string>): boolean {
  return (!!e.area && internalAreaIds.has(e.area.id)) || isCanaryRun(e) || objectsOf(e).some((id) => links.has(id));
}

/**
 * Group events into units of work. Internal events (test Area, linked objects, canary runs) and hidden routine events
 * are not steps; a unit with no remaining steps is not shown — so a run that touched both a real job and the canary
 * still shows the real job, and nothing of the canary.
 */
export function buildUnits(events: LiveEvent[], internalAreaIds: Set<string>, opts: { everything?: boolean; links?: Set<string> } = {}): Unit[] {
  const links = opts.links ?? internalLinks(events, internalAreaIds);
  const groups = new Map<string, LiveEvent[]>();
  for (const e of events) { const k = e.cause.correlationId ?? `e${e.eventId}`; const g = groups.get(k); if (g) g.push(e); else groups.set(k, [e]); }
  const units: Unit[] = [];
  for (const [key, all] of groups) {
    all.sort((a, b) => a.eventId - b.eventId);
    // a canary run is internal from start to finish; any other run loses only its internal events
    if (!opts.everything && all.some(isCanaryRun)) continue;
    let evs = opts.everything ? all : all.filter((e) => !internalEvent(e, internalAreaIds, links));
    // A run that also did internal work: its run-wide summaries (change lists) and its intake of evidence describe the
    // internal part too, so only the outcomes on real objects are kept.
    if (evs.length < all.length) evs = evs.filter((e) => !RUN_WIDE.has(e.class));
    const steps = opts.everything ? evs : evs.filter((e) => !hiddenEvent(e));
    if (!steps.length) continue;
    const top = steps.reduce((b, e) => (rankOf(e) > rankOf(b) ? e : b), steps[0]!);
    const rank = rankOf(top);
    if (rank < SHOW_THRESHOLD && !opts.everything) continue;
    units.push({
      key, events: evs, steps, firstAt: steps[0]!.at, lastAt: steps[steps.length - 1]!.at, firstId: steps[0]!.eventId, lastId: steps[steps.length - 1]!.eventId,
      area: steps.find((e) => e.area)?.area ?? null,
      title: titleOf(top, evs),
      // ◆ when the unit opened a decision for Julian, or ended waiting on him (spec §3.5: "ended with nextOwner = julian")
      yours: steps.some((e) => e.nextOwner === "julian" && (e.class === "escalation.opened" || e.class === "approval.requested" || e.class === "authority.boundary_encountered"))
        || steps[steps.length - 1]!.nextOwner === "julian",
      outcome: steps.some((e) => e.class === "task.recovered") ? "recovered" : steps.some((e) => e.class === "workflow.failed" || e.class === "task.failed" || e.class === "system.check_failed") ? "failed" : null,
      rank,
    });
  }
  return units.sort((a, b) => b.firstId - a.firstId);
}
