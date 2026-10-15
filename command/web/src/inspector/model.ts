/**
 * The Why inspector's model (spec §6, Slice 3). Pure functions over what Core served:
 *   - the causal chain is exactly /live/chain/<eventId> (root + every recorded ancestor) — never extended, re-ordered by id;
 *   - a cause an event cites that the chain does not contain is shown as missing, never filled in;
 *   - evidence = chain events of domain `evidence`;
 *   - who owns it NOW comes only from the authoritative snapshot (needsJulian / waits / tasks / exceptions); the event's
 *     own nextOwner is shown only as what was true when it was recorded;
 *   - consequences are not shown: Core has no consequences endpoint (spec D2c not built), and none is inferred here.
 * Wording may rephrase recorded classes (units.ts dictionaries); it never adds a step that has no event behind it.
 */
import { canCannot, NEEDS_LABEL, type CommandView } from "../model/command";
import type { LiveEvent, Snapshot, SnapshotException, SnapshotNeed, SnapshotTask, SnapshotWait } from "../model/types";
import { decisionText, historyText, openSubjects, subjectOf, transitionOf, verbOf } from "../model/units";

export type WhyTarget = { kind: "event"; id: number } | { kind: "object"; type: string; id: string };
const OBJECT = /^([a-z_]{2,40}):([0-9A-Za-z-]{1,64})$/;

/** `?why=<eventId>` or `?why=<type>:<id>`; "invalid" when present but malformed; null when absent. */
export function parseWhy(search: string): WhyTarget | "invalid" | null {
  const v = new URLSearchParams(search).get("why");
  if (v === null) return null;
  if (/^\d{1,15}$/.test(v)) return { kind: "event", id: Number(v) };
  const m = OBJECT.exec(v);
  return m ? { kind: "object", type: m[1]!, id: m[2]! } : "invalid";
}
export const whyValue = (t: WhyTarget) => (t.kind === "event" ? String(t.id) : `${t.type}:${t.id}`);
/** The page's query string with the inspector set (or removed); every other parameter is kept. */
export function withWhy(search: string, t: WhyTarget | null): string {
  const p = new URLSearchParams(search);
  if (t) p.set("why", whyValue(t)); else p.delete("why");
  const s = p.toString().replace(/%3A/gi, ":").replace(/(^|&)diag=(?=&|$)/, "$1diag");
  return s ? `?${s}` : "";
}
export const sameTarget = (a: WhyTarget | null, b: WhyTarget | null) => !!a && !!b && whyValue(a) === whyValue(b);

export interface ChainLine {
  e: LiveEvent;
  isRoot: boolean;
  /** recorded with no cause: the chain starts here */
  startedHere: boolean;
  /** causes this event cites that the chain does not contain (outside retention or beyond the depth Core walks) */
  missingCauses: number[];
  verb: string; text: string; transition: string | null;
  /** belongs to Finagai's internal testing — kept in the chain (it is Core's chain) but its content is not shown */
  internal: boolean;
}
export interface ChainModel { root: LiveEvent; lines: ChainLine[]; missing: number[]; evidence: ChainLine[]; ids: number[] }

export function chainModel(chain: LiveEvent[], rootId: number, isInternal: (e: LiveEvent) => boolean = () => false): ChainModel | null {
  const root = chain.find((e) => e.eventId === rootId);
  if (!root) return null;
  const have = new Set(chain.map((e) => e.eventId));
  const lines: ChainLine[] = [...chain].sort((a, b) => a.eventId - b.eventId).map((e) => {
    const internal = isInternal(e);
    return {
      e, isRoot: e.eventId === rootId, startedHere: e.cause.eventIds.length === 0, missingCauses: e.cause.eventIds.filter((id) => !have.has(id)),
      verb: internal ? "Internal test" : verbOf(e.class), text: internal ? "Finagai's internal testing (not shown)" : historyText(e),
      transition: internal ? null : transitionOf(e), internal,
    };
  });
  return { root, lines, missing: [...new Set(lines.flatMap((l) => l.missingCauses))].sort((a, b) => a - b),
    evidence: lines.filter((l) => l.e.domain === "evidence" && !l.internal), ids: lines.map((l) => l.e.eventId) };
}

