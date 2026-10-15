/**
 * ADR-089 hotfix 45 — a Mac task waiting for Julian is an authoritative escalation (Needs you), for that exact task/step.
 * Live finding 2026-10-15: Mac task 137 waited for Julian's approval of step 406 while the Command Center could show
 * "Nothing needs you". Proven here against the real lifecycle functions and the real event loop:
 *   - entering a human wait opens exactly one escalation (needs per the existing authority policy), linked to the task;
 *   - re-entering / re-ticking never duplicates; it is recorded as notified (the Mac helper prompted Julian) — no email;
 *   - approve, decline, resume, cancel and expiry each resolve it in the same transaction; a decline opens the next
 *     wait (direction after a "no") as its own escalation;
 *   - the event loop opens a wait that bypassed the lifecycle and resolves one whose task moved on (safety net);
 *   - a Finagai-owned wait (active task, budget pause, no awaiting kind) never escalates;
 *   - the snapshot (what Command renders) lists it in needsJulian while it is unresolved.
 */
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../eval/runner/j3cases.js";
import { enterAwaitingHuman, resumeTask, sweepHumanWaits } from "../../src/concierge/human-wait.js";
import { runTick } from "../../src/events/index.js";
import type { AreaModule } from "../../src/events/types.js";
import { snapshot } from "../../src/live/stream.js";
import { cancelTask, decideStep } from "../../src/pipelines/j6/control.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
let db: Awaited<ReturnType<typeof materialize>>; let pool: pg.Pool;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const empty: AreaModule = { watchers: [], subscriptions: [], workflows: [] };
const tick = (now = new Date()) => runTick(pool, { now, dryRun: false }, { modules: [empty], exceptions: { budget: async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 }) } }, "manual");

async function task(request: string) { return (await q(`INSERT INTO control_task (request) VALUES ($1) RETURNING id, code::int AS code`, [request]))[0] as { id: string; code: number }; }
async function step(taskId: string, seq: number, kind: string, summary: string, cls: string) {
  return (await q(`INSERT INTO control_step (task_id, seq, kind, params, risk, summary, status, authority_class, authority_decision) VALUES ($1, $2, $3, '{}', 'write', $4, 'proposed', $5, 'approve') RETURNING id, code::int AS code`,
    [taskId, seq, kind, summary, cls]))[0] as { id: string; code: number };
}
/** The step proposal as control.ts does it: the step row, then the wait, in one transaction. */
async function propose(t: { id: string }, seq: number, kind: string, summary: string, cls: string) {
  const s = await step(t.id, seq, kind, summary, cls);
  await enterAwaitingHuman(pool, t.id, "approval", `step ${s.code}: ${summary}`);
  return s;
}
const escalationsOf = (taskId: string) => q(`SELECT key, needs, status, resolution, notified_at, summary FROM escalation WHERE key LIKE $1 ORDER BY created_at, key`, [`mac:%@control_task:${taskId}`]);
const needsInSnapshot = async () => (await snapshot(pool)).needsJulian.filter((n: { key: string }) => n.key.startsWith("mac:"));

