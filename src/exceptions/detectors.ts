/**
 * Phase 7 (ADR-086) — what "going wrong" means, as code. Each detector reads current state (never a model's opinion)
 * and returns the exceptions that hold RIGHT NOW; a condition that clears simply stops being returned and the store
 * resolves it. Every exception says who owns it:
 *   owner 'finagai' — Finagai keeps working it (a named remedy, retries); Julian hears about it only if it outlives
 *                     Finagai's remedies (escalateAfterMin) — then as a judgment call, never as a chore
 *   owner 'julian'  — only Julian can clear it (re-authorize an account, raise a budget ceiling, wake the Mac, review)
 */
import type pg from "pg";
import { areaHealth } from "../cos/areas.js";

type Db = Pick<pg.Pool, "query">;
export type Severity = "info" | "warning" | "critical";
export interface Detected {
  key: string; detector: string; areaId?: string | null; owner: "finagai" | "julian"; severity: Severity;
  needs?: "judgment" | "authorization" | "principal_reserved"; summary: string; detail?: string;
  /** a Finagai-owned remedy (see remedies.ts) */
  remediation?: string;
  /** Finagai-owned: if still open after this long, Julian is asked (judgment) whether to keep trying or have it fixed */
  escalateAfterMin?: number;
}
export interface BudgetReading { monthToDateUsd: number; targetUsd: number; ceilingUsd: number }
export interface DetectorDeps { budget?: () => Promise<BudgetReading> }
type Detector = (db: Db, now: Date, deps: DetectorDeps) => Promise<Detected[]>;
/** Set once at Core startup (it holds the configured ceiling); every tick in the process — interval, manual, preview —
 *  then reads the same meter. Without it the budget detector reports itself unavailable (never "cleared"). */
let processBudget: DetectorDeps["budget"] | undefined;
export const setBudgetReader = (fn: DetectorDeps["budget"]) => { processBudget = fn; };
export const budgetReader = () => processBudget;

const MIN = 60_000;
const AUTH = /invalid_grant|unauthori[sz]ed|\b401\b|\b403\b|token (?:has been )?(?:expired|revoked)|not connected|re-?auth|consent/i;
const BENIGN = /more than \d+ new messages/i;
const ago = (now: Date, d: Date | string) => Math.round((now.getTime() - new Date(d).getTime()) / MIN);
const hhmm = (m: number) => (m >= 1440 ? `${Math.round(m / 1440)} d` : m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);

/** A source Finagai watches keeps failing. Auth problems are Julian's (only he can re-authorize); others are Finagai's. */
export const watcherFailing: Detector = async (db) => {
  const ticks = (await db.query(`SELECT started_at, stats FROM event_tick WHERE status IN ('done','failed') ORDER BY started_at DESC LIMIT 12`)).rows;
  const byWatcher = new Map<string, Array<{ at: Date; problems: string[] }>>();
  for (const t of ticks) for (const w of (t.stats?.watchers ?? []) as Array<{ name: string; polled: boolean; problems: string[] }>) {
    if (!w.polled) continue;
    byWatcher.set(w.name, [...(byWatcher.get(w.name) ?? []), { at: t.started_at, problems: (w.problems ?? []).filter((p) => !BENIGN.test(p)) }]);
  }
  const out: Detected[] = [];
  for (const [name, polls] of byWatcher) {
    let streak = 0;
    for (const p of polls) { if (p.problems.length) streak++; else break; }       // newest first: consecutive failing polls
    if (streak < 3) continue;
    const problem = polls[0]!.problems[0]!;
    const since = polls[streak - 1]!.at;
    if (AUTH.test(problem))
      out.push({ key: `watcher:${name}:auth`, detector: "watcher_failing", owner: "julian", severity: "critical", needs: "principal_reserved",
        summary: `Finagai can't read ${name} — the account needs to be re-authorized (only you can do that)`, detail: `${streak} failed polls since ${new Date(since).toISOString()}: ${problem.slice(0, 200)}` });
    else
      out.push({ key: `watcher:${name}`, detector: "watcher_failing", owner: "finagai", severity: "warning", escalateAfterMin: 24 * 60,
        summary: `${name} watcher failing (${streak} polls in a row) — Finagai keeps retrying`, detail: problem.slice(0, 300) });
  }
  return out;
};

