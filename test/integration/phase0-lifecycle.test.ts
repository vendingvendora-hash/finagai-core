/**
 * Phase 0 (ADR-076) regressions against a real Postgres with migration 0024:
 *  0C  approval waits expire/remind/resume (live #104/#113 sat "executing" for 4 days)
 *  0D  iMessage tasks create the same interaction record as chat (live #117 had none)
 *  0E  lifecycle failures are recorded, not swallowed
 *  0F  verified / unverified / needs_review are distinct outcomes in the metrics
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { createTask, decideStep, resumeByCode, parseControlCommand, cancelTask } from "../../src/pipelines/j6/control.js";
import { enterAwaitingHuman, sweepHumanWaits } from "../../src/concierge/human-wait.js";
import { completeForTask, reconcileInteractions, openInteraction, linkTask } from "../../src/concierge/interactions.js";
import { reportLifecycleError, recentLifecycleErrors } from "../../src/ops/lifecycle-errors.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;

async function proposeStep(taskId: string, summary: string): Promise<number> {
  const r = await pool!.query<{ code: string }>(`INSERT INTO control_step (task_id, seq, kind, params, risk, summary, status)
     VALUES ($1, (SELECT coalesce(max(seq),0)+1 FROM control_step WHERE task_id = $1), 'click', '{}', 'write', $2, 'proposed') RETURNING code`, [taskId, summary]);
  return Number(r.rows[0]!.code);
}
const ixOf = async (taskId: string) => (await pool!.query(`SELECT * FROM interaction WHERE $1 = ANY(task_ids)`, [taskId])).rows;

afterAll(async () => { await pool?.end(); });

describe.skipIf(!pool)("Phase 0C — human waits are explicit, expiring and resumable", () => {

  it("a waiting task's interaction is awaiting_human (not executing), with requested/expires timestamps", async () => {
    const t = await createTask(pool!, "Phase0 C1: click the blue button", "chat");
    const step = await proposeStep(t.id, "click the blue button");
    await enterAwaitingHuman(pool!, t.id, "approval", `step ${step}: click the blue button`);
    const task = (await pool!.query(`SELECT status, awaiting_since, expires_at, awaiting_kind FROM control_task WHERE id = $1`, [t.id])).rows[0];
    expect(task.status).toBe("waiting_approval"); expect(task.awaiting_kind).toBe("approval");
    expect(new Date(task.expires_at).getTime() - new Date(task.awaiting_since).getTime()).toBe(24 * 3600_000);
    expect((await ixOf(t.id))[0].state).toBe("awaiting_human");
  });

  it("reminders are bounded by policy and only counted when a helper can deliver them", async () => {
    const t = await createTask(pool!, "Phase0 C2: approve me", "imessage");
    const step = await proposeStep(t.id, "type hello");
    await enterAwaitingHuman(pool!, t.id, "approval", `step ${step}: type hello`);
    await pool!.query(`UPDATE control_task SET awaiting_since = now() - interval '90 minutes', expires_at = now() + interval '22 hours' WHERE id = $1`, [t.id]);
    const silent = await sweepHumanWaits(pool!, { deliver: false });
    expect(silent.reminders.find((r) => r.taskCode === t.code)).toBeUndefined();
    const first = await sweepHumanWaits(pool!, { deliver: true });
    const mine = first.reminders.filter((r) => r.taskCode === t.code);
    expect(mine).toHaveLength(1); expect(mine[0]!.text).toContain(`ok ${step}`);
    const again = await sweepHumanWaits(pool!, { deliver: true });
    expect(again.reminders.filter((r) => r.taskCode === t.code)).toHaveLength(0);   // not before the 8h mark
  });

  it("#104/#113 shape: a wait past its expiry becomes expired (task, step, interaction) with waiting time recorded", async () => {
    const t = await createTask(pool!, "Phase0 C3: read ~/.finagai/phase1-live.out", "chat");
    const step = await proposeStep(t.id, "run cat");
    await enterAwaitingHuman(pool!, t.id, "approval", `step ${step}: run cat`);
    await pool!.query(`UPDATE control_task SET awaiting_since = now() - interval '4 days', expires_at = now() - interval '3 days' WHERE id = $1`, [t.id]);
    await pool!.query(`UPDATE interaction SET awaiting_since = now() - interval '4 days' WHERE $1 = ANY(task_ids)`, [t.id]);
    const r = await sweepHumanWaits(pool!, { deliver: false });
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const task = (await pool!.query(`SELECT status, terminal_reason, result_summary FROM control_task WHERE id = $1`, [t.id])).rows[0];
    expect(task.status).toBe("expired"); expect(task.terminal_reason).toBe("awaiting_human_expired");
    expect(task.result_summary).toContain(`resume ${t.code}`);
    expect((await pool!.query(`SELECT status FROM control_step WHERE code = $1`, [step])).rows[0].status).toBe("expired");
    const ix = (await ixOf(t.id))[0];
    expect(ix.state).toBe("expired"); expect(Number(ix.waiting_human_s)).toBeGreaterThan(3 * 86400);
    expect(ix.final_response_status).toBe("pending");   // chat: Julian is told it expired
  });

  it("a late 'ok' on the expired step resumes the SAME task and interaction; the stale step is not run", async () => {
    const t = await createTask(pool!, "Phase0 C4: late ok", "chat");
    const step = await proposeStep(t.id, "click submit-free next");
    await enterAwaitingHuman(pool!, t.id, "approval", `step ${step}`);
    await pool!.query(`UPDATE control_task SET expires_at = now() - interval '1 minute' WHERE id = $1`, [t.id]);
    await sweepHumanWaits(pool!, { deliver: false });
    const before = await ixOf(t.id);
    const d = await decideStep(pool!, step, true);
    expect(d.status).toBe("approved");
    expect("stepId" in d ? d.stepId : undefined).toBeUndefined();            // helper drives the task; no stale step runs
    expect((await pool!.query(`SELECT status, resumed_count FROM control_task WHERE id = $1`, [t.id])).rows[0]).toEqual({ status: "active", resumed_count: 1 });
    expect((await pool!.query(`SELECT status FROM control_step WHERE code = $1`, [step])).rows[0].status).toBe("superseded");
    const after = await ixOf(t.id);
    expect(after).toHaveLength(1); expect(after[0].id).toBe(before[0].id); expect(after[0].state).toBe("executing");
  });

  it("'resume <code>' is a command; resuming a finished task is refused", async () => {
    expect(parseControlCommand("resume 113")).toEqual({ kind: "resume_task", code: 113 });
    expect(parseControlCommand("continúa 7")).toEqual({ kind: "resume_task", code: 7 });
    const t = await createTask(pool!, "Phase0 C5: done task", "chat");
    await pool!.query(`UPDATE control_task SET status = 'done' WHERE id = $1`, [t.id]);
    expect((await resumeByCode(pool!, t.code)).status).toBe("not_resumable");
  });

  it("reconcile marks an interaction awaiting_human when its task waits (legacy paths that bypassed enterAwaitingHuman)", async () => {
    const { interaction } = await openInteraction(pool!, { conversation: "chat", message: "Phase0 C6 legacy wait" });
    const tid = (await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin, status) VALUES ('legacy wait', 'chat', 'waiting_approval') RETURNING id`)).rows[0]!.id;
    await linkTask(pool!, interaction.id, tid);
    await pool!.query(`UPDATE interaction SET state = 'executing' WHERE id = $1`, [interaction.id]);
    await reconcileInteractions(pool!);
    expect((await pool!.query(`SELECT state FROM interaction WHERE id = $1`, [interaction.id])).rows[0].state).toBe("awaiting_human");
  });

  it("cancel closes the interaction as cancelled", async () => {
    const t = await createTask(pool!, "Phase0 C7: cancel me", "imessage");
    await cancelTask(pool!, t.code);
    expect((await ixOf(t.id))[0].state).toBe("cancelled");
  });
});

describe.skipIf(!pool)("Phase 0D — every surface creates the same interaction", () => {
  it("an iMessage task (#117 shape) opens an interaction (conversation self, origin imessage) linked to the task", async () => {
    const t = await createTask(pool!, "Finagai, help me writing a happy birthday message in spanish for my trainer", "imessage");
    const ix = await ixOf(t.id);
    expect(ix).toHaveLength(1);
    expect(ix[0]).toEqual(expect.objectContaining({ conversation: "self", origin: "imessage", state: "claimed" }));
    expect((await pool!.query(`SELECT interaction_id FROM control_task WHERE id = $1`, [t.id])).rows[0].interaction_id).toBe(ix[0].id);
    await completeForTask(pool!, t.id, { ok: true, summary: "message drafted", verification: "verified" });
    const done = (await ixOf(t.id))[0];
    expect(done.state).toBe("completed"); expect(done.final_response_status).toBe("delivered");   // delivered by the helper in the same exchange
  });
  it("a contact-requested task is attributed to the contact's conversation", async () => {
    const t = await createTask(pool!, "(Santiago asked) find the Lupo menu", "contact", "Santiago");
    expect((await ixOf(t.id))[0]).toEqual(expect.objectContaining({ conversation: "Santiago", origin: "contact" }));
  });
  it("a chat task passes its existing interaction and gets an acceptance contract stored", async () => {
    const { interaction } = await openInteraction(pool!, { conversation: "chat", message: "Phase0 D3 open TextEdit" });
    const t = await createTask(pool!, "Phase0 D3 open TextEdit", "chat", undefined, interaction.id);
    expect(t.interactionId).toBe(interaction.id);
    expect((await pool!.query(`SELECT acceptance IS NOT NULL AS has FROM control_task WHERE id = $1`, [t.id])).rows[0].has).toBe(true);
  });
});

describe.skipIf(!pool)("Phase 0E/0F — observable failures, honest completion", () => {
  it("lifecycle errors are recorded as events and readable", async () => {
    await reportLifecycleError(pool!, "test.reconcile", new Error("boom Bearer abc.def postgres://u:p@h/db"));
    const errs = await recentLifecycleErrors(pool!, 1);
    const mine = errs.find((e) => e.where === "test.reconcile");
    expect(mine).toBeDefined();
    expect(mine!.error).not.toContain("abc.def"); expect(mine!.error).not.toContain("u:p@h");
  });
  it("verified, unverified and needs_review are distinct in the interaction and the daily metrics", async () => {
    const mk = async (label: string, v: "verified" | "unverified" | "needs_review") => {
      const t = await createTask(pool!, `Phase0 F ${label}`, "chat");
      await completeForTask(pool!, t.id, { ok: true, summary: label, verification: v });
      return t;
    };
    const a = await mk("a", "verified"), b = await mk("b", "unverified"), c = await mk("c", "needs_review");
    for (const [t, v] of [[a, "verified"], [b, "unverified"], [c, "needs_review"]] as const) {
      expect((await ixOf(t.id))[0].verification_status).toBe(v);
      expect((await pool!.query(`SELECT verification_status FROM control_task WHERE id = $1`, [t.id])).rows[0].verification_status).toBe(v);
    }
    const m = (await pool!.query(`SELECT sum(completed_verified)::int AS v, sum(completed_unverified)::int AS u, sum(needs_review)::int AS n FROM interaction_metrics_daily`)).rows[0];
    expect(m.v).toBeGreaterThanOrEqual(1); expect(m.u).toBeGreaterThanOrEqual(1); expect(m.n).toBeGreaterThanOrEqual(1);
  });
});
