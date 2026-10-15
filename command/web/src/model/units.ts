/**
 * Live Activity = units of work (spec §3.5): semantic events grouped by their unit of work (cause.correlationId),
 * titled by the most significant event in the unit, with low-value and internal traffic hidden (spec §14.2).
 * Pure functions; the wording comes from Core's own summaries — nothing is invented.
 */
import type { LiveEvent } from "./types";

export interface Unit {
  /** the story's subject ("control_task:<id>") or, for a lone unit of work, its correlation id */
  key: string;
  events: LiveEvent[];
  steps: LiveEvent[];
  firstAt: string; lastAt: string; firstId: number; lastId: number;
  /** when the item's latest significant step happened — the moment its title speaks of (shown, sorted and windowed by it;
   *  a later routine re-check attached to the story does not make an old decision look new) */
  at: string; atId: number;
  area: { id: string; name: string | null } | null;
  /** past tense, phrased by the final recorded outcome — never an instruction (current state is Needs you's job) */
  title: string;
  /** ◆: the subject is open in Julian's Needs you right now (authoritative snapshot) — never inferred from history */
  yours: boolean;
  outcome: "failed" | "recovered" | null;
  rank: number;
  /** the event the Why inspector roots at for this item (its most significant step) */
  rootEventId: number;
  /** how many units of work (correlations) this item consolidates */
  parts: number;
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
  "escalation.opened": "Became your decision", "escalation.resolved": "Decision resolved", "escalation.notified": "You were emailed",
  "exception.opened": "Finagai found a problem", "exception.cleared": "Problem cleared", "exception.remediated": "Finagai applied a fix",
  "task.recovered": "Recovered and continued", "task.failed": "A step failed", "task.completed": "Task finished", "task.created": "Task started", "task.state_changed": "Task state changed", "task.step_proposed": "Step proposed",
  "evidence.attached": "New evidence", "evidence.observed": "Noticed", "evidence.classified": "Routed", "lesson.updated": "Learning updated", "lesson.learned": "Learned",
  "system.check_failed": "Self-check failed", "workflow.started": "Started", "workflow.completed": "Finished", "workflow.failed": "Workflow failed",
  "area.health_changed": "Area health changed", "notification.delivered": "Notice sent", "rule.fired": "Rule fired", "approval.requested": "Approval requested",
  "project.state_changed": "Project changed", "relationship.changed": "Linked", "authority.boundary_encountered": "Reached your authority",
  "workflow.invoked": "Trigger", "workflow.skipped": "Skipped", "other.control_step_approved": "Step approved", "other.control_step_ran": "Step ran",
};
export const verbOf = (cls: string) => VERB[cls] ?? cls.split(".").pop()!.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Core's summary without its "<class>: " prefix. */
export function textOf(e: LiveEvent): string {
  const s = e.summary.startsWith(e.class) ? e.summary.slice(e.class.length).replace(/^:\s*/, "") : e.summary;
  const a = (e.after ?? {}) as Record<string, unknown>;
  return (s || String(a.summary ?? a.outcome ?? a.statement ?? "")).trim();
}
const cleanChange = (s: string) => s.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/^status:\s*/, "").replace(/^event:\s*/, "").trim();
/** Shorten to n characters at a word boundary when one is near. */
const clip = (s: string, n = 90) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1); const sp = cut.lastIndexOf(" ");
  return `${(sp > n - 25 ? cut.slice(0, sp) : cut).trimEnd()}…`;
};
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

/**
 * What a decision was about, as recorded, without the instruction Core attached for the moment it was open
 * ("— approve a follow-up …, give a new date, or close it", "Reply "ok 406" …"). An open decision's instruction is shown
 * by Needs you, from the snapshot; history never repeats it as if it were current. Mac waits read in the past tense.
 */
export function decisionText(e: LiveEvent): string {
  const a = (e.after ?? e.before ?? {}) as Record<string, unknown>;
  let s = String(a.summary ?? textOf(e));
  if (/^mac:/.test(String(a.key ?? "")) || /^Mac task \d+ (is waiting|paused and is waiting)/.test(s)) {
    s = s.replace(/\.?\s*Reply\b[\s\S]*$/, "")
      .replace(/ is waiting for your approval/, " asked for your approval").replace(/ is waiting for your answer/, " asked you a question")
      .replace(/ is waiting for your direction/, " asked for your direction").replace(/ paused and is waiting for you/, " paused and asked for you");
    return s.trim();
  }
  s = s.replace(/ — approve applying it\? /, ": ");
  const parts = s.split(" — ");
  const kept = [parts[0]!, ...parts.slice(1).filter((p) => !INSTRUCTION.test(p.trim()) && !/only you can/i.test(p))];
  return kept.join(" — ").trim();
}
const INSTRUCTION = /^(approve|decide|reply|give|close|choose|confirm|answer|review|raise|re-?authori[sz]e|wake|respond|accept|tell|open|resume|stop)\b/i;

