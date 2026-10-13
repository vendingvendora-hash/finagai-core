/**
 * Phase 8 (ADR-088, increment 3) — failure mining from the Live State Stream.
 *
 * The reliability report counts failures; this says WHAT keeps failing. Every failure Finagai records — a workflow run,
 * a scheduled job, a tool call, a Mac task, an undeliverable notice, a canary step, a self-check, a lifecycle error, and
 * (from the event loop's own tick ledger) a watcher poll — is reduced to a failure CLASS: where it happened plus a
 * normalized signature of what went wrong (ids, numbers, dates and quoted values removed, so "task 131 stalled" and
 * "task 140 stalled" are one class). Each class carries its count, first/last seen, whether it is still happening
 * since the running Core started (or only before — likely fixed), the events that show it, and whether an open
 * exception already owns it.
 *
 * Read-only and deterministic: the same stream gives the same classes. Before this, failure mining was manual
 * (current-state audit §19: "I read the metrics and the ADRs").
 */
import { createHash } from "node:crypto";
const SYSTEM = new Set(["workflow", "job", "mac_task", "notification", "canary", "self_check", "lifecycle", "watcher"]);
/** "Task 131 stalled at 2026-10-13T07:00Z (id 3f2a…)" → "task # stalled at <time> (id <id>)" */
export function normalizeFailure(message) {
    return message.toLowerCase()
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
        .replace(/\d{4}-\d{2}-\d{2}(t[\d:.]+z?)?/g, "<time>")
        .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
        .replace(/(["'“‘])[^"'”’]{1,80}(["'”’])/g, "<q>")
        .replace(/\d+(\.\d+)?/g, "#")
        .replace(/\s+/g, " ").trim().slice(0, 140);
}
export const failureKey = (source, subject, signature) => createHash("sha1").update(`${source}|${subject}|${signature}`).digest("hex").slice(0, 10);
/** Every recorded failure in the window, from the stream (and the tick ledger for watcher polls, which write no events). */
export async function recordedFailures(db, from, to) {
    const rows = (await db.query(`SELECT id, occurred_at, action, entity_type, after FROM event WHERE occurred_at BETWEEN $1 AND $2 AND (
        action IN ('workflow_failed','lifecycle_error')
     OR (action = 'job_finished' AND after->>'status' = 'failed')
     OR (action = 'tool_called' AND after->>'outcome' = 'error')
     OR (action = 'notification_suppressed' AND COALESCE(after->>'reason','') NOT ILIKE '%quiet hours%')
     OR (action = 'canary_ran' AND (after->>'ok')::boolean IS FALSE)
     OR (action = 'reliability_checked' AND jsonb_array_length(COALESCE(after->'failing','[]'::jsonb)) > 0)
     OR (entity_type = 'control_task' AND action LIKE 'control_task%' AND after->>'status' = 'failed' AND before->>'status' IS DISTINCT FROM 'failed')
    ) ORDER BY id`, [from, to])).rows;
    const out = [];
    const s = (v) => (v == null ? "" : String(v));
    for (const r of rows) {
        const a = r.after ?? {};
        const base = { at: new Date(r.occurred_at), eventId: Number(r.id) };
        switch (r.action) {
            case "workflow_failed":
                out.push({ ...base, source: "workflow", subject: s(a.workflow) || "?", message: s(a.error) });
                break;
            case "lifecycle_error":
                out.push({ ...base, source: "lifecycle", subject: s(a.where) || "?", message: s(a.error) });
                break;
            case "job_finished":
                out.push({ ...base, source: "job", subject: s(a.job) || "?", message: s(a.detail) || "failed" });
                break;
            case "tool_called":
                out.push({ ...base, source: "tool", subject: s(a.tool) || "?", message: s(a.error) || "error (no message recorded)" });
                break;
            case "notification_suppressed":
                out.push({ ...base, source: "notification", subject: s(a.purpose) || "notice", message: s(a.reason) });
                break;
            case "canary_ran":
                for (const st of a.steps ?? [])
                    if (!st.ok)
                        out.push({ ...base, source: "canary", subject: `${s(a.canary) || "canary"}:${st.step}`, message: s(st.problems?.[0]) || "step failed" });
                break;
            case "reliability_checked":
                for (const c of a.failing ?? [])
                    out.push({ ...base, source: "self_check", subject: c, message: `${c} failed` });
                break;
            default: out.push({ ...base, source: "mac_task", subject: s(a.failure_class) || s(a.terminal_reason) || "failed", message: s(a.failure_class) || s(a.terminal_reason) || s(a.why) || "failed" });
        }
    }
    const ticks = (await db.query(`SELECT started_at, stats FROM event_tick WHERE started_at BETWEEN $1 AND $2 AND status IN ('done','failed') ORDER BY started_at`, [from, to])).rows;
    for (const t of ticks)
        for (const w of (t.stats?.watchers ?? []))
            if (w.polled)
                for (const p of w.problems ?? [])
                    if (!/more than \d+ new messages/i.test(p))
                        out.push({ source: "watcher", subject: w.name, message: p, at: new Date(t.started_at), eventId: null });
    return out;
}
/** Which open exception already owns a class (so mining never duplicates what Phase 7 is working). */
function owner(c, open) {
    const candidates = [
        c.source === "workflow" ? `workflow:${c.subject}` : null,
        c.source === "watcher" ? `watcher:${c.subject}` : null, c.source === "watcher" ? `watcher:${c.subject}:auth` : null,
        c.source === "self_check" ? `reliability:${c.subject}` : null,
        c.source === "canary" ? `canary:${c.subject.split(":")[0]}` : null,
        c.source === "notification" ? "delivery:failing" : null,
        `failure:${c.key}`,
    ];
    return candidates.find((k) => k && open.has(k)) ?? null;
}
export async function mineFailures(db, opts = {}) {
    const now = opts.now ?? new Date();
    const days = Math.min(Math.max(opts.days ?? 7, 1), 30);
    const from = opts.from ?? new Date(now.getTime() - days * 86_400_000);
    const all = await recordedFailures(db, from, now);
    const open = new Set((await db.query(`SELECT key FROM operating_exception WHERE status = 'open'`)).rows.map((r) => String(r.key)));
    const groups = new Map();
    for (const f of all) {
        const sig = normalizeFailure(f.message);
        const k = failureKey(f.source, f.subject, sig);
        groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    const dayAgo = now.getTime() - 86_400_000;
    const classes = [...groups].map(([key, fs]) => {
        const f0 = fs[0];
        const last = fs.at(-1);
        const sinceStart = opts.startedAt ? fs.filter((f) => f.at >= opts.startedAt).length : fs.length;
        const c = { key, source: f0.source, subject: f0.subject };
        return {
            ...c, signature: normalizeFailure(f0.message), example: last.message.slice(0, 200),
            count: fs.length, last24h: fs.filter((f) => f.at.getTime() >= dayAgo).length, sinceStart,
            firstSeen: f0.at.toISOString(), lastSeen: last.at.toISOString(),
            status: opts.startedAt && sinceStart === 0 ? "not seen since restart" : fs.length >= 3 ? "recurring" : "isolated",
            evidence: fs.map((f) => f.eventId).filter((x) => x != null).slice(-5),
            ownedBy: owner(c, open), system: SYSTEM.has(f0.source),
        };
    }).sort((a, b) => b.last24h - a.last24h || b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
    return { window: { from: from.toISOString(), to: now.toISOString() }, startedAt: opts.startedAt?.toISOString() ?? null, failures: all.length, classes };
}
/** A class is a reliability defect worth an exception when Finagai's own machinery keeps failing the same way:
 *  ≥ RECURRING.minIn24h times in the last 24 h, intermittently (consecutive failures are already caught by the
 *  dedicated detectors, which then own it). */
export const RECURRING = { minIn24h: 3 };
/** When this Core process started: a class that has not recurred since is treated as fixed by the running version. */
export const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));
/** Failures that are availability, not defects: a Mac task nobody claimed because the Mac was asleep (the Mac-offline
 *  exception, Julian's, already covers the waiting work). Mined and reported, never a reliability exception. */
export const NOT_A_DEFECT = (c) => c.source === "watcher" || (c.source === "mac_task" && c.subject === "abandoned");
/** The classes that should be an open `failure:<key>` exception right now. */
export async function recurringFailures(db, now, startedAt = PROCESS_STARTED_AT) {
    const m = await mineFailures(db, { days: 1, now, startedAt });
    return m.classes.filter((c) => c.system && !NOT_A_DEFECT(c) && c.last24h >= RECURRING.minIn24h && c.sinceStart >= 1
        && (!c.ownedBy || c.ownedBy === `failure:${c.key}`));
}
//# sourceMappingURL=failures.js.map