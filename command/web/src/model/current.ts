/**
 * What is still in progress, from Core's authoritative snapshot only (Slice 3 acceptance invariant 2): a running,
 * waiting, blocked or recovering execution must read in its actual current state — the past-tense story phrasing is
 * for finished work. History never decides this; the snapshot does (needsJulian, tasks, waits, exceptions).
 */
import type { CommandView } from "./command";
import type { LiveEvent, Snapshot } from "./types";
import { openSubjects, type CurrentOf } from "./units";

const NEEDS_PHRASE = { judgment: "waiting for your decision", authorization: "waiting for your approval", principal_reserved: "waiting for you (only you can do this)" } as const;

function macPhrase(key: string): string | null {
  const step = /^mac:\d+:step:(\d+)@/.exec(key)?.[1];
  if (step) return `waiting for your approval of step ${step}`;
  if (/^mac:\d+:question:/.test(key)) return "waiting for your answer";
  if (/^mac:\d+:rejected:/.test(key)) return "waiting for your direction";
  if (/^mac:/.test(key)) return "paused, waiting for you";
  return null;
}

export function currentResolver(snapshot: Snapshot, view: CommandView): CurrentOf {
  const internal = view.internalAreaIds;
  const visible = (areaId: string | null) => !areaId || !internal.has(areaId);
  const needs = view.needs.map((n) => ({ n, subjects: openSubjects([n]) }));
  const tasks = new Map(snapshot.tasks.map((t) => [Number(t.code), t]));   // pg serves a bigint code as a string
  const waits = new Map(snapshot.waits.filter((w) => visible(w.area_id)).map((w) => [`followup:${w.id}`, w]));
  const exceptions = new Map(snapshot.exceptions.filter((x) => visible(x.area_id)).map((x) => [x.key, x]));
  const asOf = snapshot.cursor;
  const resolve: CurrentOf = (subject, evs) => {
    // 1) open in Needs you
    const escIds = new Set(evs.filter((e) => e.domain === "escalation" && e.entity.id).map((e) => `escalation:${e.entity.id}`));
    const need = needs.find(({ subjects }) => subjects.has(subject) || [...escIds].some((id) => subjects.has(id)));
    // 2) a Mac task Core still lists (active / waiting_approval / paused)
    const code = subject.startsWith("control_task:") ? taskCode(subject, evs, view.needs.map((n) => n.key)) : null;
    const task = code !== null ? tasks.get(code) : undefined;
    if (need) {
      return { phrase: macPhrase(need.n.key) ?? NEEDS_PHRASE[need.n.needs], owner: "julian", ...(task ? { request: task.request } : {}) };
    }
    if (task) {
      const waitingOnJulian = !!task.awaiting_kind && task.awaiting_kind !== "budget";
      const phrase = task.status === "active" ? "running" : task.awaiting_kind === "budget" ? "paused until the model budget allows"
        : task.status === "waiting_approval" ? "waiting for approval" : waitingOnJulian ? "paused, waiting for you" : "paused";
      return { phrase, owner: waitingOnJulian ? "julian" : "finagai", request: task.request };
    }
    // 3) a problem Finagai (or Julian) still has open
    for (const e of evs) {
      const key = String(((e.after ?? e.before) as Record<string, unknown> | null)?.key ?? "");
      const x = key ? exceptions.get(key) : undefined;
      if (x) return x.owner === "julian" ? { phrase: "needs you", owner: "julian", about: x.summary } : { phrase: "Finagai is fixing it", owner: "finagai", about: x.summary };
    }
    // 4) a wait still open
    const w = waits.get(subject);
    if (w) {
      const on = w.counterparty && !w.summary.includes(w.counterparty) ? ` on ${w.counterparty}` : "";
      return w.owner === "julian" ? { phrase: "waiting on you", owner: "julian", about: w.summary }
        : { phrase: `still waiting${on}${w.state === "overdue" ? " (overdue)" : ""}`, owner: "finagai", about: w.summary };
    }
    return null;
  };
  return (subject, evs) => { const c = resolve(subject, evs); return c ? { ...c, asOf } : null; };
}

/** A Mac task's number, from what Core recorded about it: an open decision's key, an escalation key, or its creation. */
function taskCode(subject: string, evs: LiveEvent[], openKeys: string[]): number | null {
  const id = subject.slice("control_task:".length);
  for (const key of openKeys) { const k = /^mac:(\d+):.*@control_task:(.+)$/.exec(key); if (k && k[2] === id) return Number(k[1]); }
  for (const e of evs) {
    const a = (e.after ?? e.before ?? {}) as Record<string, unknown>;
    const k = new RegExp(`^mac:(\\d+):.*@control_task:${id}$`).exec(String(a.key ?? ""));
    if (k) return Number(k[1]);
    if (e.entity.type === "control_task" && e.entity.id === id && typeof a.code === "number") return a.code;
  }
  return null;
}