/** A recorded event in plain words, in the past tense, never phrased as a current instruction (history and Why). */
export function historyText(e: LiveEvent): string {
  if (e.domain === "escalation") return decisionText(e);
  if (e.class === "workflow.invoked") return invokedText(e);
  const t = textOf(e);
  const r = (e.after as Record<string, unknown> | null)?.result;
  return t || (typeof r === "string" && r.trim() ? `result: ${clip(r.trim(), 120)}` : "");
}

/** What started a unit of work (Core records it once as `work_invoked {what}`), in plain words. */
export function invokedText(e: LiveEvent): string {
  const a = (e.after ?? {}) as Record<string, unknown>;
  const what = String(a.what ?? "");
  const [kind, ...rest] = what.split(":"); const arg = rest.join(":");
  switch (kind) {
    case "engine": if (arg === "tick") return a.trigger === "interval" ? "Finagai's regular 5-minute check ran" : "Finagai's check ran (on request)"; break;
    case "tool": return `A request through Claude used Finagai's ${arg.replace(/_/g, " ")} tool`;
    case "mac": return MAC_PATH[arg] ?? `The Mac helper contacted Finagai (${arg})`;
    case "job": return `Scheduled job ran: ${pretty(arg)}`;
    case "scheduler": return arg === "dead-man-check" ? "Finagai's watchdog checked that its checks are running" : `Finagai's scheduler ran ${arg}`;
    case "http": return /\/approval/.test(arg) ? "You opened an approval link" : "A request reached Finagai";
    case "canary": return "Finagai ran an internal test";
  }
  return what ? `Started: ${what}` : "Work started";
}
const MAC_PATH: Record<string, string> = {
  "/control/next": "The Mac helper asked Finagai for its next step", "/control/decision": "The Mac helper passed on your reply",
  "/control/ran": "The Mac helper reported a step's result", "/mac/heartbeat": "The Mac helper checked in", "/artifact/register": "The Mac helper saved a file",
};

