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
});
