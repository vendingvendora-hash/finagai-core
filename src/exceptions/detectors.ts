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
import { recurringFailures } from "../live/failures.js";

type Db = Pick<pg.Pool, "query">;
export type Severity = "info" | "warning" | "critical";
export interface Detected {
  key: string; detector: string; areaId?: string | null; owner: "finagai" | "julian"; severity: Severity;
  needs?: "judgment" | "authorization" | "principal_reserved"; summary: string; detail?: string;
  /** a Finagai-owned remedy (see remedies.ts) */
  remediation?: string;
  /** Finagai-owned: if still open after this long, Julian is asked (judgment) whether to keep trying or have it fixed */
  escalateAfterMin?: number;
  /** Phase 8 (ADR-088): the stream events that show the condition (the opened exception cites them as its cause) */
  evidence?: number[];
  /** Phase 8 live (2026-10-13): evidence that is not an event (the event loop's own tick ledger, the spend meter) is
   *  named here instead and recorded on exception_opened, so every detector-opened exception says what tripped it */
  evidenceRefs?: Record<string, unknown>;
}
const ids = (rows: Array<{ id: unknown }>) => rows.map((r) => Number(r.id));
const lastEventAbout = async (db: Db, type: string, id: string) => ids((await db.query(`SELECT id FROM event WHERE entity_type = $1 AND entity_id = $2::uuid ORDER BY id DESC LIMIT 1`, [type, id])).rows);
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
  const ticks = (await db.query(`SELECT id, started_at, stats FROM event_tick WHERE status IN ('done','failed') ORDER BY started_at DESC LIMIT 12`)).rows;
  const byWatcher = new Map<string, Array<{ tick: string; at: Date; problems: string[] }>>();
  for (const t of ticks) for (const w of (t.stats?.watchers ?? []) as Array<{ name: string; polled: boolean; problems: string[] }>) {
    if (!w.polled) continue;
    byWatcher.set(w.name, [...(byWatcher.get(w.name) ?? []), { tick: String(t.id), at: t.started_at, problems: (w.problems ?? []).filter((p) => !BENIGN.test(p)) }]);
  }
  const out: Detected[] = [];
  for (const [name, polls] of byWatcher) {
    let streak = 0;
    for (const p of polls) { if (p.problems.length) streak++; else break; }       // newest first: consecutive failing polls
    if (streak < 3) continue;
    const problem = polls[0]!.problems[0]!;
    const since = polls[streak - 1]!.at;
    // the failing polls are rows of the event loop's tick ledger; any stream events those ticks wrote are cited too
    const failing = polls.slice(0, streak).map((p) => p.tick);
    const evidence = ids((await db.query(`SELECT id FROM event WHERE correlation_id::text = ANY($1::text[]) AND action = 'work_invoked' ORDER BY id DESC LIMIT 5`, [failing])).rows);
    const evidenceRefs = { failingTicks: failing.slice(0, 5), problem: problem.slice(0, 200) };
    if (AUTH.test(problem))
      out.push({ key: `watcher:${name}:auth`, detector: "watcher_failing", owner: "julian", severity: "critical", needs: "principal_reserved",
        summary: `Finagai can't read ${name} — the account needs to be re-authorized (only you can do that)`, detail: `${streak} failed polls since ${new Date(since).toISOString()}: ${problem.slice(0, 200)}`, evidence, evidenceRefs });
    else
      out.push({ key: `watcher:${name}`, detector: "watcher_failing", owner: "finagai", severity: "warning", escalateAfterMin: 24 * 60,
        summary: `${name} watcher failing (${streak} polls in a row) — Finagai keeps retrying`, detail: problem.slice(0, 300), evidence, evidenceRefs });
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
      summary: `Workflow ${name} failed its last ${r.findIndex((x) => x.ok) < 0 ? r.length : r.findIndex((x) => x.ok)} runs — its events are kept and retried`, detail: String(r[0]!.error ?? "").slice(0, 300),
      evidence: ids((await db.query(`SELECT id FROM event WHERE action = 'workflow_failed' AND after->>'workflow' = $1 ORDER BY id DESC LIMIT 3`, [name])).rows) });
  return out;
};

