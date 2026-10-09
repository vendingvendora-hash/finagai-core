/**
 * Phase 5 (ADR-084) — the event engine. One tick:
 *   1. poll every DUE watcher (mail, calendar, deadlines, Area-specific sources); record each real-world event ONCE
 *   2. route every new event to the Areas that subscribe to it (with the reason) — or record why it was ignored
 *   3. run each workflow ONCE with all its events (ten emails = one sync); Finagai-owned actions happen here
 *   4. derive what genuinely needs Julian from STATE (judgment / authorization / principal-reserved), escalate each
 *      need once, resolve escalations whose source item closed
 *   5. notify Julian of new escalations in one digest (outside quiet hours)
 * Single runner (advisory lock); a preview computes the same tick and writes nothing (no cursors, no events, no sends).
 */
import { createHash } from "node:crypto";
import { appendEvent } from "../db/index.js";
import { deliverOnce } from "../notify/delivery.js";
import { RULE_NEEDS } from "../cos/lifecycle.js";
const LOCK_KEY = 84_005; // pg advisory lock id for the event engine
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
function localHour(now, tz) { return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now)); }
export async function runTick(pool, ctxIn, deps, trigger) {
    const ctx = { ...ctxIn, pool };
    const lock = await pool.connect();
    const result = { tickId: null, trigger, preview: ctx.dryRun, watchers: [], events: [], workflows: [], escalations: { opened: [], resolved: [], open: 0, notified: [] } };
    try {
        const got = (await lock.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY])).rows[0]?.ok;
        if (!got)
            return { ...result, skipped: "another tick is running" };
        try {
            if (!ctx.dryRun)
                result.tickId = String((await pool.query(`INSERT INTO event_tick (trigger) VALUES ($1) RETURNING id`, [trigger])).rows[0].id);
            try {
                await tick(ctx, deps, result);
                if (result.tickId)
                    await pool.query(`UPDATE event_tick SET status = 'done', finished_at = now(), stats = $2::jsonb WHERE id = $1`, [result.tickId, JSON.stringify(statsOf(result))]);
            }
            catch (e) {
                if (result.tickId)
                    await pool.query(`UPDATE event_tick SET status = 'failed', finished_at = now(), error = $2, stats = $3::jsonb WHERE id = $1`, [result.tickId, String(e?.stack ?? e).slice(0, 2000), JSON.stringify(statsOf(result))]);
                throw e;
            }
        }
        finally {
            await lock.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
        }
    }
    finally {
        lock.release();
    }
    return result;
}
const statsOf = (r) => ({ watchers: r.watchers, events: r.events.length, routed: r.events.filter((e) => e.routes.length).length,
    workflows: r.workflows.map((w) => ({ name: w.name, events: w.events, ok: w.ok, changes: w.changes.length, error: w.error ?? null })), escalations: r.escalations });
