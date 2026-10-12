import { areaHealth } from "../cos/areas.js";
/** Set once at Core startup (it holds the configured ceiling); every tick in the process — interval, manual, preview —
 *  then reads the same meter. Without it the budget detector reports itself unavailable (never "cleared"). */
let processBudget;
export const setBudgetReader = (fn) => { processBudget = fn; };
export const budgetReader = () => processBudget;
const MIN = 60_000;
const AUTH = /invalid_grant|unauthori[sz]ed|\b401\b|\b403\b|token (?:has been )?(?:expired|revoked)|not connected|re-?auth|consent/i;
const BENIGN = /more than \d+ new messages/i;
const ago = (now, d) => Math.round((now.getTime() - new Date(d).getTime()) / MIN);
const hhmm = (m) => (m >= 1440 ? `${Math.round(m / 1440)} d` : m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`);
/** A source Finagai watches keeps failing. Auth problems are Julian's (only he can re-authorize); others are Finagai's. */
export const watcherFailing = async (db) => {
    const ticks = (await db.query(`SELECT started_at, stats FROM event_tick WHERE status IN ('done','failed') ORDER BY started_at DESC LIMIT 12`)).rows;
    const byWatcher = new Map();
    for (const t of ticks)
        for (const w of (t.stats?.watchers ?? [])) {
            if (!w.polled)
                continue;
            byWatcher.set(w.name, [...(byWatcher.get(w.name) ?? []), { at: t.started_at, problems: (w.problems ?? []).filter((p) => !BENIGN.test(p)) }]);
        }
    const out = [];
    for (const [name, polls] of byWatcher) {
        let streak = 0;
        for (const p of polls) {
            if (p.problems.length)
                streak++;
            else
                break;
        } // newest first: consecutive failing polls
        if (streak < 3)
            continue;
        const problem = polls[0].problems[0];
        const since = polls[streak - 1].at;
        if (AUTH.test(problem))
            out.push({ key: `watcher:${name}:auth`, detector: "watcher_failing", owner: "julian", severity: "critical", needs: "principal_reserved",
                summary: `Finagai can't read ${name} — the account needs to be re-authorized (only you can do that)`, detail: `${streak} failed polls since ${new Date(since).toISOString()}: ${problem.slice(0, 200)}` });
        else
            out.push({ key: `watcher:${name}`, detector: "watcher_failing", owner: "finagai", severity: "warning", escalateAfterMin: 24 * 60,
                summary: `${name} watcher failing (${streak} polls in a row) — Finagai keeps retrying`, detail: problem.slice(0, 300) });
    }
    return out;
};
/** A workflow failed on its last 3 runs (its events are kept and retried, but nothing is being handled). */
export const workflowFailing = async (db) => {
    const ticks = (await db.query(`SELECT stats FROM event_tick WHERE status IN ('done','failed') AND stats ? 'workflows' ORDER BY started_at DESC LIMIT 30`)).rows;
    const runs = new Map();
    for (const t of ticks)
        for (const w of (t.stats.workflows ?? []))
            runs.set(w.name, [...(runs.get(w.name) ?? []), w]);
    const out = [];
    for (const [name, r] of runs)
        if (r.length >= 3 && r.slice(0, 3).every((x) => !x.ok))
            out.push({ key: `workflow:${name}`, detector: "workflow_failing", owner: "finagai", severity: "warning", escalateAfterMin: 12 * 60,
                summary: `Workflow ${name} failed its last ${r.findIndex((x) => x.ok) < 0 ? r.length : r.findIndex((x) => x.ok)} runs — its events are kept and retried`, detail: String(r[0].error ?? "").slice(0, 300) });
    return out;
};
/** Events that exhausted their retries: nothing will handle them unless they are requeued. */
export const deadLetters = async (db) => {
    const r = (await db.query(`SELECT count(*)::int AS n, min(received_at) AS oldest, (array_agg(DISTINCT left(reason, 160)))[1:3] AS reasons FROM inbound_event WHERE status = 'failed' AND attempts >= 5`)).rows[0];
    if (!r?.n)
        return [];
    return [{ key: "events:dead_letter", detector: "dead_letter", owner: "finagai", severity: "warning", remediation: "requeue_dead_events", escalateAfterMin: 24 * 60,
            summary: `${r.n} event(s) gave up after 5 attempts (oldest ${new Date(r.oldest).toISOString().slice(0, 10)}) — Finagai requeues them once their workflow works again`, detail: (r.reasons ?? []).join(" | ") }];
};
/** Model spend near the hard ceiling. Only Julian can raise the ceiling (governance; never learned or automated). */
export const budget = async (_db, _now, deps) => {
    const read = deps.budget ?? processBudget;
    if (!read)
        throw new Error("budget meter unavailable in this process");
    const b = await read();
    const share = b.ceilingUsd > 0 ? b.monthToDateUsd / b.ceilingUsd : 0;
    const money = `$${b.monthToDateUsd.toFixed(2)} of the $${b.ceilingUsd.toFixed(2)} monthly ceiling`;
    if (share >= 0.95)
        return [{ key: "budget:ceiling", detector: "budget", owner: "julian", severity: "critical", needs: "principal_reserved",
                summary: `Model spend is ${money} — at the ceiling Finagai stops calling models; only you can raise it`, detail: `target $${b.targetUsd}` }];
    if (share >= 0.8)
        return [{ key: "budget:near", detector: "budget", owner: "finagai", severity: "info",
                summary: `Model spend is ${money} (${Math.round(100 * share)}%) — Finagai is watching it`, detail: `target $${b.targetUsd}` }];
    return [];
};
/** A notice to Julian could not be delivered (he may be missing something). */
export const deliveryFailing = async (db, now) => {
    const rows = (await db.query(`SELECT purpose, status, created_at, last_error FROM outbound_delivery
      WHERE (status = 'failed' AND created_at > $1::timestamptz - interval '48 hours') OR (status = 'pending' AND created_at < $1::timestamptz - interval '30 minutes' AND created_at > $1::timestamptz - interval '48 hours')
      ORDER BY created_at DESC LIMIT 10`, [now])).rows;
    if (!rows.length)
        return [];
    return [{ key: "delivery:failing", detector: "delivery_failing", owner: "finagai", severity: "critical",
            summary: `${rows.length} notice(s) to you could not be delivered (latest: ${rows[0].purpose}, ${ago(now, rows[0].created_at)} min ago) — shown here instead`,
            detail: rows.map((r) => `${r.purpose} ${r.status}: ${String(r.last_error ?? "").slice(0, 80)}`).join(" | ") }];
};
/** An Area breaches its service levels. Finagai reconciles first; it reaches Julian only if the breach persists. */
export const areaBreach = async (db) => {
    const out = [];
    for (const a of (await db.query(`SELECT id FROM area WHERE archived_at IS NULL AND status = 'active'`)).rows) {
        const h = await areaHealth(db, a.id);
        if (!h || h.healthy)
            continue;
        // Overdue follow-ups are already escalated one by one to whoever owns them (engine.stateNeeds) — repeating them
        // here would double-ask Julian. What is Finagai's at Area level: projects left without a next step.
        const mine = h.breaches.filter((b) => /no next action/.test(b));
        if (!mine.length)
            continue;
        out.push({ key: `area:${a.id}`, detector: "area_breach", areaId: a.id, owner: "finagai", severity: "warning", remediation: "reconcile_area", escalateAfterMin: 24 * 60,
            summary: `${h.name} is red: ${mine.join("; ")} — Finagai is reconciling it`, detail: h.breaches.join("; ") });
    }
    return out;
};
/** The Mac is unreachable while work waits for it. Waking it is physical — only Julian. */
export const macOffline = async (db, now) => {
    const m = (await db.query(`SELECT last_heartbeat_at FROM mac_runtime WHERE id = 'primary'`)).rows[0];
    if (!m)
        return [];
    const off = ago(now, m.last_heartbeat_at);
    if (off < 30)
        return [];
    const waiting = (await db.query(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM control_task WHERE status = 'active' AND created_at < $1::timestamptz - interval '15 minutes'`, [now])).rows[0];
    if (!waiting?.n)
        return [{ key: "mac:offline", detector: "mac_offline", owner: "finagai", severity: "info", summary: `Your Mac has been unreachable for ${hhmm(off)} — no Mac work is waiting` }];
    return [{ key: "mac:offline:work", detector: "mac_offline", owner: "julian", severity: "warning", needs: "principal_reserved",
            summary: `Your Mac has been unreachable for ${hhmm(off)} and ${waiting.n} Mac task(s) are waiting — wake it / open the Finagai helper (only you can)`,
            detail: `oldest waiting task created ${new Date(waiting.oldest).toISOString()}` }];
};
/** A Mac task that stopped making progress (its lease ran out and nobody resumed it). */
export const stuckTasks = async (db, now) => {
    const rows = (await db.query(`SELECT code, request, last_progress_at FROM control_task WHERE status = 'active' AND claimed_at IS NOT NULL
      AND COALESCE(last_progress_at, claimed_at) < $1::timestamptz - interval '60 minutes' ORDER BY code LIMIT 10`, [now])).rows;
    return rows.map((t) => ({ key: `task:${t.code}:stuck`, detector: "stuck_task", owner: "finagai", severity: "warning", escalateAfterMin: 6 * 60,
        summary: `Mac task ${t.code} has made no progress for ${hhmm(ago(now, t.last_progress_at ?? now))} — Finagai keeps it leased for resumption`, detail: String(t.request).slice(0, 160) }));
};
/** Results Finagai could not verify. Julian's review is needed only when the task CHANGED something (filled, uploaded,
 *  moved, typed, ran…): only he can accept that change. An unverified answer to a read-only question changed nothing —
 *  that is Finagai's verifier problem, noted but never put on his plate (live 2026-10-11: task 129, "have I received an
 *  update from Beth?", would otherwise have been escalated as "your review decides whether it counts"). */
export const STATE_CHANGING_KINDS = ["browser_fill", "browser_fill_form", "browser_select", "browser_check", "browser_upload", "browser_download", "ax_set_value", "type", "key", "hotkey", "move_file", "trash_file", "run", "drag"];
export const reviewBacklog = async (db, now) => {
    const rows = (await db.query(`SELECT t.code, t.result_summary, t.updated_at,
      EXISTS (SELECT 1 FROM control_step s WHERE s.task_id = t.id AND s.status = 'done' AND s.kind = ANY($2::text[])) AS changed
    FROM control_task t WHERE t.verification_status = 'needs_review' AND t.status IN ('done','failed')
      AND t.updated_at < $1::timestamptz - interval '24 hours' AND t.updated_at > $1::timestamptz - interval '14 days' ORDER BY t.code LIMIT 10`, [now, STATE_CHANGING_KINDS])).rows;
    // A read-only one is not an exception at all: nothing is pending for anyone and there is nothing to remedy (the
    // verifier's miss is already in the execution metrics). Listing it would only make "all normal" false.
    return rows.filter((t) => t.changed).map((t) => ({ key: `task:${t.code}:review`, detector: "review_backlog", owner: "julian", severity: "info", needs: "judgment",
        summary: `Task ${t.code} changed something Finagai could not verify — your review decides whether it counts: ${String(t.result_summary ?? "").slice(0, 120)}` }));
};
/**
 * Phase 8 (ADR-088) — the platform's own guarantees, checked continuously. The engine runs the ADR-087 live self-check
 * hourly and records each verdict on the stream (reliability_checked). A check that FAILED in the two latest runs is an
 * exception (one failure can be a coincidence — e.g. Julian's tool call landing inside the read-only window; two in a
 * row is not). PENDING is never a failure. Finagai cannot fix its own code, so if it persists an hour Julian is asked
 * (judgment) to have it fixed; it clears itself when the check passes again.
 */
export const selfCheck = async (db, now) => {
    const runs = (await db.query(`SELECT after FROM event WHERE action = 'reliability_checked' AND occurred_at > $1::timestamptz - interval '3 hours' ORDER BY id DESC LIMIT 2`, [now])).rows
        .map((r) => (r.after ?? {}));
    if (runs.length < 2)
        return [];
    const [latest, previous] = runs;
    return (latest.failing ?? []).filter((c) => (previous.failing ?? []).includes(c)).map((c) => ({
        key: `reliability:${c}`, detector: "self_check", owner: "finagai", severity: "warning", escalateAfterMin: 60,
        summary: `Finagai's live self-check "${c}" failed twice in a row — a platform guarantee (ADR-087) is not holding`,
        detail: `latest run on Core ${latest.version ?? "?"}; see finagai-job: live-acceptance for the evidence`
    }));
};
export const DETECTORS = { watcherFailing, workflowFailing, deadLetters, budget, deliveryFailing, areaBreach, macOffline, stuckTasks, reviewBacklog, selfCheck };
//# sourceMappingURL=detectors.js.map