/** Events that exhausted their retries: nothing will handle them unless they are requeued. */
export const deadLetters: Detector = async (db) => {
  const r = (await db.query(`SELECT count(*)::int AS n, min(received_at) AS oldest, (array_agg(DISTINCT left(reason, 160)))[1:3] AS reasons FROM inbound_event WHERE status = 'failed' AND attempts >= 5`)).rows[0];
  if (!r?.n) return [];
  // the dead events themselves, as they appear on the stream (their last event: the failed routing / workflow)
  const evidence = ids((await db.query(`SELECT max(e.id) AS id FROM inbound_event i JOIN event e ON e.entity_type = 'inbound_event' AND e.entity_id = i.id
      WHERE i.status = 'failed' AND i.attempts >= 5 GROUP BY i.id ORDER BY 1 DESC LIMIT 5`)).rows);
  return [{ key: "events:dead_letter", evidence, detector: "dead_letter", owner: "finagai", severity: "warning", remediation: "requeue_dead_events", escalateAfterMin: 24 * 60,
    summary: `${r.n} event(s) gave up after 5 attempts (oldest ${new Date(r.oldest).toISOString().slice(0, 10)}) — Finagai requeues them once their workflow works again`, detail: (r.reasons ?? []).join(" | ") }];
};

/** Model spend near the hard ceiling. Only Julian can raise the ceiling (governance; never learned or automated). */
export const budget: Detector = async (_db, _now, deps) => {
  const read = deps.budget ?? processBudget;
  if (!read) throw new Error("budget meter unavailable in this process");
  const b = await read();
  const share = b.ceilingUsd > 0 ? b.monthToDateUsd / b.ceilingUsd : 0;
  const money = `$${b.monthToDateUsd.toFixed(2)} of the $${b.ceilingUsd.toFixed(2)} monthly ceiling`;
  const evidenceRefs = { meter: { monthToDateUsd: b.monthToDateUsd, targetUsd: b.targetUsd, ceilingUsd: b.ceilingUsd, share: Math.round(share * 1000) / 1000 } };
  if (share >= 0.95) return [{ key: "budget:ceiling", detector: "budget", owner: "julian", severity: "critical", needs: "principal_reserved", evidenceRefs,
    summary: `Model spend is ${money} — at the ceiling Finagai stops calling models; only you can raise it`, detail: `target $${b.targetUsd}` }];
  if (share >= 0.8) return [{ key: "budget:near", detector: "budget", owner: "finagai", severity: "info", evidenceRefs,
    summary: `Model spend is ${money} (${Math.round(100 * share)}%) — Finagai is watching it`, detail: `target $${b.targetUsd}` }];
  return [];
};