async function tick(ctx, deps, result) {
    const { pool } = ctx;
    const watchers = deps.modules.flatMap((m) => m.watchers);
    const subs = deps.modules.flatMap((m) => m.subscriptions);
    const flows = new Map(deps.modules.flatMap((m) => m.workflows).map((w) => [w.name, w]));
    // 1) watchers → recorded events (idempotent)
    const cursorRows = (await pool.query(`SELECT watcher, scope, cursor, updated_at FROM event_cursor`)).rows;
    const inMemory = []; // preview: events are routed without being stored
    for (const w of watchers) {
        const mine = cursorRows.filter((c) => c.watcher === w.name);
        const last = mine.length ? Math.max(...mine.map((c) => new Date(c.updated_at).getTime())) : 0;
        if (w.everyMs > 0 && last && ctx.now.getTime() - last < w.everyMs && !ctx.dryRun) {
            result.watchers.push({ name: w.name, polled: false, events: 0, newEvents: 0, problems: [] });
            continue;
        }
        let polled;
        try {
            polled = await w.poll(ctx, new Map(mine.map((c) => [String(c.scope), String(c.cursor)])));
        }
        catch (e) {
            result.watchers.push({ name: w.name, polled: true, events: 0, newEvents: 0, problems: [String(e?.message ?? e).slice(0, 200)] });
            continue;
        }
        let fresh = 0;
        for (const ev of polled.events) {
            if (ctx.dryRun) {
                const seen = await pool.query(`SELECT 1 FROM inbound_event WHERE source = $1 AND external_id = $2`, [ev.source, ev.externalId]);
                if (!seen.rowCount) {
                    fresh++;
                    inMemory.push({ ...ev, id: `preview:${sha(ev.source + ev.externalId)}`, status: "new" });
                }
                continue;
            }
            const ins = await pool.query(`INSERT INTO inbound_event (occurred_at, source, kind, external_id, summary, payload, tick_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (source, external_id) DO NOTHING RETURNING id`, [ev.occurredAt, ev.source, ev.kind, ev.externalId, ev.summary.slice(0, 300), JSON.stringify(ev.payload), result.tickId]);
            fresh += ins.rowCount ?? 0;
        }
        if (!ctx.dryRun)
            for (const c of polled.cursors)
                await pool.query(`INSERT INTO event_cursor (watcher, scope, cursor, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (watcher, scope) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`, [w.name, c.scope, c.cursor, ctx.now]);
        result.watchers.push({ name: w.name, polled: true, events: polled.events.length, newEvents: fresh, problems: polled.problems });
    }
    // 2) route new events (and retry failed ones from the last 6 h)
    const pending = ctx.dryRun ? inMemory : (await pool.query(`SELECT id, source, kind, external_id AS "externalId", occurred_at AS "occurredAt", summary, payload, status FROM inbound_event
     WHERE status = 'new' OR (status = 'failed' AND attempts < 5) ORDER BY occurred_at, id LIMIT 500`)).rows
        .map((r) => ({ ...r, occurredAt: new Date(r.occurredAt).toISOString() }));
    const byFlow = new Map();
    const routesOf = new Map();
    for (const e of pending) {
        const routes = [];
        for (const s of subs) {
            let why = null;
            try {
                why = await s.match(e, ctx);
            }
            catch (err) {
                why = null;
                ctx.log?.("subscription match failed", { sub: s.id, error: String(err?.message ?? err).slice(0, 160) });
            }
            if (why) {
                routes.push({ subscription: s.id, area: s.area, workflow: s.workflow, why });
                byFlow.set(s.workflow, [...(byFlow.get(s.workflow) ?? []), e]);
            }
        }
        routesOf.set(e.id, routes);
        const reason = routes.length ? null : "no Area subscribes to this event";
        if (!ctx.dryRun)
            await pool.query(`UPDATE inbound_event SET status = $2, routes = $3::jsonb, reason = $4, handled_at = CASE WHEN $2 = 'ignored' THEN now() ELSE handled_at END WHERE id = $1`, [e.id, routes.length ? "routed" : "ignored", JSON.stringify(routes), reason]);
        result.events.push({ summary: e.summary, kind: e.kind, status: routes.length ? "routed" : "ignored", routes, reason });
    }
    // 3) workflows, once each, with all their events
    const needs = [];
    for (const [name, evs] of byFlow) {
        const wf = flows.get(name);
        if (!wf) {
            result.workflows.push({ name, events: evs.length, ok: false, changes: [], error: "no such workflow" });
            continue;
        }
        try {
            const r = await wf.run(ctx, evs);
            needs.push(...r.escalations.map((x) => ({ ...x, detail: x.detail ?? `from ${evs.length} event(s): ${evs.slice(0, 3).map((e) => e.summary).join(" | ")}` })));
            result.workflows.push({ name, events: evs.length, ok: true, changes: r.changes });
            if (!ctx.dryRun) {
                await pool.query(`UPDATE inbound_event SET status = 'handled', handled_at = now(), attempts = attempts + 1, reason = NULL WHERE id = ANY($1::uuid[]) AND status IN ('routed','failed')`, [evs.map((e) => e.id)]);
                if (r.changes.length)
                    await appendEvent(pool, { actor: "cos", action: "workflow_ran", entityType: "event_tick", ...(result.tickId ? { entityId: result.tickId } : {}), after: { workflow: name, events: evs.length, changes: r.changes.slice(0, 30) } });
            }
        }
        catch (e) {
            const msg = String(e?.message ?? e).slice(0, 300);
            result.workflows.push({ name, events: evs.length, ok: false, changes: [], error: msg });
            if (!ctx.dryRun)
                await pool.query(`UPDATE inbound_event SET status = 'failed', attempts = attempts + 1, reason = $2 WHERE id = ANY($1::uuid[])`, [evs.map((x) => x.id), `${name} failed: ${msg}`.slice(0, 500)]);
        }
    }
    // 4) escalations: derived from state (the single source of truth) + workflow judgments
    needs.push(...await stateNeeds(pool, ctx.now));
    await reconcileEscalations(ctx, needs, result);
    // 5) one digest for new escalations
    if (deps.notify)
        await notifyDigest(ctx, deps.notify, result);
}
/** What only Julian can do right now, read from state — independent of which event (if any) revealed it. */
export async function stateNeeds(db, now) {
    const out = [];
    // a) lifecycle steps the policy put on Julian's plate (each declares why)
    for (const f of (await db.query(`SELECT f.id, f.summary, f.rule, f.due_at, COALESCE(f.area_id, p.area_id) AS area_id FROM followup f LEFT JOIN project p ON p.id = f.project_id
      WHERE f.origin = 'lifecycle' AND f.state IN ('open','overdue') AND f.rule = ANY($1::text[])`, [Object.keys(RULE_NEEDS)])).rows)
        out.push({ key: `followup:${f.id}`, needs: RULE_NEEDS[f.rule], summary: f.summary, areaId: f.area_id, followupId: f.id, dueAt: f.due_at ? new Date(f.due_at).toISOString() : null });
    // b) something Julian himself is waiting on went past its date with no answer: following up goes out as him
    for (const f of (await db.query(`SELECT f.id, f.summary, f.counterparty, f.due_at, COALESCE(f.area_id, p.area_id) AS area_id FROM followup f LEFT JOIN project p ON p.id = f.project_id
      WHERE f.origin IN ('julian','bootstrap') AND f.state IN ('open','waiting','overdue') AND f.due_at IS NOT NULL AND f.due_at <= $1`, [now])).rows)
        out.push({ key: `overdue:${f.id}:${new Date(f.due_at).toISOString().slice(0, 10)}`, needs: "principal_reserved", areaId: f.area_id, followupId: f.id, dueAt: new Date(f.due_at).toISOString(),
            summary: `No answer from ${f.counterparty ?? "them"} by ${new Date(f.due_at).toISOString().slice(0, 10)} — approve a follow-up (Finagai drafts it; it goes out as you), give a new date, or close it`, detail: f.summary });
    return out;
}
async function reconcileEscalations(ctx, needs, result) {
    const { pool } = ctx;
    const want = new Map(needs.map((n) => [n.key, n]));
    const open = (await pool.query(`SELECT e.id, e.key, e.summary, e.followup_id, f.state AS fstate FROM escalation e LEFT JOIN followup f ON f.id = e.followup_id WHERE e.status = 'open'`)).rows;
    // Resolve what no longer needs Julian (its follow-up closed / moved on, or a state-derived need disappeared).
    for (const o of open) {
        const stateDerived = /^(followup|overdue):/.test(o.key);
        if ((o.followup_id && (o.fstate === "done" || o.fstate === "cancelled")) || (stateDerived && !want.has(o.key))) {
            result.escalations.resolved.push(o.summary);
            if (!ctx.dryRun)
                await pool.query(`UPDATE escalation SET status = 'resolved', resolved_at = now(), resolution = $2 WHERE id = $1`, [o.id, o.fstate === "done" || o.fstate === "cancelled" ? `follow-up ${o.fstate}` : "no longer needed"]);
        }
    }
    const openKeys = new Set(open.map((o) => o.key));
    for (const n of want.values()) {
        if (openKeys.has(n.key))
            continue;
        const seen = await pool.query(`SELECT status FROM escalation WHERE key = $1`, [n.key]);
        if (seen.rowCount)
            continue; // resolved before: never re-escalated for the same key
        result.escalations.opened.push(`[${n.needs}] ${n.summary}`);
        if (!ctx.dryRun)
            await pool.query(`INSERT INTO escalation (key, area_id, needs, summary, detail, due_at, followup_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (key) DO NOTHING`, [n.key, n.areaId ?? null, n.needs, n.summary.slice(0, 500), n.detail?.slice(0, 1000) ?? null, n.dueAt ?? null, n.followupId ?? null]);
    }
    result.escalations.open = ctx.dryRun ? open.length - result.escalations.resolved.length + result.escalations.opened.length
        : Number((await pool.query(`SELECT count(*)::int AS n FROM escalation WHERE status = 'open'`)).rows[0].n);
}
const NEEDS_LABEL = { judgment: "your decision", authorization: "your authorization", principal_reserved: "only you can do this" };
async function notifyDigest(ctx, n, result) {
    const rows = (await ctx.pool.query(`SELECT e.id, e.key, e.needs, e.summary, e.due_at, a.name AS area FROM escalation e LEFT JOIN area a ON a.id = e.area_id
     WHERE e.status = 'open' AND e.notified_at IS NULL ORDER BY e.created_at`)).rows;
    const pendingPreview = ctx.dryRun ? result.escalations.opened : [];
    if (!rows.length && !pendingPreview.length)
        return;
    const [qs, qe] = n.quietHours ?? [22, 7];
    const h = localHour(ctx.now, n.timezone);
    if (h >= qs || h < qe) {
        result.escalations.held = `quiet hours (${qs}:00–${qe}:00 ${n.timezone}); sent at ${qe}:00`;
        return;
    }
    if (ctx.dryRun) {
        result.escalations.notified = pendingPreview;
        return;
    }
    const lines = rows.map((r) => `• ${r.area ? `[${r.area}] ` : ""}${r.summary}${r.due_at ? ` (by ${new Date(r.due_at).toISOString().slice(0, 10)})` : ""} — ${NEEDS_LABEL[r.needs]}`);
    const key = `escalations:${sha(rows.map((r) => r.key).sort().join("|"))}`;
    const r = await deliverOnce(n.store, n.sender, key, "escalation_digest", {
        subject: rows.length === 1 ? `Finagai needs you: ${String(rows[0].summary).slice(0, 80)}` : `Finagai needs you on ${rows.length} things`,
        text: `Only the items below need you; everything else Finagai is handling.\n\n${lines.join("\n")}\n\nAsk Finagai in Claude (e.g. "what needs me?") to act on any of them.`,
    });
    if (r === "sent" || r === "already_sent") {
        await ctx.pool.query(`UPDATE escalation SET notified_at = now() WHERE id = ANY($1::uuid[])`, [rows.map((x) => x.id)]);
        result.escalations.notified = rows.map((x) => x.summary);
    }
    else
        result.escalations.held = `digest not sent: ${r}`;
}
/** Read-only status for tools: the engine's heartbeat, cursors, recent events and open escalations. */
export async function proactivityStatus(pool, limit = 25) {
    const ticks = (await pool.query(`SELECT started_at, finished_at, trigger, status, stats, error FROM event_tick ORDER BY started_at DESC LIMIT 5`)).rows;
    const cursors = (await pool.query(`SELECT watcher, scope, cursor, updated_at FROM event_cursor ORDER BY watcher, scope`)).rows;
    const events = (await pool.query(`SELECT received_at, kind, summary, status, routes, reason FROM inbound_event ORDER BY received_at DESC LIMIT $1`, [limit])).rows
        .map((e) => ({ at: e.received_at, kind: e.kind, summary: e.summary, status: e.status, routedTo: e.routes.map((r) => `${r.area}/${r.workflow}: ${r.why}`), reason: e.reason }));
    const counts = (await pool.query(`SELECT status, count(*)::int AS n FROM inbound_event WHERE received_at > now() - interval '24 hours' GROUP BY status`)).rows;
    const escalations = (await pool.query(`SELECT e.created_at, e.needs, e.summary, e.due_at, e.status, e.notified_at, a.name AS area FROM escalation e LEFT JOIN area a ON a.id = e.area_id
     WHERE e.status = 'open' OR e.resolved_at > now() - interval '3 days' ORDER BY e.status, e.created_at DESC LIMIT 20`)).rows;
    const last = ticks.find((t) => t.status !== "skipped");
    return {
        heartbeat: last ? { lastTick: last.started_at, status: last.status, ageMinutes: Math.round((Date.now() - new Date(last.started_at).getTime()) / 60_000), error: last.error } : null,
        last24h: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        needsJulian: escalations.filter((e) => e.status === "open").map((e) => ({ area: e.area, needs: NEEDS_LABEL[e.needs], summary: e.summary, due: e.due_at, notified: !!e.notified_at })),
        recentlyResolved: escalations.filter((e) => e.status === "resolved").map((e) => e.summary),
        recentEvents: events, watchers: cursors, ticks,
    };
}
//# sourceMappingURL=engine.js.map