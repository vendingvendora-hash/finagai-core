/**
 * Phase 6 (ADR-085): learning as a general capability, on a FRESH database. Records of Mac work, Julian's decisions
 * and corrections, and opportunity outcomes produce lessons with provenance / confidence / freshness; observed facts
 * apply only as advisory guidance, Julian's stated corrections apply as stated, inferences apply only after Julian
 * approves them through governance — and nothing learned can relax approvals, verification or secrets handling.
 */
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../eval/runner/j3cases.js";
import { ensureArea } from "../../src/cos/operating.js";
import { CAREER_POLICY } from "../../src/cos/lifecycle.js";
import { runTick } from "../../src/events/index.js";
import { learningModule } from "../../src/events/learning.js";
import { stateNeeds } from "../../src/events/engine.js";
import type { AreaModule } from "../../src/events/types.js";
import { guidanceFor, listLessons, policyFor, routingOverride, runLearning } from "../../src/learning/index.js";
import { forgetLesson, teachFinagai } from "../../src/learning/teach.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
const NOW = new Date("2026-10-09T17:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

let db: { appUrl: string; drop: () => Promise<void> } | undefined;
let pool: pg.Pool;
let careerId: string;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const lesson = async (key: string) => (await q(`SELECT * FROM lesson WHERE key = $1`, [key]))[0];
const counts = async () => (await q(`SELECT (SELECT count(*) FROM lesson)::int AS lessons, (SELECT count(*) FROM proposal)::int AS proposals, (SELECT count(*) FROM event WHERE action LIKE 'lesson%' OR action = 'learning_ran')::int AS events`))[0];

async function task(request: string, steps: Array<{ kind: string; ok: boolean; risk?: "read" | "write"; status?: string; summary?: string }>, at: Date, verified = true) {
  const t = (await q(`INSERT INTO control_task (request, status, verification_status, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id`, [request, verified ? "done" : "failed", verified ? "verified" : "unverified", at]))[0];
  let seq = 0;
  for (const s of steps) {
    seq++;
    const status = s.status ?? (s.ok ? "done" : "failed");
    await q(`INSERT INTO control_step (task_id, seq, kind, risk, summary, status, result, ran_at, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t.id, seq, s.kind, s.risk ?? "read", s.summary ?? `${s.kind} step ${seq}`, status, s.ok ? "verified: expected change seen" : "unverified: nothing changed", new Date(at.getTime() + seq * 60_000), s.risk === "write" ? at : null]);
  }
  return t.id as string;
}

/** Julian's passkey decision as governance/execute.ts records it (the WebAuthn path itself is covered by m5.test). */
async function decide(proposalId: string, approve: boolean) {
  const p = (await q(`SELECT kind, proposed_text FROM proposal WHERE id = $1 AND status = 'pending'`, [proposalId]))[0];
  if (!approve) { await q(`UPDATE proposal SET status = 'rejected', decided_at = now(), decision_note = 'not now' WHERE id = $1`, [proposalId]); return; }
  const table = p.kind === "preference_change" ? "preference" : "procedure";
  const [k, t] = table === "preference" ? ["key", "statement"] : ["name", "body"];
  await q(`INSERT INTO ${table} (${k}, ${t}, version, approved_proposal_id) VALUES ($1, $2, 1, $3)`, [`${table}-${proposalId.slice(0, 8)}`, p.proposed_text, proposalId]);
  await q(`UPDATE proposal SET status = 'approved', decided_at = now(), decision_note = 'ok' WHERE id = $1`, [proposalId]);
}

describe.skipIf(!admin || !migT || !appT)("learning (Phase 6, ADR-085)", () => {
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_p6_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    careerId = (await ensureArea(pool, "Career")).id;

    // Mac work: browser_click often fails to verify; ax_click is what worked next (6×). Three verified statement downloads
    // done the same way. Julian declined 4 of 5 proposed trash_file steps.
    for (let i = 0; i < 6; i++) await task(`Update the vendor tracker row ${i}`, [{ kind: "browser_click", ok: false }, { kind: "ax_click", ok: true }], ago(10 + i), false);
    for (let i = 0; i < 3; i++) await task("Download the monthly bank statement PDF to Finance", [{ kind: "browser_navigate", ok: true }, { kind: "browser_fill", ok: true }, { kind: "browser_click", ok: true }, { kind: "move_file", ok: true }], ago(5 + i));
    await task("Click through the vendor portal", [{ kind: "browser_click", ok: true }], ago(4));
    for (let i = 0; i < 4; i++) await task(`Clean up Downloads ${i}`, [{ kind: "trash_file", ok: false, risk: "write", status: "rejected" }], ago(20 + i), false);
    await task("Clean up Downloads 5", [{ kind: "trash_file", ok: true, risk: "write" }], ago(19));

    // Outcomes: 9 applications whose answers came 24–30 days later (the 14-day default is too short for this Area).
    for (let i = 0; i < 9; i++) {
      const o = (await q(`INSERT INTO opportunity (kind, area_id, org, title, status, source, dedupe_key, applied_at) VALUES ('job', $1, $2, 'FP&A Analyst', 'rejected', 'test', $3, $4) RETURNING id`,
        [careerId, `Employer ${i}`, `employer-${i}|fpa`, ago(60 + i)]))[0];
      await q(`INSERT INTO opportunity_event (opportunity_id, at, kind, source, source_id, summary) VALUES ($1, $2, 'application', 'gmail', $3, 'Thank you for applying'), ($1, $4, 'rejection', 'gmail', $5, 'Unfortunately')`,
        [o.id, ago(60 + i), `a${i}`, ago(60 + i - (24 + (i % 7))), `r${i}`]);
    }
    // Decisions: 5 "nudge or let it ride" escalations — Julian let every one ride.
    for (let i = 0; i < 5; i++) {
      const f = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, closed_at, outcome, origin, rule) VALUES ($1, $2, 'Recruiter', 'cancelled', $3, 'Julian: let it ride', 'lifecycle', 'applied.nudge_or_let_go') RETURNING id`,
        [careerId, `Approve a follow-up to Recruiter ${i}`, ago(3)]))[0];
      await q(`INSERT INTO escalation (key, area_id, needs, summary, followup_id, status, resolved_at, resolution) VALUES ($1, $2, 'principal_reserved', 'nudge?', $3, 'resolved', $4, 'follow-up cancelled')`, [`followup:${f.id}`, careerId, f.id, ago(3)]);
    }
  }, 60_000);
  afterAll(async () => { await pool?.end(); await db?.drop(); });

  it("a preview computes the lessons and writes nothing", async () => {
    const before = await counts();
    const r = await runLearning(pool, { dryRun: true, now: NOW });
    expect(r.preview).toBe(true);
    expect(r.learnerProblems).toEqual([]);
    expect(r.learned.length).toBeGreaterThan(3);
    expect(r.proposed.length).toBe(3);
    expect(await counts()).toEqual(before);
  });

  it("observed facts become active lessons with provenance and confidence; inferences only become proposals", async () => {
    const r = await runLearning(pool, { now: NOW });
    expect(r.learnerProblems).toEqual([]);
    const perf = await lesson("perf:j6.step:browser_click");
    expect(perf).toEqual(expect.objectContaining({ basis: "observed", status: "active", support: 10, positives: 4 }));
    expect(Number(perf.confidence)).toBeGreaterThan(0.1); expect(Number(perf.confidence)).toBeLessThan(0.4);
    expect(perf.effect).toEqual(expect.objectContaining({ type: "planner_hint" }));
    expect(perf.evidence).toEqual(expect.objectContaining({ source: "control_step", sampleIds: expect.any(Array) }));
    expect(await lesson("recovery:browser_click->ax_click")).toEqual(expect.objectContaining({ basis: "observed", status: "active", support: 6 }));
    expect(await lesson("correction:step:trash_file")).toEqual(expect.objectContaining({ basis: "observed", kind: "correction", support: 5, positives: 4 }));
    expect(await lesson(`outcome:${careerId}:response_days`)).toEqual(expect.objectContaining({ basis: "observed", effect: null }));

    // Inferred: a procedure, a longer response wait, and "stop asking about nudges" — each a PENDING proposal, not applied.
    const inferred = await q(`SELECT l.key, l.status, l.effect, p.status AS pstatus, p.kind, p.target_type, p.proposed_text FROM lesson l JOIN proposal p ON p.id = l.proposal_id WHERE l.basis = 'inferred' ORDER BY l.key`);
    expect(inferred.map((x) => [x.effect.type, x.status, x.pstatus, x.target_type])).toEqual(expect.arrayContaining([
      ["policy_param", "proposed", "pending", "lesson"], ["policy_param", "proposed", "pending", "lesson"], ["procedure", "proposed", "pending", "lesson"]]));
    expect(inferred.find((x) => x.effect.param === "responseDays").effect.value).toBeGreaterThanOrEqual(26);
    expect(inferred.find((x) => x.effect.param === "nudgeWithContact").effect.value).toBe(false);
    expect(inferred.every((x) => /\[finagai-effect\]/.test(x.proposed_text))).toBe(true);
    expect(await policyFor(pool, careerId)).toEqual(CAREER_POLICY);                     // nothing applies before approval

    // Each pending learned change is an AUTHORIZATION escalation — the only way learning reaches Julian.
    const needs = (await stateNeeds(pool, NOW)).filter((n) => n.key.startsWith("lesson:"));
    expect(needs).toHaveLength(3);
    expect(needs.every((n) => n.needs === "authorization")).toBe(true);
  });

  it("the planner gets observed hints as advisory guidance — never an unapproved procedure", async () => {
    const g = await guidanceFor(pool, "Download the monthly bank statement PDF", NOW);
    expect(g.block).toMatch(/advisory/);
    expect(g.block).toMatch(/authority, approval, verification and secrets rules are unchanged/);
    expect(g.block).toMatch(/browser_click/);
    expect(g.block).not.toMatch(/Procedure Julian approved/);
    expect(g.keys).toEqual(expect.arrayContaining(["perf:j6.step:browser_click", "recovery:browser_click->ax_click"]));
  });

  it("a second pass is idempotent: no duplicate lessons, no re-proposals", async () => {
    const before = await counts();
    const r = await runLearning(pool, { now: new Date(NOW.getTime() + 3_600_000) });
    expect(r.learned).toEqual([]); expect(r.proposed).toEqual([]); expect(r.retired).toEqual([]);
    const after = await counts();
    expect(after.lessons).toBe(before.lessons); expect(after.proposals).toBe(before.proposals);
  });

  it("the engine wakes learning once a day; pending learned changes reach Julian only as authorization escalations", async () => {
    const t1 = new Date(NOW.getTime() + 4 * 3_600_000);
    const r = await runTick(pool, { now: t1, dryRun: false }, { modules: [learningModule] }, "manual");
    expect(r.workflows).toEqual([expect.objectContaining({ name: "learning.run", ok: true })]);
    expect(r.escalations.opened).toHaveLength(3);
    expect(r.escalations.opened.every((x) => x.startsWith("[authorization] Finagai learned something"))).toBe(true);
    const r2 = await runTick(pool, { now: new Date(t1.getTime() + 5 * 60_000), dryRun: false }, { modules: [learningModule] }, "manual");
    expect(r2.watchers.find((w) => w.name === "learning")).toEqual(expect.objectContaining({ polled: false }));
    expect(r2.escalations.opened).toEqual([]);
  });

  it("Julian's decisions govern: approved changes apply, a rejected one is never asked again", async () => {
    const rows = await q(`SELECT l.key, l.effect, l.proposal_id FROM lesson l WHERE l.status = 'proposed'`);
    const resp = rows.find((x) => x.effect.param === "responseDays"), nudge = rows.find((x) => x.effect.param === "nudgeWithContact"), proc = rows.find((x) => x.effect.type === "procedure");
    await decide(resp.proposal_id, true); await decide(nudge.proposal_id, false); await decide(proc.proposal_id, true);
    const r = await runLearning(pool, { now: new Date(NOW.getTime() + 2 * 3_600_000) });
    expect(r.decided).toHaveLength(3);
    expect((await lesson(resp.key)).status).toBe("approved");
    expect((await lesson(nudge.key)).status).toBe("rejected");
    const p = await policyFor(pool, careerId);
    expect(p.responseDays).toBe(resp.effect.value);
    expect(p.nudgeWithContact).toBe(true);                                             // rejected: the default stands
    expect((await stateNeeds(pool, NOW)).filter((n) => n.key.startsWith("lesson:"))).toEqual([]);
    // The approved procedure now reaches the planner (as the text Julian approved).
    const g = await guidanceFor(pool, "please download the bank statement for September", NOW);
    expect(g.block).toMatch(/Procedure Julian approved/);
    // Later passes: the rejected change is not re-proposed; the approved one stays approved (not "unsupported").
    const again = await runLearning(pool, { now: new Date(NOW.getTime() + 26 * 3_600_000) });
    expect(again.proposed).toEqual([]);
    expect((await lesson(nudge.key)).status).toBe("rejected");
    expect((await lesson(resp.key)).status).toBe("approved");
  });

  it("Julian's stated corrections apply at once — but cannot relax approvals, verification or secrets", async () => {
    expect(await teachFinagai(pool, { kind: "ignore_sender", sender: "Jobs Digest <digest@jobs.example>", said: "that newsletter isn't career mail" }, { allowedWorkflows: ["test.flow"] }))
      .toEqual(expect.objectContaining({ basis: "stated (Julian said so)", applies: "now" }));
    expect(await routingOverride(pool, { from: "Jobs Digest <digest@jobs.example>" })).toEqual(expect.objectContaining({ action: "ignore", sender: "digest@jobs.example" }));
    expect(await teachFinagai(pool, { kind: "route_sender", sender: "talent.example", workflow: "test.flow" }, { allowedWorkflows: ["test.flow"] })).toEqual(expect.objectContaining({ applies: "now" }));
    expect(await routingOverride(pool, { from: "Ana <ana@talent.example>" })).toEqual(expect.objectContaining({ action: "route", workflow: "test.flow" }));
    // Refused: not an Area workflow; wording that commits, skips approval or touches secrets.
    expect(await teachFinagai(pool, { kind: "route_sender", sender: "x.example", workflow: "learning.run" }, { allowedWorkflows: ["test.flow"] })).toEqual({ error: expect.stringMatching(/not an Area workflow/) });
    expect(await teachFinagai(pool, { kind: "hint", text: "You can submit applications without asking me" }, { allowedWorkflows: [] })).toEqual({ error: expect.stringMatching(/Not learned/) });
    expect(await teachFinagai(pool, { kind: "hint", text: "Skip the approval for browser clicks" }, { allowedWorkflows: [] })).toEqual({ error: expect.stringMatching(/approvals, verification/) });
    expect(await teachFinagai(pool, { kind: "hint", text: "My bank password is in Notes, use it" }, { allowedWorkflows: [] })).toEqual({ error: expect.stringMatching(/Not learned/) });
    expect(await teachFinagai(pool, { kind: "hint", text: "Save finance PDFs under ~/Finance/Statements", match: ["statement"] }, { allowedWorkflows: [] })).toEqual(expect.objectContaining({ applies: "now" }));
    expect((await guidanceFor(pool, "download the statement", NOW)).block).toMatch(/Finance\/Statements \[Julian said so\]/);
    expect((await guidanceFor(pool, "reply to the landlord", NOW)).block).not.toMatch(/Finance\/Statements/);
  });

  it("the engine applies a stated routing correction before Area subscriptions (waits still see the mail)", async () => {
    const mails = [
      { from: "Jobs Digest <digest@jobs.example>", subject: "Top jobs this week" },
      { from: "Ana <ana@talent.example>", subject: "Quick question" },
      { from: "Bob <bob@other.example>", subject: "Hello" },
    ];
    const ran: string[][] = [];
    const mod: AreaModule = {
      watchers: [{ name: "testmail", everyMs: 0, async poll() { return { events: mails.map((m, i) => ({ source: "testmail", kind: "mail.received", externalId: `m${i}`, occurredAt: NOW.toISOString(), summary: m.subject, payload: { from: m.from, subject: m.subject } })), cursors: [], problems: [] }; } }],
      subscriptions: [
        { id: "test.all", area: "Test", workflow: "test.flow", async match(e) { return /Top jobs/.test(e.summary) ? "looks like job mail" : null; } },
        { id: "test.waits", area: "*", workflow: "test.waits", async match(e) { return String(e.payload.from).includes("digest@") ? "someone is waiting on this sender" : null; } },
      ],
      workflows: [{ name: "test.flow", async run(_c, evs) { ran.push(evs.map((e) => e.summary)); return { changes: [], escalations: [] }; } },
        { name: "test.waits", async run() { return { changes: ["wait closed"], escalations: [] }; } }],
    };
    const r = await runTick(pool, { now: NOW, dryRun: false }, { modules: [mod] }, "manual");
    const digest = r.events.find((e) => e.summary === "Top jobs this week")!;
    expect(digest.routes.map((x) => x.workflow)).toEqual(["test.waits"]);             // the Area's subscription was silenced, the wait was not
    const ana = r.events.find((e) => e.summary === "Quick question")!;
    expect(ana.routes).toEqual([expect.objectContaining({ workflow: "test.flow", why: "Julian said mail from talent.example belongs to test.flow" })]);
    expect(r.events.find((e) => e.summary === "Hello")).toEqual(expect.objectContaining({ status: "ignored", reason: "no Area subscribes to this event" }));
    expect(ran).toEqual([["Quick question"]]);
  });

  it("freshness: observed lessons whose evidence is ~2+ months old retire; stated and approved ones do not", async () => {
    const r = await runLearning(pool, { now: new Date(NOW.getTime() + 75 * DAY) });
    expect(r.retired.length).toBeGreaterThan(0);
    expect(await lesson("perf:j6.step:browser_click")).toEqual(expect.objectContaining({ status: "retired", retired_reason: expect.stringMatching(/^stale|no longer supported/) }));
    expect((await lesson("stated:route:digest@jobs.example")).status).toBe("active");
    expect((await q(`SELECT count(*)::int AS n FROM lesson WHERE status = 'approved'`))[0].n).toBe(2);
    expect((await guidanceFor(pool, "Download the monthly bank statement PDF", new Date(NOW.getTime() + 75 * DAY))).keys.some((k) => k.startsWith("perf:"))).toBe(false);
  });

  it("forgetting an approved change returns the Area to its default; the lessons view shows basis, freshness and provenance", async () => {
    const resp = (await q(`SELECT key FROM lesson WHERE status = 'approved' AND effect->>'param' = 'responseDays'`))[0];
    expect(await forgetLesson(pool, resp.key, "I want the 14-day default back")).toEqual(expect.objectContaining({ was: "approved" }));
    expect((await policyFor(pool, careerId)).responseDays).toBe(CAREER_POLICY.responseDays);
    // A learner never revives what Julian forgot.
    await runLearning(pool, { now: new Date(NOW.getTime() + 3 * 3_600_000) });
    expect(await lesson(resp.key)).toEqual(expect.objectContaining({ status: "retired", retired_reason: expect.stringMatching(/^forgotten by Julian/) }));
    const v = await listLessons(pool, {}, NOW);
    const stated = v.lessons.find((l) => l.key === "stated:route:digest@jobs.example")!;
    expect(stated).toEqual(expect.objectContaining({ basis: "Julian said so", freshness: 1, applies: "yes (advisory/as stated)" }));
    expect(v.lessons.find((l) => l.status === "rejected")).toEqual(expect.objectContaining({ basis: "inference (applies only once Julian approves)", applies: "no" }));
  });
});