describe.skipIf(!admin || !migT || !appT)("Mac waits are authoritative escalations (ADR-089 hotfix 45)", () => {
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_macesc_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
  }, 120_000);
  afterAll(async () => { await pool?.end(); await db?.drop(); });

  it("a step waiting for approval opens one escalation for that exact step, listed in needsJulian, never duplicated or emailed; approval resolves it", async () => {
    const t = await task("Report the macOS version");
    const s = await propose(t, 1, "run", "Run the read-only command `sw_vers -productVersion`", "HIGH_RISK");
    let e = await escalationsOf(t.id);
    expect(e).toHaveLength(1);
    expect(e[0]).toEqual(expect.objectContaining({ key: `mac:${t.code}:step:${s.code}@control_task:${t.id}`, needs: "authorization", status: "open" }));
    expect(e[0]!.notified_at).not.toBeNull();                                               // the Mac helper prompted him
    expect(e[0]!.summary).toMatch(new RegExp(`^Mac task ${t.code} is waiting for your approval — step ${s.code}: Run the read-only command`));
    const opened = (await q(`SELECT cause_ids, after FROM event WHERE action = 'escalation_opened' AND after->>'key' = $1`, [e[0]!.key]));
    expect(opened).toHaveLength(1);
    expect(opened[0].cause_ids.length).toBe(1);                                             // caused by the task's transition
    // Command's input: the snapshot lists it, linked to the task
    let n = await needsInSnapshot();
    expect(n).toEqual([expect.objectContaining({ key: e[0]!.key, needs: "authorization", subject: { type: "control_task", id: t.id } })]);
    // re-entering the same wait, and the event loop's safety net, never duplicate it — and nothing is emailed
    await enterAwaitingHuman(pool, t.id, "approval", `step ${s.code}: again`);
    await tick(); await tick();
    expect(await escalationsOf(t.id)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM event WHERE action = 'notification_delivered'`)).toHaveLength(0);
    // Julian approves: resolved in the same transaction
    expect((await decideStep(pool, s.code, true)).status).toBe("approved");
    e = await escalationsOf(t.id);
    expect(e[0]).toEqual(expect.objectContaining({ status: "resolved", resolution: "step approved by Julian" }));
    n = await needsInSnapshot();
    expect(n).toEqual([]);
    await tick();
    expect(await escalationsOf(t.id)).toHaveLength(1);                                       // not reopened by the loop
  });

  it("needs follows the existing authority policy: a commitment that goes out as Julian is principal-reserved; a decline opens the next wait; cancel resolves it", async () => {
    const t = await task("Send the reply to Chimes");
    const s = await propose(t, 1, "browser_click", "Click Send", "EXTERNAL_COMMITMENT");
    expect((await escalationsOf(t.id))[0]).toEqual(expect.objectContaining({ needs: "principal_reserved", status: "open" }));
    expect((await decideStep(pool, s.code, false)).status).toBe("rejected");
    const e = await escalationsOf(t.id);
    expect(e.map((x) => [x.needs, x.status, x.resolution])).toEqual([["principal_reserved", "resolved", "step declined by Julian"], ["judgment", "open", null]]);
    expect(e[1]!.key).toMatch(new RegExp(`^mac:${t.code}:rejected:\\d+@control_task:${t.id}$`));
    expect(e[1]!.summary).toMatch(/is waiting for your direction after you declined a step/);
    expect((await cancelTask(pool, t.code)).status).toBe("cancelled");
    expect((await escalationsOf(t.id)).every((x) => x.status === "resolved")).toBe(true);
    expect((await escalationsOf(t.id))[1]!.resolution).toBe("task cancelled by Julian");
  });

  it("a question waits as Julian's judgment; resume resolves it; an unanswered wait resolves when it expires", async () => {
    const t = await task("Find the Chimes recruiter's email");
    await enterAwaitingHuman(pool, t.id, "question", "Which of the two Chimes threads do you mean?");
    expect((await escalationsOf(t.id))[0]).toEqual(expect.objectContaining({ needs: "judgment", status: "open" }));
    expect((await resumeTask(pool, t.code)).status).toBe("resumed");
    expect((await escalationsOf(t.id))[0]).toEqual(expect.objectContaining({ status: "resolved", resolution: "resumed by Julian" }));

    const u = await task("Check the Amazon portal status");
    await propose(u, 1, "run", "Run a shell read", "HIGH_RISK");
    const r = await sweepHumanWaits(pool, { deliver: false, now: new Date(Date.now() + 25 * 3_600_000) });   // past the 24 h approval expiry
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await escalationsOf(u.id))[0]).toEqual(expect.objectContaining({ status: "resolved", resolution: "expired without an answer" }));
  });

  it("the event loop is the safety net: it opens a wait that bypassed the lifecycle and resolves one whose task moved on", async () => {
    const t = await task("Legacy waiting task");
    const s = await step(t.id, 1, "run", "Run something", "HIGH_RISK");
    await q(`UPDATE control_task SET status = 'waiting_approval', awaiting_since = now(), awaiting_kind = 'approval', awaiting_reason = $2, expires_at = now() + interval '1 day' WHERE id = $1`, [t.id, `step ${s.code}: Run something`]);
    expect(await escalationsOf(t.id)).toHaveLength(0);
    await tick();
    const e = await escalationsOf(t.id);
    expect(e).toEqual([expect.objectContaining({ key: `mac:${t.code}:step:${s.code}@control_task:${t.id}`, status: "open", needs: "authorization" })]);
    expect(e[0]!.notified_at).not.toBeNull();
    await q(`UPDATE control_task SET status = 'done' WHERE id = $1`, [t.id]);                 // a helper report moved it on
    await tick();
    expect((await escalationsOf(t.id))[0]).toEqual(expect.objectContaining({ status: "resolved" }));
  });

  it("Finagai-owned waits never escalate: an active task, a budget pause, a wait with no awaiting kind", async () => {
    const a = await task("Active task"); await step(a.id, 1, "observe", "Look", "OBSERVE");
    const b = await task("Budget pause");
    await enterAwaitingHuman(pool, b.id, "budget", "monthly model budget reached; raise it or wait", "paused");
    const c = await task("Paused without a human wait");
    await q(`UPDATE control_task SET status = 'paused' WHERE id = $1`, [c.id]);
    await tick();
    for (const x of [a, b, c]) expect(await escalationsOf(x.id)).toHaveLength(0);
  });
});
