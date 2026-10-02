/**
 * Weekly review and missed-run handlers (ADR-033 idempotency contract).
 *   weekly_review     review keyed by slot (review.slot_key); delivery keyed by review ID
 *   missed_run_check  RECOVERY first: if the slot's review was not delivered, re-run the weekly
 *                     review with the SAME slot key, then send one alert keyed by that slot
 */
import type pg from "pg";
import { deliverOnce, type DeliveryStore, type EmailSender } from "../notify/delivery.js";
import { deliverReview, runReview, type J3Deps } from "../pipelines/j3/review.js";
import { slotIdempotencyKey, type JobHandler } from "./dispatcher.js";
import { parseHhmm, zonedParts, zonedWallTimeToUtc } from "./time.js";

export interface J3JobDeps {
  pool: pg.Pool;
  j3: J3Deps;
  store: DeliveryStore;
  sender: EmailSender;
  timezone: string;
  weeklyReviewTime: string;
}

export function weeklyReviewHandler(d: J3JobDeps): JobHandler {
  return async (ctx) => {
    const r = await runReview(d.j3, { kind: "weekly", slotKey: ctx.idempotencyKey });
    if (ctx.signal.aborted) return { status: "failed", detail: "lease lost before delivery" };
    const delivery = await deliverReview(d.pool, d.store, d.sender, r.reviewId, r.rendered, r.degraded);
    if (delivery === "in_progress") return { status: "failed", detail: "delivery in progress elsewhere; will retry" };
    return { status: "succeeded", detail: r.degraded ? "degraded review delivered" : "review delivered" };
  };
}

/** The weekly slot on the same local day as the missed-run check. */
export function weeklySlotFor(checkSlot: Date, timezone: string, weeklyReviewTime: string): Date {
  const p = zonedParts(checkSlot, timezone);
  const { hour, minute } = parseHhmm(weeklyReviewTime);
  return zonedWallTimeToUtc(p.year, p.month, p.day, hour, minute, timezone);
}

export function missedRunCheckHandler(d: J3JobDeps): JobHandler {
  const weekly = weeklyReviewHandler(d);
  return async (ctx) => {
    const slot = weeklySlotFor(ctx.scheduledFor, d.timezone, d.weeklyReviewTime);
    const key = slotIdempotencyKey("weekly_review", slot);
    const row = (await d.pool.query<{ delivery_status: string | null }>(`SELECT delivery_status FROM review WHERE slot_key = $1`, [key])).rows[0];
    if (row?.delivery_status === "sent") return { status: "succeeded", detail: "weekly review was delivered" };
    let recovered = false;
    try {
      const out = await weekly({ ...ctx, job: "weekly_review", scheduledFor: slot, idempotencyKey: key });
      recovered = out.status === "succeeded";
    } catch { recovered = false; }
    // One key per outcome: the two messages differ, and a key must always carry the same payload.
    await deliverOnce(d.store, d.sender, `missed-run-alert:${key}:${recovered ? "recovered" : "failed"}`, "missed_run_alert", {
      subject: recovered ? "Finagai: weekly review was late and has now been sent" : "Finagai: weekly review failed",
      text: recovered
        ? `The weekly review for ${slot.toISOString()} had not been delivered by the check time. Finagai re-ran it and delivered it.`
        : `The weekly review for ${slot.toISOString()} could not be generated or delivered. Check job_run and the service logs.`,
    });
    return recovered ? { status: "succeeded", detail: "recovered late weekly review" } : { status: "failed", detail: "weekly review not recovered" };
  };
}
