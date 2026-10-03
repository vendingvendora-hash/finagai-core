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

  it("navigation auto-runs; a send step still waits; approval one-shot; done closes the task", async () => {
    const task = await createTask(pool!, "Open Drive and send Santiago the file", "chat");
    const model = new Script([
      { kind: "screenshot", params: {}, risk: "read", summary: "Look at the screen" },
      { kind: "open_url", params: { url: "https://drive.google.com/drive/search?q=x" }, risk: "write", summary: "Open Drive search" },
      { kind: "click", params: { x: 1, y: 1 }, risk: "write", summary: "Enviar el archivo a Santiago" },
      { kind: "done", summary: "Sent" },
    ]);
    const d = deps(model);

    const r1 = await planNext(d, task.id, "shot1");
    expect(r1.status).toBe("run_read");
    await recordRun(pool!, r1.step!.id, true, "screenshot taken");

    const r2 = await planNext(d, task.id, "shot2", "screenshot taken");
    expect(r2.status).toBe("run_approved");                 // open_url auto-runs in auto mode
    expect(await getStep(pool!, r2.step!.id)).not.toBeNull();
    await recordRun(pool!, r2.step!.id, true, "opened Drive");

    const r3 = await planNext(d, task.id, "shot3", "opened Drive");
    expect(r3.status).toBe("await_approval");               // "enviar ... a Santiago" still confirms
    const dec = await decideStep(pool!, r3.step!.code, true);
    expect(dec.status).toBe("approved");
    expect(await decideStep(pool!, r3.step!.code, true)).toEqual({ status: "already_handled" });
    await recordRun(pool!, r3.step!.id, true, "sent");

    const r4 = await planNext(d, task.id, "shot4", "sent");
    expect(r4.status).toBe("done");
  });

  it("stops asking when a step repeats (loop guard)", async () => {
    const task = await createTask(pool!, "Open the compliance folder", "chat");
    const model = new Script([{ kind: "double_click", params: { x: 5, y: 5 }, risk: "write", summary: "Open the compliance folder" }]);
    const d = deps(model);
    // First two identical steps auto-run; the third identical one trips the guard and asks.
    const a = await planNext(d, task.id, "s"); await recordRun(pool!, a.step!.id, true, "nothing changed");
    const b = await planNext(d, task.id, "s", "nothing changed"); await recordRun(pool!, b.step!.id, true, "nothing changed");
    const c = await planNext(d, task.id, "s", "nothing changed");
    expect(c.status).toBe("ask");
    expect(c.message).toMatch(/same step/i);
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

  it("a contact can request a task; it records the requester and still needs Julian's approval (ADR-051)", async () => {
    const task = await createTask(pool!, "(Santiago asked) make a chart of our October spending", "contact", "Santiago");
    const row = (await pool!.query(`SELECT origin, requester FROM control_task WHERE id = $1`, [task.id])).rows[0];
    expect(row.origin).toBe("contact");
    expect(row.requester).toBe("Santiago");
    const r = await planNext(deps(new Script([{ kind: "click", params: { x: 1, y: 1 }, risk: "write", summary: "Enviar el chart a Santiago" }])), task.id, "shot");
    expect(r.status).toBe("await_approval");         // sending to the contact always needs Julian's ok
    const dec = await decideStep(pool!, r.step!.code, true);
    expect(dec.status).toBe("approved");
    const ev = (await pool!.query(`SELECT actor FROM event WHERE action = 'control_step_approved' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(ev.actor).toBe("julian");                 // approval is Julian's, never the contact's
  });
});
