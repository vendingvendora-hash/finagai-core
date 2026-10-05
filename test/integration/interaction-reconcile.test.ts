/** ADR-075: live interactions stayed "executing" after their tasks ended, and cost_usd was never recorded. */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { openInteraction, linkTask, setState, reconcileInteractions } from "../../src/concierge/interactions.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;

describe.skipIf(!pool)("interaction reconciliation + cost attribution (ADR-075)", () => {
  afterAll(async () => { await pool?.end(); });
  it("an interaction whose tasks all ended is closed with the task outcome and its model cost", async () => {
    const { interaction } = await openInteraction(pool!, { conversation: "chat", message: "reconcile test #113 shape" });
    const t = (await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ('rt-113', 'chat') RETURNING id`)).rows[0]!.id;
    await linkTask(pool!, interaction.id, t);
    await setState(pool!, interaction.id, "executing");
    await pool!.query(`INSERT INTO llm_call (pipeline, step, model, prompt_version, purpose, status, cost_usd, request_id)
                       VALUES ('j6','plan','m','v','concierge','ok',0.0123,$1), ('j6','verify','m','v','concierge','ok',0.0100,$1)`, [t]);
    await pool!.query(`UPDATE control_task SET status = 'failed', failure_class = 'model_parse', result_summary = 'planner reply unreadable' WHERE id = $1`, [t]);
    const r = await reconcileInteractions(pool!);
    expect(r.closed).toBeGreaterThanOrEqual(1);
    const i = (await pool!.query(`SELECT state, failure_class, cost_usd FROM interaction WHERE id = $1`, [interaction.id])).rows[0];
    expect(i.state).toBe("failed"); expect(i.failure_class).toBe("model_parse"); expect(Number(i.cost_usd)).toBeCloseTo(0.0223, 4);
  });
  it("an open interaction with no task for 6h is abandoned; one still running is left alone", async () => {
    const { interaction: stale } = await openInteraction(pool!, { conversation: "chat", message: "reconcile orphan" });
    await pool!.query(`UPDATE interaction SET state = 'executing', updated_at = now() - interval '7 hours' WHERE id = $1`, [stale.id]);
    const { interaction: live } = await openInteraction(pool!, { conversation: "chat", message: "reconcile live" });
    const t = (await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ('rt-live', 'chat') RETURNING id`)).rows[0]!.id;
    await linkTask(pool!, live.id, t); await setState(pool!, live.id, "executing");
    await reconcileInteractions(pool!);
    const s = (await pool!.query(`SELECT id, state, failure_class FROM interaction WHERE id = ANY($1::uuid[])`, [[stale.id, live.id]])).rows;
    expect(s.find((x) => x.id === stale.id)!.state).toBe("failed");
    expect(s.find((x) => x.id === stale.id)!.failure_class).toBe("abandoned");
    expect(s.find((x) => x.id === live.id)!.state).toBe("executing");
  });
});
