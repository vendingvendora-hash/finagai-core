/** Phase 3 (ADR-079): structured waiting-on, green/yellow/red with reasons, exception-first brief. */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { addWaiting, areaStatus, ensureArea, executiveBriefV2, placeUnderArea, setObjective, waitingOn, parseDue } from "../../src/cos/operating.js";
import { planResources } from "../../src/resources/planner.js";
import { refreshRegistry } from "../../src/resources/registry.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;
afterAll(async () => { await pool?.end(); });

describe.skipIf(!pool)("employee layer (Phase 3)", () => {
  it("existing projects are linked, not duplicated", async () => {
    await pool!.query(`INSERT INTO project (name) VALUES ('Vendora PG County rollout')`);
    await ensureArea(pool!, "Vendora");
    const r = await placeUnderArea(pool!, "Vendora PG County rollout", "Vendora");
    expect(r).toEqual(expect.objectContaining({ projectCreated: false, area: "Vendora" }));
    expect((await pool!.query(`SELECT count(*)::int AS n FROM project WHERE name = 'Vendora PG County rollout'`)).rows[0].n).toBe(1);
  });

  it("yellow explains itself; red means a breached service level", async () => {
    await ensureArea(pool!, "Health Admin");
    const y = await areaStatus(pool!, "Health Admin");
    expect(y).toEqual(expect.objectContaining({ color: "yellow" }));
    expect((y as { warnings: string[] }).warnings.join(" ")).toMatch(/no open objective/);
    await setObjective(pool!, "Health Admin", "Renew insurance");
    await placeUnderArea(pool!, "Insurance renewal", "Health Admin");
    await addWaiting(pool!, { counterparty: "Broker", project: "Insurance renewal", due: "2020-01-01" });
    const r = await areaStatus(pool!, "Health Admin");
    expect((r as { color: string }).color).toBe("red");
    expect((r as { why: string }).why).toMatch(/follow-up\(s\) overdue/);
  });

  it("'What am I waiting on?' plans from structured state only — no Gmail keyword search", async () => {
    await refreshRegistry(pool!, { googleConfigured: true, resendConfigured: true, models: {} });
    const plan = await planResources(pool!, "What am I waiting on?");
    expect(plan.authoritative.commitments).toBe("state.areas");
    expect(plan.use.map((u) => u.capabilityId)).not.toContain("google.gmail");
    const w = await waitingOn(pool!);
    expect(w).toEqual(expect.objectContaining({ source: expect.stringMatching(/structured/) }));
  });

  it("brief leads with exceptions: decisions and blocked work before completed work", async () => {
    const b = await executiveBriefV2(pool!);
    expect(Object.keys(b)).toEqual(["generatedAt", "headline", "decisions", "blocked", "changes", "risks", "completed", "rest"]);
    expect(b.blocked.join(" ")).toMatch(/Overdue: Waiting on Broker/);
    expect(b.blocked.join(" ")).not.toMatch(/No answer from Julian/);   // live: expired test tasks are a change, not a decision
  });

  it("due-date parsing", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    expect(parseDue("in 5 days", now)!.toISOString().slice(0, 10)).toBe("2026-10-14");
    expect(parseDue("tomorrow", now)!.toISOString().slice(0, 10)).toBe("2026-10-10");
    expect(parseDue("2026-11-02", now)!.toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(parseDue("whenever", now)).toBeNull();
  });
});

