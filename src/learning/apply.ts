/**
 * Phase 6 (ADR-085) — where learned lessons are USED. Three narrow doors, nothing else:
 *   guidanceFor   advisory text for the Mac planner (observed hints, Julian's stated hints, Julian-approved procedures)
 *   routingOverride  Julian's stated "ignore / route mail from X" — applied before Area subscriptions
 *   policyFor     an Area's lifecycle policy: code defaults + parameters Julian APPROVED through governance
 * Authority, approvals, verification, secrets, budgets and escalation categories are not reachable from here.
 */
import type pg from "pg";
import { CAREER_POLICY, type LifecyclePolicy } from "../cos/lifecycle.js";
import { decodeEffect, validateEffect, type Effect, EffectRejected } from "./guard.js";

type Db = Pick<pg.Pool, "query">;
const DAY = 86_400_000;
export const HALF_LIFE_DAYS = 30;
export const MIN_FRESHNESS = 0.25;
/** How current the evidence behind a lesson is: 1 = today, halves every 30 days. Stated lessons do not decay. */
export const freshness = (lastEvidenceAt: Date | string, now: Date) => Math.pow(0.5, Math.max(0, now.getTime() - new Date(lastEvidenceAt).getTime()) / DAY / HALF_LIFE_DAYS);

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9_ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));

/** Effects Julian approved: read from the GOVERNED rows (procedure / preference created by the approval), never from
 *  the lesson row — what applies is exactly the text he approved. A forgotten (retired) lesson stops applying. */
async function approvedEffects(db: Db, type: Effect["type"]): Promise<Array<{ key: string; effect: Effect; approvedAt: string }>> {
  const rows = (await db.query(`SELECT DISTINCT ON (l.id) l.key, COALESCE(pr.statement, pc.body) AS text, COALESCE(pr.created_at, pc.created_at) AS at
      FROM lesson l JOIN proposal p ON p.target_type = 'lesson' AND p.target_id = l.id AND p.status = 'approved'
      LEFT JOIN preference pr ON pr.approved_proposal_id = p.id AND pr.archived_at IS NULL
      LEFT JOIN procedure pc ON pc.approved_proposal_id = p.id AND pc.archived_at IS NULL
     WHERE l.status <> 'retired' AND (pr.id IS NOT NULL OR pc.id IS NOT NULL)
     ORDER BY l.id, COALESCE(pr.created_at, pc.created_at) DESC`)).rows;
  const out: Array<{ key: string; effect: Effect; approvedAt: string }> = [];
  for (const r of rows) {
    const e = decodeEffect(String(r.text ?? ""));
    if (!e || e.type !== type) continue;
    try { out.push({ key: r.key, effect: validateEffect(e, "inferred"), approvedAt: new Date(r.at).toISOString() }); }
    catch (err) { if (!(err instanceof EffectRejected)) throw err; }       // re-validated at use: an out-of-bounds row never applies
  }
  return out;
}

export interface Guidance { block: string; keys: string[] }

/** Advisory guidance for one Mac task. Empty when nothing learned is relevant. */
export async function guidanceFor(db: Db, request: string, now: Date = new Date()): Promise<Guidance> {
  const req = words(request);
  const hints = (await db.query(`SELECT key, basis, statement, effect, support, positives, confidence, last_evidence_at FROM lesson
      WHERE status = 'active' AND effect->>'type' = 'planner_hint' ORDER BY confidence DESC, support DESC LIMIT 40`)).rows
    .filter((l) => l.basis === "stated" || freshness(l.last_evidence_at, now) >= MIN_FRESHNESS)
    .map((l) => { try { return { ...l, effect: validateEffect(l.effect as Effect, l.basis) as Extract<Effect, { type: "planner_hint" }> }; } catch { return null; } })
    .filter((l): l is NonNullable<typeof l> => !!l)
    // Julian's stated hints apply when their words match the request (or they named none); observed hints are about
    // step kinds and apply to any task.
    .filter((l) => l.basis !== "stated" || !l.effect.match.length || l.effect.match.some((m: string) => req.has(m.toLowerCase())))
    .slice(0, 5);
  const procs = (await approvedEffects(db, "procedure"))
    .map((p) => ({ ...p, effect: p.effect as Extract<Effect, { type: "procedure" }> }))
    .filter((p) => { const w = p.effect.when.map((x) => x.toLowerCase()); return w.length > 0 && w.filter((x) => req.has(x)).length >= Math.ceil(w.length / 2); })
    .slice(0, 2);
  if (!hints.length && !procs.length) return { block: "", keys: [] };
  const lines = [
    ...hints.map((h) => `- ${h.effect.text} [${h.basis === "stated" ? "Julian said so" : `observed, ${h.positives ?? h.support}/${h.support}, confidence ${Number(h.confidence).toFixed(2)}`}]`),
    ...procs.map((p) => `- Procedure Julian approved (${p.approvedAt.slice(0, 10)}) for "${p.effect.name}":\n${p.effect.steps.map((s, i) => `    ${i + 1}. ${s}`).join("\n")}`),
  ];
  return {
    block: `Learned guidance (advisory, from Finagai's own records and Julian's approvals — your authority, approval, verification and secrets rules are unchanged and always take precedence; ignore a line that does not fit this screen):\n${lines.join("\n")}`,
    keys: [...hints.map((h) => String(h.key)), ...procs.map((p) => p.key)],
  };
}

const emailOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase().trim();

/** Julian's stated routing correction for this mail, if any (exact address first, then its domain). */
export async function routingOverride(db: Db, payload: Record<string, unknown>): Promise<{ key: string; sender: string; action: "ignore" | "route"; workflow?: string } | null> {
  const email = emailOf(String(payload.from ?? ""));
  if (!email.includes("@")) return null;
  const domain = email.split("@")[1]!;
  const rows = (await db.query(`SELECT key, effect FROM lesson WHERE status = 'active' AND basis = 'stated' AND effect->>'type' = 'routing_override' AND effect->>'sender' = ANY($1::text[])`, [[email, domain]])).rows;
  const pick = rows.find((r) => r.effect.sender === email) ?? rows.find((r) => r.effect.sender === domain);
  if (!pick) return null;
  try { const e = validateEffect(pick.effect as Effect, "stated") as Extract<Effect, { type: "routing_override" }>; return { key: pick.key, sender: e.sender, action: e.action, ...(e.workflow ? { workflow: e.workflow } : {}) }; }
  catch { return null; }
}

/** The lifecycle policy for an Area: code defaults, overridden only by parameters Julian approved for that Area. */
export async function policyFor(db: Db, areaId: string | null | undefined): Promise<LifecyclePolicy> {
  const base: LifecyclePolicy = { ...CAREER_POLICY };
  if (!areaId) return base;
  const area = (await db.query(`SELECT name FROM area WHERE id = $1`, [areaId])).rows[0]?.name as string | undefined;
  if (!area) return base;
  const approved = (await approvedEffects(db, "policy_param")).map((a) => ({ ...a, effect: a.effect as Extract<Effect, { type: "policy_param" }> }))
    .filter((a) => a.effect.area.toLowerCase() === area.toLowerCase())
    .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));                       // the latest approval of a parameter wins
  for (const a of approved) (base as unknown as Record<string, number | boolean>)[a.effect.param] = a.effect.value;
  return base;
}
