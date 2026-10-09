/**
 * Phase 4 (ADR-082): the opportunity lifecycle on a FRESH database built from the real 2026-10-09 evidence — find,
 * pipeline, track (dedupe), record (one job only, forward-only), lifecycle next steps, evidence sync (attributed,
 * idempotent, previewable), and the J6 golden-workflow hooks (record the posting, verified approved submit).
 */
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../eval/runner/j3cases.js";
import { applyBootstrap, proposeCareerBootstrap } from "../../src/cos/bootstrap.js";
import { CAREER_QUERIES } from "../../src/cos/career-evidence.js";
import { runCareerSync, syncCareer, type SyncResult } from "../../src/cos/career-sync.js";
import { archiveTestJob, findOpportunity, inTx, lifecycleTick, pipelineSummary, recordOpportunityUpdate, trackOpportunity } from "../../src/cos/opportunities.js";
import { addWaiting, areaStatus, ensureArea, executiveBriefV2 } from "../../src/cos/operating.js";
import { createTask, recordRun, runCoreStep } from "../../src/pipelines/j6/control.js";
import { ACCOUNT, REC, SHEET_CSV, fixtureRecord, linkedInRejection, LINKEDIN_SENDER, queryHits } from "../fixtures/career-2026-10-09.js";
import type { GmailRecord } from "../../src/google/client.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
const T = new Date("2026-10-09T17:00:00Z");
const keyOf = (q: string) => Object.entries(CAREER_QUERIES).find(([, b]) => q.endsWith(b))![0];
const google = (recs: GmailRecord[]) => ({
  sheetCsv: async () => ({ id: "sheet-1", name: "Vendora Career Copilot - Job History", modified: "2026-10-09T16:29:38Z", account: "vending.vendora@gmail.com", csv: SHEET_CSV }),
  gmailEnumerate: async (q: string, o: { known?: Map<string, Map<string, GmailRecord>>; onFetched?: (a: string, r: GmailRecord) => void } = {}) => {
    const h = queryHits(keyOf(q), recs); let fetched = 0, reused = 0;
    const out = h.map((x) => { const k = o.known?.get(ACCOUNT)?.get(x.id); if (k) { reused++; return k; } fetched++; o.onFetched?.(ACCOUNT, x); return x; });
    return [{ account: ACCOUNT, ok: true, records: out, pages: 1, truncated: false, ids: h.length, vanished: [], fetched, reused }]; },
  gmailMetadata: async (_a: string, ids: string[]) => ({ records: recs.filter((x) => ids.includes(x.id)), missing: ids.filter((id) => !recs.some((x) => x.id === id)).map((id) => ({ id, reason: "deleted at source" })) }),
  calendarEnumerate: async (q: string) => [{ account: ACCOUNT, ok: true, pages: 1, records: q === "interview" ? [{ id: "cal-1", start: "2026-09-28T15:00:00-04:00", summary: "Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst" }] : [] }],
});
const ALL = Object.values(REC);
// NEW evidence after the bootstrap: LinkedIn rejects the Vallum SMR application (real LinkedIn rejection shape).
const VALLUM_SMR_REJECTED = fixtureRecord("1a12fff000000001", String(Date.parse("2026-10-10T14:00:00Z")), "Your application to Project Finance Analyst - SMR at Vallum Associates", LINKEDIN_SENDER,
  "Your application to Project Finance Analyst - SMR at Vallum Associates ͏ ͏ ͏", ...linkedInRejection("Vallum Associates"));

let db: { appUrl: string; drop: () => Promise<void> } | undefined;
let pool: pg.Pool;
const one = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0];
const counts = async () => one(`SELECT (SELECT count(*) FROM opportunity)::int AS o, (SELECT count(*) FROM opportunity_event)::int AS ev, (SELECT count(*) FROM project)::int AS p,
  (SELECT count(*) FROM followup)::int AS f, (SELECT count(*) FILTER (WHERE state IN ('open','waiting','overdue')) FROM followup)::int AS fo, (SELECT string_agg(status, ',' ORDER BY id) FROM opportunity) AS st`);

