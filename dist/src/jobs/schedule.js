/**
 * Pure schedule computation for the 15-minute dispatcher (ADR-027). No database access:
 * the dispatcher touches Neon only when this returns at least one due job.
 */
import { parseHhmm, zonedDateAddDays, zonedParts, zonedWallTimeToUtc } from "./time.js";
/** Fixed local times for daily jobs (implementation detail; not principal-level defaults). */
export const DAILY_JOB_TIMES = {
    // Backups run in GitHub Actions (ADR-040), not on the Render scheduler.
    daily_maintenance: "03:00",
};
/** A slot stays due for this long, so a missed cron tick or a deploy cannot skip it. */
export const DUE_WINDOW_MINUTES = 120;
function mostRecentDailySlot(now, hhmm, tz) {
    const { hour, minute } = parseHhmm(hhmm);
    const today = zonedParts(now, tz);
    const todaySlot = zonedWallTimeToUtc(today.year, today.month, today.day, hour, minute, tz);
    if (todaySlot.getTime() <= now.getTime())
        return todaySlot;
    const y = zonedDateAddDays(today, -1);
    return zonedWallTimeToUtc(y.year, y.month, y.day, hour, minute, tz);
}
function mostRecentWeeklySlot(now, weekday, hhmm, tz) {
    const { hour, minute } = parseHhmm(hhmm);
    const today = zonedParts(now, tz);
    const back = (today.weekday - weekday + 7) % 7;
    for (const daysBack of [back, back + 7]) {
        const d = zonedDateAddDays(today, -daysBack);
        const slot = zonedWallTimeToUtc(d.year, d.month, d.day, hour, minute, tz);
        if (slot.getTime() <= now.getTime())
            return slot;
    }
    throw new Error("unreachable: no weekly slot within two weeks");
}
/** Jobs whose most recent slot is at or before `now` and still inside the due window. */
export function dueJobs(now, cfg) {
    const tz = cfg.FINAGAI_TIMEZONE;
    const slots = [
        { job: "weekly_review", scheduledFor: mostRecentWeeklySlot(now, cfg.WEEKLY_REVIEW_DAY, cfg.WEEKLY_REVIEW_TIME, tz) },
        { job: "missed_run_check", scheduledFor: mostRecentWeeklySlot(now, cfg.WEEKLY_REVIEW_DAY, cfg.MISSED_RUN_CHECK_TIME, tz) },
        { job: "daily_maintenance", scheduledFor: mostRecentDailySlot(now, DAILY_JOB_TIMES.daily_maintenance, tz) },
    ];
    const windowMs = DUE_WINDOW_MINUTES * 60_000;
    return slots.filter((s) => now.getTime() - s.scheduledFor.getTime() < windowMs);
}
//# sourceMappingURL=schedule.js.map