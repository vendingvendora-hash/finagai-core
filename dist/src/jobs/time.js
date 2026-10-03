/**
 * Timezone helpers built on Intl only (no tz library). All scheduling is computed in
 * Julian's configured timezone (default America/New_York) so it stays correct across DST.
 */
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();
function formatter(tz) {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            weekday: "short",
        });
        formatters.set(tz, f);
    }
    return f;
}
/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(instant, tz) {
    const parts = Object.fromEntries(formatter(tz).formatToParts(instant).map((p) => [p.type, p.value]));
    const weekday = WEEKDAYS[parts.weekday ?? ""];
    if (weekday === undefined)
        throw new Error(`unrecognized weekday for ${tz}`);
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        weekday,
    };
}
/** Offset (ms) between the timezone's wall clock and UTC at an instant. */
function offsetMs(instant, tz) {
    const p = zonedParts(instant, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}
/**
 * The UTC instant at which the timezone's wall clock shows the given local time.
 * For a wall time skipped by a spring-forward transition, returns the first valid instant after it.
 * For a repeated (fall-back) wall time, returns the earlier occurrence.
 */
export function zonedWallTimeToUtc(year, month, day, hour, minute, tz) {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    // Two candidate offsets: the one in effect just before and just after the guess.
    const candidates = [offsetMs(new Date(guess - 6 * 3_600_000), tz), offsetMs(new Date(guess + 6 * 3_600_000), tz)];
    const matches = candidates
        .map((off) => new Date(guess - off))
        .filter((d) => {
        const p = zonedParts(d, tz);
        return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    })
        .sort((a, b) => a.getTime() - b.getTime());
    if (matches[0])
        return matches[0];
    // Nonexistent local time (spring forward): move to the first valid minute after the gap.
    const after = new Date(guess - Math.min(...candidates));
    return after;
}
/** Calendar date (year, month, day) of the timezone's wall clock, shifted by whole days. */
export function zonedDateAddDays(p, days) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
/** UTC instant of local midnight on the first day of the month containing `instant`. */
export function startOfZonedMonth(instant, tz) {
    const p = zonedParts(instant, tz);
    return zonedWallTimeToUtc(p.year, p.month, 1, 0, 0, tz);
}
export function parseHhmm(value) {
    const m = /^(\d{2}):(\d{2})$/.exec(value);
    if (!m)
        throw new Error(`invalid HH:MM value`);
    return { hour: Number(m[1]), minute: Number(m[2]) };
}
//# sourceMappingURL=time.js.map