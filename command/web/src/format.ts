/** Time formatting in Julian's browser time zone. Relative times freeze to absolute ones when the UI is not live. */
const tf = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const df = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
const sdf = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const dtf = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const fmtTime = (iso: string | number) => tf.format(new Date(iso));
export const fmtDay = (iso: string) => df.format(new Date(iso));
export const fmtShortDay = (iso: string) => sdf.format(new Date(iso));
export const fmtDateTime = (iso: string | number) => dtf.format(new Date(iso));

/** "12:04" today, "Oct 12" earlier (activity times). */
export function fmtWhen(iso: string, now: number) {
  const d = new Date(iso); const n = new Date(now);
  return d.toDateString() === n.toDateString() ? tf.format(d) : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
}

/** "12 min ago" when live; absolute when not (spec §3.6: relative times freeze when offline). */
export function fmtAgo(iso: string, now: number, live: boolean) {
  if (!live) return fmtDateTime(iso);
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return fmtShortDay(iso);
}

export function fmtDue(iso: string, now: number) {
  const ms = Date.parse(iso) - now;
  if (ms < 0) return `due ${fmtShortDay(iso)} · overdue`;
  return `due ${fmtShortDay(iso)}`;
}
