/**
 * ADR-080 operator channel: a small WHITELIST of read-only Core diagnostics reachable through `control_mac` with a
 * `finagai-job:` prefix, so surfaces whose MCP tool list predates the diagnostics tools can still run them. These
 * never create a Mac task, never touch the Mac, and never write Career state (no apply exists here).
 */
import type pg from "pg";
import { proposeCareerBootstrap } from "./bootstrap.js";
import { diagnosticResult, replayProposal, startStabilityJob, traceProposal } from "./career-diagnostics.js";
import type { GoogleSearch } from "../resources/retrieve.js";

export type FinagaiJob =
  | { kind: "stability"; runs: number; orgs: string[] } | { kind: "result"; code: number } | { kind: "trace"; code: number; org: string }
  | { kind: "replay"; code: number; runs: number } | { kind: "propose" } | { kind: "acquisitions"; limit: number } | { kind: "unknown"; text: string };

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
  if (c === "acquisitions") return { kind: "acquisitions", limit: Math.min(int(rest[0], 10), 30) };
  return { kind: "unknown", text: t.slice(0, 100) };
}

export async function runFinagaiJob(pool: pg.Pool, google: GoogleSearch | undefined, job: FinagaiJob): Promise<object> {
  switch (job.kind) {
    case "stability": return startStabilityJob(pool, google, job.runs, job.orgs);
    case "result": return diagnosticResult(pool, job.code);
    case "trace": return traceProposal(pool, job.code, job.org);
    case "replay": return replayProposal(pool, job.code, job.runs);
    case "propose": { const r = await proposeCareerBootstrap(pool, google); const { delta, ...s } = r.summary;
      return { proposalCode: r.code, ...s, delta: delta ? { ...delta, addedRecords: delta.addedRecords.slice(0, 25), removedRecords: delta.removedRecords.slice(0, 25) } : null }; }
    case "acquisitions": {
      const r = await pool.query(`SELECT a.acquired_at, a.complete, a.search_misses, a.problems, a.stats, s.digest, s.record_count FROM evidence_acquisition a JOIN evidence_snapshot s ON s.id = a.snapshot_id
        WHERE a.area = 'Career' ORDER BY a.acquired_at DESC LIMIT $1`, [job.limit]);
      return { acquisitions: r.rows };
    }
    case "unknown": return { error: `Unknown finagai-job "${job.text}". Allowed: stability [runs] [org,org], result <code>, trace <proposal> <org>, replay <proposal> [runs], propose, acquisitions [n].` };
  }
}