function titleOf(top: LiveEvent, events: LiveEvent[]): string {
  const a = (top.after ?? {}) as Record<string, unknown>;
  const changes = events.flatMap((e) => (hasChanges(e) ? ((e.after as { changes: string[] }).changes) : []));
  switch (top.class) {
    case "escalation.opened": return `${clip(decisionText(top), 110)} — became your decision`;
    case "escalation.resolved": return `${clip(decisionText(top), 110)} — resolved${a.resolution ? ` (${String(a.resolution)})` : ""}`;
    case "wait.expired": return `${String(a.summary ?? textOf(top))} — passed its due date`;
    case "exception.opened": return `Finagai found a problem: ${String(a.summary ?? textOf(top))}`;
    case "exception.cleared": return `Problem cleared: ${String(a.summary ?? textOf(top))}`;
    case "workflow.failed": return `${pretty(String(a.workflow ?? a.job ?? "A workflow"))} failed`;
    case "task.recovered": return `Recovered and continued — ${textOf(top)}`;
    case "task.created": return `Mac task${a.code ? ` ${String(a.code)}` : ""} started: ${clip(String(a.request ?? textOf(top)))}`;
    case "task.state_changed":
      if (a.status === "waiting_approval" || top.nextOwner === "julian") return `Mac task asked for your approval — ${clip(String(a.reason ?? textOf(top)).replace(/^step \d+:\s*/, ""))}`;
      return `Mac task ${TASK_STATUS[String(a.status)] ?? "changed state"}${a.reason ? ` — ${clip(String(a.reason))}` : ""}`;
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

/** Mac task status → past-tense phrase. */
const TASK_STATUS: Record<string, string> = { done: "completed", failed: "failed", cancelled: "was cancelled", expired: "expired", active: "resumed", paused: "paused",
  waiting_approval: "waited for your approval" };
/** A resolved Mac wait, by Core's recorded resolution. */
const RESOLUTION: Array<[RegExp, (step: string | null) => string]> = [
  [/step approved/i, (st) => `you approved ${st ? `step ${st}` : "the step"}`], [/step declined/i, (st) => `you declined ${st ? `step ${st}` : "the step"}`],
  [/cancelled/i, () => "you cancelled it"], [/expired/i, () => "your answer was not given before it expired"], [/resumed/i, () => "you resumed it"],
];
/** An open (or unresolved-in-view) Mac wait, by its key. */
function macAsk(key: string): string {
  const step = /:step:(\d+)@/.exec(key)?.[1];
  if (step) return `asked for your approval of step ${step}`;
  if (/:question:/.test(key)) return "asked you a question";
  if (/:rejected:/.test(key)) return "asked for your direction after a declined step";
  return "paused and asked for you";
}

/** Group events into units of work (one correlation). Internal events never become steps (see internalEvent). */
interface Raw { key: string; all: LiveEvent[]; evs: LiveEvent[]; steps: LiveEvent[]; top: LiveEvent | null; rank: number }
function rawUnits(events: LiveEvent[], internalAreaIds: Set<string>, links: Set<string>, everything: boolean): Raw[] {
  const groups = new Map<string, LiveEvent[]>();
  for (const e of events) { const k = e.cause.correlationId ?? `e${e.eventId}`; const g = groups.get(k); if (g) g.push(e); else groups.set(k, [e]); }
  const out: Raw[] = [];
  for (const [key, all] of groups) {
    all.sort((a, b) => a.eventId - b.eventId);
    // a canary run is internal from start to finish; any other run loses only its internal events
    if (!everything && all.some(isCanaryRun)) continue;
    let evs = everything ? all : all.filter((e) => !internalEvent(e, internalAreaIds, links));
    // A run that also did internal work: its run-wide summaries (change lists) and its intake of evidence describe the
    // internal part too, so only the outcomes on real objects are kept.
    if (evs.length < all.length) evs = evs.filter((e) => !RUN_WIDE.has(e.class));
    if (!evs.length) continue;
    const steps = everything ? evs : evs.filter((e) => !hiddenEvent(e));
    const top = steps.length ? topOf(steps) : null;
    out.push({ key, all, evs, steps, top, rank: top ? rankOf(top) : 0 });
  }
  return out;
}

/** What a decision is about: the subject in its key (`…@type:uuid`), or the follow-up its key names. */
const KEY_SUBJECT = /^(?:followup|overdue):([0-9a-f-]{36})/;
export function subjectOf(e: LiveEvent): string | null {
  if (e.domain === "escalation") {
    const key = String(((e.after ?? e.before) as Record<string, unknown> | null)?.key ?? "");
    const at = SUBJECT.exec(key); if (at) return `${at[1]}:${at[2]}`;
    const f = KEY_SUBJECT.exec(key); if (f) return `followup:${f[1]}`;
    return e.entity.id ? `escalation:${e.entity.id}` : null;
  }
  return e.entity.id && e.entity.type && STORY_TYPES.has(e.entity.type) ? `${e.entity.type}:${e.entity.id}` : null;
}
const STORY_TYPES = new Set(["control_task", "control_step", "opportunity", "followup", "project", "lesson", "operating_exception", "escalation"]);
/**
 * The business objects an event is about (for attaching minor fragments such as "the step ran" to their story). Only
 * story objects count — never an Area, a tick, an inbound item or a tool, which many unrelated units share (production
 * 2026-10-15: no-change career syncs on the Career Area must not join Beth Young's decision).
 */
function storyObjectsOf(e: LiveEvent): string[] {
  const out = new Set<string>();
  const s = subjectOf(e); if (s) out.add(s);
  if (e.entity.id && e.entity.type && STORY_TYPES.has(e.entity.type)) out.add(`${e.entity.type}:${e.entity.id}`);
  for (const side of [e.after, e.before] as Array<Record<string, unknown> | null>) if (side) for (const k of ["opportunity_id", "project_id", "followup_id"]) if (typeof side[k] === "string") out.add(`${k.replace("_id", "")}:${side[k] as string}`);
  return [...out];
}

/**
 * Live Activity items. The units of work about one subject are consolidated into one story, titled by its final recorded
 * outcome in the past tense ("Mac task 137: you approved step 406; task completed — …") instead of adjacent lifecycle
 * fragments ("Active", "Changed", "now your decision", "no longer needs you"). Every step stays in the story: history is
 * consolidated, never hidden. A unit about no business object stays on its own.
 * `open` = what is open in Needs you right now (authoritative snapshot, see openSubjects): only those items carry ◆.
 * Ownership is never inferred from the history itself.
 */
export function buildUnits(events: LiveEvent[], internalAreaIds: Set<string>, opts: { everything?: boolean; links?: Set<string>; open?: Set<string> } = {}): Unit[] {
  const everything = !!opts.everything;
  const links = opts.links ?? internalLinks(events, internalAreaIds);
  const open = opts.open ?? new Set<string>();
  const raws = rawUnits(events, internalAreaIds, links, everything);
  // 1) stories: units of work whose most significant event is about the same object
  const stories = new Map<string, Raw[]>(); const lone: Raw[] = []; const minor: Raw[] = [];
  for (const r of raws) {
    const subject = r.top ? subjectOf(r.top) : null;
    if (subject && r.rank >= SHOW_THRESHOLD) { const g = stories.get(subject); if (g) g.push(r); else stories.set(subject, [r]); }
    else if (r.rank >= SHOW_THRESHOLD || (everything && r.steps.length)) lone.push(r);
    else minor.push(r);
  }
  // 2) minor fragments of a story (e.g. "the step ran", unclassified in Core) join the story whose objects they mention
  const objectsOfStory = new Map<string, Set<string>>();
  for (const [k, rs] of stories) objectsOfStory.set(k, new Set(rs.flatMap((r) => r.evs.flatMap(storyObjectsOf))));
  for (const m of minor) {
    if (!m.steps.length) continue;
    const objs = m.evs.flatMap(storyObjectsOf);
    for (const [k, set] of objectsOfStory) if (objs.some((o) => set.has(o))) { stories.get(k)!.push(m); break; }
  }
  const items: Unit[] = [];
  const make = (key: string, rs: Raw[], subject: string | null) => {
    rs.sort((a, b) => a.evs[0]!.eventId - b.evs[0]!.eventId);
    const evs = rs.flatMap((r) => r.evs).sort((a, b) => a.eventId - b.eventId);
    const steps = rs.flatMap((r) => r.steps).sort((a, b) => a.eventId - b.eventId);
    if (!steps.length) return;
    const top = topOf(steps);
    const topUnit = rs.find((r) => r.steps.includes(top))!;
    const sig = [...steps].reverse().find((e) => rankOf(e) >= SHOW_THRESHOLD) ?? top;
    const title = (subject && (rs.length > 1 || subject.startsWith("control_task:")) ? storyTitle(subject, evs) : null) ?? titleOf(top, topUnit.evs);
    items.push({
      key, events: evs, steps, firstAt: steps[0]!.at, lastAt: steps[steps.length - 1]!.at, firstId: steps[0]!.eventId, lastId: steps[steps.length - 1]!.eventId,
      at: sig.at, atId: sig.eventId, area: steps.find((e) => e.area)?.area ?? null, title,
      yours: !!subject && (open.has(subject) || evs.some((e) => e.domain === "escalation" && !!e.entity.id && open.has(`escalation:${e.entity.id}`))),
      outcome: finalOutcome(steps), rank: rankOf(top), rootEventId: top.eventId, parts: rs.length,
    });
  };
  for (const [k, rs] of stories) make(k, rs, k);
  for (const r of lone) make(r.key, [r], null);
  return items.sort((a, b) => b.atId - a.atId);
}
/** The most significant step; on a tie the later one (the story's final word). */
const topOf = (steps: LiveEvent[]) => steps.reduce((b, e) => (rankOf(e) >= rankOf(b) ? e : b), steps[0]!);

/** What Needs you holds right now (authoritative snapshot), as the subjects buildUnits and the inspector match against. */
export function openSubjects(needs: Array<{ id: string; key: string; followup_id: string | null; subject: { type: string; id: string } | null }>): Set<string> {
  const out = new Set<string>();
  for (const n of needs) {
    out.add(`escalation:${n.id}`);
    if (n.subject) out.add(`${n.subject.type}:${n.subject.id}`);
    if (n.followup_id) out.add(`followup:${n.followup_id}`);
    const f = KEY_SUBJECT.exec(n.key); if (f) out.add(`followup:${f[1]}`);
  }
  return out;
}

/** failed / recovered only when that is how the story ENDED (a later success supersedes an earlier failure). */
function finalOutcome(steps: LiveEvent[]): Unit["outcome"] {
  const last = [...steps].reverse().find((e) => /^(task\.(completed|failed|recovered)|workflow\.(failed|completed)|system\.check_failed)$/.test(e.class)
    || (e.class === "task.state_changed" && !!(e.after as Record<string, unknown> | null)?.status));
  if (!last) return null;
  if (last.class === "task.recovered") return "recovered";
  if (last.class === "workflow.failed" || last.class === "task.failed" || last.class === "system.check_failed") return "failed";
  if (last.class === "task.state_changed" && (last.after as Record<string, unknown>).status === "failed") return "failed";
  return null;
}

/** A story's title, by its final recorded outcome, in the past tense. Null when the top event says it best. */
function storyTitle(subject: string, evs: LiveEvent[]): string | null {
  const after = (e: LiveEvent | undefined) => (e?.after ?? e?.before ?? {}) as Record<string, unknown>;
  // each decision in the story, in order: opened → resolved (by escalation id)
  const decisions: Array<{ opened: LiveEvent; resolved: LiveEvent | undefined }> = [];
  for (const e of evs) if (e.class === "escalation.opened") decisions.push({ opened: e, resolved: evs.find((r) => r.class === "escalation.resolved" && r.entity.id === e.entity.id && r.eventId > e.eventId) });
  // a resolution whose opening is older than the window still tells how the story went
  for (const r of evs) if (r.class === "escalation.resolved" && !decisions.some((d) => d.opened.entity.id === r.entity.id)) decisions.push({ opened: r, resolved: r });
  decisions.sort((a, b) => a.opened.eventId - b.opened.eventId);
  if (subject.startsWith("control_task:")) {
    const created = evs.find((e) => e.class === "task.created");
    const key0 = String(after(decisions[0]?.opened).key ?? "");
    const code = /^mac:(\d+):/.exec(key0)?.[1] ?? (after(created).code != null ? String(after(created).code) : null);
    const clauses = decisions.map(({ opened, resolved }) => {
      const key = String(after(opened).key ?? "");
      if (!resolved) return macAsk(key);
      const step = /:step:(\d+)@/.exec(key)?.[1] ?? null;
      return RESOLUTION.find(([re]) => re.test(String(after(resolved).resolution ?? "")))?.[1](step) ?? `${macAsk(key)} (resolved)`;
    });
    if (!decisions.length && evs.some((e) => e.class === "task.state_changed" && after(e).status === "waiting_approval")) clauses.push("waited for your approval");
    const lastState = [...evs].reverse().find((e) => e.class === "task.completed" || (e.class === "task.state_changed" && typeof after(e).status === "string"));
    const status = lastState?.class === "task.completed" ? "done" : String(after(lastState).status ?? "");
    const lastClause = clauses[clauses.length - 1] ?? "";
    const redundant = (status === "waiting_approval" && /approval/.test(lastClause)) || (status === "active" && decisions.length > 0) || (status === "cancelled" && /cancelled/.test(lastClause))
      || (status === "paused" && /paused|asked/.test(lastClause));
    if (TASK_STATUS[status] && !redundant) clauses.push(`task ${TASK_STATUS[status]}`);
    if (!clauses.length) clauses.push(created ? "started" : "changed state");
    const result = lastState?.class === "task.completed" ? String(after(lastState).summary ?? "") : created && !decisions.length ? String(after(created).request ?? "") : "";
    return `Mac task${code ? ` ${code}` : ""}: ${clauses.slice(-3).join("; ")}${result ? ` — ${clip(result, 80)}` : ""}`;
  }
  const last = decisions[decisions.length - 1];
  if (!last) return null;
  const what = clip(decisionText(last.opened), 110);
  if (!last.resolved) return `${what} — became your decision`;
  const how = String(after(last.resolved).resolution ?? "");
  // a state change recorded after the decision closed is how the story ended
  const later = [...evs].reverse().find((e) => e.eventId > last.resolved!.eventId && e.class === "entity.state_changed");
  const then = later ? cleanChange(((later.after as { changes?: string[] } | null)?.changes ?? [])[0] ?? transitionOf(later) ?? "") : "";
  return `${what} — resolved${how ? ` (${how})` : ""}${then ? `; then ${then}` : ""}`;
}
