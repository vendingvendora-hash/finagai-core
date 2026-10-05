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

  it("sweep: an unclaimed task older than 30min and a stalled claimed task become FAILED with reasons; fresh ones are untouched", async () => {
    const { sweepStaleTasks } = await import("../../src/mac/runtime.js");
    const mk = async (req: string) => (await pool!.query<{ id: string }>(`INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id`, [req])).rows[0]!.id;
    const zombie = await mk("control: old abandoned");
    await pool!.query(`UPDATE control_task SET created_at = now() - interval '2 hours' WHERE id = $1`, [zombie]);
    const stalled = await mk("control: stalled");
    await pool!.query(`UPDATE control_task SET claimed_at = now() - interval '1 hour', lease_until = now() - interval '50 minutes', last_progress_at = now() - interval '50 minutes', worker_id = 'dead' WHERE id = $1`, [stalled]);
    const fresh = await mk("mac_ping");
    const r = await sweepStaleTasks(pool!);
    expect(r.abandoned).toBeGreaterThanOrEqual(1); expect(r.stalled).toBeGreaterThanOrEqual(1);
    const st = async (id: string) => (await pool!.query(`SELECT status, result_summary FROM control_task WHERE id = $1`, [id])).rows[0];
    expect((await st(zombie)).status).toBe("failed"); expect((await st(zombie)).result_summary).toContain("Abandoned");
    expect((await st(stalled)).status).toBe("failed"); expect((await st(stalled)).result_summary).toContain("Stalled");
    expect((await st(fresh)).status).toBe("active");
  });
  it("pending order: a fresh mac_ping is served before older open-ended tasks (no starvation)", async () => {
    const mk = async (req: string) => (await pool!.query<{ id: string; code: string }>(`INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id, code`, [req])).rows[0]!;
    for (let i = 0; i < 6; i++) await mk(`control: long j6 task ${i} ${Date.now()}`);
    const ping = await mk("mac_ping");
    const r = await pool!.query(`SELECT id, request FROM control_task WHERE status = 'active' AND (claimed_at IS NULL OR lease_until < now())
      AND NOT EXISTS (SELECT 1 FROM control_step s WHERE s.task_id = control_task.id AND s.status IN ('proposed','running'))
      ORDER BY (CASE WHEN request LIKE 'mac_ping%' THEN 0 WHEN request LIKE 'mac_chart:%' THEN 1 ELSE 2 END), created_at DESC LIMIT 5`);
    expect(r.rows[0]!.id).toBe(ping.id);          // the ping is first even though 6 older J6 tasks exist
  });

  it("live test B regression: a reconnect after a process restart is counted (+1 per event, not per-process GREATEST)", async () => {
    const before = Number((await pool!.query(`SELECT coalesce(reconnect_count,0) AS n FROM mac_runtime WHERE id = 'primary'`)).rows[0]?.n ?? 0);
    await recordHeartbeat(pool!, { startedAt: new Date().toISOString(), helperVersion: "runtime-10" });                  // fresh process
    await recordHeartbeat(pool!, { startedAt: new Date(Date.now() - 1).toISOString(), helperVersion: "runtime-10", reconnected: { downSeconds: 40 } });
    const after = Number((await pool!.query(`SELECT reconnect_count AS n FROM mac_runtime WHERE id = 'primary'`)).rows[0].n);
    expect(after).toBe(before + 1);
    const ev = await pool!.query(`SELECT after FROM event WHERE action = 'mac_reconnected' ORDER BY occurred_at DESC LIMIT 1`);
    expect(ev.rows[0].after.downSeconds).toBe(40);
  });

  it("Phase 1E against the REAL schema: a helper diagnostic is stored and surfaces in mac_status (production bug: never stored)", async () => {
    const { recordDiagnostic, recentDiagnostics } = await import("../../src/mac/runtime.js");
    await recordDiagnostic(pool!, { kind: "diag_selftest", detail: "Authorization: Bearer abc123 leaked?", taskId: "not-a-uuid", helperVersion: "runtime-10" });
    const d = await recentDiagnostics(pool!, 1);
    expect(d[0]!.kind).toBe("diag_selftest"); expect(d[0]!.detail).not.toMatch(/abc123/);
    const st = await macStatus(pool!);
    expect((st as { recentDiagnostics: Array<{ kind: string }> }).recentDiagnostics[0]!.kind).toBe("diag_selftest");
  });
});
