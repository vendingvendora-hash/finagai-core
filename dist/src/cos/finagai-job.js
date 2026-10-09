import { compactProposal, proposeCareerBootstrap, reinterpretProposal } from "./bootstrap.js";
import { careerState, diagnosticResult, jobsAtEmployer, replayProposal, startStabilityJob, traceProposal } from "./career-diagnostics.js";
export function parseFinagaiJob(request) {
    const m = /^\s*finagai-job:\s*(.*)$/is.exec(request);
    if (!m)
        return null;
    const t = m[1].trim();
    const [cmd, ...rest] = t.split(/\s+/);
    const c = (cmd ?? "").toLowerCase();
    const int = (s, d) => (s && /^\d+$/.test(s) ? Number(s) : d);
    if (c === "stability") {
        const runs = int(rest[0], 10);
        const orgs = (rest[0] && /^\d+$/.test(rest[0]) ? rest.slice(1) : rest).join(" ").split(",").map((x) => x.trim()).filter(Boolean);
        return { kind: "stability", runs, orgs: orgs.length ? orgs : ["Immuta", "Transurban"] };
    }
    if (c === "result" && rest[0])
        return { kind: "result", code: int(rest[0], 0) };
    if (c === "trace" && rest[0] && rest[1])
        return { kind: "trace", code: int(rest[0], 0), org: rest.slice(1).join(" ") };
    if (c === "replay" && rest[0])
        return { kind: "replay", code: int(rest[0], 0), runs: int(rest[1], 10) };
    if (c === "propose")
        return { kind: "propose" };
    if (c === "jobs" && rest[0] && rest[1])
        return { kind: "jobs", code: int(rest[0], 0), employer: rest.slice(1).join(" ") };
    if (c === "career-state")
        return { kind: "career-state" };
    if (c === "proposal" && rest[0])
        return { kind: "proposal", code: int(rest[0], 0) };
    if (c === "reinterpret" && rest[0])
        return { kind: "reinterpret", code: int(rest[0], 0) };
    if (c === "acquisitions")
        return { kind: "acquisitions", limit: Math.min(int(rest[0], 10), 30) };
    return { kind: "unknown", text: t.slice(0, 100) };
}
export async function runFinagaiJob(pool, google, job) {
    switch (job.kind) {
        case "stability": return startStabilityJob(pool, google, job.runs, job.orgs);
        case "result": return diagnosticResult(pool, job.code);
        case "trace": return traceProposal(pool, job.code, job.org);
        case "replay": return replayProposal(pool, job.code, job.runs);
        case "jobs": return jobsAtEmployer(pool, job.code, job.employer);
        case "career-state": return careerState(pool);
        case "reinterpret": {
            const r = await reinterpretProposal(pool, job.code);
            if ("error" in r)
                return r;
            return { supersedes: r.supersedes, ...compactProposal(r.code, r.summary) };
        }
        case "proposal": {
            const r = (await pool.query(`SELECT code, status, payload FROM bootstrap_proposal WHERE code = $1`, [job.code])).rows[0];
            if (!r)
                return { error: `No bootstrap proposal ${job.code}.` };
            const { opportunities: _o, ...s } = r.payload;
            void _o;
            return { status: r.status, ...compactProposal(Number(r.code), s) };
        }
        case "propose": {
            const r = await proposeCareerBootstrap(pool, google);
            return compactProposal(r.code, r.summary);
        }
        case "acquisitions": {
            const r = await pool.query(`SELECT a.acquired_at, a.complete, a.search_misses, a.problems, a.stats, s.digest, s.record_count FROM evidence_acquisition a JOIN evidence_snapshot s ON s.id = a.snapshot_id
        WHERE a.area = 'Career' ORDER BY a.acquired_at DESC LIMIT $1`, [job.limit]);
            return { acquisitions: r.rows };
        }
        case "unknown": return { error: `Unknown finagai-job "${job.text}". Allowed: stability [runs] [org,org], result <code>, trace <proposal> <org>, replay <proposal> [runs], jobs <proposal> <employer>, proposal <code>, reinterpret <code>, career-state, propose, acquisitions [n].` };
    }
}
//# sourceMappingURL=finagai-job.js.map