import { applyBootstrap, proposeCareerBootstrap } from "../../src/cos/bootstrap.js";
import { replayProposal, traceProposal } from "../../src/cos/career-diagnostics.js";
import { parseFinagaiJob, runFinagaiJob } from "../../src/cos/finagai-job.js";
import { CAREER_QUERIES } from "../../src/cos/career-evidence.js";
import { ACCOUNT, REC, SHEET_CSV, queryHits } from "../fixtures/career-2026-10-09.js";
import type { GmailRecord } from "../../src/google/client.js";
describe.skipIf(!pool)("Career bootstrap (ADR-080): acquire → snapshot → interpret → propose → apply, reproducibly", () => {
  const keyOf = (q: string) => Object.entries(CAREER_QUERIES).find(([, b]) => q.endsWith(b))![0];
  const google = (recs: GmailRecord[], omit = new Set<string>()) => ({
    sheetCsv: async () => ({ id: "sheet-1", name: "Vendora Career Copilot - Job History", modified: "2026-10-09T16:29:38Z", account: "vending.vendora@gmail.com", csv: SHEET_CSV }),
    gmailEnumerate: async (q: string, o: { known?: Map<string, Map<string, GmailRecord>>; onFetched?: (a: string, r: GmailRecord) => void } = {}) => {
      const h = queryHits(keyOf(q), recs).filter((x) => !omit.has(x.id)); let fetched = 0, reused = 0;
      const out = h.map((x) => { const k = o.known?.get(ACCOUNT)?.get(x.id); if (k) { reused++; return k; } fetched++; o.onFetched?.(ACCOUNT, x); return x; });
      return [{ account: ACCOUNT, ok: true, records: out, pages: 1, truncated: false, ids: h.length, vanished: [], fetched, reused }]; },
    gmailMetadata: async (_a: string, ids: string[]) => ({ records: recs.filter((x) => ids.includes(x.id)), missing: ids.filter((id) => !recs.some((x) => x.id === id)).map((id) => ({ id, reason: "deleted at source" })) }),
    calendarEnumerate: async (q: string) => [{ account: ACCOUNT, ok: true, pages: 1, records: q === "interview" ? [{ id: "cal-1", start: "2026-09-28T15:00:00-04:00", summary: "Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst" }] : [] }],
  });
  const ALL = Object.values(REC);
  const BEFORE = ALL.filter((x) => ![REC.riSent1009, REC.riThanks1009, REC.riPricing1009].includes(x));
  const T = new Date("2026-10-09T17:00:00Z");
  const careerCounts = async () => (await pool!.query(`SELECT (SELECT count(*) FROM opportunity)::int AS o, (SELECT count(*) FROM employer)::int AS e, (SELECT count(*) FROM opportunity_event)::int AS ev, (SELECT count(*) FROM project)::int AS p, (SELECT count(*) FROM followup)::int AS f`)).rows[0];
  it("stores the frozen snapshot + acquisition, proposes WITHOUT writing any Career state, and records provenance", async () => {
    const before = await careerCounts();
    const p = await proposeCareerBootstrap(pool!, google(BEFORE) as never, T);
    expect(await careerCounts()).toEqual(before);                                  // read-only until approval
    expect(p.summary.provenance).toEqual(expect.objectContaining({ complete: true, interpreterVersion: "career-interpret-5", previousSnapshot: null }));
    expect(p.summary.activeProjects.map((a) => `${a.name}:${a.status}`)).toEqual(expect.arrayContaining(["Altarum — Pricing Analyst:interviewing", "Vallum Associates — Project Finance Analyst - SMR:applied",
      "Amazon — Senior Financial Analyst, R2L Sub Same Day - Delivery Finance (10471926):applied"]));
    expect(p.summary.closed!.map((c) => c.job)).toEqual(expect.arrayContaining(["Amazon — Sr. Financial Analyst, Amazon Business Finance (10460629)", "Transurban — Senior Financial Planning Analyst", "Vallum Associates — Structured Finance Analyst"]));
    const row = (await pool!.query(`SELECT snapshot_digest, interpretation_digest, interpreter_version FROM bootstrap_proposal WHERE code = $1`, [p.code])).rows[0];
    expect(row.snapshot_digest).toBe(p.summary.provenance!.snapshotDigest);
  });
  it("same sources again → same snapshot row, same digests; a search that drops Transurban is healed by carry-forward", async () => {
    const a = await proposeCareerBootstrap(pool!, google(BEFORE) as never, new Date(T.getTime() + 60_000));
    const st = (await pool!.query(`SELECT stats FROM evidence_acquisition ORDER BY acquired_at DESC LIMIT 1`)).rows[0].stats;
    expect(st.gmail.every((g: { fetched: number }) => g.fetched === 0)).toBe(true);           // all content reused from run 1
    expect((await pool!.query(`SELECT count(*)::int AS n FROM gmail_message_content`)).rows[0].n).toBe(st.contentCache.known);
    const b = await proposeCareerBootstrap(pool!, google(BEFORE, new Set([REC.transSent1002.id, REC.transViewed1002.id, REC.transSenior1002.id])) as never, new Date(T.getTime() + 120_000));
    expect(b.summary.provenance!.snapshotDigest).toBe(a.summary.provenance!.snapshotDigest);
    expect(b.summary.provenance!.opportunitySetDigest).toBe(a.summary.provenance!.opportunitySetDigest);
    expect(b.summary.provenance!.searchMisses).toBe(3);
    expect(b.summary.delta).toEqual(expect.objectContaining({ sameInput: true, sameOpportunitySet: true, unexplained: [] }));
    expect((await pool!.query(`SELECT count(DISTINCT snapshot_id)::int AS n FROM bootstrap_proposal WHERE code IN ($1, $2)`, [a.code, b.code])).rows[0].n).toBe(1);
    const r = await replayProposal(pool!, b.code, 10);
    expect(r).toEqual(expect.objectContaining({ identical: true, matchesStoredProposal: true, runs: 10 }));
    const t = await traceProposal(pool!, b.code, "Transurban") as unknown as { found: Array<{ stage: string; acquiredVia: string[] }>; jobs: Array<{ status: string }> };
    expect(t.jobs.map((j) => j.status)).toEqual(["rejected"]); expect(t.found.filter((f) => !f.acquiredVia.includes("carry-forward"))).toEqual([]);
  });
  it("new evidence → the delta names the records; apply upserts by stable identity and never deletes", async () => {
    const p = await proposeCareerBootstrap(pool!, google(ALL) as never, new Date(T.getTime() + 180_000));
    expect(p.summary.delta!.oppAdded).toEqual([{ org: "Resource Innovations — Pricing Analyst", explainedBy: [REC.riSent1009.id, REC.riThanks1009.id, REC.riPricing1009.id] }]);
    expect(p.summary.applicable).toEqual({ ok: true, why: [] });
    const a = await applyBootstrap(pool!, p.code);
    expect(a).toEqual(expect.objectContaining({ area: "Career" }));
    // One row per JOB; the employer is shared; each job has its own status, requisition, history and project.
    const amz = (await pool!.query(`SELECT o.requisition_id, o.status, o.title, e.name AS employer, (SELECT count(*)::int FROM opportunity_event v WHERE v.opportunity_id = o.id) AS events
      FROM opportunity o JOIN employer e ON e.id = o.employer_id WHERE e.key = 'amazon' AND o.requisition_id IS NOT NULL ORDER BY o.requisition_id`)).rows;
    expect(amz.map((r) => [r.requisition_id, r.status, r.events])).toEqual([["10383371", "applied", 2], ["10460629", "rejected", 3], ["10466286", "applied", 1], ["10471926", "applied", 2], ["10491543", "withdrawn", 3], ["10499413", "closed", 3]]);
    expect(new Set(amz.map((r) => r.employer))).toEqual(new Set(["Amazon"]));
    const vallum = (await pool!.query(`SELECT title, status FROM opportunity WHERE org = 'Vallum Associates' AND archived_at IS NULL ORDER BY title`)).rows;
    expect(vallum).toEqual([{ title: "Project Finance Analyst - SMR", status: "applied" }, { title: "Structured Finance Analyst", status: "rejected" }]);
    const proj = (await pool!.query(`SELECT p.name FROM opportunity o JOIN project p ON p.id = o.project_id WHERE o.requisition_id = '10471926'`)).rows;
    expect(proj).toEqual([{ name: "Amazon — Senior Financial Analyst, R2L Sub Same Day - Delivery Finance (10471926)" }]);
    expect((await pool!.query(`SELECT count(*)::int AS n FROM opportunity WHERE org ~* '^senior'`)).rows[0].n).toBe(0);
    const n1 = (await pool!.query(`SELECT count(*)::int AS n FROM opportunity`)).rows[0].n;
    const again = await proposeCareerBootstrap(pool!, google(ALL) as never, new Date(T.getTime() + 240_000));
    await applyBootstrap(pool!, again.code);
    expect((await pool!.query(`SELECT count(*)::int AS n FROM opportunity`)).rows[0].n).toBe(n1);   // idempotent: no duplicates
    expect((await pool!.query(`SELECT count(*)::int AS n FROM (SELECT opportunity_id, source_id FROM opportunity_event GROUP BY 1, 2 HAVING count(*) > 1) d`)).rows[0].n).toBe(0);
    expect((await applyBootstrap(pool!, p.code)) as { error?: string }).toEqual({ error: expect.stringMatching(/already applied/) });
    const f = (await pool!.query(`SELECT p.name, f.counterparty FROM followup f JOIN project p ON p.id = f.project_id WHERE f.state = 'waiting' ORDER BY p.name`)).rows;
    expect(f).toEqual(expect.arrayContaining([{ name: "Chimes — role not named in evidence", counterparty: "Chimes" }]));   // follow-ups are per JOB project
    void waitingOn;
  });
  it("an incomplete acquisition yields a proposal that cannot be applied", async () => {
    const g = { ...google(ALL), gmailEnumerate: async () => [{ account: ACCOUNT, ok: false, error: "google gmail.googleapis.com HTTP 429", records: [], pages: 0, truncated: false, ids: 0 }] };
    const p = await proposeCareerBootstrap(pool!, g as never, new Date(T.getTime() + 300_000));
    expect(p.summary.applicable!.ok).toBe(false);
    expect((await applyBootstrap(pool!, p.code)) as { error?: string }).toEqual({ error: expect.stringMatching(/not applicable: incomplete snapshot/) });
  });
  it("finagai-job channel: whitelisted, read-only, no Mac task", async () => {
    expect(parseFinagaiJob("open Safari")).toBeNull();
    expect(parseFinagaiJob("finagai-job: stability 10 Immuta, Transurban")).toEqual({ kind: "stability", runs: 10, orgs: ["Immuta", "Transurban"] });
    expect(parseFinagaiJob("finagai-job: apply 3")).toEqual({ kind: "unknown", text: "apply 3" });
    const tasks = (await pool!.query(`SELECT count(*)::int AS n FROM control_task`)).rows[0].n;
    const r = await runFinagaiJob(pool!, google(ALL) as never, { kind: "acquisitions", limit: 3 }) as { acquisitions: unknown[] };
    expect(r.acquisitions.length).toBe(3);
    expect(await runFinagaiJob(pool!, undefined, { kind: "unknown", text: "apply 3" })).toEqual({ error: expect.stringMatching(/Unknown finagai-job/) });
    expect((await pool!.query(`SELECT count(*)::int AS n FROM control_task`)).rows[0].n).toBe(tasks);
  });
});

