/**
 * ADR-080 operator channel: a small WHITELIST of read-only Core diagnostics reachable through `control_mac` with a
 * `finagai-job:` prefix, so surfaces whose MCP tool list predates the diagnostics tools can still run them. These
 * never create a Mac task, never touch the Mac, and never write Career state (no apply exists here).
 */
import type pg from "pg";
import { compactProposal, proposeCareerBootstrap, reinterpretProposal } from "./bootstrap.js";
import { careerState, diagnosticResult, jobsAtEmployer, replayProposal, startStabilityJob, traceProposal } from "./career-diagnostics.js";
import type { GoogleSearch } from "../resources/retrieve.js";
import { startCareerSync } from "./career-sync.js";
import { findOpportunity, inTx, lifecycleTick, pipelineSummary } from "./opportunities.js";
import { areaStatus, executiveBriefV2, waitingOn } from "./operating.js";

export type FinagaiJob =
  | { kind: "stability"; runs: number; orgs: string[] } | { kind: "result"; code: number } | { kind: "trace"; code: number; org: string }
  | { kind: "replay"; code: number; runs: number } | { kind: "propose" } | { kind: "jobs"; code: number; employer: string } | { kind: "career-state" } | { kind: "proposal"; code: number } | { kind: "reinterpret"; code: number } | { kind: "acquisitions"; limit: number } | { kind: "unknown"; text: string }
  | { kind: "pipeline"; area: string } | { kind: "find"; text: string } | { kind: "sync-preview" } | { kind: "lifecycle-preview" } | { kind: "brief" } | { kind: "area-status"; area: string } | { kind: "waiting" };

export function parseFinagaiJob(request: string): FinagaiJob | null {
  const m = /^\s*finagai-job:\s*(.*)$/is.exec(request);
  if (!m) return null;
  const t = m[1]!.trim(); const [cmd, ...rest] = t.split(/\s+/); const c = (cmd ?? "").toLowerCase();
  const int = (s: string | undefined, d: number) => (s && /^\d+$/.test(s) ? Number(s) : d);
  if (c === "stability") { const runs = int(rest[0], 10); const orgs = (rest[0] && /^\d+$/.test(rest[0]) ? rest.slice(1) : rest).join(" ").split(",").map((x) => x.trim()).filter(Boolean); return { kind: "stability", runs, orgs: orgs.length ? orgs : ["Immuta", "Transurban"] }; }
  if (c === "result" && rest[0]) return { kind: "result", code: int(rest[0], 0) };
  if (c === "trace" && rest[0] && rest[1]) return { kind: "trace", code: int(rest[0], 0), org: rest.slice(1).join(" ") };
  if (c === "replay" && rest[0]) return { kind: "replay", code: int(rest[0], 0), runs: int(rest[1], 10) };
  if (c === "propose") return { kind: "propose" };
  if (c === "jobs" && rest[0] && rest[1]) return { kind: "jobs", code: int(rest[0], 0), employer: rest.slice(1).join(" ") };
  if (c === "career-state") return { kind: "career-state" };
  if (c === "proposal" && rest[0]) return { kind: "proposal", code: int(rest[0], 0) };
  if (c === "reinterpret" && rest[0]) return { kind: "reinterpret", code: int(rest[0], 0) };
  if (c === "acquisitions") return { kind: "acquisitions", limit: Math.min(int(rest[0], 10), 30) };
  // Phase 4 (ADR-082): read-only views and PREVIEWS (computed inside a transaction that is rolled back).
  if (c === "pipeline") return { kind: "pipeline", area: rest.join(" ") || "Career" };
  if (c === "find" && rest.length) return { kind: "find", text: rest.join(" ") };
  if (c === "sync-preview") return { kind: "sync-preview" };
  if (c === "lifecycle-preview") return { kind: "lifecycle-preview" };
  if (c === "brief") return { kind: "brief" };
  if (c === "area-status") return { kind: "area-status", area: rest.join(" ") || "Career" };
  if (c === "waiting") return { kind: "waiting" };
  return { kind: "unknown", text: t.slice(0, 100) };
}

export async function runFinagaiJob(pool: pg.Pool, google: GoogleSearch | undefined, job: FinagaiJob): Promise<object> {
  switch (job.kind) {
    case "stability": return startStabilityJob(pool, google, job.runs, job.orgs);
    case "result": return diagnosticResult(pool, job.code);
    case "trace": return traceProposal(pool, job.code, job.org);
    case "replay": return replayProposal(pool, job.code, job.runs);
    case "jobs": return jobsAtEmployer(pool, job.code, job.employer);
    case "career-state": return careerState(pool);
    case "reinterpret": { const r = await reinterpretProposal(pool, job.code); if ("error" in r) return r; return { supersedes: r.supersedes, ...compactProposal(r.code, r.summary) }; }
    case "proposal": { const r = (await pool.query(`SELECT code, status, payload FROM bootstrap_proposal WHERE code = $1`, [job.code])).rows[0];
      if (!r) return { error: `No bootstrap proposal ${job.code}.` };
      const { opportunities: _o, ...s } = r.payload as import("./bootstrap.js").BootstrapPayload; void _o;
      return { status: r.status, ...compactProposal(Number(r.code), s) }; }
    case "propose": { const r = await proposeCareerBootstrap(pool, google); return compactProposal(r.code, r.summary); }
    case "acquisitions": {
      const r = await pool.query(`SELECT a.acquired_at, a.complete, a.search_misses, a.problems, a.stats, s.digest, s.record_count FROM evidence_acquisition a JOIN evidence_snapshot s ON s.id = a.snapshot_id
        WHERE a.area = 'Career' ORDER BY a.acquired_at DESC LIMIT $1`, [job.limit]);
      return { acquisitions: r.rows };
    }
    case "pipeline": return pipelineSummary(pool, job.area);
    case "find": return findOpportunity(pool, { query: job.text });
    case "sync-preview": return startCareerSync(pool, google, true);
    case "lifecycle-preview": return inTx(pool, true, async (tx) => ({ preview: true, note: "computed and rolled back — nothing was written", ...(await lifecycleTick(tx, new Date())) }));
    case "brief": return executiveBriefV2(pool);
    case "area-status": return areaStatus(pool, job.area);
    case "waiting": return waitingOn(pool, null);
    case "unknown": return { error: `Unknown finagai-job "${job.text}". Allowed: stability [runs] [org,org], result <code>, trace <proposal> <org>, replay <proposal> [runs], jobs <proposal> <employer>, proposal <code>, reinterpret <code>, career-state, propose, acquisitions [n], pipeline [area], find <text>, sync-preview, lifecycle-preview, brief, area-status [area], waiting.` };
  }
}