/** A notice to Julian could not be delivered (he may be missing something). */
export const deliveryFailing: Detector = async (db, now) => {
  const rows = (await db.query(`SELECT purpose, status, created_at, last_error FROM outbound_delivery
      WHERE (status = 'failed' AND created_at > $1::timestamptz - interval '48 hours') OR (status = 'pending' AND created_at < $1::timestamptz - interval '30 minutes' AND created_at > $1::timestamptz - interval '48 hours')
      ORDER BY created_at DESC LIMIT 10`, [now])).rows;
  if (!rows.length) return [];
  const evidence = ids((await db.query(`SELECT id FROM event WHERE action = 'notification_suppressed' AND occurred_at > $1::timestamptz - interval '48 hours' AND COALESCE(after->>'reason', '') NOT ILIKE '%quiet hours%' ORDER BY id DESC LIMIT 5`, [now])).rows);
  return [{ key: "delivery:failing", detector: "delivery_failing", owner: "finagai", severity: "critical", evidence,
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
    // the Area turning red on the stream, and the latest change to each active project in it with no next step
    const evidence = ids((await db.query(`(SELECT id FROM event WHERE action = 'area_health_changed' AND entity_id = $1::uuid ORDER BY id DESC LIMIT 1)
        UNION (SELECT max(e.id) AS id FROM project p JOIN event e ON e.entity_type = 'project' AND e.entity_id = p.id
          WHERE p.area_id = $1::uuid AND p.archived_at IS NULL AND p.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM work_item t WHERE t.project_id = p.id AND t.status IN ('open','in_progress','waiting'))
            AND NOT EXISTS (SELECT 1 FROM followup f WHERE f.project_id = p.id AND f.state IN ('open','waiting','overdue')) GROUP BY p.id ORDER BY 1 DESC LIMIT 4)`, [a.id])).rows.filter((r) => r.id != null));
    out.push({ key: `area:${a.id}`, detector: "area_breach", areaId: a.id, evidence, owner: "finagai", severity: "warning", remediation: "reconcile_area", escalateAfterMin: 24 * 60,
      summary: `${h.name} is red: ${mine.join("; ")} — Finagai is reconciling it`, detail: h.breaches.join("; ") });
  }
  return out;
};

/**
 * The Mac is unreachable while work waits for it. Waking it is physical — only Julian.
 * Phase 8 (ADR-088, live 2026-10-13): a sleeping Mac with NO work waiting is normal, not an exception. As an "info" note
 * it opened and cleared through the night (macOS dark wakes send a heartbeat every so often; any 30-minute gap reopened
 * it — 7 opens in 24 h before a hysteresis fix, still 2 open/close cycles between 03:34Z and 06:34Z after it). Nothing
 * was ever wrong and no one had anything to do, so it is no longer an exception at all. Julian can still ask to be told
 * ("tell me when the Mac has been offline more than N minutes" — the mac_offline_minutes rule metric).
 */
export const macOffline: Detector = async (db, now) => {
  const m = (await db.query(`SELECT last_heartbeat_at FROM mac_runtime WHERE id = 'primary'`)).rows[0];
  if (!m) return [];
  const off = ago(now, m.last_heartbeat_at);
  if (off < 30) return [];
  const waiting = (await db.query(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM control_task WHERE status = 'active' AND created_at < $1::timestamptz - interval '15 minutes'`, [now])).rows[0];
  if (!waiting?.n) return [];
  // the waiting Mac tasks (their latest event) — what makes a sleeping Mac Julian's problem
  const evidence = ids((await db.query(`SELECT max(e.id) AS id FROM control_task t JOIN event e ON e.entity_type = 'control_task' AND e.entity_id = t.id
      WHERE t.status = 'active' AND t.created_at < $1::timestamptz - interval '15 minutes' GROUP BY t.id ORDER BY 1 DESC LIMIT 5`, [now])).rows);
  return [{ key: "mac:offline:work", evidence, evidenceRefs: { lastHeartbeatAt: new Date(m.last_heartbeat_at).toISOString() }, detector: "mac_offline", owner: "julian", severity: "warning", needs: "principal_reserved",
    summary: `Your Mac has been unreachable for ${hhmm(off)} and ${waiting.n} Mac task(s) are waiting — wake it / open the Finagai helper (only you can)`,
    detail: `oldest waiting task created ${new Date(waiting.oldest).toISOString()}` }];
};

/** A Mac task that stopped making progress (its lease ran out and nobody resumed it). */
export const stuckTasks: Detector = async (db, now) => {
  const rows = (await db.query(`SELECT id, code, request, last_progress_at FROM control_task WHERE status = 'active' AND claimed_at IS NOT NULL
      AND COALESCE(last_progress_at, claimed_at) < $1::timestamptz - interval '60 minutes' ORDER BY code LIMIT 10`, [now])).rows;
  const out: Detected[] = [];
  for (const t of rows) out.push({ key: `task:${t.code}:stuck`, detector: "stuck_task", owner: "finagai", severity: "warning", escalateAfterMin: 6 * 60,
    summary: `Mac task ${t.code} has made no progress for ${hhmm(ago(now, t.last_progress_at ?? now))} — Finagai keeps it leased for resumption`, detail: String(t.request).slice(0, 160),
    evidence: await lastEventAbout(db, "control_task", String(t.id)) });
  return out;
};

/** Results Finagai could not verify. Julian's review is needed only when the task CHANGED something (filled, uploaded,
 *  moved, typed, ran…): only he can accept that change. An unverified answer to a read-only question changed nothing —
 *  that is Finagai's verifier problem, noted but never put on his plate (live 2026-10-11: task 129, "have I received an
 *  update from Beth?", would otherwise have been escalated as "your review decides whether it counts"). */
export const STATE_CHANGING_KINDS = ["browser_fill", "browser_fill_form", "browser_select", "browser_check", "browser_upload", "browser_download", "ax_set_value", "type", "key", "hotkey", "move_file", "trash_file", "run", "drag"];
export const reviewBacklog: Detector = async (db, now) => {
  const rows = (await db.query(`SELECT t.id, t.code, t.result_summary, t.updated_at,
      EXISTS (SELECT 1 FROM control_step s WHERE s.task_id = t.id AND s.status = 'done' AND s.kind = ANY($2::text[])) AS changed
    FROM control_task t WHERE t.verification_status = 'needs_review' AND t.status IN ('done','failed')
      AND t.updated_at < $1::timestamptz - interval '24 hours' AND t.updated_at > $1::timestamptz - interval '14 days' ORDER BY t.code LIMIT 10`, [now, STATE_CHANGING_KINDS])).rows;
  // A read-only one is not an exception at all: nothing is pending for anyone and there is nothing to remedy (the
  // verifier's miss is already in the execution metrics). Listing it would only make "all normal" false.
  const out: Detected[] = [];
  for (const t of rows.filter((x) => x.changed)) out.push({ key: `task:${t.code}:review`, detector: "review_backlog", owner: "julian", severity: "info", needs: "judgment",
    summary: `Task ${t.code} changed something Finagai could not verify — your review decides whether it counts: ${String(t.result_summary ?? "").slice(0, 120)}`,
    evidence: await lastEventAbout(db, "control_task", String(t.id)) });
  return out;
};

/**
 * Phase 8 (ADR-088) — the platform's own guarantees, checked continuously. The engine runs the ADR-087 live self-check
 * hourly and records each verdict on the stream (reliability_checked). A check that FAILED in the two latest runs is an
 * exception (one failure can be a coincidence — e.g. Julian's tool call landing inside the read-only window; two in a
 * row is not). PENDING is never a failure. Finagai cannot fix its own code, so if it persists an hour Julian is asked
 * (judgment) to have it fixed; it clears itself when the check passes again.
 */
export const selfCheck: Detector = async (db, now) => {
  const rows = (await db.query(`SELECT id, after FROM event WHERE action = 'reliability_checked' AND occurred_at > $1::timestamptz - interval '3 hours' ORDER BY id DESC LIMIT 2`, [now])).rows;
  const runs = rows.map((r) => (r.after ?? {}) as { failing?: string[]; version?: string; at?: string });
  if (runs.length < 2) return [];
  const [latest, previous] = runs as [{ failing?: string[]; version?: string }, { failing?: string[] }];
  const evidence = ids(rows);
  return (latest.failing ?? []).filter((c) => (previous.failing ?? []).includes(c)).map((c) => ({
    key: `reliability:${c}`, detector: "self_check", owner: "finagai" as const, severity: "warning" as const, escalateAfterMin: 60,
    summary: `Finagai's live self-check "${c}" failed twice in a row — a platform guarantee (ADR-087) is not holding`,
    detail: `latest run on Core ${latest.version ?? "?"}; see finagai-job: live-acceptance for the evidence`, evidence }));
};

