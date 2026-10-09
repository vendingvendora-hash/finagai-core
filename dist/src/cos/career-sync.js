import { appendEvent } from "../db/index.js";
import { acquireAndStoreCareer, buildCareerPayload } from "./bootstrap.js";
import { interpretCareer, interpretationDigest, INTERPRETER_VERSION } from "./career-evidence.js";
import { isTerminal, transitionAllowed } from "./lifecycle.js";
import { inTx, lifecycleTick } from "./opportunities.js";
const label = (o) => `${o.org} — ${o.title}${o.reqId ? ` (${o.reqId})` : ""}`;
/** Pure-ish reconcile of one interpreted job against the stored row (no I/O). */
export function planJob(o, stored) {
    if (!stored)
        return { create: true, newEvents: o.events, status: o.status, decision: null };
    const newEvents = o.events.filter((e) => !stored.eventIds.has(e.sourceId));
    if (o.status === stored.status)
        return { create: false, newEvents, status: null, decision: null };
    const t = transitionAllowed(stored.status, o.status);
    if (t.ok)
        return { create: false, newEvents, status: o.status, decision: null };
    // Backwards (e.g. the sheet still says "analyzed" for a job Julian recorded as applied) is ignored: stored state is ahead.
    if (t.anomaly && o.statusSource === "evidence" && newEvents.length)
        return { create: false, newEvents, status: null, decision: `${label(o)}: evidence says ${o.status} but the job is ${stored.status} — ${t.anomaly}` };
    return { create: false, newEvents, status: null, decision: null };
}
export async function syncCareer(pool, google, opts = {}) {
    const now = opts.now ?? new Date();
    const dryRun = opts.dryRun === true;
    const area = (await pool.query(`SELECT id, name FROM area WHERE archived_at IS NULL AND lower(name) = 'career'`)).rows[0];
    const applied = (await pool.query(`SELECT code FROM bootstrap_proposal WHERE area = 'Career' AND status = 'applied' ORDER BY applied_at DESC LIMIT 1`)).rows[0];
    if (!area || !applied)
        return { error: "The Career bootstrap has not been applied yet — sync keeps APPLIED state current; apply a bootstrap first." };
    const acq = await acquireAndStoreCareer(pool, (google ?? {}), now);
    const interp = interpretCareer(acq.snapshot, { asOf: now.toISOString() });
    const base = { dryRun, area: String(area.name), acquiredAt: acq.snapshot.acquiredAt, snapshotDigest: acq.digest, interpretationDigest: interpretationDigest(interp), interpreterVersion: INTERPRETER_VERSION,
        records: acq.records, complete: acq.snapshot.completeness.complete, problems: acq.snapshot.completeness.problems };
    if (!acq.snapshot.completeness.complete)
        return { ...base, ok: false, newSourceRecords: 0, changes: [], lifecycle: [], decisions: [`Not synced: the acquisition was incomplete (${acq.snapshot.completeness.problems.join("; ")}). Nothing was written.`],
            unassigned: [], kept: 0, supersededProposals: [], counts: { jobsCreated: 0, eventsAdded: 0, statusChanges: 0, lifecycleChanges: 0, decisions: 1 } };
    const payload = buildCareerPayload(interp, acq.snapshot, []);
    return inTx(pool, dryRun, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('finagai.career_sync'))`);
        const rows = (await tx.query(`SELECT id, dedupe_key, alias_keys, status FROM opportunity WHERE kind = 'job' AND archived_at IS NULL`)).rows;
        const byKey = new Map();
        for (const r of rows)
            for (const k of new Set([r.dedupe_key, ...r.alias_keys]))
                byKey.set(k, [...(byKey.get(k) ?? []), r]);
        const evRows = (await tx.query(`SELECT opportunity_id, source_id FROM opportunity_event WHERE source = 'gmail'`)).rows;
        const eventsOf = new Map();
        for (const e of evRows)
            (eventsOf.get(e.opportunity_id) ?? eventsOf.set(e.opportunity_id, new Set()).get(e.opportunity_id)).add(e.source_id);
        const seenRecords = new Set(evRows.map((e) => String(e.source_id)));
        const changes = [];
        const decisions = [];
        const touched = new Set();
        let jobsCreated = 0, eventsAdded = 0, statusChanges = 0, kept = 0;
        const empIds = new Map();
        for (const e of payload.employers ?? []) {
            const r = await tx.query(`INSERT INTO employer (key, name, aliases, party, details) VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (key) DO UPDATE SET aliases = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(employer.aliases || EXCLUDED.aliases) x), updated_at = now() RETURNING id`, [e.key, e.name, e.aliases, e.party, JSON.stringify({ partyReason: e.partyReason })]);
            empIds.set(e.key, String(r.rows[0].id));
        }
        for (const o of payload.opportunities) {
            const keys = [...new Set([o.dedupe, ...o.aliasKeys])];
            const exact = byKey.get(o.dedupe) ?? [];
            const cands = exact.length === 1 ? exact : [...new Map(keys.flatMap((k) => byKey.get(k) ?? []).map((r) => [r.id, r])).values()];
            if (cands.length > 1) {
                decisions.push(`${label(o)}: matches ${cands.length} stored jobs — not merged, not written (identity needs you)`);
                continue;
            }
            const stored = cands[0] ?? null;
            const plan = planJob(o, stored ? { status: stored.status, eventIds: eventsOf.get(stored.id) ?? new Set() } : null);
            if (plan.decision)
                decisions.push(plan.decision);
            let id = stored?.id ?? null;
            if (plan.create) {
                // A sheet-only row that is new is a pipeline record; it carries no event and no lifecycle work.
                let employerId = empIds.get(o.employerKey) ?? null;
                if (!employerId)
                    employerId = String((await tx.query(`INSERT INTO employer (key, name, aliases) VALUES ($1, $2, ARRAY[$1]) ON CONFLICT (key) DO UPDATE SET updated_at = now() RETURNING id`, [o.employerKey, o.org])).rows[0].id);
                id = String((await tx.query(`INSERT INTO opportunity (kind, area_id, org, title, url, location, work_mode, salary, eligibility, status, fit_score, fit_notes, resume_ref, source, dedupe_key, details,
            employer_id, requisition_id, identity_basis, alias_keys, source_ids, contact, first_evidence_at, last_evidence_at, applied_at)
          VALUES ('job', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23, $24) RETURNING id`, [area.id, o.org, o.title, o.url, o.location, o.workMode, o.salary, o.eligibility, o.status, o.fitScore, o.fitNotes, o.resume, o.statusSource === "evidence" ? "gmail" : `career_copilot:${o.sourceId}`, o.dedupe,
                    JSON.stringify({ folder: o.folder, sheetUpdatedAt: o.updatedAt, statusSource: o.statusSource, anomalies: o.anomalies, via: "sync" }),
                    employerId, o.reqId, o.identityBasis, keys, o.sourceIds, o.contact, o.firstEvidenceAt, o.lastEvidenceAt, o.appliedAt])).rows[0].id);
                jobsCreated++;
                changes.push({ job: label(o), change: "new job", detail: `${o.status} (${o.statusSource})`, sources: o.events.length ? o.events.map((e) => `gmail:${e.sourceId}`) : o.sourceIds });
                if (o.events.length)
                    touched.add(id);
            }
            else if (stored) {
                await tx.query(`UPDATE opportunity SET alias_keys = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(alias_keys || $2::text[]) x), source_ids = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(source_ids || $3::text[]) x),
            requisition_id = COALESCE(requisition_id, $4), contact = COALESCE(contact, $5), url = COALESCE(url, $6), location = COALESCE(location, $7), fit_score = COALESCE(fit_score, $8),
            first_evidence_at = LEAST(first_evidence_at, $9), last_evidence_at = GREATEST(last_evidence_at, $10), applied_at = COALESCE(applied_at, $11) WHERE id = $1`, [stored.id, keys, o.sourceIds, o.reqId, o.contact, o.url, o.location, o.fitScore, o.firstEvidenceAt, o.lastEvidenceAt, o.appliedAt]);
                if (plan.status) {
                    await tx.query(`UPDATE opportunity SET status = $2, updated_at = now() WHERE id = $1`, [stored.id, plan.status]);
                    await appendEvent(tx, { actor: "cos", action: "opportunity_status", entityType: "opportunity", entityId: stored.id, before: { status: stored.status }, after: { status: plan.status, via: "career_sync", sources: plan.newEvents.map((e) => e.sourceId) } });
                    statusChanges++;
                    touched.add(stored.id);
                    changes.push({ job: label(o), change: "status", detail: `${stored.status} → ${plan.status}${o.statusSource === "sheet" ? " (Career Copilot sheet)" : ""}`, sources: plan.newEvents.length ? plan.newEvents.map((e) => `gmail:${e.sourceId}`) : o.sourceIds.filter((s) => s.startsWith("sheet:")) });
                }
                else if (!plan.newEvents.length)
                    kept++;
            }
            for (const e of plan.newEvents) {
                if (!id)
                    break;
                const r = await tx.query(`INSERT INTO opportunity_event (opportunity_id, at, kind, source, source_id, summary, transition) VALUES ($1, $2, $3, 'gmail', $4, $5, $6) ON CONFLICT DO NOTHING`, [id, e.at, e.kind, e.sourceId, e.subject, e.transition]);
                if (r.rowCount) {
                    eventsAdded++;
                    touched.add(id);
                    if (!plan.create)
                        changes.push({ job: label(o), change: "event", detail: `${e.at.slice(0, 10)} ${e.kind}: ${e.subject}`.slice(0, 200), sources: [`gmail:${e.sourceId}`] });
                }
            }
            // The interpreter never reopens a terminal job; a NEW record it flagged as an anomaly is Julian's to judge.
            const flagged = plan.newEvents.filter((e) => o.anomalies.some((a) => a.includes(e.sourceId)));
            if (stored && !plan.decision && flagged.length)
                decisions.push(`${label(o)}: ${flagged.map((e) => `${e.at.slice(0, 10)} ${e.kind}`).join(", ")} arrived after the job was ${isTerminal(stored.status) ? stored.status : o.status} — recorded as history, status unchanged (a new application is a new job)`);
        }
        const unassigned = (payload.unassigned ?? []).filter((u) => !seenRecords.has(u.recordId)).map((u) => `${u.at.slice(0, 10)} ${u.employer} ${u.kind} (record ${u.recordId}): ${u.reason}`);
        const tick = await lifecycleTick(tx, now, { areaId: String(area.id) });
        // Older pending bootstrap proposals are evidence of earlier runs, not candidates any more.
        const sup = (await tx.query(`UPDATE bootstrap_proposal SET status = 'discarded' WHERE area = 'Career' AND status = 'pending' RETURNING code`)).rows.map((r) => Number(r.code)).sort((a, b) => a - b);
        const newSourceRecords = new Set(changes.flatMap((c) => c.sources).filter((s) => s.startsWith("gmail:"))).size;
        const result = { ...base, ok: true, newSourceRecords, changes, lifecycle: tick.changes, decisions, unassigned, kept, supersededProposals: sup,
            counts: { jobsCreated, eventsAdded, statusChanges, lifecycleChanges: tick.changes.length, decisions: decisions.length } };
        await appendEvent(tx, { actor: "cos", action: "career_synced", entityType: "area", entityId: String(area.id),
            after: { dryRun, snapshot: acq.digest, counts: result.counts, decisions: decisions.slice(0, 20), changes: changes.slice(0, 40).map((c) => `${c.change}: ${c.job} — ${c.detail}`), lifecycle: tick.changes.slice(0, 40).map((c) => `${c.change}: ${c.job} — ${c.detail}`) } });
        void touched;
        return result;
    });
}
/** Async wrapper (acquisition can take a minute): progress and result are kept in diagnostic_job. */
/** Compact, decision-relevant view of a sync result for chat (full detail stays in the diagnostic job). */
export function compactSync(r) {
    return { ok: r.ok, preview: r.dryRun, snapshot: r.snapshotDigest, records: r.records, complete: r.complete, newSourceRecords: r.newSourceRecords, counts: r.counts,
        changes: r.changes.slice(0, 30).map((c) => `${c.change}: ${c.job} — ${c.detail} [${c.sources.join(", ")}]`),
        nextSteps: r.lifecycle.slice(0, 30).map((c) => `${c.change}: ${c.job} — ${c.detail}`),
        decisions: r.decisions, unassignedEvents: r.unassigned.length, supersededProposals: r.supersededProposals.length };
}
/** Start a sync and wait for it up to waitMs (it usually takes seconds thanks to the content cache); else return the job code. */
export async function runCareerSync(pool, google, dryRun, waitMs = 50_000) {
    const started = await startCareerSync(pool, google, dryRun);
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
        const j = (await pool.query(`SELECT status, result, error FROM diagnostic_job WHERE code = $1`, [started.jobCode])).rows[0];
        if (j && j.status !== "running") {
            if (j.status === "failed" || !j.result || "error" in j.result)
                return { jobCode: started.jobCode, error: j.error ?? j.result?.error ?? "sync failed" };
            return { jobCode: started.jobCode, ...compactSync(j.result) };
        }
        await new Promise((res) => setTimeout(res, 1000));
    }
    return { ...started, note: `${started.note} Still running after ${Math.round(waitMs / 1000)}s.` };
}
export async function startCareerSync(pool, google, dryRun) {
    const running = await pool.query(`SELECT code FROM diagnostic_job WHERE kind = 'career_sync' AND status = 'running' AND created_at > now() - interval '20 minutes' LIMIT 1`);
    if (running.rows[0])
        return { jobCode: Number(running.rows[0].code), reused: true, note: "A Career sync is already running." };
    const j = await pool.query(`INSERT INTO diagnostic_job (kind, params) VALUES ('career_sync', $1::jsonb) RETURNING id, code`, [JSON.stringify({ dryRun })]);
    const id = String(j.rows[0].id);
    void (async () => {
        try {
            const r = await syncCareer(pool, google, { dryRun });
            await pool.query(`UPDATE diagnostic_job SET status = $2, result = $3::jsonb, error = $4, finished_at = now() WHERE id = $1`, [id, "error" in r ? "failed" : "done", JSON.stringify(r), "error" in r ? r.error : null]);
        }
        catch (e) {
            await pool.query(`UPDATE diagnostic_job SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [id, String(e?.stack ?? e).slice(0, 2000)]).catch(() => { });
        }
    })();
    return { jobCode: Number(j.rows[0].code), dryRun, note: `Career sync ${dryRun ? "preview " : ""}started; read it with diagnostic_result {code:${j.rows[0].code}}.` };
}
//# sourceMappingURL=career-sync.js.map