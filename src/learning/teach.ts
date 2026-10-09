/**
 * Phase 6 (ADR-085) — what Julian tells Finagai directly (STATED lessons) and what he tells it to forget.
 * A stated lesson passes the same whitelist as everything else: Julian cannot, through teaching, relax approvals,
 * verification, commitments or secrets handling — those change only through governance.
 */
import type pg from "pg";
import { createHash } from "node:crypto";
import { appendEvent } from "../db/index.js";
import { EffectRejected, validateEffect, type Effect } from "./guard.js";

type Db = Pick<pg.Pool, "query">;
export type Teaching =
  | { kind: "ignore_sender"; sender: string; said?: string }
  | { kind: "route_sender"; sender: string; workflow: string; said?: string }
  | { kind: "hint"; text: string; match?: string[]; said?: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cleanSender = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).toLowerCase().trim().replace(/^@/, "");

export async function teachFinagai(db: Db, t: Teaching, ctx: { allowedWorkflows: string[]; client?: string; now?: Date }) {
  const now = ctx.now ?? new Date();
  let effect: Effect; let key: string; let statement: string; let scope: string; let kind: "correction" | "preference";
  if (t.kind === "ignore_sender" || t.kind === "route_sender") {
    const sender = cleanSender(t.sender);
    if (t.kind === "route_sender" && !ctx.allowedWorkflows.includes(t.workflow)) return { error: `"${t.workflow}" is not an Area workflow. Known: ${ctx.allowedWorkflows.join(", ") || "none"}.` };
    effect = t.kind === "ignore_sender" ? { type: "routing_override", sender, action: "ignore" } : { type: "routing_override", sender, action: "route", workflow: t.workflow };
    key = `stated:route:${sender}`; scope = `sender:${sender}`; kind = "correction";
    statement = t.kind === "ignore_sender" ? `Julian said mail from ${sender} is not for any Area (Finagai's waits and deadlines still see it).` : `Julian said mail from ${sender} belongs to ${t.workflow}.`;
  } else {
    effect = { type: "planner_hint", match: (t.match ?? []).map((m) => m.toLowerCase()), text: t.text };
    key = `stated:hint:${sha(t.text.toLowerCase().replace(/\s+/g, " ").trim())}`; scope = "j6.planner"; kind = "preference";
    statement = `Julian said: ${t.text.replace(/\s+/g, " ").trim()}`;
  }
  try { effect = validateEffect(effect, "stated"); }
  catch (e) {
    if (!(e instanceof EffectRejected)) throw e;
    return { error: `Not learned: ${e.message}. Learning can't change approvals, verification, commitments or credentials — those only change through governance.` };
  }
  const evidence = { source: `Julian (${ctx.client ?? "chat"})`, said: (t.said ?? "").slice(0, 400), at: now.toISOString() };
  const r = await db.query(`INSERT INTO lesson (key, kind, basis, scope, statement, effect, support, positives, confidence, evidence, first_seen_at, last_evidence_at, status, created_at, updated_at)
      VALUES ($1, $2, 'stated', $3, $4, $5::jsonb, 1, 1, 1, $6::jsonb, $7, $7, 'active', $7, $7)
      ON CONFLICT (key) DO UPDATE SET statement = EXCLUDED.statement, effect = EXCLUDED.effect, support = lesson.support + 1, evidence = EXCLUDED.evidence,
        last_evidence_at = EXCLUDED.last_evidence_at, status = 'active', retired_reason = NULL, updated_at = EXCLUDED.updated_at
      RETURNING id, (xmax = 0) AS created`, [key, kind, scope, statement, JSON.stringify(effect), JSON.stringify(evidence), now]);
  await appendEvent(db, { actor: "julian", action: "lesson_stated", entityType: "lesson", entityId: String(r.rows[0].id), after: { key, statement, effect }, ...(ctx.client ? { client: ctx.client } : {}) });
  return { learned: statement, key, basis: "stated (Julian said so)", applies: "now", created: !!r.rows[0].created };
}

/** Stop using a lesson. History is kept; a forgotten lesson is never revived by a learner (only by Julian re-teaching). */
export async function forgetLesson(db: Db, key: string, reason: string, now = new Date()) {
  const l = (await db.query(`SELECT id, statement, status, proposal_id FROM lesson WHERE key = $1`, [key])).rows[0];
  if (!l) return { error: `No lesson "${key}". Use lessons to see their keys.` };
  if (l.proposal_id) await db.query(`UPDATE proposal SET status = 'superseded', updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'pending'`, [l.proposal_id]);
  await db.query(`UPDATE lesson SET status = 'retired', retired_reason = $2, updated_at = $3 WHERE id = $1`, [l.id, `forgotten by Julian: ${reason.slice(0, 200)}`, now]);
  await appendEvent(db, { actor: "julian", action: "lesson_forgotten", entityType: "lesson", entityId: String(l.id), after: { key, reason: reason.slice(0, 200), was: l.status } });
  return { forgotten: l.statement, was: l.status, note: l.status === "approved" ? "the approved change no longer applies; the Area is back on its default for it" : "no longer used" };
}