/** Phase 8 (ADR-088, increment 2): the internal state-path canary failed on its two latest daily runs. */
export const canaryFailing: Detector = async (db, now) => {
  const rows = (await db.query(`SELECT id, after FROM event WHERE action = 'canary_ran' AND occurred_at > $1::timestamptz - interval '3 days' ORDER BY id DESC LIMIT 2`, [now])).rows;
  if (rows.length < 2 || rows.some((r) => r.after?.ok !== false)) return [];
  const steps = ((rows[0].after?.steps ?? []) as Array<{ step: string; ok: boolean; problems?: string[] }>).filter((s) => !s.ok);
  return [{ key: "canary:state_path", detector: "canary", owner: "finagai", severity: "warning", escalateAfterMin: 60, evidence: ids(rows),
    summary: `Finagai's daily internal canary failed twice in a row (${steps.map((s) => s.step).join(", ") || "run"}) — a state-change path is not behaving as ADR-087 guarantees`,
    detail: steps.flatMap((s) => s.problems ?? []).join(" | ").slice(0, 900) }];
};

/**
 * Phase 8 (ADR-088, increment 3): failure mining. The other detectors catch a part that is DOWN (failing every time,
 * N in a row). This one catches what keeps failing intermittently — the same class (where + normalized what) at least 3
 * times in 24 h, still happening on the running Core, in Finagai's own machinery — which no single-streak detector sees.
 * Finagai owns it; it reaches Julian only as a "have it fixed" judgment if it persists a day; it clears when the class
 * falls below the threshold. A class another exception already owns is left to that one.
 */
export const failureRecurring: Detector = async (db, now) => (await recurringFailures(db, now)).map((c) => ({
  key: `failure:${c.key}`, detector: "failure_recurring", owner: "finagai" as const, severity: "warning" as const, escalateAfterMin: 24 * 60,
  summary: `${c.source.replace("_", " ")} ${c.subject} keeps failing the same way (${c.last24h}× in 24 h): ${c.example.slice(0, 140)}`,
  detail: `failure class ${c.key} — "${c.signature}"; first seen ${c.firstSeen}, last ${c.lastSeen}; finagai-job: failures for the evidence`,
  evidence: c.evidence, evidenceRefs: { failureClass: c.key, signature: c.signature, last24h: c.last24h, sinceStart: c.sinceStart } }));

export const DETECTORS: Record<string, Detector> = { watcherFailing, workflowFailing, deadLetters, budget, deliveryFailing, areaBreach, macOffline, stuckTasks, reviewBacklog, selfCheck, canaryFailing, failureRecurring };