/** A workflow failed on its last 3 runs (its events are kept and retried, but nothing is being handled). */
export const workflowFailing: Detector = async (db) => {
  const ticks = (await db.query(`SELECT stats FROM event_tick WHERE status IN ('done','failed') AND stats ? 'workflows' ORDER BY started_at DESC LIMIT 30`)).rows;
  const runs = new Map<string, Array<{ ok: boolean; error: string | null }>>();
  for (const t of ticks) for (const w of (t.stats.workflows ?? []) as Array<{ name: string; ok: boolean; error: string | null }>) runs.set(w.name, [...(runs.get(w.name) ?? []), w]);
  const out: Detected[] = [];
  for (const [name, r] of runs) if (r.length >= 3 && r.slice(0, 3).every((x) => !x.ok))
    out.push({ key: `workflow:${name}`, detector: "workflow_failing", owner: "finagai", severity: "warning", escalateAfterMin: 12 * 60,
      summary: `Workflow ${name} failed its last ${r.findIndex((x) => x.ok) < 0 ? r.length : r.findIndex((x) => x.ok)} runs — its events are kept and retried`, detail: String(r[0]!.error ?? "").slice(0, 300) });
  return out;
};

/** Events that exhausted their retries: nothing will handle them unless they are requeued. */
export const deadLetters: Detector = async (db) => {
  const r = (await db.query(`SELECT count(*)::int AS n, min(received_at) AS oldest, (array_agg(DISTINCT left(reason, 160)))[1:3] AS reasons FROM inbound_event WHERE status = 'failed' AND attempts >= 5`)).rows[0];
  if (!r?.n) return [];
  return [{ key: "events:dead_letter", detector: "dead_letter", owner: "finagai", severity: "warning", remediation: "requeue_dead_events", escalateAfterMin: 24 * 60,
    summary: `${r.n} event(s) gave up after 5 attempts (oldest ${new Date(r.oldest).toISOString().slice(0, 10)}) — Finagai requeues them once their workflow works again`, detail: (r.reasons ?? []).join(" | ") }];
};

/** Model spend near the hard ceiling. Only Julian can raise the ceiling (governance; never learned or automated). */
export const budget: Detector = async (_db, _now, deps) => {
  const read = deps.budget ?? processBudget;
  if (!read) throw new Error("budget meter unavailable in this process");
  const b = await read();
  const share = b.ceilingUsd > 0 ? b.monthToDateUsd / b.ceilingUsd : 0;
  const money = `$${b.monthToDateUsd.toFixed(2)} of the $${b.ceilingUsd.toFixed(2)} monthly ceiling`;
  if (share >= 0.95) return [{ key: "budget:ceiling", detector: "budget", owner: "julian", severity: "critical", needs: "principal_reserved",
    summary: `Model spend is ${money} — at the ceiling Finagai stops calling models; only you can raise it`, detail: `target $${b.targetUsd}` }];
  if (share >= 0.8) return [{ key: "budget:near", detector: "budget", owner: "finagai", severity: "info",
    summary: `Model spend is ${money} (${Math.round(100 * share)}%) — Finagai is watching it`, detail: `target $${b.targetUsd}` }];
  return [];
};

/** A notice to Julian could not be delivered (he may be missing something). */
export const deliveryFailing: Detector = async (db, now) => {
  const rows = (await db.query(`SELECT purpose, status, created_at, last_error FROM outbound_delivery
      WHERE (status = 'failed' AND created_at > $1::timestamptz - interval '48 hours') OR (status = 'pending' AND created_at < $1::timestamptz - interval '30 minutes' AND created_at > $1::timestamptz - interval '48 hours')
      ORDER BY created_at DESC LIMIT 10`, [now])).rows;
  if (!rows.length) return [];
  return [{ key: "delivery:failing", detector: "delivery_failing", owner: "finagai", severity: "critical",
    summary: `${rows.length} notice(s) to you could not be delivered (latest: ${rows[0].purpose}, ${ago(now, rows[0].created_at)} min ago) — shown here instead`,
    detail: rows.map((r) => `${r.purpose} ${r.status}: ${String(r.last_error ?? "").slice(0, 80)}`).join(" | ") }];
};

