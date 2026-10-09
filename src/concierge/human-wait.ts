/**
 * Phase 0C (ADR-076) — waiting for Julian is an explicit, durable, EXPIRING lifecycle.
 *
 * Live defect (audit 2026-10-09): tasks #104/#113 sat in waiting_approval for 4+ days while their interactions
 * said "executing". Now:
 *   enter  -> control_task {awaiting_since, awaiting_kind, awaiting_reason, expires_at}; interaction 'awaiting_human'
 *   remind -> at most POLICY[kind].remindAfter.length reminders (delivered by the Mac helper over iMessage)
 *   expire -> task 'expired' (resumable), proposed steps 'expired', interaction 'expired' with a concrete reason
 *   resume -> "resume <code>" or a late "ok <step>" reopens the SAME task + interaction (no duplicate); the stale
 *             step is not executed — the planner re-observes first, because the screen has moved on.
 * Waiting time accumulates in interaction.waiting_human_s, separate from active execution time.
 */
import type pg from "pg";
import { reportLifecycleError } from "../ops/lifecycle-errors.js";

type Db = Pick<pg.Pool, "query">;
export type AwaitingKind = "approval" | "question" | "loop" | "step_limit" | "budget" | "rejected";

const H = 3_600_000;
/** Reminder offsets (from awaiting_since) and expiry, per kind. Bounded: never more reminders than listed. */
export const HUMAN_WAIT_POLICY: Record<AwaitingKind, { remindAfterMs: number[]; expireAfterMs: number }> = {
  approval:   { remindAfterMs: [1 * H, 8 * H], expireAfterMs: 24 * H },
  question:   { remindAfterMs: [2 * H, 20 * H], expireAfterMs: 48 * H },
  loop:       { remindAfterMs: [2 * H], expireAfterMs: 24 * H },
  step_limit: { remindAfterMs: [2 * H], expireAfterMs: 24 * H },
  budget:     { remindAfterMs: [], expireAfterMs: 72 * H },
  rejected:   { remindAfterMs: [], expireAfterMs: 12 * H },
};

const TERMINAL_IX = `('completed','failed','superseded','expired','cancelled')`;

/** Task starts waiting for Julian. `status` is the control_task status that represents the wait. */
export async function enterAwaitingHuman(db: Db, taskId: string, kind: AwaitingKind, reason: string, status: "waiting_approval" | "paused" = "waiting_approval"): Promise<void> {
  const ms = HUMAN_WAIT_POLICY[kind].expireAfterMs;
  await db.query(
    `UPDATE control_task SET status = $2, awaiting_since = COALESCE(awaiting_since, now()), awaiting_kind = $3, awaiting_reason = $4,
            expires_at = COALESCE(awaiting_since, now()) + ($5 || ' milliseconds')::interval, updated_at = now()
      WHERE id = $1`, [taskId, status, kind, reason.slice(0, 500), String(ms)]);
  await db.query(
    `UPDATE interaction SET state = 'awaiting_human', awaiting_since = COALESCE(awaiting_since, now()), progress_note = $2, updated_at = now()
      WHERE $1 = ANY(task_ids) AND state NOT IN ${TERMINAL_IX}`, [taskId, `Waiting for Julian (${kind}): ${reason}`.slice(0, 500)]);
}

/** Julian answered (approve/reject/resume): the wait ends, its duration is accounted, execution resumes. */
export async function leaveAwaitingHuman(db: Db, taskId: string, opts: { intervention?: boolean } = {}): Promise<void> {
  await db.query(
    `UPDATE interaction SET state = CASE WHEN state IN ('awaiting_human','expired','resumable') THEN 'executing' ELSE state END,
            waiting_human_s = waiting_human_s + COALESCE(extract(epoch FROM now() - awaiting_since), 0),
            awaiting_since = NULL, user_interventions = user_interventions + $2, completed_at = NULL,
            terminal_reason = CASE WHEN terminal_reason = 'awaiting_human_expired' THEN NULL ELSE terminal_reason END,
            updated_at = now()
      WHERE $1 = ANY(task_ids) AND state NOT IN ('completed','failed','superseded','cancelled')`, [taskId, opts.intervention === false ? 0 : 1]);
  await db.query(
    `UPDATE control_task SET awaiting_since = NULL, awaiting_kind = NULL, awaiting_reason = NULL, expires_at = NULL,
            reminders_sent = 0, last_reminded_at = NULL WHERE id = $1`, [taskId]);
}

export type Reminder = { taskCode: number; stepCode: number | null; kind: AwaitingKind; text: string };

/**
 * Sweep human waits: due reminders (returned for delivery; counted only when `deliver` is true, i.e. a helper
 * that can actually send them asked) and expiries. Safe to run often (heartbeat) and from Core-only paths.
 */
