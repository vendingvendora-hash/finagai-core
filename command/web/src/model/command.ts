/**
 * What the Command screen shows, derived from Core's snapshot and reliability report (spec §3). The rules:
 *   - Needs you = open escalations only (never exceptions, failures or waits directly).
 *   - Finagai is handling = waits whose owner is Finagai (Core decides owner), Mac tasks running, Finagai-owned problems,
 *     armed rules, and the event loop's last check.
 *   - Health = one rule (spec §3.3). Finagai's internal test Area never appears.
 * Pure; the client computes no business verdict of its own (Area colors, owners and the report come from Core).
 */
import type { Reliability, Snapshot, SnapshotArea, SnapshotNeed, SnapshotWait } from "./types";

export type Health = "healthy" | "degraded" | "attention" | "unknown";
export interface AreaRow { area: SnapshotArea; needs: number; waits: number; fact: string }
export interface CommandView {
  needs: SnapshotNeed[];
  waits: SnapshotWait[];
  nextDue: { at: string; who: string[] } | null;
  tasksRunning: Snapshot["tasks"];
  problems: Snapshot["exceptions"];
  rulesArmed: number;
  lastTick: string | null; stalled: boolean;
  health: Health; healthWhy: string[];
  calm: boolean;
  areas: AreaRow[];
  upcoming: Array<{ at: string; text: string; yours: boolean }>;
  waitingOn: Array<{ who: string; items: SnapshotWait[] }>;
  areaName: (id: string | null) => string | null;
  /** Finagai's internal test Area(s) — excluded everywhere in Command */
  internalAreaIds: Set<string>;
}

export const STALL_MS = 15 * 60_000, FRESH_MS = 2 * 60_000;
const COLOR_ORDER = { red: 0, yellow: 1, green: 2 } as const;

/**
 * `snapshotAt` is when the snapshot was read: "Finagai's checks stopped" is only claimed from a snapshot read in the last
 * two minutes (an old snapshot says nothing about whether checks continue — the connection state covers that).
 * `internalLinked` are objects tied to Finagai's internal test Area through the events (see units.ts `internalLinks`):
 * decisions about them are internal even when their own row carries no Area (rows created before Core recorded one).
 */
