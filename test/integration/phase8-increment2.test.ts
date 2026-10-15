/**
 * Phase 8 increment 2 (ADR-088):
 *   - the daily internal canary drives a labeled test job through the normal paths and verifies on the stream that every
 *     step produced its semantic events (object, own Area, cause, before-state); cleanup archives, never deletes;
 *   - two failed canary runs in a row are a Finagai-owned exception citing those runs;
 *   - workflow-raised judgments resolve when their object moves on, or expire — they no longer stay open forever;
 *   - detector-opened exceptions cite the evidence that tripped them;
 *   - the brief carries one reliability line only when degraded, and never shows Finagai's own test activity.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../eval/runner/j3cases.js";
import { createArea } from "../../src/cos/areas.js";
import { ensureArea, executiveBriefV2 } from "../../src/cos/operating.js";
import { appendEvent, withCause } from "../../src/db/index.js";
import { runTick } from "../../src/events/index.js";
import { WORKFLOW_ESCALATION_TTL_DAYS } from "../../src/events/engine.js";
import { runStateCanary } from "../../src/live/canary.js";
import { runExceptions } from "../../src/exceptions/index.js";
import { reliabilityReport } from "../../src/live/reliability.js";
import { publish } from "../../src/live/stream.js";
import type { AreaModule, EngineCtx } from "../../src/events/types.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
let db: Awaited<ReturnType<typeof materialize>>; let pool: pg.Pool; let careerId: string;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const empty: AreaModule = { watchers: [], subscriptions: [], workflows: [] };
const budget = async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 });
type Deps = Parameters<typeof runTick>[2];
const tick = (extra: Partial<Deps> = {}, now = new Date(), modules: AreaModule[] = [empty]) => runTick(pool, { now, dryRun: false }, { modules, exceptions: { budget }, ...extra }, "manual");

describe.skipIf(!admin || !migT || !appT)("Phase 8 increment 2 (ADR-088)", () => {
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_p8i2_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    careerId = (await ensureArea(pool, "Career")).id;
  }, 60_000);
  afterAll(async () => { await pool?.end(); await db?.drop(); });

  it("the internal canary drives a labeled test job through the normal paths and every step checks out on the stream", async () => {
    const r = await runStateCanary(pool, new Date());
    expect(r.steps.map((s) => [s.step, s.ok, s.problems])).toEqual([["track", true, []], ["evidence", true, []], ["withdraw", true, []], ["cleanup", true, []]]);
    expect(r.ok).toBe(true);
    const job = (await q(`SELECT o.status, o.archived_at, a.name AS area, o.source FROM opportunity o JOIN area a ON a.id = o.area_id WHERE o.id = $1`, [r.jobId]))[0];
    expect(job).toEqual(expect.objectContaining({ status: "withdrawn", area: "Finagai Test", source: "canary" }));
    expect(job.archived_at).toBeTruthy();                                                        // archived, never deleted
    // the project's archival is its own event (live 16:56Z: it was a second "project_completed")
    expect((await q(`SELECT action FROM event WHERE entity_type = 'project' AND entity_id = (SELECT project_id FROM opportunity WHERE id = $1) ORDER BY id`, [r.jobId])).map((x) => x.action))
      .toEqual(["create", "project_completed", "project_archived"]);
    expect((await q(`SELECT state FROM followup WHERE opportunity_id = $1`, [r.jobId])).map((f) => f.state)).toEqual(["done"]);
    // attributed to Finagai itself, never to Julian
    expect((await q(`SELECT DISTINCT actor FROM event WHERE entity_id = $1 AND entity_type = 'opportunity'`, [r.jobId])).map((x) => x.actor).sort()).toEqual(["cos", "system"]);
    expect(await q(`SELECT 1 FROM event WHERE entity_id = $1 AND actor = 'julian'`, [r.jobId])).toEqual([]);
    // nothing about it reaches the brief or Julian
    const brief = await executiveBriefV2(pool);
    expect(JSON.stringify(brief.changes)).not.toMatch(/FINAGAI-CANARY|State Path Canary/);
    expect(brief.decisions).toEqual([]);
    // live 2026-10-13: the test Area itself still reached the brief ("Finagai Test is yellow: no open objective",
    // "area created: Finagai Test") — Finagai's own testing is never news, risk or noise for Julian
    expect(JSON.stringify(brief)).not.toMatch(/Finagai Test/);
  }, 60_000);

  it("the engine runs it once a day, records the verdict, and two failed runs are a Finagai-owned exception citing them", async () => {
    let calls = 0;
    const run = async () => { calls++; return { ok: true, jobId: null, label: "x", steps: [{ step: "track", ok: true, events: 3, problems: [] }] }; };
    await tick({ canary: { everyMs: 24 * 3_600_000, run } });
    await tick({ canary: { everyMs: 24 * 3_600_000, run } });                             // not due again
    expect(calls).toBe(1);
    const first = (await q(`SELECT after, cause_ids FROM event WHERE action = 'canary_ran' ORDER BY id`))[0];
    expect(first.after).toEqual(expect.objectContaining({ ok: true, canary: "state_path" }));
    expect(first.cause_ids.length).toBe(1);
    const bad = async () => ({ ok: false, jobId: null, label: "y", steps: [{ step: "evidence", ok: false, events: 2, problems: ["missing followup_updated on followup"] }] });
    await tick({ canary: { everyMs: 0, run: bad } });
    expect(await q(`SELECT 1 FROM operating_exception WHERE key = 'canary:state_path'`)).toEqual([]);   // one failure is not enough
    await tick({ canary: { everyMs: 0, run: bad } });
    const ex = (await q(`SELECT owner, severity, status FROM operating_exception WHERE key = 'canary:state_path'`))[0];
    expect(ex).toEqual({ owner: "finagai", severity: "warning", status: "open" });
    const opened = (await q(`SELECT cause_ids FROM event WHERE action = 'exception_opened' AND after->>'key' = 'canary:state_path'`))[0];
    const runs = (await q(`SELECT id FROM event WHERE action = 'canary_ran' ORDER BY id DESC LIMIT 2`)).map((x) => Number(x.id));
    expect(opened.cause_ids.map(Number).sort()).toEqual(runs.sort());                            // the exception cites the evidence
    await tick({ canary: { everyMs: 0, run } });
    expect((await q(`SELECT status FROM operating_exception WHERE key = 'canary:state_path'`))[0].status).toBe("resolved");
  }, 60_000);

  it("a workflow-raised judgment resolves when its object moves on, and otherwise expires — never open forever", async () => {
    const o = (await q(`INSERT INTO opportunity (kind, area_id, org, title, status, source, dedupe_key) VALUES ('job', $1, 'Vallum', 'Analyst', 'rejected', 'test', 'vallum|analyst') RETURNING id`, [careerId]))[0];
    let n = 0;
    const mod = (key: string, subject: boolean): AreaModule => ({
      watchers: [{ name: `w-${key}`, everyMs: 0, async poll() { return { events: [{ source: "testmail", kind: "mail.received", externalId: `m-${key}`, occurredAt: new Date().toISOString(), summary: `evidence ${key}`, payload: {} }], cursors: [], problems: [] }; } }],
      subscriptions: [{ id: `s-${key}`, area: "Career", workflow: `wf-${key}`, async match() { return "job evidence"; } }],
      workflows: [{ name: `wf-${key}`, async run(_ctx: EngineCtx) { n++; return { changes: [], escalations: [{ key: `career.sync:${key}`, needs: "judgment" as const, summary: `Career: ${key} arrived after the job was rejected`, areaId: careerId,
        ...(subject ? { subject: { type: "opportunity", id: o.id } } : {}) }] }; } }],
    });
    await tick({}, new Date(), [mod("a", true)]);
    const esc = (await q(`SELECT id, key, status FROM escalation WHERE key LIKE 'career.sync:a%'`))[0];
    expect(esc).toEqual(expect.objectContaining({ key: `career.sync:a@opportunity:${o.id}`, status: "open" }));
    await tick({}, new Date(), [empty]);
    expect((await q(`SELECT status FROM escalation WHERE id = $1`, [esc.id]))[0].status).toBe("open");   // nothing moved yet
    // Julian records what happened to that job (another unit of work) → the judgment is moot
    const moved = await withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:record_opportunity_update" } },
      () => appendEvent(pool, { actor: "julian", action: "opportunity_evidence_added", entityType: "opportunity", entityId: o.id, after: { kind: "note" } }));
    const r = await tick({}, new Date(), [empty]);
    expect(r.escalations.resolved).toEqual([expect.stringMatching(/arrived after the job was rejected/)]);
    const res = (await q(`SELECT before, after, cause_ids FROM event WHERE action = 'escalation_resolved' AND entity_id = $1`, [esc.id]))[0];
    expect(res.after).toEqual(expect.objectContaining({ resolution: "moved on (opportunity_evidence_added)" }));
    expect(res.before).toEqual(expect.objectContaining({ status: "open" }));
    expect(res.cause_ids.map(Number)).toEqual([moved]);
    // live 2026-10-15 (Canary 4B): the brief listed the judgment twice (the escalation AND the last career_synced
    // event's decisions), and kept the second copy for 48 h after the judgment resolved itself
    await appendEvent(pool, { actor: "cos", action: "career_synced", entityType: "area", entityId: careerId, after: { dryRun: false, decisions: ["Vallum: c arrived after the job was rejected"] } });
    const mod2 = { ...mod("c", true) };
    mod2.workflows = [{ name: "wf-c", async run() { return { changes: [], escalations: [{ key: "career.sync:c", needs: "judgment" as const, summary: "Career: Vallum: c arrived after the job was rejected", subject: { type: "opportunity", id: o.id } }] }; } }];
    await tick({}, new Date(), [mod2]);
    const c = (await q(`SELECT id, area_id FROM escalation WHERE key LIKE 'career.sync:c@%'`))[0];
    expect(c.area_id).toBe(careerId);                                                            // the job's own Area
    expect((await executiveBriefV2(pool)).decisions.filter((d) => /c arrived after/.test(d))).toHaveLength(1);
    await withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:record_opportunity_update" } },
      () => appendEvent(pool, { actor: "julian", action: "opportunity_evidence_added", entityType: "opportunity", entityId: o.id, after: { kind: "note" } }));
    await tick({}, new Date(), [empty]);
    expect((await executiveBriefV2(pool)).decisions.filter((d) => /c arrived after/.test(d))).toEqual([]);
    // without a subject it expires after the TTL (the tick's clock), resolved with that reason
    await tick({}, new Date(), [mod("b", false)]);
    const b = (await q(`SELECT id FROM escalation WHERE key = 'career.sync:b' AND status = 'open'`))[0];
    expect(b).toBeTruthy();
    await tick({}, new Date(Date.now() + (WORKFLOW_ESCALATION_TTL_DAYS - 1) * 86_400_000), [empty]);
    expect((await q(`SELECT status FROM escalation WHERE id = $1`, [b.id]))[0].status).toBe("open");
    await tick({}, new Date(Date.now() + (WORKFLOW_ESCALATION_TTL_DAYS + 1) * 86_400_000), [empty]);
    expect((await q(`SELECT status, resolution FROM escalation WHERE id = $1`, [b.id]))[0]).toEqual({ status: "resolved", resolution: `expired: no answer in ${WORKFLOW_ESCALATION_TTL_DAYS} days` });
    expect(n).toBe(2);
  }, 60_000);

  it("the brief carries ONE reliability line only when degraded; the report can evaluate behaviour since a moment", async () => {
    const since = new Date();
    await new Promise((r) => setTimeout(r, 50));
    await publish(pool);
    const after = await reliabilityReport(pool, { since });
    expect(after.window.from).toBe(since.toISOString());
    expect(after.canary.runs).toBe(0);                                                            // canary runs above are before `since`
    const all = await reliabilityReport(pool, { days: 1 });
    expect(all.canary).toEqual(expect.objectContaining({ failed: 2, failedSteps: ["evidence"] }));
    expect(all.verdict).toBe("degraded");
    const brief = await executiveBriefV2(pool);
    expect(brief.risks.filter((x) => /Finagai reliability/.test(x))).toEqual([expect.stringMatching(/^Finagai reliability \(last 24 h\) is degraded: .*internal canary failed in 2 of \d+ runs/)]);
    expect(brief.decisions).toEqual([]);                                                          // a risk, never a task for Julian
  });

  it("every detector-opened exception cites what tripped it — events where they exist, the tick ledger or meter where not (live 2026-10-13)", async () => {
    const now = new Date();
    const opened = async (key: string) => (await q(`SELECT cause_ids, after FROM event WHERE action = 'exception_opened' AND after->>'key' = $1 ORDER BY id DESC LIMIT 1`, [key]))[0];
    // a watcher failing three polls in a row: the failing ticks are named
    for (let i = 0; i < 3; i++) await q(`INSERT INTO event_tick (trigger, status, started_at, finished_at, stats) VALUES ('interval', 'done', now() + ($1 || ' seconds')::interval, now(), $2::jsonb)`,
      [String(i + 1), JSON.stringify({ watchers: [{ name: "testwatch", polled: true, problems: ["ECONNRESET talking to the source"] }] })]);
    // a sleeping Mac with a Mac task waiting: the waiting task is the evidence
    await q(`INSERT INTO mac_runtime (id, last_heartbeat_at) VALUES ('primary', now() - interval '40 minutes') ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at`);
    const task = (await q(`INSERT INTO control_task (request, status, created_at) VALUES ('export the chart', 'active', now() - interval '40 minutes') RETURNING id`))[0];
    const taskEv = await appendEvent(pool, { actor: "julian", action: "control_task_created", entityType: "control_task", entityId: task.id, after: { request: "export the chart" } });
    // an event that gave up after 5 attempts: its last event on the stream
    const dl = (await q(`INSERT INTO inbound_event (occurred_at, source, kind, external_id, summary, payload, status, attempts, routes, reason, received_at)
        VALUES (now() - interval '3 hours', 'test', 'mail.received', 'dl-p8', 'stuck mail', '{}'::jsonb, 'failed', 5, '[]'::jsonb, 'boom', now() - interval '3 hours') RETURNING id`))[0];
    const dlEv = await appendEvent(pool, { actor: "system", action: "evidence_routed", entityType: "inbound_event", entityId: dl.id, after: { reason: "boom" } });
    // an Area red because a project has no next step: the project's last event
    const area = await createArea(pool, { name: `Breach ${Date.now()}`, policy: { max_projects_without_next_action: 0 } });
    const proj = (await q(`INSERT INTO project (name, status, area_id) VALUES ('stale project', 'active', $1) RETURNING id`, [area.id]))[0];
    const projEv = await appendEvent(pool, { actor: "julian", action: "create", entityType: "project", entityId: proj.id, areaId: area.id, after: { name: "stale project" } });
    await runExceptions(pool, new Date(now.getTime() + 10_000), false, { budget: async () => ({ monthToDateUsd: 30, targetUsd: 30, ceilingUsd: 36 }) });

    const w = await opened("watcher:testwatch");
    expect(w.after.evidenceRefs).toEqual(expect.objectContaining({ problem: "ECONNRESET talking to the source" }));
    expect(w.after.evidenceRefs.failingTicks).toHaveLength(3);
    const mac = await opened("mac:offline:work");
    expect(mac.cause_ids.map(Number)).toEqual([taskEv]);
    expect(mac.after.evidence).toEqual([taskEv]);
    expect((await opened("events:dead_letter")).cause_ids.map(Number)).toEqual([dlEv]);
    expect((await opened("budget:near")).after.evidenceRefs.meter).toEqual(expect.objectContaining({ monthToDateUsd: 30, ceilingUsd: 36 }));
    expect((await opened(`area:${area.id}`)).cause_ids.map(Number)).toContain(projEv);
    await q(`UPDATE control_task SET status = 'cancelled' WHERE id = $1`, [task.id]);
    await q(`UPDATE mac_runtime SET last_heartbeat_at = now() WHERE id = 'primary'`);
  }, 60_000);
});