/** An Area breaches its service levels. Finagai reconciles first; it reaches Julian only if the breach persists. */
export const areaBreach: Detector = async (db) => {
  const out: Detected[] = [];
  for (const a of (await db.query(`SELECT id FROM area WHERE archived_at IS NULL AND status = 'active'`)).rows) {
    const h = await areaHealth(db as pg.Pool, a.id);
    if (!h || h.healthy) continue;
    // Overdue follow-ups are already escalated one by one to whoever owns them (engine.stateNeeds) — repeating them
    // here would double-ask Julian. What is Finagai's at Area level: projects left without a next step.
    const mine = h.breaches.filter((b) => /no next action/.test(b));
    if (!mine.length) continue;
    out.push({ key: `area:${a.id}`, detector: "area_breach", areaId: a.id, owner: "finagai", severity: "warning", remediation: "reconcile_area", escalateAfterMin: 24 * 60,
      summary: `${h.name} is red: ${mine.join("; ")} — Finagai is reconciling it`, detail: h.breaches.join("; ") });
  }
  return out;
};

/** The Mac is unreachable while work waits for it. Waking it is physical — only Julian. */
export const macOffline: Detector = async (db, now) => {
  const m = (await db.query(`SELECT last_heartbeat_at FROM mac_runtime WHERE id = 'primary'`)).rows[0];
  if (!m) return [];
  const off = ago(now, m.last_heartbeat_at);
  if (off < 30) return [];
  const waiting = (await db.query(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM control_task WHERE status = 'active' AND created_at < $1::timestamptz - interval '15 minutes'`, [now])).rows[0];
  if (!waiting?.n) return [{ key: "mac:offline", detector: "mac_offline", owner: "finagai", severity: "info", summary: `Your Mac has been unreachable for ${hhmm(off)} — no Mac work is waiting` }];
  return [{ key: "mac:offline:work", detector: "mac_offline", owner: "julian", severity: "warning", needs: "principal_reserved",
    summary: `Your Mac has been unreachable for ${hhmm(off)} and ${waiting.n} Mac task(s) are waiting — wake it / open the Finagai helper (only you can)`,
    detail: `oldest waiting task created ${new Date(waiting.oldest).toISOString()}` }];
};

/** A Mac task that stopped making progress (its lease ran out and nobody resumed it). */
export const stuckTasks: Detector = async (db, now) => {
  const rows = (await db.query(`SELECT code, request, last_progress_at FROM control_task WHERE status = 'active' AND claimed_at IS NOT NULL
      AND COALESCE(last_progress_at, claimed_at) < $1::timestamptz - interval '60 minutes' ORDER BY code LIMIT 10`, [now])).rows;
  return rows.map((t) => ({ key: `task:${t.code}:stuck`, detector: "stuck_task", owner: "finagai" as const, severity: "warning" as const, escalateAfterMin: 6 * 60,
    summary: `Mac task ${t.code} has made no progress for ${hhmm(ago(now, t.last_progress_at ?? now))} — Finagai keeps it leased for resumption`, detail: String(t.request).slice(0, 160) }));
};

/** Results Finagai could not verify and that wait for Julian's review. */
export const reviewBacklog: Detector = async (db, now) => {
  const rows = (await db.query(`SELECT code, result_summary, updated_at FROM control_task WHERE verification_status = 'needs_review' AND status IN ('done','failed')
      AND updated_at < $1::timestamptz - interval '24 hours' AND updated_at > $1::timestamptz - interval '14 days' ORDER BY code LIMIT 10`, [now])).rows;
  return rows.map((t) => ({ key: `task:${t.code}:review`, detector: "review_backlog", owner: "julian" as const, severity: "info" as const, needs: "judgment" as const,
    summary: `Task ${t.code}'s result could not be verified automatically — your review decides whether it counts: ${String(t.result_summary ?? "").slice(0, 120)}` }));
};

export const DETECTORS: Record<string, Detector> = { watcherFailing, workflowFailing, deadLetters, budget, deliveryFailing, areaBreach, macOffline, stuckTasks, reviewBacklog };
