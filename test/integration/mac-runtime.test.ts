/**
 * Mac runtime round-trip (ADR-066) against real Postgres: heartbeat -> claim -> progress -> lifecycle.
 * Reproduces tasks 33/34: a task with no worker is reported waiting_for_mac immediately, not "active".
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db/index.js";
import { recordHeartbeat, getRuntime, claimTask, taskProgress, deriveLifecycle, macStatus } from "../../src/mac/runtime.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;

describe.skipIf(!pool)("Mac runtime (ADR-066)", () => {
  afterAll(async () => { await pool?.end(); });

  it("R01: a task with no fresh Mac heartbeat is waiting_for_mac, not active; after heartbeat+claim+progress it is executing", async () => {
    // make the runtime look offline (stale heartbeat)
    await pool!.query(`INSERT INTO mac_runtime (id, last_heartbeat_at) VALUES ('primary', now() - interval '10 minutes')
                       ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = now() - interval '10 minutes'`);
    const t = await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ('mac_chart:rt-test', 'chat') RETURNING id`);
    const id = t.rows[0]!.id;
    const row = async () => (await pool!.query(`SELECT status, claimed_at, last_progress_at FROM control_task WHERE id = $1`, [id])).rows[0];
    expect(deriveLifecycle(await row(), await getRuntime(pool!)).lifecycle).toBe("waiting_for_mac");

    // worker comes online, claims, reports progress
    await recordHeartbeat(pool!, { helperVersion: "runtime-1", capabilities: { screen: true, accessibility: true, files: true } });
    expect(deriveLifecycle(await row(), await getRuntime(pool!)).lifecycle).toBe("queued");
    expect(await claimTask(pool!, id, "w1")).toBe(true);
    await taskProgress(pool!, id, "reading workbook");
    expect(deriveLifecycle(await row(), await getRuntime(pool!)).lifecycle).toBe("executing");

    // status matrix reflects real capabilities
    const st = await macStatus(pool!);
    expect(st.connected).toBe(true);
    expect(st.screenCapture).toBe("PASS");
    expect(st.accessibility).toBe("PASS");

    // terminal failure never leaves it active
    await pool!.query(`UPDATE control_task SET status = 'failed' WHERE id = $1`, [id]);
    expect(deriveLifecycle(await row(), await getRuntime(pool!)).lifecycle).toBe("failed");
  });

  it("R02: a second worker cannot steal a live claim; it can after the lease expires", async () => {
    const t = await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ('mac_chart:lease-test', 'chat') RETURNING id`);
    const id = t.rows[0]!.id;
    expect(await claimTask(pool!, id, "w1")).toBe(true);
    expect(await claimTask(pool!, id, "w2")).toBe(false);          // live lease held by w1
    await pool!.query(`UPDATE control_task SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await claimTask(pool!, id, "w2")).toBe(true);           // reclaim after expiry (stalled recovery)
  });

  it("G: a stale worker cannot complete a task that another worker reclaimed", async () => {
    const { workerMayComplete } = await import("../../src/mac/runtime.js");
    const t = await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ('mac_ping', 'chat') RETURNING id`);
    const id = t.rows[0]!.id;
    expect(await claimTask(pool!, id, "w1")).toBe(true);
    await pool!.query(`UPDATE control_task SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);   // w1 died
    expect(await claimTask(pool!, id, "w2")).toBe(true);                                                             // reclaimed
    expect(await workerMayComplete(pool!, id, "w1")).toBe(false);     // stale worker refused
    expect(await workerMayComplete(pool!, id, "w2")).toBe(true);      // live holder allowed
    expect(await workerMayComplete(pool!, id, null)).toBe(false);     // anonymous caller refused on a claimed task
  });
  it("health counters: restart_count increments when startedAt changes; reconnects are recorded; last success stamped", async () => {
    const { recordSuccess } = await import("../../src/mac/runtime.js");
    await recordHeartbeat(pool!, { startedAt: "2026-10-04T00:00:00.000Z", reconnects: 0 });
    const before = (await getRuntime(pool!))!.restartCount;
    await recordHeartbeat(pool!, { startedAt: "2026-10-04T01:00:00.000Z", reconnects: 3 });   // daemon restarted + 3 reconnects
    const rt = (await getRuntime(pool!))!;
    expect(rt.restartCount).toBe(before + 1);
    expect(rt.reconnectCount).toBeGreaterThanOrEqual(3);
    const t = await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ('mac_ping', 'chat') RETURNING id`);
    await recordSuccess(pool!, t.rows[0]!.id);
    expect((await getRuntime(pool!))!.lastSuccessAt).not.toBeNull();
  });
});
