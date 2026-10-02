/**
 * J3 steps 3-7 (implementation plan section 10): compose (Claude), validate (code), render (code),
 * store, deliver. Facts in the output come from the database; the model contributes prioritization
 * and wording only. At the hard ceiling, or after a failed repair, the zero-model degraded review is used.
 */
import type pg from "pg";
import { z } from "zod";
import { appendEvent, withTransaction } from "../../db/index.js";
import { BudgetBlockedError, type ModelRequest, type ModelResult } from "../../llm/types.js";
import { deliverOnce, reviewEmailKey, type DeliveryStore, type EmailSender } from "../../notify/delivery.js";
import { J3_COMPOSE_SYSTEM, J3_COMPOSE_VERSION } from "../../prompts/j3.js";
import { collectReviewInput, type CollectOptions, type CollectedReview } from "./collect.js";
import { renderDegradedReview, SECTION_TITLES, type ReviewSection } from "./degraded.js";

const SECTIONS = ["requires_attention", "upcoming", "waiting", "project_changes", "risks_conflicts", "recommended_actions", "fyi"] as const;

export const reviewDraftSchema = z.object({
  sections: z.array(z.object({
    section: z.enum(SECTIONS),
    entries: z.array(z.object({
      item_ids: z.array(z.string()).min(1),
      headline: z.string().min(1).max(300),
      why: z.string().max(500).nullable(),
      urgency: z.enum(["high", "medium", "low"]),
      importance: z.enum(["high", "medium", "low"]),
      uncertainty: z.string().max(300).nullable(),
    }).strict()).max(40),
  }).strict()),
  nothing_material_changed: z.boolean(),
}).strict();
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

// ------------------------------------------------------------------------------ validation (G15, G16, G17)

const DATE_LIKE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b(\s+\d{1,2})?/i;

export function validateDraft(draft: ReviewDraft, c: CollectedReview): string[] {
  const known = new Set(c.items.map((i) => i.id));
  const cited = new Set<string>();
  const v: string[] = [];
  for (const s of draft.sections) {
    if (s.section === "recommended_actions" && s.entries.length > 5) v.push("V4: more than 5 recommended actions");
    for (const e of s.entries) {
      for (const id of e.item_ids) {
        if (!known.has(id)) v.push(`V1: entry "${e.headline}" cites unknown or non-live id ${id}`);
        cited.add(id);
      }
      if (DATE_LIKE.test(e.headline)) v.push(`V6: headline "${e.headline}" states a date; dates are rendered by code`);
      if (s.section === "recommended_actions") {
        for (const id of e.item_ids) {
          const conflicts = c.disputed[id];
          if (conflicts && !conflicts.some((cid) => e.item_ids.includes(cid))) {
            v.push(`V5: recommendation "${e.headline}" is based on disputed item ${id} without citing its conflict`);
          }
        }
      }
    }
  }
  for (const i of c.items) if (i.mustMention && !cited.has(i.id)) v.push(`V3: must-mention item ${i.id} ("${i.title}") is missing`);
  return v;
}

// ------------------------------------------------------------------------------ rendering (facts from code)

function fmtDate(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
}

export function renderReview(draft: ReviewDraft, c: CollectedReview, kind: string): string {
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const lines = [`Finagai ${kind === "weekly" ? "weekly" : "operating"} review: ${fmtDate(c.periodStart, c.timezone)} to ${fmtDate(c.periodEnd, c.timezone)}`];
  if (draft.nothing_material_changed) lines.push("", "Nothing material changed since the last review.");
  for (const section of SECTIONS) {
    const s = draft.sections.find((x) => x.section === section);
    if (!s || s.entries.length === 0) continue;
    lines.push("", `## ${SECTION_TITLES[section as ReviewSection]}`);
    for (const e of s.entries) {
      lines.push(`- ${e.headline}${e.why ? ` - ${e.why}` : ""}`);
      for (const id of e.item_ids) {
        const i = byId.get(id)!;
        const facts = [i.project && `project: ${i.project}`, i.status && `status: ${i.status}`, i.dueAt && `due: ${fmtDate(i.dueAt, c.timezone)}`,
          i.waitingOn && `waiting on: ${i.waitingOn}`, i.daysSinceActivity !== null && `${i.daysSinceActivity} days without activity`, i.note]
          .filter(Boolean).join("; ");
        lines.push(`  - ${i.title}${facts ? ` (${facts})` : ""} [${id}]`);
      }
      if (e.uncertainty) lines.push(`  - Uncertain: ${e.uncertainty}`);
    }
  }
  if (c.deferredCaptures > 0) lines.push("", `Captures waiting for budget: ${c.deferredCaptures}.`);
  lines.push("", `Model spend this month: $${c.budget.monthToDateUsd.toFixed(2)} (target $${c.budget.targetUsd.toFixed(2)}, ceiling $${c.budget.ceilingUsd.toFixed(2)}).`);
  return lines.join("\n");
}

// ------------------------------------------------------------------------------ orchestration

export interface J3Deps {
  pool: pg.Pool;
  model: { complete(req: ModelRequest): Promise<ModelResult> };
  modelId: string;
  collect: Omit<CollectOptions, "now" | "budget">;
  budget: () => Promise<{ monthToDateUsd: number; targetUsd: number; ceilingUsd: number }>;
  now?: () => Date;
}

