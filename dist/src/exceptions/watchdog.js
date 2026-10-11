import { deliverOnce } from "../notify/delivery.js";
export const STALL_AFTER_MIN = 30;
function localHour(now, tz) { return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now)); }
export async function eventLoopWatchdog(pool, now, notify) {
    const last = (await pool.query(`SELECT max(started_at) AS at FROM event_tick WHERE status IN ('done','running')`)).rows[0]?.at;
    if (!last)
        return { stalled: false, reason: "the event loop has never run" };
    const ageMin = Math.round((now.getTime() - new Date(last).getTime()) / 60_000);
    if (ageMin <= STALL_AFTER_MIN)
        return { stalled: false, ageMin };
    const since = new Date(last).toISOString();
    const summary = `Finagai's event loop has not run since ${since.slice(0, 16).replace("T", " ")} UTC (${ageMin} min) — Core may be down; new mail and deadlines are not being noticed`;
    await pool.query(`INSERT INTO operating_exception (key, detector, owner, severity, needs, summary, detail, first_seen_at, last_seen_at)
      VALUES ('loop:stalled', 'event_loop', 'julian', 'critical', 'judgment', $1, $2, $3, $3)
      ON CONFLICT (key) DO UPDATE SET summary = EXCLUDED.summary, last_seen_at = EXCLUDED.last_seen_at,
        status = 'open', resolved_at = NULL, resolution = NULL,
        first_seen_at = CASE WHEN operating_exception.status = 'resolved' THEN EXCLUDED.first_seen_at ELSE operating_exception.first_seen_at END,
        occurrences = operating_exception.occurrences + CASE WHEN operating_exception.status = 'resolved' THEN 1 ELSE 0 END`, [summary, "detected by the scheduler's dead-man check", now]);
    if (!notify)
        return { stalled: true, ageMin, notified: "no notifier" };
    const [qs, qe] = notify.quietHours ?? [22, 7];
    const h = localHour(now, notify.timezone);
    if (h >= qs || h < qe)
        return { stalled: true, ageMin, notified: "held for quiet hours" };
    const r = await deliverOnce(notify.store, notify.sender, `watchdog:event-loop:${since}`, "watchdog_alert", {
        subject: "Finagai has stopped noticing new mail and deadlines",
        // The message is identical for the whole outage (the idempotency key is the outage's start).
        text: `Finagai's event loop has not run since ${since.slice(0, 16).replace("T", " ")} UTC — Core may be down; new mail and deadlines are not being noticed.\n\nThe Finagai Core service (finagai-core on Render) is probably down or restarting. Nothing else needs you; this alert is sent once per outage and clears itself when the loop runs again.`,
    });
    return { stalled: true, ageMin, notified: r };
}
//# sourceMappingURL=watchdog.js.map