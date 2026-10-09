import { toolRef } from "../tools/manifest.js";
import { proposeCareerBootstrap } from "./bootstrap.js";
import { interpretCareer, interpretationDigest, opportunitySetDigest, snapshotDigest, traceOrg } from "./career-evidence.js";
const countBy = (xs) => { const m = {}; for (const x of [...xs].sort())
    m[x] = (m[x] ?? 0) + 1; return m; };
/** Jobs at one employer in a proposal's frozen inputs, re-interpreted with the current code (compact). */
export async function jobsAtEmployer(pool, code, employer) {
    const p = await loadProposal(pool, code);
    if ("error" in p)
        return p;
    const asOf = p.payload.provenance?.asOf;
    const i = interpretCareer(p.snapshot, asOf ? { asOf } : {});
    const t = traceOrg(p.snapshot, i, employer);
    return { code, interpreterVersion: i.interpreterVersion, snapshotDigest: i.snapshotDigest, employer: t.employer, jobs: t.jobs,
        unassigned: i.unassigned.filter((u) => u.employerKey === t.employer?.key), sheetRowsNotLinked: t.sheetRows.filter((r) => !t.jobs.some((j) => j.sheetRows.includes(r.id))).length };
}
/** Proof that proposing never wrote Career state: counts of authoritative Career tables and proposal statuses. */
export async function careerState(pool) {
    const q = async (sql) => (await pool.query(sql)).rows;
    return {
        opportunities: Number((await q(`SELECT count(*)::int AS n FROM opportunity`))[0].n), employers: Number((await q(`SELECT count(*)::int AS n FROM employer`))[0].n),
        opportunityEvents: Number((await q(`SELECT count(*)::int AS n FROM opportunity_event`))[0].n),
        careerArea: (await q(`SELECT name FROM area WHERE lower(name) = 'career'`)).length > 0,
        proposals: Object.fromEntries((await q(`SELECT status, count(*)::int AS n FROM bootstrap_proposal GROUP BY status ORDER BY status`)).map((r) => [r.status, r.n])),
        bootstrapAppliedEvents: Number((await q(`SELECT count(*)::int AS n FROM event WHERE action = 'bootstrap_applied'`))[0].n),
    };
}
async function loadProposal(pool, code) {
    const r = await pool.query(`SELECT p.code, p.payload, p.snapshot_digest, p.interpretation_digest, p.opportunity_set_digest, p.interpreter_version, s.payload AS snapshot,
      a.stats AS acq_stats, a.acquired_at AS acq_at, a.search_misses AS acq_misses, a.problems AS acq_problems
    FROM bootstrap_proposal p LEFT JOIN evidence_snapshot s ON s.id = p.snapshot_id LEFT JOIN evidence_acquisition a ON a.id = p.acquisition_id WHERE p.code = $1`, [code]);
    const row = r.rows[0];
    if (!row)
        return { error: `No bootstrap proposal ${code}.` };
    if (!row.snapshot)
        return { error: `Proposal ${code} predates ADR-080: it recorded no input snapshot, so it cannot be replayed or traced.` };
    return { row, snapshot: row.snapshot, payload: row.payload };
}
function shuffled(a, seed) {
    const x = [...a];
    let s = seed >>> 0;
    for (let i = x.length - 1; i > 0; i--) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        const j = s % (i + 1);
        [x[i], x[j]] = [x[j], x[i]];
    }
    return x;
}
export function permuteSnapshot(s, seed) {
    return { ...s, gmail: shuffled(s.gmail, seed).map((g, i) => ({ ...g, records: shuffled(g.records, seed + i + 1) })), calendar: shuffled(s.calendar, seed + 97).map((c, i) => ({ ...c, records: shuffled(c.records, seed + i + 101) })),
        carryForward: shuffled(s.carryForward ?? [], seed + 211).map((c, i) => ({ ...c, records: shuffled(c.records, seed + i + 307) })) };
}
export async function replayProposal(pool, code, runs = 10) {
    const p = await loadProposal(pool, code);
    if ("error" in p)
        return p;
    const asOf = p.payload.provenance?.asOf;
    const out = [];
    for (let n = 0; n < Math.min(Math.max(runs, 1), 50); n++) {
        const s = n === 0 ? p.snapshot : permuteSnapshot(p.snapshot, n * 7919 + 13);
        const i = interpretCareer(s, asOf ? { asOf } : {});
        out.push({ run: n + 1, order: n === 0 ? "as stored" : `permuted (seed ${n * 7919 + 13})`, snapshotDigest: snapshotDigest(s), interpretationDigest: interpretationDigest(i), opportunitySetDigest: opportunitySetDigest(i) });
    }
    const i0 = interpretCareer(p.snapshot, asOf ? { asOf } : {});
    const distinct = (k) => [...new Set(out.map((o) => o[k]))];
    return {
        code, runs: out.length, stored: { snapshotDigest: p.row.snapshot_digest, interpretationDigest: p.row.interpretation_digest, opportunitySetDigest: p.row.opportunity_set_digest, interpreterVersion: p.row.interpreter_version },
        distinctSnapshotDigests: distinct("snapshotDigest"), distinctInterpretationDigests: distinct("interpretationDigest"), distinctOpportunitySets: distinct("opportunitySetDigest"),
        identical: distinct("interpretationDigest").length === 1 && distinct("snapshotDigest").length === 1,
        matchesStoredProposal: distinct("interpretationDigest")[0] === p.row.interpretation_digest,
        jobsByStatus: countBy(i0.opportunities.map((o) => o.status)), jobs: i0.opportunities.length, employers: i0.employers.length, unassignedEvents: i0.unassigned.length,
        perRun: out,
    };
}
export async function traceProposal(pool, code, org) {
    const p = await loadProposal(pool, code);
    if ("error" in p)
        return p;
    const asOf = p.payload.provenance?.asOf;
    const i = interpretCareer(p.snapshot, asOf ? { asOf } : {});
    // Per-run acquisition facts come from THIS proposal's acquisition record (the snapshot row is shared by identical runs).
    const st = (p.row.acq_stats ?? {});
    const via = new Map();
    for (const [k, ids] of Object.entries(st.ids ?? {})) {
        const [q, account] = [k.slice(0, k.indexOf("@")), k.slice(k.indexOf("@") + 1)];
        for (const id of ids)
            via.set(`${account}|${id}`, [...(via.get(`${account}|${id}`) ?? []), q].sort());
    }
    const t = traceOrg(p.snapshot, i, org);
    const found = st.ids ? t.found.map((f) => ({ ...f, acquiredVia: via.get(`${f.account}|${f.recordId}`) ?? ["(not in this run)"] })) : t.found;
    return { code, acquisition: { acquiredAt: p.row.acq_at, searchMisses: p.row.acq_misses, problems: p.row.acq_problems, gmail: st.gmail, carryForward: st.carryForward, calendar: st.calendar, sheet: st.sheet,
            queries: [...new Set(p.snapshot.gmail.map((g) => g.query))] }, ...t, found };
}
// ---------------------------------------------------------------------------------------------------------------
// Live stability job (async; progress persisted after every run).
const STALE_MS = 20 * 60_000;
const PROCESS_STARTED = new Date();
export async function startStabilityJob(pool, google, runs = 10, traceOrgs = ["Immuta", "Transurban"]) {
    // A job started before this process existed died with the previous process (deploy/restart): close it honestly.
    await pool.query(`UPDATE diagnostic_job SET status = 'failed', error = 'Core restarted while the job was running', finished_at = now() WHERE status = 'running' AND created_at < $1`, [PROCESS_STARTED]);
    const running = await pool.query(`SELECT code FROM diagnostic_job WHERE kind = 'career_stability' AND status = 'running' LIMIT 1`);
    if (running.rows[0])
        return { jobCode: Number(running.rows[0].code), reused: true, note: "A stability job is already running." };
    const n = Math.min(Math.max(runs, 2), 20);
    const j = await pool.query(`INSERT INTO diagnostic_job (kind, params) VALUES ('career_stability', $1::jsonb) RETURNING id, code`, [JSON.stringify({ runs: n, traceOrgs })]);
    const id = String(j.rows[0].id);
    void (async () => {
        const progress = [];
        const codes = [];
        try {
            for (let k = 1; k <= n; k++) {
                const t0 = Date.now();
                const r = await proposeCareerBootstrap(pool, google, new Date());
                codes.push(r.code);
                const pv = r.summary.provenance;
                const d = r.summary.delta;
                progress.push({ run: k, proposal: r.code, ms: Date.now() - t0, acquiredAt: pv.acquiredAt, snapshotDigest: pv.snapshotDigest, interpretationDigest: pv.interpretationDigest,
                    opportunitySetDigest: pv.opportunitySetDigest, complete: pv.complete, problems: pv.problems, records: pv.records, searchMisses: pv.searchMisses,
                    jobsByStatus: countBy(r.interp.opportunities.map((o) => o.status)), jobs: r.interp.opportunities.length,
                    vsPrevious: d ? { sameInput: d.sameInput, sameOpportunitySet: d.sameOpportunitySet, addedCount: d.addedRecords.length, removedCount: d.removedRecords.length,
                        addedRecords: d.addedRecords.slice(0, 25), removedRecords: d.removedRecords.slice(0, 25), sheet: { ...d.sheet, rowsAdded: d.sheet.rowsAdded.slice(0, 25), rowsRemoved: d.sheet.rowsRemoved.slice(0, 25) },
                        oppAdded: d.oppAdded, oppRemoved: d.oppRemoved, statusChanged: d.statusChanged, unexplained: d.unexplained } : null });
                await pool.query(`UPDATE diagnostic_job SET progress = $2::jsonb WHERE id = $1`, [id, JSON.stringify(progress)]);
            }
            // Keep only the last proposal pending; earlier diagnostic proposals are discarded (they are evidence, not candidates).
            if (codes.length > 1)
                await pool.query(`UPDATE bootstrap_proposal SET status = 'discarded' WHERE code = ANY($1::bigint[]) AND status = 'pending'`, [codes.slice(0, -1)]);
            const runsOut = progress;
            const distinct = (k) => [...new Set(runsOut.map((x) => x[k]))];
            // Within the job, run 1 is compared with the snapshot before the job; runs 2..n with the previous run.
            const within = runsOut.slice(1);
            const unexplained = runsOut.flatMap((x) => x.vsPrevious?.unexplained ?? []);
            const inputChanged = within.some((x) => x.vsPrevious && !x.vsPrevious.sameInput);
            const setStable = new Set(within.map((x) => x.opportunitySetDigest).concat(runsOut[0].opportunitySetDigest)).size === 1;
            const verdict = runsOut.some((x) => !x.complete) ? "INCOMPLETE_ACQUISITION" : unexplained.length ? "UNSTABLE" : setStable ? "STABLE" : inputChanged ? "CHANGED_WITH_ATTRIBUTED_EVIDENCE" : "UNSTABLE";
            const traces = {};
            for (const o of traceOrgs)
                traces[o] = await traceProposal(pool, codes[codes.length - 1], o);
            const result = { verdict, runs: runsOut.length, proposals: codes, keptPending: codes[codes.length - 1], distinctSnapshotDigests: distinct("snapshotDigest"),
                distinctOpportunitySets: distinct("opportunitySetDigest"), distinctInterpretationDigests: distinct("interpretationDigest"), allComplete: runsOut.every((x) => x.complete),
                unexplained, traces };
            await pool.query(`UPDATE diagnostic_job SET status = 'done', result = $2::jsonb, finished_at = now() WHERE id = $1`, [id, JSON.stringify(result)]);
        }
        catch (e) {
            await pool.query(`UPDATE diagnostic_job SET status = 'failed', error = $2, finished_at = now(), progress = $3::jsonb WHERE id = $1`, [id, String(e?.stack ?? e).slice(0, 2000), JSON.stringify(progress)]).catch(() => { });
        }
    })();
    return { jobCode: Number(j.rows[0].code), runs: n, note: `Running ${n} consecutive live proposals; read it: ${toolRef("diagnostic_result", { code: Number(j.rows[0].code) })}.` };
}
export async function diagnosticResult(pool, code) {
    const r = await pool.query(`SELECT code, kind, params, status, progress, result, error, created_at, finished_at FROM diagnostic_job WHERE code = $1`, [code]);
    const j = r.rows[0];
    if (!j)
        return { error: `No diagnostic job ${code}.` };
    const stale = j.status === "running" && Date.now() - new Date(j.created_at).getTime() > STALE_MS;
    return { code: Number(j.code), kind: j.kind, params: j.params, status: stale ? "stale (Core restarted mid-run?)" : j.status, completedRuns: j.progress.length,
        progress: j.progress, result: j.result, error: j.error, startedAt: j.created_at, finishedAt: j.finished_at };
}
//# sourceMappingURL=career-diagnostics.js.map