export interface ReviewOutcome { reviewId: string; rendered: string; degraded: boolean; reused: boolean }

function parseDraft(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { const r = reviewDraftSchema.safeParse(JSON.parse(cleaned)); return r.success ? r.data : null; } catch { return null; }
}

export async function runReview(deps: J3Deps, opts: { kind: "weekly" | "on_demand" | "baseline"; slotKey?: string; purpose?: "eval" }): Promise<ReviewOutcome> {
  if (opts.slotKey) {
    const existing = (await deps.pool.query<{ id: string; rendered: string; degraded: boolean }>(
      `SELECT id, rendered, degraded FROM review WHERE slot_key = $1`, [opts.slotKey])).rows[0];
    if (existing) return { reviewId: existing.id, rendered: existing.rendered, degraded: existing.degraded, reused: true };
  }
  const now = (deps.now ?? (() => new Date()))();
  const collected = await collectReviewInput(deps.pool, { ...deps.collect, now, budget: await deps.budget() });
  // Evaluation runs are budgeted as "eval" (paused at the target and reported, ADR-025).
  const purpose = opts.purpose ?? (opts.kind === "on_demand" ? "on_demand_review" : "weekly_review");
  const payload = JSON.stringify(collected.items.map((i) => ({
    id: i.id, section: i.section, must_mention: i.mustMention, title: i.title, project: i.project, status: i.status,
    due_in_days: i.dueAt ? Math.round((i.dueAt.getTime() - now.getTime()) / 86_400_000) : null, waiting_on: i.waitingOn,
    days_without_activity: i.daysSinceActivity, note: i.note,
  })));
  const base = { pipeline: "j3" as const, step: "compose", purpose, model: deps.modelId, promptVersion: J3_COMPOSE_VERSION,
    system: J3_COMPOSE_SYSTEM, maxTokens: 4000 } satisfies Omit<ModelRequest, "messages">;

  let draft: ReviewDraft | null = null;
  let violations: string[] = [];
  let degradedReason: "budget_ceiling" | "validation_failed" | null = null;
  let cost = 0;
  try {
    const first = await deps.model.complete({ ...base, messages: [{ role: "user", content: payload }] });
    cost += first.costUsd;
    draft = parseDraft(first.text);
    violations = draft ? validateDraft(draft, collected) : ["V0: output did not match the review schema"];
    if (violations.length > 0) {
      const repair = await deps.model.complete({ ...base, messages: [
        { role: "user", content: payload }, { role: "assistant", content: first.text },
        { role: "user", content: `Fix these problems and return the full corrected JSON only:\n${violations.join("\n")}` }] });
      cost += repair.costUsd;
      draft = parseDraft(repair.text);
      violations = draft ? validateDraft(draft, collected) : ["V0: output did not match the review schema"];
      if (violations.length > 0) degradedReason = "validation_failed";
    }
  } catch (err) {
    if (err instanceof BudgetBlockedError && err.level === "ceiling") degradedReason = "budget_ceiling";
    else if (err instanceof BudgetBlockedError && opts.kind === "on_demand") throw err; // restricted: tell Julian, don't degrade silently
    else throw err;
  }

  const degraded = degradedReason ? renderDegradedReview(collected, degradedReason) : null;
  const rendered = degraded ? degraded.rendered : renderReview(draft!, collected, opts.kind);
  const content = degraded ? degraded.content : { degraded: false, modelInvoked: true, draft };
  const validation = degraded ? { ...degraded.validation, composeViolations: violations } : { violations: [] };

  const reviewId = await withTransaction(deps.pool, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO review (kind, period_start, period_end, watermark_event_id, model, prompt_version, content, rendered,
                           validation_result, degraded, delivery_status, cost_usd, slot_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [opts.kind, collected.periodStart, collected.periodEnd, collected.watermarkEventId || null,
       degraded ? "none" : deps.modelId, J3_COMPOSE_VERSION, JSON.stringify(content), rendered, JSON.stringify(validation),
       Boolean(degraded), opts.kind === "weekly" ? "pending" : "not_applicable", cost, opts.slotKey ?? null]);
    await appendEvent(tx, { actor: "j3", action: "review_generated", entityType: "review", entityId: r.rows[0]!.id,
      after: { kind: opts.kind, degraded: degradedReason, model_invoked: !degraded || degradedReason === "validation_failed" } });
    return r.rows[0]!.id;
  });
  return { reviewId, rendered, degraded: Boolean(degraded), reused: false };
}

/** Weekly delivery: one email per review, keyed by the immutable review ID (ADR-033). */
export async function deliverReview(pool: pg.Pool, store: DeliveryStore, sender: EmailSender, reviewId: string, rendered: string, degraded: boolean) {
  const result = await deliverOnce(store, sender, reviewEmailKey(reviewId), "weekly_review",
    { subject: degraded ? "Finagai weekly review (degraded)" : "Finagai weekly review", text: rendered }, reviewId);
  // Only a delivery Core recorded under its own lease counts. lease_lost, in_progress, and
  // needs_reconciliation leave the review undelivered for retry or reconciliation.
  if (result === "sent" || result === "already_sent") {
    await pool.query(`UPDATE review SET delivered_at = coalesce(delivered_at, now()), delivery_status = 'sent' WHERE id = $1`, [reviewId]);
  }
  return result;
}
