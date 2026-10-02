/**
 * Runs against a real Postgres with all migrations applied, connected as finagai_app.
 * Skipped unless INTEGRATION_DATABASE_URL is set (scripts/test-integration.sh sets it).
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  appendEvent, createPool, getUnassignedProject, PgDeliveryStore, PgJobLedger, PgLlmCallRecorder, withTransaction,
} from "../../src/db/index.js";
import { deliverOnce } from "../../src/notify/delivery.js";
import { dispatch } from "../../src/jobs/dispatcher.js";
import { placeholderHandlers } from "../../src/jobs/handlers.js";
import { MeteredModelClient } from "../../src/llm/metered.js";
import type { ModelProvider } from "../../src/llm/types.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;
afterAll(async () => { await pool?.end(); });

describe.skipIf(!url)("database layer against Schema v0 (as finagai_app)", () => {
  it("finds the Unassigned holding project from migration 0004", async () => {
    const p = await getUnassignedProject(pool!);
    expect(p.is_unassigned_holding).toBe(true);
    expect(p.name).toBe("Unassigned");
  });

  it("writes a project and its event in one transaction", async () => {
    const id = await withTransaction(pool!, async (tx) => {
      const p = await tx.query<{ id: string }>(`INSERT INTO project (name) VALUES ('Integration test project') RETURNING id`);
      const projectId = p.rows[0]!.id;
      const eventId = await appendEvent(tx, { actor: "j2", action: "create", entityType: "project", entityId: projectId, after: { name: "Integration test project" } });
      await tx.query(`UPDATE project SET last_event_id = $2 WHERE id = $1`, [projectId, eventId]);
      return projectId;
    });
    const row = await pool!.query(`SELECT last_event_id FROM project WHERE id = $1`, [id]);
    expect(row.rows[0].last_event_id).not.toBeNull();
  });

  it("rolls back the domain write when the event write fails", async () => {
    await expect(withTransaction(pool!, async (tx) => {
      await tx.query(`INSERT INTO project (name) VALUES ('Must not persist')`);
      await appendEvent(tx, { actor: "julian", action: "approve", approvalId: "00000000-0000-0000-0000-000000000001" }); // no principal
    })).rejects.toThrow(/ck_event_approval_has_principal/);
    const r = await pool!.query(`SELECT count(*)::int AS n FROM project WHERE name = 'Must not persist'`);
    expect(r.rows[0].n).toBe(0);
  });

  it("cannot edit or delete events through the app role", async () => {
    await expect(pool!.query(`UPDATE event SET reason = 'tamper'`)).rejects.toThrow(/permission denied/);
    await expect(pool!.query(`DELETE FROM event`)).rejects.toThrow(/permission denied/);
  });

  it("ADR-033: an active lease blocks other ticks; an expired lease is reclaimed as the next attempt", async () => {
    const ledger = new PgJobLedger(pool!);
    const at = new Date("2026-03-09T11:00:00Z");
    const a = await ledger.claim("weekly_review", at, "owner-A", 400); // A crashes after claiming
    expect(a).toMatchObject({ attempt: 1 });
    expect(await ledger.claim("weekly_review", at, "owner-B", 400)).toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    const b = await ledger.claim("weekly_review", at, "owner-B", 60_000);
    expect(b).toMatchObject({ runId: a!.runId, attempt: 2 });
    expect(await ledger.finish(a!.runId, "owner-A", { status: "failed", detail: "stale" })).toBe(false);
    expect(await ledger.finish(b!.runId, "owner-B", { status: "succeeded" })).toBe(true);
    expect(await ledger.claim("weekly_review", at, "owner-C", 60_000)).toBeNull(); // complete slots never rerun
  });

  it("ADR-033: concurrent claims of one slot yield exactly one lease", async () => {
    const ledger = new PgJobLedger(pool!);
    const at = new Date("2026-03-16T11:00:00Z");
    const results = await Promise.all(["A", "B", "C", "D"].map((o) => ledger.claim("weekly_review", at, o, 60_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("ADR-033: failed attempts retry up to max_attempts, then stay failed", async () => {
    const ledger = new PgJobLedger(pool!);
    const at = new Date("2026-03-23T11:00:00Z");
    for (let i = 1; i <= 3; i++) {
      const c = await ledger.claim("weekly_review", at, `o${i}`, 60_000);
      expect(c?.attempt).toBe(i);
      await ledger.finish(c!.runId, `o${i}`, { status: "failed", detail: "boom" });
    }
    expect(await ledger.claim("weekly_review", at, "o4", 60_000)).toBeNull();
  });

  it("ADR-033: an expired lease at max attempts becomes a terminal failure", async () => {
    const ledger = new PgJobLedger(pool!);
    const at = new Date("2026-03-30T11:00:00Z");
    for (let i = 1; i <= 3; i++) {
      const c = await ledger.claim("weekly_review", at, `o${i}`, 100);
      expect(c?.attempt).toBe(i);
      await new Promise((r) => setTimeout(r, 150)); // each attempt "crashes"
    }
    expect(await ledger.claim("weekly_review", at, "o4", 100)).toBeNull();
    const r = await pool!.query(`SELECT status, error FROM job_run WHERE job = 'weekly_review' AND scheduled_for = $1`, [at]);
    expect(r.rows[0]).toEqual({ status: "failed", error: "lease expired at max attempts" });
  });

  it("dispatches through the real ledger once per slot", async () => {
    const deps = { cfg: { FINAGAI_TIMEZONE: "America/New_York", WEEKLY_REVIEW_DAY: 1, WEEKLY_REVIEW_TIME: "07:00", MISSED_RUN_CHECK_TIME: "09:00" },
      handlers: placeholderHandlers(), log: () => {}, openLedger: async () => new PgJobLedger(pool!) };
    const a = await dispatch(new Date("2026-11-02T12:00:00Z"), deps);
    const b = await dispatch(new Date("2026-11-02T12:15:00Z"), deps);
    expect(a.ran.map((r) => r.job)).toContain("weekly_review");
    expect(b.notClaimed).toContain("weekly_review");
  });

  it("ADR-033: the Postgres delivery ledger sends a key once, refuses mutated payloads, and wins races", async () => {
    const store = new PgDeliveryStore(pool!);
    const sent: string[] = [];
    const sender = { async send(_m: unknown, key: string) { await new Promise((r) => setTimeout(r, 20)); sent.push(key); return "provider-1"; } };
    const msg = { subject: "s", text: "t" };
    const results = await Promise.all(Array.from({ length: 6 }, () => deliverOnce(store, sender, "review-email:it-race", "weekly_review", msg)));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(await deliverOnce(store, sender, "review-email:it-race", "weekly_review", msg)).toBe("already_sent");
    await expect(deliverOnce(store, sender, "review-email:it-race", "weekly_review", { ...msg, text: "changed" })).rejects.toThrow(/blocked/);
    expect(sent).toEqual(["review-email:it-race"]);
  });

  it("ADR-033: a stale delivery worker cannot mutate a reclaimed delivery (Postgres)", async () => {
    const store = new PgDeliveryStore(pool!);
    const k = "review-email:it-stale-token";
    const a = await store.claim(k, "weekly_review", "hash-1", 100, 72_000_000);
    expect(a.kind).toBe("claimed");
    await new Promise((r) => setTimeout(r, 150));
    const b = await store.claim(k, "weekly_review", "hash-1", 60_000, 72_000_000);
    expect(b.kind).toBe("claimed");
    const ta = (a as { token: string }).token, tb = (b as { token: string }).token;
    expect(tb).not.toBe(ta);
    expect(await store.markSent(k, ta, "late")).toBe(false);
    expect(await store.markFailed(k, ta, "late")).toBe(false);
    expect(await store.markConflict(k, ta, "late")).toBe(false);
    expect((await pool!.query(`SELECT status FROM outbound_delivery WHERE idempotency_key = $1`, [k])).rows[0].status).toBe("sending");
    expect(await store.markSent(k, tb, "provider-B")).toBe(true);
    const row = (await pool!.query(`SELECT status, provider_message_id, sending_token FROM outbound_delivery WHERE idempotency_key = $1`, [k])).rows[0];
    expect(row).toEqual({ status: "sent", provider_message_id: "provider-B", sending_token: null });
  });

  it("ADR-034: meters model calls and settles reservations to actual cost", async () => {
    const rec = new PgLlmCallRecorder(pool!, "America/New_York");
    const provider: ModelProvider = { async send() {
      return { text: "ok", model: "claude-sonnet-5-5", stopReason: "end_turn",
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    } };
    const before = await rec.monthToDateUsd(new Date());
    const client = new MeteredModelClient(provider, rec, { limits: { targetUsd: 30, ceilingUsd: 36 } });
    await client.complete({ pipeline: "j2", step: "extract", purpose: "capture", model: "claude-sonnet-5-5",
      promptVersion: "it-1", system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 10 });
    expect((await rec.monthToDateUsd(new Date())) - before).toBeCloseTo(2, 6); // 1M input tokens x $2/M
    const rows = await pool!.query(`SELECT status, cost_usd::float AS cost, reserved_usd::float AS reserved FROM llm_call WHERE prompt_version = 'it-1'`);
    expect(rows.rows[0]).toEqual({ status: "ok", cost: 2, reserved: 0 });
  });

  /**
   * Concurrency at both boundaries. The month's real spend is shifted by a synthetic offset so the
   * test can place committed spend just under $30 or $36 regardless of earlier tests.
   */
  async function raceAt(boundary: "target" | "ceiling", purpose: "shadow" | "capture" | "weekly_review") {
    const rec = new PgLlmCallRecorder(pool!, "America/New_York");
    const spent = await rec.monthToDateUsd(new Date());
    const reservedUsd = 0.25;
    const limits = { targetUsd: 30, ceilingUsd: 36 };
    const edge = boundary === "target" ? limits.targetUsd : limits.ceilingUsd;
    // Seed committed spend so exactly 5 reservations fit under the boundary.
    const seed = edge - spent - 5 * reservedUsd - 0.01;
    await pool!.query(
      `INSERT INTO llm_call (pipeline, step, model, prompt_version, purpose, status, cost_usd)
       VALUES ('j2', 'seed-offset', 'claude-sonnet-5-5', $1, 'capture', 'ok', $2)`, [`offset-${boundary}`, seed]);
    const results = await Promise.all(Array.from({ length: 25 }, () => rec.reserve({
      pipeline: "j3", step: "compose", model: "claude-opus-5-5", promptVersion: `race-${boundary}-${purpose}`,
      purpose, reservedUsd, limits, now: new Date() })));
    const after = await rec.monthToDateUsd(new Date());
    // Remove the synthetic offset and reservations so later tests start from a known state.
    await pool!.query(`UPDATE llm_call SET status = 'ok', cost_usd = 0, reserved_usd = 0
                        WHERE prompt_version IN ($1, $2)`, [`offset-${boundary}`, `race-${boundary}-${purpose}`]);
    return { allowed: results.filter((r) => r.allowed).length, after, edge };
  }

  it("ADR-034: 25 concurrent shadow reservations never cross the $30 target", async () => {
    const r = await raceAt("target", "shadow");
    expect(r.allowed).toBe(5); // exactly the 5 that fit strictly below the target
    expect(r.after).toBeLessThan(r.edge);
  });

  it("ADR-034: 25 concurrent capture reservations never cross the $36 hard ceiling", async () => {
    const r = await raceAt("ceiling", "capture");
    expect(r.allowed).toBe(5);
    expect(r.after).toBeLessThanOrEqual(r.edge);
  });

  it("ADR-034: the weekly review is not exempt from the $36 hard ceiling under concurrency", async () => {
    const r = await raceAt("ceiling", "weekly_review");
    expect(r.allowed).toBe(5);
    expect(r.after).toBeLessThanOrEqual(r.edge);
  });
});
