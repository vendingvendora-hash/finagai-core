/**
 * Phase 8 increment 3 (ADR-088) — failure mining from the Live State Stream:
 *   - every recorded failure is reduced to a class (where + normalized what), with count, evidence and owner;
 *   - a class of Finagai's own machinery recurring ≥ 3× in 24 h on the running Core is a Finagai-owned exception that
 *     cites its failures; availability (a Mac asleep) and Julian's own unanswerable asks never are;
 *   - a class that has not recurred since the running Core started is "not seen since restart", never an exception;
 *   - the reliability report lists the classes and names a recurring one as a reason it is degraded.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../eval/runner/j3cases.js";
import { appendEvent } from "../../src/db/index.js";
import { runExceptions } from "../../src/exceptions/index.js";
import { mineFailures, recurringFailures } from "../../src/live/failures.js";
import { reliabilityReport } from "../../src/live/reliability.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
let db: Awaited<ReturnType<typeof materialize>>; let pool: pg.Pool;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const budget = async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 });

describe.skipIf(!admin || !migT || !appT)("Phase 8 failure mining (ADR-088 increment 3)", () => {
  const ev: Record<string, number[]> = { wf: [], tool: [], parse: [], abandoned: [] };
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_p8fm_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    // the same workflow failing the same way, intermittently, with different ids in the message
    for (const n of [101, 202, 303]) ev.wf!.push(await appendEvent(pool, { actor: "cos", action: "workflow_failed", entityType: "event_tick", entityId: randomUUID(),
      after: { workflow: "career.sync", events: 1, error: `sheet read failed for row ${n} (${randomUUID()})` } }));
    // Julian asking for something that does not exist — mined, never an exception
    for (let i = 0; i < 4; i++) ev.tool!.push(await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "get_project", outcome: "error", error: `No active project with that ID or name.` } }));
    // Mac tasks: the planner failing to parse (a defect) vs nobody claiming the task while the Mac slept (availability)
    for (let i = 0; i < 3; i++) {
      const t1 = randomUUID(), t2 = randomUUID();
      ev.parse!.push(await appendEvent(pool, { actor: "system", action: "control_task_state", entityType: "control_task", entityId: t1, before: { status: "active" }, after: { status: "failed", failure_class: "model_parse", terminal_reason: "model_parse" } }));
      ev.abandoned!.push(await appendEvent(pool, { actor: "system", action: "control_task_state", entityType: "control_task", entityId: t2, before: { status: "active" }, after: { status: "failed", failure_class: "abandoned" } }));
    }
    await appendEvent(pool, { actor: "system", action: "job_finished", after: { job: "weekly_review", status: "failed", detail: "model budget blocked" } });
    // successes and domain answers are not failures
    await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "resolve_reference", outcome: "none" } });
    await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "waiting_on", outcome: "ok" } });
  }, 60_000);
  afterAll(async () => { await pool?.end(); await db?.drop(); });

  it("mines every recorded failure into classes, with counts, evidence and status", async () => {
    const m = await mineFailures(pool, { days: 7 });
    expect(m.failures).toBe(3 + 4 + 3 + 3 + 1);
    const by = (where: string) => m.classes.filter((c) => `${c.source}:${c.subject}` === where);
    expect(by("workflow:career.sync")).toEqual([expect.objectContaining({ count: 3, last24h: 3, status: "recurring", system: true, signature: "sheet read failed for row # (<id>)", evidence: ev.wf })]);
    expect(by("tool:get_project")).toEqual([expect.objectContaining({ count: 4, system: false, example: "No active project with that ID or name." })]);
    expect(by("mac_task:model_parse")[0]!.evidence).toEqual(ev.parse);
    expect(by("mac_task:abandoned")[0]!.count).toBe(3);
    expect(by("job:weekly_review")).toEqual([expect.objectContaining({ count: 1, status: "isolated" })]);
    expect(m.classes.map((c) => c.subject)).not.toContain("resolve_reference");
    // a class that has not happened since the running Core started is treated as fixed by it
    const later = await mineFailures(pool, { days: 7, startedAt: new Date(Date.now() + 1000) });
    expect(later.classes.every((c) => c.status === "not seen since restart")).toBe(true);
    expect(await recurringFailures(pool, new Date(), new Date(Date.now() + 1000))).toEqual([]);
  });

  it("a recurring failure in Finagai's own machinery is a Finagai-owned exception citing its failures — never a Mac asleep or Julian's own asks", async () => {
    const now = new Date();
    await runExceptions(pool, now, false, { budget });
    const ex = await q(`SELECT key, owner, severity, summary FROM operating_exception WHERE detector = 'failure_recurring' AND status = 'open' ORDER BY summary`);
    expect(ex.map((x) => x.summary)).toEqual([
      expect.stringMatching(/^mac task model_parse keeps failing the same way \(3× in 24 h\)/),
      expect.stringMatching(/^workflow career\.sync keeps failing the same way \(3× in 24 h\): sheet read failed for row 303/),
    ]);
    expect(ex.every((x) => x.owner === "finagai" && x.severity === "warning")).toBe(true);
    const opened = (await q(`SELECT cause_ids, after FROM event WHERE action = 'exception_opened' AND after->>'detector' = 'failure_recurring' AND after->>'summary' LIKE 'workflow%'`))[0];
    expect(opened.cause_ids.map(Number)).toEqual(ev.wf);
    expect(opened.after.evidenceRefs).toEqual(expect.objectContaining({ last24h: 3, signature: "sheet read failed for row # (<id>)" }));
    // nothing for Julian until it outlives a day of Finagai owning it
    const r = await runExceptions(pool, new Date(now.getTime() + 60_000), false, { budget });
    expect(r.needs).toEqual([]);
    // the report names it as a reason the platform is degraded, and lists the classes
    const rep = await reliabilityReport(pool, { days: 1 });
    expect(rep.why).toEqual(expect.arrayContaining([expect.stringMatching(/^recurring failure: workflow career\.sync 3× in 24 h/), expect.stringMatching(/^recurring failure: mac task model_parse/)]));
    expect(rep.why.join(" ")).not.toMatch(/recurring failure: (tool|mac task abandoned)/);
    expect(rep.failures.top.map((t) => t.where)).toEqual(expect.arrayContaining(["workflow:career.sync", "tool:get_project", "mac_task:abandoned"]));
    // a day later the failures fall out of the window and the exceptions clear themselves
    await runExceptions(pool, new Date(now.getTime() + 25 * 3_600_000), false, { budget });
    expect(await q(`SELECT key FROM operating_exception WHERE detector = 'failure_recurring' AND status = 'open'`)).toEqual([]);
  }, 60_000);
});
