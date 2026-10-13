/**
 * Phase 8 (ADR-088, increment 2) — the continuous internal canary.
 *
 * The hourly self-check proves the ADR-087 guarantees over whatever real traffic happened; on a quiet day nothing
 * exercises the state-change paths at all. This canary drives one labeled, disposable job through Finagai's NORMAL
 * paths (the same functions the MCP tools call — track, record evidence, withdraw, remove test job) in the dedicated
 * "Finagai Test" Area, then checks on the Live State Stream that every step produced its semantic events: the object,
 * a before-state for every transition, the object's own Area, a unit of work and a cause. Cleanup is the normal,
 * non-destructive path (withdraw → follow-up done, project completed → test job archived); nothing is deleted.
 * The verdict is recorded on the stream (canary_ran); two failed runs in a row are a Finagai-owned exception.
 * It never touches Career, never sends anything, and never asks Julian for anything.
 */
import { randomUUID } from "node:crypto";
import { withCause } from "../db/live-context.js";
import { EVENT_SEMANTICS } from "../db/state-events.js";
import { archiveTestJob, recordOnJob, TEST_AREA, trackOpportunity } from "../cos/opportunities.js";
import { toEnvelopes } from "./stream.js";
async function unit(what, fn) {
    const correlationId = randomUUID();
    const value = await withCause({ correlationId, causeIds: [], root: { actor: "system", what: `canary:${what}` } }, fn);
    return { value, correlationId };
}
/**
 * Checked on the Live State Stream itself (the same envelopes a viewer gets): every state event of the unit names its
 * object, shows the object's own Area, cites a cause, and — for a transition — carries a before-state.
 */
async function verify(pool, correlationId, testArea, expect) {
    const rows = (await pool.query(`SELECT l.seq, e.id, e.occurred_at, e.actor, e.action, e.entity_type, e.entity_id, e.before, e.after, e.request_id, e.approval_id, e.correlation_id, e.cause_ids, e.area_id
      FROM event e LEFT JOIN live_event l ON l.event_id = e.id WHERE e.correlation_id = $1 ORDER BY e.id`, [correlationId])).rows;
    const envs = await toEnvelopes(pool, rows);
    const problems = [];
    const state = envs.filter((e) => e.entity.type && ["opportunity", "followup", "project"].includes(e.entity.type));
    for (const e of state) {
        if (!e.entity.id)
            problems.push(`${e.eventId} ${e.action}: no object`);
        if (e.area?.id !== testArea)
            problems.push(`${e.eventId} ${e.action}: shown under ${e.area?.name ?? "no Area"}, not ${TEST_AREA}`);
        if (!e.cause.eventIds.length)
            problems.push(`${e.eventId} ${e.action}: no cause`);
        if (EVENT_SEMANTICS[e.action] === "transition" && (!e.before || !Object.keys(e.before).length))
            problems.push(`${e.eventId} ${e.action}: transition without before-state`);
    }
    for (const x of expect) {
        const hit = state.filter((e) => e.action === x.action && e.entity.type === x.entity);
        if (!hit.length) {
            problems.push(`missing ${x.action} on ${x.entity}`);
            continue;
        }
        for (const e of hit) {
            const p = x.check?.(e);
            if (p)
                problems.push(`${e.eventId} ${e.action}: ${p}`);
        }
    }
    return { events: envs.length, problems };
}
export async function runStateCanary(pool, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z"; // 20261013T0715Z
    const label = `FINAGAI-CANARY-${stamp}`;
    const steps = [];
    let jobId = null;
    const add = (step, v) => { steps.push({ step, ok: !v.problems.length, events: v.events, problems: v.problems.slice(0, 10) }); return !v.problems.length; };
    const fail = (step, e) => steps.push({ step, ok: false, events: 0, problems: [String(e?.message ?? e).slice(0, 200)] });
    try {
        // 1) track a labeled fixture job as applied three days ago → job, project, Finagai-owned follow-up, in Finagai Test
        const applied = new Date(now.getTime() - 3 * 86_400_000);
        const t = await unit("track", () => trackOpportunity(pool, { employer: label, title: "State Path Canary", status: "applied", at: applied.toISOString(), source: "canary",
            url: `https://finagai-core.onrender.com/fixtures/${label.toLowerCase()}`, notes: "FINAGAI INTERNAL CANARY (ADR-088) — acceptance-test data, not a real job" }, now));
        const tracked = t.value;
        if (!tracked.jobId)
            throw new Error(`track failed: ${tracked.error ?? JSON.stringify(tracked).slice(0, 160)}`);
        jobId = tracked.jobId;
        const testArea = String((await pool.query(`SELECT area_id FROM opportunity WHERE id = $1`, [jobId])).rows[0]?.area_id ?? "");
        if (!add("track", await verify(pool, t.correlationId, testArea, [
            { action: "opportunity_tracked", entity: "opportunity" },
            { action: "opportunity_status", entity: "opportunity", check: (e) => (e.after?.status === "applied" ? null : `status ${String(e.after?.status)}`) },
            { action: "followup_created", entity: "followup" },
        ])))
            return { ok: false, jobId, label, steps };
        // 2) new evidence (the application was viewed today) → the follow-up is rescheduled, as its own transition
        const v = await unit("evidence", () => recordOnJob(pool, jobId, { kind: "application", at: now, source: "canary", sourceId: `canary:viewed:${stamp}`, summary: "application viewed (internal canary)" }, now));
        if (!add("evidence", await verify(pool, v.correlationId, testArea, [
            { action: "opportunity_evidence_added", entity: "opportunity" },
            { action: "followup_updated", entity: "followup", check: (e) => (e.before?.due_at && e.after?.due_at && e.before.due_at !== e.after.due_at ? null : "due date did not move") },
        ])))
            return { ok: false, jobId, label, steps };
        // 3) withdraw → status withdrawn, follow-up closed, project completed (the normal lifecycle)
        const w = await unit("withdraw", () => recordOnJob(pool, jobId, { kind: "withdrawal", at: now, source: "canary", sourceId: `canary:withdrawal:${stamp}`, summary: "internal canary cleanup — acceptance-test data" }, now));
        add("withdraw", await verify(pool, w.correlationId, testArea, [
            { action: "opportunity_status", entity: "opportunity", check: (e) => (e.after?.status === "withdrawn" ? null : `status ${String(e.after?.status)}`) },
            { action: "followup_done", entity: "followup" },
            { action: "project_completed", entity: "project" },
        ]));
    }
    catch (e) {
        fail(jobId ? "run" : "track", e);
    }
    // 4) cleanup — the normal non-destructive removal of a test (fixture) job: archived, never deleted
    if (jobId) {
        try {
            const a = await unit("cleanup", () => archiveTestJob(pool, jobId));
            const testArea = String((await pool.query(`SELECT area_id FROM opportunity WHERE id = $1`, [jobId])).rows[0]?.area_id ?? "");
            add("cleanup", await verify(pool, a.correlationId, testArea, [{ action: "opportunity_archived", entity: "opportunity" }, { action: "project_archived", entity: "project" }]));
        }
        catch (e) {
            fail("cleanup", e);
        }
    }
    return { ok: steps.length > 0 && steps.every((s) => s.ok), jobId, label, steps };
}
//# sourceMappingURL=canary.js.map