describe.skipIf(!admin || !migT || !appT)("opportunity lifecycle (Phase 4, ADR-082)", () => {
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_p4_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    // Live order of events: Career created, Julian tracks Beth (no project yet), then bootstrap #45 is applied.
    await ensureArea(pool, "Career");
    await addWaiting(pool, { counterparty: "Beth Young", about: "Altarum Pricing Analyst outcome after the 9/28 panel", area: "Career", due: "2026-10-14", now: new Date("2026-10-09T13:00:00Z") });
    const p = await proposeCareerBootstrap(pool, google(ALL) as never, T);
    const a = await applyBootstrap(pool, p.code, { objective: "Secure a high-quality finance role in corporate finance, FP&A, pricing, strategic finance, or adjacent analytical finance functions" });
    expect(a).toEqual(expect.objectContaining({ area: "Career" }));
  }, 60_000);
  afterAll(async () => { await pool?.end(); await db?.drop(); });

  it("lifecycle: a preview writes nothing; the real tick gives every engaged job exactly one next step; a second tick changes nothing", async () => {
    // Live defect (sync chat, 2026-10-09): the bootstrap follow-up said "due 2026-10-05" but was stored as apply-time + 3 days.
    const bf = await one(`SELECT summary, to_char(due_at, 'YYYY-MM-DD') AS due FROM followup WHERE origin = 'bootstrap' AND summary LIKE 'Follow up with Chimes%'`);
    expect(bf.summary).toContain(`follow-up due ${bf.due}`);
    const before = await counts();
    const prev = await inTx(pool, true, (tx) => lifecycleTick(tx, T));
    expect(prev.changes.length).toBeGreaterThan(0);
    expect(await counts()).toEqual(before);                                                    // preview = rolled back
    const r = await inTx(pool, false, (tx) => lifecycleTick(tx, T));
    if (process.env.P4_DEBUG) console.log(JSON.stringify(r, null, 1));
    expect(r.changes.map((c) => `${c.job}|${c.change}`).sort()).toEqual(prev.changes.map((c) => `${c.job}|${c.change}`).sort());   // preview == real
    // Julian's own "waiting on Beth" now belongs to the Altarum job; the engine adds nothing on top of it.
    const alt = (await pool.query(`SELECT f.summary, f.origin, f.due_at FROM followup f JOIN opportunity o ON o.id = f.opportunity_id WHERE o.org ILIKE 'Altarum%' AND f.state IN ('open','waiting','overdue')`)).rows;
    expect(alt.map((x) => x.origin)).toEqual(["julian"]);
    // Amazon 10471926: waiting on the employer until 10/19 (lifecycle-owned).
    expect(await one(`SELECT f.rule, f.state, to_char(f.due_at, 'YYYY-MM-DD') AS due FROM followup f JOIN opportunity o ON o.id = f.opportunity_id WHERE o.requisition_id = '10471926' AND f.state IN ('open','waiting')`))
      .toEqual({ rule: "applied.awaiting_response", state: "waiting", due: "2026-10-19" });
    // Every active Career project now has a next step.
    const st = await areaStatus(pool, "Career", T) as { breaches: string[] };
    expect(st.breaches.join(" ")).not.toMatch(/no next action/);
    const again = await inTx(pool, false, (tx) => lifecycleTick(tx, T));
    expect(again.changes).toEqual([]);
  });

  it("find: Amazon is many separate jobs; a requisition id finds exactly one", async () => {
    const amz = await findOpportunity(pool, { employer: "Amazon" }, T);
    expect(amz.found).toBeGreaterThanOrEqual(7);
    expect(new Set(amz.jobs.map((j) => j.job)).size).toBe(amz.found);
    const one1 = await findOpportunity(pool, { reqId: "10471926" }, T);
    expect(one1.found).toBe(1);
    expect(one1.jobs[0]).toEqual(expect.objectContaining({ status: "applied", appliedAt: "2026-10-05", project: "Amazon — Senior Financial Analyst, R2L Sub Same Day - Delivery Finance (10471926)" }));
    expect(one1.jobs[0]!.history.length).toBeGreaterThan(0);
    const p = await pipelineSummary(pool, "Career", T) as { headline: string; engaged: string[] };
    expect(p.headline).toMatch(/1 interviewing/);
    expect(p.engaged.join(" ")).toMatch(/Altarum — Pricing Analyst/);
  });

  it("track: an existing requisition says ALREADY applied; a new posting is created once; an ambiguous title asks", async () => {
    const ex = await inTx(pool, false, (tx) => trackOpportunity(tx, { employer: "Amazon", title: "Senior Financial Analyst, R2L Sub Same Day - Delivery Finance", reqId: "10471926", source: "julian" }, T));
    expect(ex).toEqual(expect.objectContaining({ outcome: "existing", alreadyApplied: true, previousStatus: "applied" }));
    const n0 = (await counts()).o;
    const created = await inTx(pool, false, (tx) => trackOpportunity(tx, { employer: "HITT Contracting Inc.", title: "Senior Associate, Financial Planning & Analysis (Corporate)", status: "preparing", source: "julian" }, T));
    expect(created).toEqual(expect.objectContaining({ outcome: "created", status: "preparing", area: "Career" }));
    expect((created as { nextStep: string }).nextStep).toMatch(/submit/i);
    const again = await inTx(pool, false, (tx) => trackOpportunity(tx, { employer: "HITT Contracting", title: "Senior Associate, Financial Planning & Analysis (Corporate)", source: "julian" }, T));
    expect(again).toEqual(expect.objectContaining({ outcome: "existing", status: "preparing" }));
    expect((await counts()).o).toBe(n0 + 1);
    const amb = await inTx(pool, false, (tx) => trackOpportunity(tx, { employer: "Amazon", title: "Senior Financial Analyst, NACF", source: "julian" }, T));
    expect(amb).toEqual(expect.objectContaining({ outcome: "ambiguous" }));
    expect((amb as { candidates: string[] }).candidates.join(" ")).toMatch(/10383371[\s\S]*10466286|10466286[\s\S]*10383371/);
  });

  it("record: a rejection on ONE Amazon requisition changes only that job and closes its project; a later application is an anomaly", async () => {
    const amzBefore = (await pool.query(`SELECT requisition_id, status FROM opportunity WHERE org = 'Amazon' AND requisition_id IS NOT NULL ORDER BY requisition_id`)).rows;
    const r = await inTx(pool, false, (tx) => recordOpportunityUpdate(tx, { reqId: "10471926", kind: "rejection", at: "2026-10-10", note: "Rejection email (told by Julian)" }, T));
    expect(r).toEqual(expect.objectContaining({ status: "rejected", transition: "applied→rejected" }));
    const amzAfter = (await pool.query(`SELECT requisition_id, status FROM opportunity WHERE org = 'Amazon' AND requisition_id IS NOT NULL ORDER BY requisition_id`)).rows;
    expect(amzAfter.filter((x, i) => x.status !== amzBefore[i]!.status)).toEqual([{ requisition_id: "10471926", status: "rejected" }]);
    expect(await one(`SELECT p.status FROM project p JOIN opportunity o ON o.project_id = p.id WHERE o.requisition_id = '10471926'`)).toEqual({ status: "completed" });
    expect((await one(`SELECT count(*)::int AS n FROM followup f JOIN opportunity o ON o.id = f.opportunity_id WHERE o.requisition_id = '10471926' AND f.state IN ('open','waiting','overdue')`)).n).toBe(0);
    const late = await inTx(pool, false, (tx) => recordOpportunityUpdate(tx, { reqId: "10471926", kind: "application", at: "2026-10-11" }, T));
    expect(late).toEqual(expect.objectContaining({ status: "rejected", transition: null, anomaly: expect.stringMatching(/never reopened/) }));
    const amb = await inTx(pool, false, (tx) => recordOpportunityUpdate(tx, { employer: "Amazon", kind: "rejection" }, T));
    expect(amb).toEqual(expect.objectContaining({ outcome: "ambiguous" }));
  });

  it("sync: same evidence → nothing; a new rejection email → one attributed change (previewable); then nothing again", async () => {
    const s0 = await syncCareer(pool, google(ALL) as never, { now: new Date(T.getTime() + 3_600_000) }) as SyncResult;
    expect(s0.counts).toEqual(expect.objectContaining({ jobsCreated: 0, eventsAdded: 0, statusChanges: 0 }));
    expect(s0.decisions).toEqual([]);                                                        // Julian's own rejection record (ahead of the evidence) is kept
    expect(await one(`SELECT status FROM opportunity WHERE requisition_id = '10471926'`)).toEqual({ status: "rejected" });
    const before = await counts();
    const prev = await syncCareer(pool, google([...ALL, VALLUM_SMR_REJECTED]) as never, { now: new Date("2026-10-10T15:00:00Z"), dryRun: true }) as SyncResult;
    expect(prev.counts).toEqual(expect.objectContaining({ statusChanges: 1, eventsAdded: 1, jobsCreated: 0 }));
    expect(await counts()).toEqual(before);                                                  // preview wrote nothing
    const s1 = await syncCareer(pool, google([...ALL, VALLUM_SMR_REJECTED]) as never, { now: new Date("2026-10-10T15:00:00Z") }) as SyncResult;
    expect(s1.changes.filter((c) => c.change === "status")).toEqual([{ job: "Vallum Associates — Project Finance Analyst - SMR", change: "status", detail: "applied → rejected", sources: [`gmail:${VALLUM_SMR_REJECTED.id}`] }]);
    expect(s1.lifecycle.map((c) => c.change)).toContain("project completed");
    expect(s1.newSourceRecords).toBe(1);
    const s2 = await syncCareer(pool, google([...ALL, VALLUM_SMR_REJECTED]) as never, { now: new Date("2026-10-10T16:00:00Z") }) as SyncResult;
    expect(s2.counts).toEqual({ jobsCreated: 0, eventsAdded: 0, statusChanges: 0, lifecycleChanges: 0, decisions: 0 });
    const b = await executiveBriefV2(pool, new Date("2026-10-10T16:00:00Z"));
    expect(b.changes.join(" ")).toMatch(/Vallum Associates — Project Finance Analyst - SMR: applied → rejected/);
  });

  it("sync_career returns its result inline (no second call needed)", async () => {
    const r = await runCareerSync(pool, google([...ALL, VALLUM_SMR_REJECTED]) as never, true, 30_000) as { preview: boolean; counts: { eventsAdded: number }; jobCode: number };
    expect(r).toEqual(expect.objectContaining({ preview: true, counts: expect.objectContaining({ eventsAdded: 0, statusChanges: 0 }) }));
    expect(r.jobCode).toBeGreaterThan(0);
  });

  it("an incomplete acquisition writes nothing", async () => {
    const before = await counts();
    const g = { ...google(ALL), gmailEnumerate: async () => [{ account: ACCOUNT, ok: false, error: "HTTP 429", records: [], pages: 0, truncated: false, ids: 0, vanished: [] }] };
    const s = await syncCareer(pool, g as never, { now: new Date("2026-10-10T17:00:00Z") }) as SyncResult;
    expect(s.ok).toBe(false);
    expect(await counts()).toEqual(before);
  });

  it("J6 golden workflow: the posting is recorded (fixture → test area, never Career); a duplicate is flagged; a verified approved submit records the application", async () => {
    const t = await createTask(pool, "Prepare my application for the Acme Health Pricing Analyst posting that's open — do not submit", "chat");
    const res = await runCoreStep(pool, t.id, null, { kind: "record_opportunity", params: { employer: "Acme Health", title: "Pricing Analyst", url: "https://finagai-core.onrender.com/fixtures/apply.html", location: "Silver Spring, MD" }, risk: "read", summary: "Record the posting", done: false });
    expect(res).toMatch(/^recorded: Acme Health — Pricing Analyst \(new job; now preparing; area Finagai Test\)/);
    const job = await one(`SELECT o.id, a.name AS area, o.status FROM opportunity o JOIN area a ON a.id = o.area_id JOIN control_task t ON t.opportunity_id = o.id WHERE t.id = $1`, [t.id]);
    expect(job).toEqual(expect.objectContaining({ area: "Finagai Test", status: "preparing" }));
    const dup = await runCoreStep(pool, t.id, null, { kind: "record_opportunity", params: { employer: "Altarum", title: "Pricing Analyst" }, risk: "read", summary: "Record the posting", done: false });
    expect(dup).toMatch(/^ALREADY interviewing: Julian applied to Altarum — Pricing Analyst/);
    expect(await runCoreStep(pool, t.id, "Mom", { kind: "record_opportunity", params: { employer: "X", title: "Analyst" }, risk: "read", summary: "", done: false })).toMatch(/^refused/);
    // Re-link the task to the fixture job (the duplicate check above re-linked it to Altarum), then Julian approves Submit.
    await pool.query(`UPDATE control_task SET opportunity_id = $2 WHERE id = $1`, [t.id, job.id]);
    const step = await one(`INSERT INTO control_step (task_id, seq, kind, params, risk, summary, status, authority_class, authority_decision, decided_at)
      VALUES ($1, 1, 'browser_click', '{"label":"Submit application"}', 'write', 'Click Submit application', 'approved', 'EXTERNAL_COMMITMENT', 'approve', now()) RETURNING id`, [t.id]);
    await recordRun(pool, step.id, true, "verified: clicked “Submit application”; page shows SUBMITTED");
    expect(await one(`SELECT status FROM opportunity WHERE id = $1`, [job.id])).toEqual({ status: "applied" });
    expect(await one(`SELECT source, kind FROM opportunity_event WHERE opportunity_id = $1 AND kind = 'application'`, [job.id])).toEqual({ source: "j6", kind: "application" });
    // An UNverified click records nothing.
    const t2 = await createTask(pool, "Apply to the Acme posting", "chat");
    await pool.query(`UPDATE control_task SET opportunity_id = (SELECT id FROM opportunity WHERE org = 'Altarum' LIMIT 1) WHERE id = $1`, [t2.id]);
    const s2 = await one(`INSERT INTO control_step (task_id, seq, kind, params, risk, summary, status, authority_class, authority_decision, decided_at)
      VALUES ($1, 1, 'browser_click', '{"label":"Submit application"}', 'write', 'Click Submit application', 'approved', 'EXTERNAL_COMMITMENT', 'approve', now()) RETURNING id`, [t2.id]);
    const evBefore = (await counts()).ev;
    await recordRun(pool, s2.id, true, "unverified: no change observed");
    expect((await counts()).ev).toBe(evBefore);
    expect(await inTx(pool, false, (tx) => archiveTestJob(tx, job.id))).toEqual({ archived: job.id });
    expect(await inTx(pool, false, async (tx) => archiveTestJob(tx, (await tx.query(`SELECT id FROM opportunity WHERE org = 'Altarum' LIMIT 1`)).rows[0].id))).toEqual({ error: expect.stringMatching(/Only Finagai's own test/) });
  });
});
