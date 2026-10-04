/**
 * WO2 acceptance (ADR-067): a request becomes a durable interaction owned until a terminal state.
 * Reproduces #9/#32 and the "finished after the turn ended but never delivered" failure.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { openInteraction, linkTask, completeForTask, undelivered, markDelivered, requestKey, getInteraction, setState } from "../../src/concierge/interactions.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;

describe.skipIf(!pool)("Durable interactions (WO2 / ADR-067)", () => {
  afterAll(async () => { await pool?.end(); });

  it("requestKey: wording variants of the same ask map to one logical identity", () => {
    expect(requestKey("Finagai, make the Altarum chart and show it to me")).toBe(requestKey("make the altarum chart and show it to me please"));
    expect(requestKey("mac_chart:Altarum")).not.toBe(requestKey("mac_chart:Degree of Leverage"));
  });

  it("W1: the same request twice (impatient follow-up) => exactly ONE interaction, ONE task (no #32 beside #9)", async () => {
    const msg = `make the altarum chart ${Date.now()}`;
    const a = await openInteraction(pool!, { conversation: "chat", message: msg });
    const t = await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id`, [msg]);
    await linkTask(pool!, a.interaction.id, t.rows[0]!.id);
    const b = await openInteraction(pool!, { conversation: "chat", message: msg + " " });   // follow-up, same ask
    expect(b.reused).toBe(true);
    expect(b.interaction.id).toBe(a.interaction.id);
    expect((await getInteraction(pool!, a.interaction.id))!.taskIds.length).toBe(1);        // one logical execution
  });

  it("W2: task outlives the turn; completion becomes pending delivery; it is surfaced on the next tool call, then marked delivered", async () => {
    const msg = `chart something async ${Date.now()}`;
    const ix = await openInteraction(pool!, { conversation: "chat", message: msg });
    const t = await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id`, [msg]);
    await linkTask(pool!, ix.interaction.id, t.rows[0]!.id);
    await setState(pool!, ix.interaction.id, "executing", "reading workbook");
    // ...the Claude turn ends here. Later the worker finishes:
    await completeForTask(pool!, t.rows[0]!.id, { ok: true, summary: "Built chart of Unit Price by Month", imageB64: "iVBORw0KGgo=" });
    const due = await undelivered(pool!, "chat", 10);
    const mine = due.find((d) => d.id === ix.interaction.id);
    expect(mine).toBeDefined();                            // surfaced without Julian saying "check again"
    expect(mine!.state).toBe("completed");
    expect(mine!.resultImageB64).toBe("iVBORw0KGgo=");
    await markDelivered(pool!, [ix.interaction.id]);
    expect((await undelivered(pool!, "chat", 10)).find((d) => d.id === ix.interaction.id)).toBeUndefined();
    expect((await getInteraction(pool!, ix.interaction.id))!.finalResponseStatus).toBe("delivered");
  });

  it("W3: Core restart mid-execution — a fresh process (new pool) still owns and finishes the interaction", async () => {
    const msg = `survive core restart ${Date.now()}`;
    const ix = await openInteraction(pool!, { conversation: "chat", message: msg });
    const t = await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id`, [msg]);
    await linkTask(pool!, ix.interaction.id, t.rows[0]!.id);
    const pool2 = createPool(url!);                         // "restarted Core": no in-memory state at all
    try {
      const again = await openInteraction(pool2, { conversation: "chat", message: msg });
      expect(again.reused).toBe(true);                      // ownership is durable, not in RAM
      await completeForTask(pool2, t.rows[0]!.id, { ok: true, summary: "done after restart" });
      expect((await getInteraction(pool2, ix.interaction.id))!.state).toBe("completed");
    } finally { await pool2.end(); }
  });

  it("W4: a failed task yields a failed interaction with a concrete reason (never silently active)", async () => {
    const msg = `will fail ${Date.now()}`;
    const ix = await openInteraction(pool!, { conversation: "chat", message: msg });
    const t = await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id`, [msg]);
    await linkTask(pool!, ix.interaction.id, t.rows[0]!.id);
    await completeForTask(pool!, t.rows[0]!.id, { ok: false, summary: "Spotlight found no workbook named X" });
    const got = (await getInteraction(pool!, ix.interaction.id))!;
    expect(got.state).toBe("failed");
    expect(got.resultSummary).toContain("Spotlight");
  });
});
