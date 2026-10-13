/**
 * Phase 8 (ADR-088) — continuous reliability on the Live State Stream:
 *   - the ADR-087 self-check runs inside real ticks (never previews), at most every `everyMs`, its verdict on the stream;
 *     a check failing twice in a row is a Finagai-owned exception that clears itself when the check passes again;
 *   - scheduled job runs are on the stream (job_finished, correlated with the run);
 *   - a flapping condition stays one exception (hysteresis), instead of reopening every cycle;
 *   - events about rules / exceptions / escalations / lessons carry the object's own Area;
 *   - the reliability report is derived from the stream and names what breaks the budget.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../eval/runner/j3cases.js";
import { ensureArea } from "../../src/cos/operating.js";
import { appendEvent, withCause } from "../../src/db/index.js";
import { PgJobLedger } from "../../src/db/jobRuns.js";
import { runTick } from "../../src/events/index.js";
import { addRule, removeRule } from "../../src/exceptions/rules.js";
import { reliabilityReport } from "../../src/live/reliability.js";
import { publish } from "../../src/live/stream.js";
import type { AreaModule } from "../../src/events/types.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
let db: Awaited<ReturnType<typeof materialize>>; let pool: pg.Pool;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const empty: AreaModule = { watchers: [], subscriptions: [], workflows: [] };
const budget = async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 });
const tick = (reliability?: Parameters<typeof runTick>[2]["reliability"], dryRun = false) =>
  runTick(pool, { now: new Date(), dryRun }, { modules: [empty], exceptions: { budget }, ...(reliability ? { reliability } : {}) }, dryRun ? "preview" : "manual");

describe.skipIf(!admin || !migT || !appT)("Phase 8 continuous reliability (ADR-088)", () => {
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_rel_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
  }, 60_000);
  afterAll(async () => { await pool?.end(); await db?.drop(); });

  it("the self-check runs in real ticks only, records its verdict on the stream, and a repeated failure is an exception that clears itself", async () => {
    let verdict = ["ordering: FAIL", "health: PASS", "emailToStateChain: PENDING"];
    const calls: number[] = [];
    const rel = { everyMs: 0, version: "test", check: async () => { calls.push(1); return { allPass: false, verdict }; } };
    await tick(rel, true);                                                          // a preview never runs it
    expect(calls.length).toBe(0);
    await tick(rel);
    const first = (await q(`SELECT after, correlation_id, cause_ids FROM event WHERE action = 'reliability_checked' ORDER BY id`));
    expect(first).toHaveLength(1);
    expect(first[0].after).toEqual(expect.objectContaining({ allPass: false, failing: ["ordering"], pending: ["emailToStateChain"], passed: 1, version: "test" }));
    expect(first[0].correlation_id).toBeTruthy();                                   // part of the tick's unit of work
    expect(first[0].cause_ids.length).toBe(1);                                      // caused by the tick
    expect(await q(`SELECT key FROM operating_exception WHERE key = 'reliability:ordering'`)).toEqual([]);   // one failure is not enough
    await tick(rel);
    const ex = (await q(`SELECT key, owner, severity, status FROM operating_exception WHERE key = 'reliability:ordering'`))[0];
    expect(ex).toEqual({ key: "reliability:ordering", owner: "finagai", severity: "warning", status: "open" });
    expect((await q(`SELECT area_id FROM event WHERE action = 'exception_opened' AND after->>'key' = 'reliability:ordering'`))).toHaveLength(1);
    verdict = ["ordering: PASS", "health: PASS", "emailToStateChain: PENDING"];
    await tick({ ...rel, check: async () => ({ allPass: false, verdict }) });
    expect((await q(`SELECT status FROM operating_exception WHERE key = 'reliability:ordering'`))[0].status).toBe("resolved");
    // due-gating: with an hourly cadence the next tick does not run it again
    const n = (await q(`SELECT count(*)::int AS n FROM event WHERE action = 'reliability_checked'`))[0].n;
    await tick({ ...rel, everyMs: 3_600_000 });
    expect((await q(`SELECT count(*)::int AS n FROM event WHERE action = 'reliability_checked'`))[0].n).toBe(n);
    // a check that throws is itself a failure, recorded — never silently skipped
    await tick({ everyMs: 0, check: async () => { throw new Error("boom"); } });
    expect((await q(`SELECT after FROM event WHERE action = 'reliability_checked' ORDER BY id DESC LIMIT 1`))[0].after.failing).toEqual(["selfCheck"]);
  }, 60_000);

  it("scheduled job runs are on the stream, in the run's own unit of work", async () => {
    const ledger = new PgJobLedger(pool);
    const slot = new Date("2026-10-13T07:00:00Z");
    const claim = (await ledger.claim("daily_maintenance", slot, "owner-1", 60_000))!;
    expect(await ledger.finish(claim.runId, "owner-1", { status: "succeeded" })).toBe(true);
    const c2 = (await ledger.claim("weekly_review", slot, "owner-1", 60_000))!;
    await ledger.finish(c2.runId, "owner-1", { status: "failed", detail: "model budget blocked" });
    const evs = await q(`SELECT correlation_id, after FROM event WHERE action = 'job_finished' ORDER BY id`);
    expect(evs.map((e) => [e.correlation_id, e.after.job, e.after.status])).toEqual([[claim.runId, "daily_maintenance", "succeeded"], [c2.runId, "weekly_review", "failed"]]);
    expect(evs[1].after).toEqual(expect.objectContaining({ attempt: 1, scheduledFor: slot.toISOString(), detail: "model budget blocked" }));
    // a finish after the lease was lost records nothing (the outcome is discarded)
    expect(await ledger.finish(claim.runId, "owner-1", { status: "succeeded" })).toBe(false);
    expect((await q(`SELECT count(*)::int AS n FROM event WHERE action = 'job_finished'`))[0].n).toBe(2);
  });

  it("an idle Mac sleeping and waking is not an exception: the night's dark wakes write nothing (live 2026-10-13)", async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM event WHERE action IN ('exception_opened','exception_resolved')`))[0].n;
    await q(`INSERT INTO mac_runtime (id, last_heartbeat_at) VALUES ('primary', now() - interval '40 minutes') ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at`);
    await tick();                                                                   // asleep
    await q(`UPDATE mac_runtime SET last_heartbeat_at = now() WHERE id = 'primary'`);
    await tick();                                                                   // a dark wake
    await q(`UPDATE mac_runtime SET last_heartbeat_at = now() - interval '35 minutes' WHERE id = 'primary'`);
    await tick();                                                                   // asleep again
    expect(await q(`SELECT key FROM operating_exception WHERE detector = 'mac_offline'`)).toEqual([]);
    expect((await q(`SELECT count(*)::int AS n FROM event WHERE action IN ('exception_opened','exception_resolved')`))[0].n).toBe(before);
    // the same sleep WITH Mac work waiting is Julian's, and clears the moment the Mac is back
    await q(`INSERT INTO control_task (request, status, created_at) VALUES ('export the chart', 'active', now() - interval '40 minutes')`);
    await tick();
    expect((await q(`SELECT owner, status FROM operating_exception WHERE key = 'mac:offline:work'`))[0]).toEqual({ owner: "julian", status: "open" });
    await q(`UPDATE control_task SET status = 'cancelled' WHERE status = 'active'`);
    await q(`UPDATE mac_runtime SET last_heartbeat_at = now() WHERE id = 'primary'`);
    await tick();
    expect((await q(`SELECT status FROM operating_exception WHERE key = 'mac:offline:work'`))[0].status).toBe("resolved");
  }, 60_000);

  it("rule events carry the rule's Area (ADR-087 residual: watch_rule_removed had none)", async () => {
    const area = (await ensureArea(pool, "Finagai Test")).id;
    const unit = <T,>(fn: () => Promise<T>) => withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:tell_me_when" } }, fn);
    const r = await unit(() => addRule(pool, { statement: "tell me when a Finagai Test job reaches offer", event: "opportunity_status", area: "Finagai Test", status: "offer" })) as { rule: number };
    await unit(() => removeRule(pool, r.rule));
    const evs = await q(`SELECT action, area_id, before FROM event WHERE entity_type = 'watch_rule' ORDER BY id`);
    expect(evs.map((e) => [e.action, e.area_id])).toEqual([["watch_rule_added", area], ["watch_rule_removed", area]]);
    expect(evs[1].before).toEqual({ status: "active", removed_at: null });
  });

  it("the reliability report is derived from the stream and names what breaks the budget", async () => {
    const healthy = await reliabilityReport(pool, { days: 1 });
    expect(healthy).toEqual(expect.objectContaining({ verdict: "degraded" }));          // the failed weekly_review job above
    expect(healthy.why).toEqual(expect.arrayContaining([expect.stringMatching(/scheduled job weekly_review failed 1×/), expect.stringMatching(/self-check failed in \d+ of \d+ runs \(.*ordering/)]));
    expect(healthy.jobs).toEqual(expect.objectContaining({ daily_maintenance: { succeeded: 1 }, weekly_review: { failed: 1 } }));
    expect(healthy.selfCheck.runs).toBeGreaterThanOrEqual(4);
    // flapping: the same exception opening again and again is named
    for (let i = 0; i < 4; i++) await appendEvent(pool, { actor: "cos", action: "exception_opened", entityType: "operating_exception", entityId: randomUUID(), causeIds: [], before: null, after: { key: "watcher:testmail" } });
    // call_tool's routing record is not a failed call (Phase 8 live: 28/28 call_tool records counted as failures)
    for (let i = 0; i < 4; i++) await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "call_tool", routedTo: "tell_me_when" } });
    for (let i = 0; i < 4; i++) await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "tell_me_when", outcome: "ok" } });
    await publish(pool);
    const r = await reliabilityReport(pool, { days: 1 });
    expect(r.tools).toEqual(expect.objectContaining({ calls: 4, failed: 0, failureRate: 0 }));
    expect(r.exceptions.flapping).toEqual(["watcher:testmail: opened 4×"]);
    expect(r.loop.ticks).toBeGreaterThanOrEqual(5);
    expect(r.stream.unpublished).toBe(0);
  });
});
