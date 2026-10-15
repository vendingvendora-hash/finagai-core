/**
 * ADR-089 hotfix 45 — a Mac task that waits for Julian is an authoritative escalation.
 *
 * Live 2026-10-15: Mac task 137 waited for Julian's approval of a step, yet the Command Center could show "Nothing needs
 * you": Needs you comes only from Core escalations, and a Mac wait never opened one. Now every human wait a Mac task
 * enters (src/concierge/human-wait.ts) has exactly one open escalation for that exact task/step, opened in the same
 * transaction as the wait and resolved in the same transaction as whatever ends it (approved, declined, resumed,
 * cancelled, expired). The event loop re-derives the same needs from state each tick (stateNeeds) as a safety net, with
 * the same deterministic key — so the pair never duplicates and never outlives the wait.
 *
 * `needs` follows the existing authority policy (src/governance/authority.ts), no new class:
 *   step approval, EXTERNAL_COMMITMENT (it goes out as Julian)   → principal_reserved
 *   step approval, any other class (HIGH_RISK, PREPARATORY, …)    → authorization
 *   a question / a loop / the step limit / waiting after a "no"  → judgment
 * A Finagai-owned wait never escalates: only rows in Julian's human-wait lifecycle (awaiting_kind set) qualify, and the
 * 'budget' kind is excluded because the budget ceiling is already its own escalation (exceptions/detectors.ts budget).
 * The Mac helper already prompts Julian in Messages for each of these waits (and reminds him), so the escalation is
 * recorded as notified: it is authoritative state for Needs you, not a second notification channel.
 */
import type pg from "pg";
import { appendEvent } from "../db/index.js";
import { recordTransition, rowState } from "../db/state-events.js";
import type { EscalationNeed } from "../events/types.js";

type Db = Pick<pg.Pool, "query">;
export const MAC_KEY_PREFIX = "mac:";
export const PROMPTED_BY_MAC_HELPER = "prompted in Messages by the Mac helper";

interface WaitRow { id: string; code: string; awaiting_kind: string; awaiting_reason: string | null; awaiting_since: Date; step_code: string | null; step_summary: string | null; authority_class: string | null }

const SELECT_WAITS = `SELECT t.id, t.code, t.awaiting_kind, t.awaiting_reason, t.awaiting_since,
       s.code AS step_code, s.summary AS step_summary, s.authority_class
  FROM control_task t
  LEFT JOIN LATERAL (SELECT code, summary, authority_class FROM control_step WHERE task_id = t.id AND status = 'proposed' ORDER BY seq DESC LIMIT 1) s ON t.awaiting_kind = 'approval'
 WHERE t.status IN ('waiting_approval','paused') AND t.awaiting_since IS NOT NULL AND t.awaiting_kind IS NOT NULL AND t.awaiting_kind <> 'budget'`;

/** The escalation a waiting task needs (null when it does not wait for Julian, or an approval has no proposed step). */
export function macWaitNeed(t: WaitRow): EscalationNeed | null {
  const code = Number(t.code);
  const subject = { type: "control_task", id: t.id };
  if (t.awaiting_kind === "approval") {
    if (!t.step_code) return null;
    const step = Number(t.step_code);
    return { key: `${MAC_KEY_PREFIX}${code}:step:${step}@control_task:${t.id}`, subject, areaId: null, prompted: true,
      needs: t.authority_class === "EXTERNAL_COMMITMENT" ? "principal_reserved" : "authorization",
      summary: `Mac task ${code} is waiting for your approval — step ${step}: ${String(t.step_summary ?? t.awaiting_reason ?? "").slice(0, 300)}. Reply "ok ${step}" or "no ${step}" in Messages, or "stop ${code}".`,
      detail: `Authority class ${t.authority_class ?? "unknown"}. ${PROMPTED_BY_MAC_HELPER}.` };
  }
  const since = new Date(t.awaiting_since).getTime();
  const what = t.awaiting_kind === "question" ? "is waiting for your answer" : t.awaiting_kind === "rejected" ? "is waiting for your direction after you declined a step" : "paused and is waiting for you";
  return { key: `${MAC_KEY_PREFIX}${code}:${t.awaiting_kind}:${since}@control_task:${t.id}`, subject, areaId: null, needs: "judgment", prompted: true,
    summary: `Mac task ${code} ${what} — ${String(t.awaiting_reason ?? "").slice(0, 300)}. Reply in Messages, "resume ${code}" or "stop ${code}".`,
    detail: `${PROMPTED_BY_MAC_HELPER}.` };
}

/** Every Mac wait that needs Julian, read from state (the event loop's safety net). */
export async function macWaitNeeds(db: Db): Promise<EscalationNeed[]> {
  return (await db.query<WaitRow>(SELECT_WAITS)).rows.map(macWaitNeed).filter((n): n is EscalationNeed => n !== null);
}

/** Open the escalation for one task's current wait, at the moment it starts waiting. Idempotent (key is unique). */
export async function openMacWaitEscalation(db: Db, taskId: string, causeIds: number[]): Promise<string | null> {
  const t = (await db.query<WaitRow>(`${SELECT_WAITS} AND t.id = $1`, [taskId])).rows[0];
  const n = t ? macWaitNeed(t) : null;
  if (!n) return null;
  const seen = (await db.query(`SELECT id FROM escalation WHERE key = $1`, [n.key])).rows[0];
  if (seen) return String(seen.id);
  const ins = await db.query<{ id: string }>(`INSERT INTO escalation (key, area_id, needs, summary, detail, notified_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (key) DO NOTHING RETURNING id`, [n.key, n.areaId ?? null, n.needs, n.summary.slice(0, 500), n.detail?.slice(0, 1000) ?? null]);
  if (!ins.rowCount) return null;
  const id = String(ins.rows[0]!.id);
  await appendEvent(db, { actor: "cos", action: "escalation_opened", entityType: "escalation", entityId: id, areaId: n.areaId ?? null,
    ...(causeIds.length ? { causeIds } : {}), after: { key: n.key, needs: n.needs, summary: n.summary.slice(0, 300), dueAt: null, notified: PROMPTED_BY_MAC_HELPER } });
  return id;
}

/** Resolve the open escalation(s) of a task's wait, in the transaction that ends the wait. */
export async function resolveMacWaitEscalations(db: Db, taskId: string, resolution: string, causeIds: number[]): Promise<number> {
  const open = (await db.query<{ id: string; key: string; needs: string; summary: string }>(
    `SELECT id, key, needs, summary FROM escalation WHERE status = 'open' AND key LIKE $1`, [`${MAC_KEY_PREFIX}%@control_task:${taskId}`])).rows;
  for (const o of open) {
    const before = await rowState(db, "escalation", o.id);
    await db.query(`UPDATE escalation SET status = 'resolved', resolved_at = now(), resolution = $2 WHERE id = $1 AND status = 'open'`, [o.id, resolution.slice(0, 200)]);
    await recordTransition(db, { actor: "cos", action: "escalation_resolved", table: "escalation", id: o.id, before, ...(causeIds.length ? { causeIds } : {}),
      context: { key: o.key, needs: o.needs, resolution: resolution.slice(0, 200), summary: o.summary } });
  }
  return open.length;
}
