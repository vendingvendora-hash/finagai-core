/**
 * J6 control lifecycle against real Postgres (as finagai_app). Model scripted. Verifies the safety
 * contract: read steps run without approval; write steps wait; approval happens once; the DB forbids a
 * write step reaching 'done' without a recorded decision; cancel supersedes pending steps; no deletes.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import type { ModelRequest, ModelResult } from "../../src/llm/types.js";
import { cancelTask, createTask, decideStep, getStep, planNext, recordRun, type ControlDeps } from "../../src/pipelines/j6/control.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;

class Script {
  i = 0;
  constructor(public steps: object[]) {}
  async complete(req: ModelRequest): Promise<ModelResult> {
    const body = this.steps[Math.min(this.i++, this.steps.length - 1)];
    return { text: JSON.stringify(body), model: req.model, stopReason: "end_turn", costUsd: 0.01, retries: 0, latencyMs: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}
const deps = (m: Script): ControlDeps => ({ pool: pool!, model: m, modelId: "claude-sonnet-5-5" });

describe.skipIf(!pool)("J6 control lifecycle", () => {
  afterAll(async () => { await pool?.end(); });

  it("read runs without approval; write waits; approval is one-shot; done closes the task", async () => {
    const task = await createTask(pool!, "Open Notes and add a reminder", "chat");
    const model = new Script([
      { kind: "screenshot", params: {}, risk: "read", summary: "Look at the screen" },
      { kind: "open_app", params: { name: "Notes" }, risk: "write", summary: "Open the Notes app" },
      { kind: "type", params: { text: "Reminder" }, risk: "write", summary: "Type the reminder" },
      { kind: "done", summary: "Added the reminder" },
    ]);
    const d = deps(model);

    const r1 = await planNext(d, task.id, "shot1");
    expect(r1.status).toBe("run_read");
    await recordRun(pool!, r1.step!.id, true, "screenshot taken");

    const r2 = await planNext(d, task.id, "shot2", "screenshot taken");
    expect(r2.status).toBe("await_approval");
    expect(r2.step!.summary).toMatch(/Open the Notes app/);
    // Not yet runnable: getStep only returns approved steps.
    expect(await getStep(pool!, r2.step!.id)).toBeNull();
    // Task is blocked on approval.
    expect((await pool!.query(`SELECT status FROM control_task WHERE id = $1`, [task.id])).rows[0].status).toBe("waiting_approval");

    const dec = await decideStep(pool!, r2.step!.code, true);
    expect(dec.status).toBe("approved");
    expect(await decideStep(pool!, r2.step!.code, true)).toEqual({ status: "already_handled" }); // one-shot
    const step = await getStep(pool!, r2.step!.id);
    expect(step!.kind).toBe("open_app");
    await recordRun(pool!, r2.step!.id, true, "opened Notes");

    const r3 = await planNext(d, task.id, "shot3", "opened Notes");
    expect(r3.status).toBe("await_approval");
    await decideStep(pool!, r3.step!.code, false); // reject this one
    expect((await pool!.query(`SELECT status FROM control_step WHERE id = $1`, [r3.step!.id])).rows[0].status).toBe("rejected");

    const r4 = await planNext(d, task.id, "shot4", "user skipped typing");
    expect(r4.status).toBe("done");
    expect((await pool!.query(`SELECT status FROM control_task WHERE id = $1`, [task.id])).rows[0].status).toBe("done");
  });

  it("the database refuses a write step marked done without a decision", async () => {
    const task = await createTask(pool!, "x", "chat");
    const ins = await pool!.query<{ id: string }>(
      `INSERT INTO control_step (task_id, seq, kind, params, risk, summary, status) VALUES ($1,1,'click','{}','write','click',''proposed'') RETURNING id`.replace("''proposed''", "'proposed'"), [task.id]);
    await expect(pool!.query(`UPDATE control_step SET status = 'done' WHERE id = $1`, [ins.rows[0]!.id])).rejects.toThrow(/ck_control_write_decided|violates check/);
  });

  it("ask pauses the task for Julian", async () => {
    const task = await createTask(pool!, "Pick a restaurant and book it", "chat");
    const r = await planNext(deps(new Script([{ kind: "ask", summary: "which cuisine?", question: "Italian or Thai?" }])), task.id, "shot");
    expect(r.status).toBe("ask");
    expect(r.message).toBe("Italian or Thai?");
  });

  it("cancel supersedes pending steps and the app cannot delete history", async () => {
    const task = await createTask(pool!, "y", "chat");
    const r = await planNext(deps(new Script([{ kind: "run", params: { cmd: "echo hi" }, risk: "write", summary: "Run echo" }])), task.id, "s");
    expect(r.status).toBe("await_approval");
    expect(r.step).toBeDefined();
    const c = await cancelTask(pool!, task.code);
    expect(c.status).toBe("cancelled");
    expect((await pool!.query(`SELECT status FROM control_step WHERE id = $1`, [r.step!.id])).rows[0].status).toBe("superseded"); // eslint-disable-line
    await expect(pool!.query(`DELETE FROM control_task`)).rejects.toThrow(/permission denied/);
    await expect(pool!.query(`DELETE FROM control_step`)).rejects.toThrow(/permission denied/);
  });

  it("J6 model calls are accepted by the metering ledger", async () => {
    await pool!.query(`INSERT INTO llm_call (pipeline, step, model, prompt_version, purpose, status) VALUES ('j6','plan','claude-sonnet-5-5','j6-control-v1','concierge','budget_blocked')`);
  });
});