export function deriveCommand(s: Snapshot, rel: Reliability | null, now: number, snapshotAt: number | null = now, internalLinked: Set<string> = new Set()): CommandView {
  const internal = new Set(s.areas.filter((a) => a.internal).map((a) => a.id));
  const visible = (areaId: string | null) => !areaId || !internal.has(areaId);
  const names = new Map(s.areas.map((a) => [a.id, a.name]));
  const linked = (...ids: Array<string | null | undefined>) => ids.some((id) => !!id && internalLinked.has(id));
  const needs = s.needsJulian.filter((n) => visible(n.area_id) && !linked(n.id, n.subject?.id, n.followup_id))
    .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999") || a.created_at.localeCompare(b.created_at));
  const waits = s.waits.filter((w) => w.owner === "finagai" && visible(w.area_id) && !linked(w.id, w.opportunity_id, w.project_id) && (w.state === "waiting" || w.state === "open"))
    .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
  const dated = waits.filter((w) => w.due_at);
  const firstDay = dated[0]?.due_at?.slice(0, 10);
  const nextDue = firstDay ? { at: dated[0]!.due_at!, who: [...new Set(dated.filter((w) => w.due_at!.slice(0, 10) === firstDay).map((w) => w.counterparty ?? "someone"))] } : null;
  const problems = s.exceptions.filter((x) => x.owner === "finagai" && x.severity !== "info" && visible(x.area_id));
  const julianProblems = s.exceptions.filter((x) => x.owner === "julian" && visible(x.area_id));
  const tasksRunning = s.tasks.filter((t) => t.status === "active");
  const lastTick = s.eventLoopLastTick;
  const fresh = snapshotAt !== null && now - snapshotAt < FRESH_MS;
  const stalled = fresh && !!lastTick && now - Date.parse(lastTick) > STALL_MS;

  let health: Health; const healthWhy: string[] = [];
  if (julianProblems.length) { health = "attention"; healthWhy.push(...julianProblems.map((x) => x.summary)); }
  else if (rel?.verdict === "degraded" || problems.length || stalled) {
    health = "degraded";
    healthWhy.push(...problems.map((x) => x.summary), ...(rel?.verdict === "degraded" ? rel.why : []), ...(stalled ? ["Finagai's checks have stopped"] : []));
  } else if (!rel) health = "unknown";
  else health = "healthy";

  const areas: AreaRow[] = s.areas.filter((a) => !a.internal).map((area) => {
    const n = needs.filter((x) => x.area_id === area.id).length;
    const w = waits.filter((x) => x.area_id === area.id).length;
    const fact = n ? `${area.health.color} · ${n} need${n === 1 ? "s" : ""} you` : w ? `${w} wait${w === 1 ? "" : "s"}` : area.health.color === "green" ? "quiet" : area.health.color;
    return { area, needs: n, waits: w, fact };
  }).sort((a, b) => (b.needs > 0 ? 1 : 0) - (a.needs > 0 ? 1 : 0) || COLOR_ORDER[a.area.health.color] - COLOR_ORDER[b.area.health.color] || a.area.name.localeCompare(b.area.name));

  const week = now + 7 * 86_400_000;
  const upcoming = [
    ...needs.filter((n) => n.due_at && Date.parse(n.due_at) <= week).map((n) => ({ at: n.due_at!, text: n.summary, yours: true })),
    ...waits.filter((w) => w.due_at && Date.parse(w.due_at) <= week).map((w) => ({ at: w.due_at!, text: w.summary, yours: false })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const byWho = new Map<string, SnapshotWait[]>();
  for (const w of waits) { const k = w.counterparty ?? "Someone"; byWho.set(k, [...(byWho.get(k) ?? []), w]); }

  return {
    needs, waits, nextDue, tasksRunning, problems, rulesArmed: s.rules.filter((r) => r.armed).length, lastTick, stalled,
    health, healthWhy, calm: needs.length === 0 && health === "healthy", areas, upcoming,
    waitingOn: [...byWho.entries()].map(([who, items]) => ({ who, items })),
    areaName: (id) => (id ? names.get(id) ?? null : null),
    internalAreaIds: internal,
  };
}

/** The calm statement's sentences (spec §3.4): only non-zero facts, at most three. */
export function calmSentences(v: CommandView, fmtDay: (iso: string) => string, fmtTime: (iso: string) => string): string[] {
  const out: string[] = [];
  const watching: string[] = [];
  if (v.waits.length) watching.push(`${v.waits.length} wait${v.waits.length === 1 ? "" : "s"} on other people`);
  if (v.tasksRunning.length) watching.push(`${v.tasksRunning.length} Mac task${v.tasksRunning.length === 1 ? "" : "s"}`);
  if (v.rulesArmed) watching.push(`${v.rulesArmed} "tell me when" rule${v.rulesArmed === 1 ? "" : "s"}`);
  if (watching.length) out.push(`Finagai is watching ${joinAnd(watching)}.`);
  else out.push("Finagai has no open work.");
  if (v.nextDue) out.push(`Next due ${fmtDay(v.nextDue.at)} — ${joinAnd(v.nextDue.who)}.`);
  if (v.lastTick) out.push(`Checks every 5 minutes, last at ${fmtTime(v.lastTick)}.`);
  return out.slice(0, 3);
}
export const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "Finagai can / Only you can" (spec §6.4), keyed by the server's fields; null when no mapping exists (never guessed). */
export function canCannot(n: SnapshotNeed): { can: string; only: string } | null {
  if (n.key.startsWith("overdue:")) return { can: "draft the follow-up and send it once you approve; keep watching", only: "decide whether to nudge, wait or let it go" };
  if (n.key.startsWith("career.sync:")) return { can: "keep the job closed and record the evidence", only: "decide whether this is a new application" };
  if (n.key.startsWith("exception:")) return n.needs === "judgment" ? { can: "keep retrying and report", only: "decide to keep trying or have it fixed" } : { can: "keep everything else running", only: "clear it — it needs your account, money or hands" };
  if (n.key.startsWith("lesson:")) return { can: "keep the lesson advisory", only: "approve or reject the change" };
  if (/offer/i.test(n.summary) && n.key.startsWith("followup:")) return { can: "gather the offer details and deadline", only: "accept, negotiate or decline" };
  // a Mac task waiting for Julian (Core escalation, hotfix 45): the step waits; the Mac helper prompted him in Messages
  if (/^mac:\d+:step:/.test(n.key)) return n.needs === "principal_reserved"
    ? { can: "prepare the step and hold it — nothing goes out as you until you approve", only: "approve or decline the step (reply in Messages)" }
    : { can: "run the step once you approve it, then check the result", only: "approve or decline the step (reply in Messages)" };
  if (n.key.startsWith("mac:")) return { can: "keep the task paused and pick it up when you answer", only: "answer, resume or stop the task (in Messages)" };
  return null;
}
export const NEEDS_LABEL: Record<SnapshotNeed["needs"], string> = { judgment: "Your decision", authorization: "Your approval", principal_reserved: "Only you can do this" };
