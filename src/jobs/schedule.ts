/**
 * Pure schedule computation for the 15-minute dispatcher (ADR-027). No database access:
 * the dispatcher touches Neon only when this returns at least one due job.
 */
import { parseHhmm, zonedDateAddDays, zonedParts, zonedWallTimeToUtc } from "./time.js";

export type JobName = "weekly_review" | "missed_run_check" | "daily_maintenance";

export interface ScheduleConfig {
  FINAGAI_TIMEZONE: string;
  WEEKLY_REVIEW_DAY: number; // 0 = Sunday
  WEEKLY_REVIEW_TIME: string; // HH:MM local
  MISSED_RUN_CHECK_TIME: string; // HH:MM local, same day as the review
}

/** Fixed local times for daily jobs (implementation detail; not principal-level defaults). */
export const DAILY_JOB_TIMES: Record<"daily_maintenance", string> = {
  // Backups run in GitHub Actions (ADR-040), not on the Render scheduler.
  daily_maintenance: "03:00",
};

/** A slot stays due for this long, so a missed cron tick or a deploy cannot skip it. */
export const DUE_WINDOW_MINUTES = 120;

export interface DueJob {
  job: JobName;
  scheduledFor: Date; // UTC instant of the local slot; part of the idempotency key
}

function mostRecentDailySlot(now: Date, hhmm: string, tz: string): Date {
  const { hour, minute } = parseHhmm(hhmm);
  const today = zonedParts(now, tz);
  const todaySlot = zonedWallTimeToUtc(today.year, today.month, today.day, hour, minute, tz);
  if (todaySlot.getTime() <= now.getTime()) return todaySlot;
  const y = zonedDateAddDays(today, -1);
  return zonedWallTimeToUtc(y.year, y.month, y.day, hour, minute, tz);
}

function mostRecentWeeklySlot(now: Date, weekday: number, hhmm: string, tz: string): Date {
  const { hour, minute } = parseHhmm(hhmm);
  const today = zonedParts(now, tz);
  const back = (today.weekday - weekday + 7) % 7;
  for (const daysBack of [back, back + 7]) {
    const d = zonedDateAddDays(today, -daysBack);
    const slot = zonedWallTimeToUtc(d.year, d.month, d.day, hour, minute, tz);
    if (slot.getTime() <= now.getTime()) return slot;
  }
  throw new Error("unreachable: no weekly slot within two weeks");
}

/** Jobs whose most recent slot is at or before `now` and still inside the due window. */
export function dueJobs(now: Date, cfg: ScheduleConfig): DueJob[] {
  const tz = cfg.FINAGAI_TIMEZONE;
  const slots: DueJob[] = [
    { job: "weekly_review", scheduledFor: mostRecentWeeklySlot(now, cfg.WEEKLY_REVIEW_DAY, cfg.WEEKLY_REVIEW_TIME, tz) },
    { job: "missed_run_check", scheduledFor: mostRecentWeeklySlot(now, cfg.WEEKLY_REVIEW_DAY, cfg.MISSED_RUN_CHECK_TIME, tz) },
    { job: "daily_maintenance", scheduledFor: mostRecentDailySlot(now, DAILY_JOB_TIMES.daily_maintenance, tz) },
  ];
  const windowMs = DUE_WINDOW_MINUTES * 60_000;
  return slots.filter((s) => now.getTime() - s.scheduledFor.getTime() < windowMs);
}