export async function sweepHumanWaits(pool: pg.Pool, opts: { deliver: boolean; now?: Date } = { deliver: false }): Promise<{ reminders: Reminder[]; expired: number }> {
  const now = opts.now ?? new Date();
  const reminders: Reminder[] = [];
  const waiting = await pool.query<{ id: string; code: string; awaiting_since: Date; awaiting_kind: AwaitingKind; awaiting_reason: string | null; reminders_sent: number; expires_at: Date; step_code: string | null }>(
    `SELECT t.id, t.code, t.awaiting_since, t.awaiting_kind, t.awaiting_reason, t.reminders_sent, t.expires_at,
            (SELECT s.code FROM control_step s WHERE s.task_id = t.id AND s.status = 'proposed' ORDER BY s.seq DESC LIMIT 1) AS step_code
       FROM control_task t WHERE t.status IN ('waiting_approval','paused') AND t.awaiting_since IS NOT NULL`);
  let expired = 0;
  for (const t of waiting.rows) {
    try {
      if (new Date(t.expires_at).getTime() <= now.getTime()) {
        await expireTask(pool, t.id, `No answer from Julian for ${Math.round((now.getTime() - new Date(t.awaiting_since).getTime()) / H)}h (${t.awaiting_kind}: ${t.awaiting_reason ?? "waiting"}). Say "resume ${t.code}" to continue from a fresh look at the screen.`);
        expired++;
        continue;
      }
      const policy = HUMAN_WAIT_POLICY[t.awaiting_kind] ?? HUMAN_WAIT_POLICY.approval;
      const due = policy.remindAfterMs[t.reminders_sent];
      if (opts.deliver && due !== undefined && now.getTime() - new Date(t.awaiting_since).getTime() >= due) {
        const r = await pool.query(`UPDATE control_task SET reminders_sent = reminders_sent + 1, last_reminded_at = now() WHERE id = $1 AND reminders_sent = $2 RETURNING id`, [t.id, t.reminders_sent]);
        if (r.rowCount === 1) {
          const step = t.step_code ? Number(t.step_code) : null;
          const left = Math.max(1, Math.round((new Date(t.expires_at).getTime() - now.getTime()) / H));
          const answer = step ? `ok ${step} / no ${step} / stop ${t.code}` : `reply, or stop ${t.code}`;
          reminders.push({ taskCode: Number(t.code), stepCode: step, kind: t.awaiting_kind,
            text: `⏳ Finagai task ${t.code} is still waiting for you: ${(t.awaiting_reason ?? "").slice(0, 200)}\n${answer} — it expires in ~${left}h.` });
        }
      }
    } catch (e) { await reportLifecycleError(pool, "sweepHumanWaits", e, { taskId: t.id }); }
  }
  return { reminders, expired };
}

export async function expireTask(pool: pg.Pool, taskId: string, summary: string): Promise<void> {
  await pool.query(`UPDATE control_task SET status = 'expired', terminal_reason = 'awaiting_human_expired', failure_class = COALESCE(failure_class, 'awaiting_human_expired'),
     result_summary = $2, updated_at = now() WHERE id = $1 AND status IN ('waiting_approval','paused')`, [taskId, summary.slice(0, 1000)]);
  await pool.query(`UPDATE control_step SET status = 'expired' WHERE task_id = $1 AND status = 'proposed'`, [taskId]);
  await pool.query(
    `UPDATE interaction SET state = 'expired', terminal_reason = 'awaiting_human_expired', failure_class = 'awaiting_human_expired',
            waiting_human_s = waiting_human_s + COALESCE(extract(epoch FROM now() - awaiting_since), 0), awaiting_since = NULL,
            result_summary = $2, completed_at = now(), updated_at = now(),
            final_response_status = CASE WHEN conversation = 'chat' THEN 'pending' ELSE final_response_status END
      WHERE $1 = ANY(task_ids) AND state NOT IN ('completed','failed','superseded','cancelled')`, [taskId, summary.slice(0, 1000)]);
  await pool.query(`INSERT INTO event (actor, action, entity_type, entity_id, after) VALUES ('system', 'control_task_expired', 'control_task', $1, $2::jsonb)`,
    [taskId, JSON.stringify({ summary: summary.slice(0, 300) })]);
}

/**
 * Resume a waiting/expired task by code: the same task and interaction continue (never a duplicate). Any stale
 * proposed/expired step is superseded so the planner re-observes before acting.
 */
export async function resumeTask(pool: pg.Pool, code: number): Promise<{ status: "resumed"; taskId: string } | { status: "not_found" | "not_resumable"; state?: string }> {
  const t = (await pool.query<{ id: string; status: string }>(`SELECT id, status FROM control_task WHERE code = $1`, [code])).rows[0];
  if (!t) return { status: "not_found" };
  if (!["expired", "paused", "waiting_approval"].includes(t.status)) return { status: "not_resumable", state: t.status };
  await pool.query(`UPDATE control_step SET status = 'superseded' WHERE task_id = $1 AND status IN ('proposed','expired')`, [t.id]);
  await pool.query(`UPDATE control_task SET status = 'active', resumed_count = resumed_count + 1, terminal_reason = NULL,
     failure_class = CASE WHEN failure_class = 'awaiting_human_expired' THEN NULL ELSE failure_class END,
     claimed_at = NULL, worker_id = NULL, lease_until = NULL, updated_at = now() WHERE id = $1`, [t.id]);
  // The "expired" notice is superseded by the resumed work: it no longer needs delivering.
  await pool.query(`UPDATE interaction SET final_response_status = 'not_needed' WHERE $1 = ANY(task_ids) AND state = 'expired' AND final_response_status = 'pending'`, [t.id]);
  await leaveAwaitingHuman(pool, t.id);
  await pool.query(`INSERT INTO event (actor, action, entity_type, entity_id, after) VALUES ('julian', 'control_task_resumed', 'control_task', $1, $2::jsonb)`,
    [t.id, JSON.stringify({ from: t.status })]);
  return { status: "resumed", taskId: t.id };
}