/** The inspector's heading for the event it is rooted at (past tense; a decision without its instruction). */
export function headingOf(e: LiveEvent): string {
  if (e.domain === "escalation") return decisionText(e);
  if (e.class === "workflow.invoked") return historyText(e);
  const t = historyText(e);
  return t ? `${verbOf(e.class)}: ${t}` : verbOf(e.class);
}

/** What the event is about, as the keys the snapshot can be matched on. */
export function subjectsOf(e: LiveEvent): Set<string> {
  const out = new Set<string>();
  const s = subjectOf(e); if (s) out.add(s);
  if (e.entity.type && e.entity.id) out.add(`${e.entity.type}:${e.entity.id}`);
  for (const side of [e.after, e.before] as Array<Record<string, unknown> | null>) {
    if (!side) continue;
    for (const k of ["opportunity_id", "project_id", "followup_id"]) if (typeof side[k] === "string") out.add(`${k.replace("_id", "")}:${side[k] as string}`);
  }
  return out;
}

export type OwnerNow =
  | { kind: "julian"; need: SnapshotNeed; label: string; cc: { can: string; only: string } | null }
  | { kind: "wait"; wait: SnapshotWait }
  | { kind: "task"; task: SnapshotTask }
  | { kind: "exception"; exception: SnapshotException }
  | { kind: "none" };

/** Who owns it now — from the authoritative snapshot only. `events` (the store) only helps find a Mac task's number. */
export function ownerNow(root: LiveEvent, view: CommandView, snapshot: Snapshot, events: LiveEvent[] = []): OwnerNow {
  const subjects = subjectsOf(root);
  const need = view.needs.find((n) => [...openSubjects([n])].some((s) => subjects.has(s)));
  if (need) return { kind: "julian", need, label: NEEDS_LABEL[need.needs], cc: canCannot(need) };
  const wait = snapshot.waits.find((w) => subjects.has(`followup:${w.id}`) && (w.area_id === null || !view.internalAreaIds.has(w.area_id)));
  if (wait) return { kind: "wait", wait };
  const taskCode = taskCodeOf(root, events);
  const task = taskCode !== null ? snapshot.tasks.find((t) => t.code === taskCode) : undefined;
  if (task) return { kind: "task", task };
  const key = String(((root.after ?? root.before) as Record<string, unknown> | null)?.key ?? "");
  const exception = key ? snapshot.exceptions.find((x) => x.key === key && (x.area_id === null || !view.internalAreaIds.has(x.area_id))) : undefined;
  if (exception) return { kind: "exception", exception };
  return { kind: "none" };
}
function taskCodeOf(e: LiveEvent, events: LiveEvent[]): number | null {
  const a = (e.after ?? {}) as Record<string, unknown>;
  const k = /^mac:(\d+):/.exec(String(a.key ?? ((e.before ?? {}) as Record<string, unknown>).key ?? ""));
  if (k) return Number(k[1]);
  if (e.entity.type !== "control_task" || !e.entity.id) return null;
  if (typeof a.code === "number") return a.code;
  const created = events.find((x) => x.class === "task.created" && x.entity.id === e.entity.id);
  const c = (created?.after as Record<string, unknown> | null)?.code;
  return typeof c === "number" ? c : null;
}

const ACTOR: Record<string, string> = { cos: "Finagai", system: "Finagai", julian: "a request from you (through Claude)", j6: "the Mac helper", job: "a scheduled job", learning: "Finagai's learning pass" };
export const actorLabel = (a: string) => ACTOR[a] ?? a;

/** Authorization, verification, confidence and provenance — only the fields the event actually carries. */
export function recordFacts(e: LiveEvent): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [{ label: "Recorded by", value: actorLabel(e.actor) }];
  if (e.area?.name) out.push({ label: "Area", value: e.area.name });
  if (e.humanAuthorized) out.push({ label: "Authorization", value: "done under your passkey approval" });
  if (e.verified !== null) out.push({ label: "Verification", value: e.verified ? "✓ verified" : "✕ not verified" });
  if (e.confidence !== null) out.push({ label: "Confidence", value: `${Math.round(e.confidence * 100)}%` });
  return out;
}
