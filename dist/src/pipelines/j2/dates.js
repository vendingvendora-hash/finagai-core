/**
 * G11: code re-parses every date expression the model resolved, relative to the capture's
 * received time in Julian's timezone. Outcomes:
 *   verified      code and model agree on the calendar day -> due date stored
 *   mismatch      they disagree, or the expression is self-contradictory -> date NOT stored, flagged
 *   unverifiable  code cannot parse the expression -> date NOT stored, flagged for confirmation
 * A deadline is stored only when code independently confirms it (unacceptable error: fabricated deadline).
 */
import { zonedDateAddDays, zonedParts } from "../../jobs/time.js";
const MONTHS = {
    january: 1, jan: 1, enero: 1, ene: 1, february: 2, feb: 2, febrero: 2, march: 3, mar: 3, marzo: 3,
    april: 4, apr: 4, abril: 4, abr: 4, may: 5, mayo: 5, june: 6, jun: 6, junio: 6, july: 7, jul: 7, julio: 7,
    august: 8, aug: 8, agosto: 8, ago: 8, september: 9, sep: 9, sept: 9, septiembre: 9, setiembre: 9,
    october: 10, oct: 10, octubre: 10, november: 11, nov: 11, noviembre: 11, december: 12, dec: 12, diciembre: 12, dic: 12,
};
const WEEKDAYS = {
    sunday: 0, sun: 0, domingo: 0, monday: 1, mon: 1, lunes: 1, tuesday: 2, tue: 2, tues: 2, martes: 2,
    wednesday: 3, wed: 3, miercoles: 3, thursday: 4, thu: 4, thurs: 4, jueves: 4, friday: 5, fri: 5, viernes: 5,
    saturday: 6, sat: 6, sabado: 6,
};
const strip = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const valid = (y, m, d) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const dayOrd = (c) => Date.UTC(c.year, c.month - 1, c.day) / 86_400_000;
const weekdayOf = (c) => new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
/** Year inference without an explicit year: the next occurrence, allowing up to 7 days in the past. */
function inferYear(month, day, ref) {
    for (const year of [ref.year, ref.year + 1]) {
        if (!valid(year, month, day))
            continue;
        const c = { year, month, day };
        if (dayOrd(c) >= dayOrd(ref) - 7)
            return c;
    }
    return null;
}
/**
 * Parse an expression to a calendar day. Returns null when it cannot be parsed confidently,
 * or { contradiction } when parts disagree (e.g. a weekday that does not match the date).
 */
export function parseDateExpression(expr, receivedAt, tz, language) {
    const s = strip(expr).replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
    const r = zonedParts(receivedAt, tz);
    const ref = { year: r.year, month: r.month, day: r.day };
    let explicit = null;
    let m;
    if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) {
        const c = { year: +m[1], month: +m[2], day: +m[3] };
        if (valid(c.year, c.month, c.day))
            explicit = c;
    }
    else if ((m = /\b(\d{1,2}) de ([a-z]+)(?: de(?:l)? (\d{4}))?\b/.exec(s)) && MONTHS[m[2]]) {
        explicit = m[3] ? (valid(+m[3], MONTHS[m[2]], +m[1]) ? { year: +m[3], month: MONTHS[m[2]], day: +m[1] } : null)
            : inferYear(MONTHS[m[2]], +m[1], ref);
    }
    else if ((m = /\b([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?\b/.exec(s)) && MONTHS[m[1]]) {
        explicit = m[3] ? (valid(+m[3], MONTHS[m[1]], +m[2]) ? { year: +m[3], month: MONTHS[m[1]], day: +m[2] } : null)
            : inferYear(MONTHS[m[1]], +m[2], ref);
    }
    else if ((m = /\b(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)(?: (\d{4}))?\b/.exec(s)) && MONTHS[m[2]]) {
        explicit = m[3] ? (valid(+m[3], MONTHS[m[2]], +m[1]) ? { year: +m[3], month: MONTHS[m[2]], day: +m[1] } : null)
            : inferYear(MONTHS[m[2]], +m[1], ref);
    }
    else if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s))) {
        const a = +m[1], b = +m[2];
        // Numeric dates are only accepted when unambiguous for the stated language.
        let month, day;
        if (a > 12 && b <= 12) {
            day = a;
            month = b;
        }
        else if (b > 12 && a <= 12) {
            month = a;
            day = b;
        }
        else if (language === "en") {
            month = a;
            day = b;
        }
        else if (language === "es") {
            day = a;
            month = b;
        }
        else
            return null;
        const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
        explicit = year ? (valid(year, month, day) ? { year, month, day } : null) : inferYear(month, day, ref);
    }
    // Relative expressions.
    let relative = null;
    if (/\b(pasado manana|day after tomorrow)\b/.test(s))
        relative = zonedDateAddDays(ref, 2);
    else if (/\b(manana|tomorrow)\b/.test(s))
        relative = zonedDateAddDays(ref, 1);
    else if (/\b(hoy|today|tonight|esta noche)\b/.test(s))
        relative = ref;
    const wd = Object.keys(WEEKDAYS).find((w) => new RegExp(`\\b${w}\\b`).test(s));
    if (explicit) {
        if (wd !== undefined && weekdayOf(explicit) !== WEEKDAYS[wd]) {
            return { contradiction: `weekday "${wd}" does not match ${explicit.year}-${explicit.month}-${explicit.day}` };
        }
        if (relative && dayOrd(relative) !== dayOrd(explicit))
            return { contradiction: "relative and explicit dates disagree" };
        return explicit;
    }
    if (relative)
        return relative;
    if (wd !== undefined) {
        // "next Friday" / "el proximo viernes" / "este viernes" / "Friday": next occurrence strictly after today.
        // "next week's Friday" style phrasing is not handled and returns null.
        if (/\b(next week|la proxima semana|la semana que viene)\b/.test(s))
            return null;
        const target = WEEKDAYS[wd];
        const diff = ((target - r.weekday + 7) % 7) || 7;
        return zonedDateAddDays(ref, diff);
    }
    return null;
}
export function verifyResolvedDate(expression, modelResolved, receivedAt, tz, language) {
    if (!expression && !modelResolved)
        return null;
    if (!expression || !modelResolved)
        return { kind: "mismatch", parsed: null, reason: "expression and resolution must both be present" };
    const parsed = parseDateExpression(expression, receivedAt, tz, language);
    if (parsed === null)
        return { kind: "unverifiable" };
    if ("contradiction" in parsed)
        return { kind: "mismatch", parsed: null, reason: parsed.contradiction };
    const mp = zonedParts(new Date(modelResolved), tz);
    const model = { year: mp.year, month: mp.month, day: mp.day };
    return dayOrd(model) === dayOrd(parsed)
        ? { kind: "verified", day: parsed }
        : { kind: "mismatch", parsed, reason: `model resolved ${model.year}-${model.month}-${model.day}, code parsed ${parsed.year}-${parsed.month}-${parsed.day}` };
}
//# sourceMappingURL=dates.js.map