/**
 * ADR-089 slice 0 — the read-only Core enablement for the Command Center:
 *   - the snapshot carries what Command must not infer: an Area's verdict (as Finagai computes it) and whether it is
 *     internal, who owns each wait's next step, and what each open decision is about;
 *   - history filters BEFORE its limit and pages newest-first;
 *   - /live/summary/reliability serves the Phase 8 report;
 *   - repeated reads of every endpoint write ZERO semantic events and change ZERO business rows.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { materialize } from "../../eval/runner/j3cases.js";
import { loadConfig } from "../../src/config/index.js";
import { ensureArea } from "../../src/cos/operating.js";
import { sweepOverdue } from "../../src/cos/followups.js";
import { appendEvent } from "../../src/db/index.js";
import { runTick } from "../../src/events/index.js";
import type { AreaModule } from "../../src/events/types.js";
import { liveHandler } from "../../src/live/http.js";
import { publish } from "../../src/live/stream.js";
import { createHandler } from "../../src/server/app.js";
import { createLogger } from "../../src/server/log.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
let db: Awaited<ReturnType<typeof materialize>>; let pool: pg.Pool;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
let server: http.Server; let base = ""; let key: CryptoKey; let jwk: JWK;
const env = { NODE_ENV: "test", FINAGAI_PUBLIC_BASE_URL: "http://127.0.0.1", FINAGAI_MCP_RESOURCE_URL: "http://127.0.0.1/mcp", DATABASE_URL: "postgres://unused", ANTHROPIC_API_KEY: "unused",
  OAUTH_ISSUER: "https://auth.example.test", OAUTH_JWKS_URL: "https://auth.example.test/jwks", PRINCIPAL_SUBJECT: "user_julian_test", APPROVAL_CLIENT_ID: "c", APPROVAL_CLIENT_SECRET: "s",
  SESSION_SECRET: "x".repeat(40), RESEND_API_KEY: "r", NOTIFY_FROM: "Finagai <review@notify.example.test>", NOTIFY_TO: "julian@example.test", NOTIFY_REPLY_TO: "julian@example.test" };
const token = () => new SignJWT({ client_id: "command-center-test" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(env.OAUTH_ISSUER)
  .setAudience(`${base}/mcp`).setSubject("user_julian_test").setIssuedAt().setExpirationTime("5m").sign(key);
const get = async (path: string) => { const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${await token()}` } }); return { status: r.status, body: await r.json() as any }; };
const empty: AreaModule = { watchers: [], subscriptions: [], workflows: [] };

/** Every business table's content, as one fingerprint (the event table and the stream index are counted separately). */
async function businessFingerprint() {
  const tables = ["area", "objective", "project", "opportunity", "opportunity_event", "followup", "escalation", "operating_exception", "lesson", "watch_rule", "control_task", "event_tick", "inbound_event"];
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = (await q(`SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`))[0].h;
  return out;
}

describe.skipIf(!admin || !migT || !appT)("Command Center reads (ADR-089 slice 0)", () => {
  let career: string; let test: string; let overdueWait: string; let unswept: string; let finagaiWait: string; let offerWait: string;
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_ccr_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    career = (await ensureArea(pool, "Career")).id;
    test = (await ensureArea(pool, "Finagai Test")).id;
    // Julian's own wait, past due (the engine escalates it as principal-reserved); a wait Finagai watches; an offer step (Julian's by rule)
    overdueWait = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Beth Young', 'Beth Young', 'waiting', now() - interval '1 hour', 'julian') RETURNING id`, [career]))[0].id;
    finagaiWait = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin, rule) VALUES ($1, 'Waiting on Chimes to respond', 'Chimes', 'waiting', now() + interval '5 days', 'lifecycle', 'applied.awaiting_response') RETURNING id`, [career]))[0].id;
    offerWait = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin, rule) VALUES ($1, 'Respond to the Acme offer', 'Acme', 'open', now() + interval '3 days', 'lifecycle', 'offer.respond') RETURNING id`, [career]))[0].id;
    await sweepOverdue(pool);                                                       // what the engine's deadline check does
    await runTick(pool, { now: new Date(), dryRun: false }, { modules: [empty], exceptions: { budget: async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 }) } }, "manual");
    // a wait that passed its date AFTER the last sweep: reads must never sweep it
    unswept = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Dana', 'Dana', 'waiting', now() - interval '1 minute', 'julian') RETURNING id`, [career]))[0].id;
    // a workflow judgment about an opportunity (subject in the key)
    const opp = (await q(`INSERT INTO opportunity (kind, area_id, org, title, status, source, dedupe_key) VALUES ('job', $1, 'Vallum', 'Analyst', 'rejected', 'test', 'vallum|analyst') RETURNING id`, [career]))[0].id;
    await q(`INSERT INTO escalation (key, area_id, needs, summary) VALUES ($1, $2, 'judgment', 'Career: Vallum evidence after rejection')`, [`career.sync:abc@opportunity:${opp}`, career]);
    // lots of unrelated low-value traffic, then a few events about one entity, then more traffic
    for (let i = 0; i < 700; i++) await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "x", outcome: "ok" } });
    for (let i = 0; i < 3; i++) await appendEvent(pool, { actor: "cos", action: "followup_updated", entityType: "followup", entityId: finagaiWait, areaId: career, before: { due_at: `d${i}` }, after: { due_at: `d${i + 1}` } });
    for (let i = 0; i < 700; i++) await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "y", outcome: "ok" } });
    await publish(pool);
    const pair = await generateKeyPair("ES256", { extractable: true }); key = pair.privateKey; jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
    server = http.createServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cfg = loadConfig({ ...env, FINAGAI_PUBLIC_BASE_URL: base, FINAGAI_MCP_RESOURCE_URL: `${base}/mcp` });
    server.on("request", createHandler(cfg, { version: "test", startedAt: new Date() }, createLogger(cfg, () => {}),
      { keys: createLocalJWKSet({ keys: [jwk] }), live: liveHandler(pool, { pollMs: 50, heartbeatMs: 200, maxStreamMs: 500 }) }));
  }, 120_000);
  afterAll(async () => { server?.close(); await pool?.end(); await db?.drop(); });

  it("the snapshot carries each Area's own verdict, the internal flag, wait ownership and each decision's subject", async () => {
    const { status, body: s } = await get("/live/snapshot");
    expect(status).toBe(200);
    expect(s.v).toBe(2);
    const areas = Object.fromEntries(s.areas.map((a: any) => [a.name, a]));
    expect(areas["Finagai Test"].internal).toBe(true);
    expect(areas.Career.internal).toBe(false);
    expect(areas.Career.health.color).toBe("red");                                   // the overdue wait (same verdict as area_status)
    expect(areas.Career.health.breaches.join(" ")).toMatch(/overdue/);
    const waits = Object.fromEntries(s.waits.map((w: any) => [w.id, w]));
    expect(waits[overdueWait]).toEqual(expect.objectContaining({ owner: "julian", escalated: true }));
    expect(waits[finagaiWait]).toEqual(expect.objectContaining({ owner: "finagai", escalated: false }));
    expect(waits[offerWait]).toEqual(expect.objectContaining({ owner: "julian" }));     // by the lifecycle rule, escalated or not
    const subjects = s.needsJulian.map((n: any) => n.subject?.type).sort();
    expect(subjects).toEqual(expect.arrayContaining(["opportunity", "followup"]));
    expect(s.needsJulian.find((n: any) => n.key.startsWith("career.sync:")).subject).toEqual({ type: "opportunity", id: expect.any(String) });
  });

  it("history filters before its limit and pages newest-first", async () => {
    // the 3 events about the wait sit between 1,400 unrelated ones: an entity filter must still find them
    const asc = (await get(`/live/history?entityType=followup&entityId=${finagaiWait}&limit=2`)).body.events;
    expect(asc.map((e: any) => e.after.due_at)).toEqual(["d1", "d2"]);
    const desc = (await get(`/live/history?entityType=followup&entityId=${finagaiWait}&limit=2&order=desc`)).body.events;
    expect(desc.map((e: any) => e.after.due_at)).toEqual(["d3", "d2"]);
    const next = (await get(`/live/history?entityType=followup&entityId=${finagaiWait}&limit=2&order=desc&before=${desc[1].eventId}`)).body.events;
    expect(next.map((e: any) => e.after.due_at)).toEqual(["d1"]);
    // a class filter is applied before the limit too (newest tool calls are not "wait" events)
    const waits = (await get(`/live/history?class=wait&limit=3&order=desc`)).body.events;
    expect(waits.length).toBe(3);
    expect(waits.every((e: any) => e.domain === "wait")).toBe(true);
    // newest-first without filters starts at the newest event
    const latest = (await get(`/live/history?limit=1&order=desc`)).body.events[0];
    expect(latest.eventId).toBe(Number((await q(`SELECT max(id) AS m FROM event`))[0].m));
  });

  it("serves the Phase 8 reliability report", async () => {
    const r = (await get("/live/summary/reliability?days=1")).body;
    expect(r).toEqual(expect.objectContaining({ verdict: expect.stringMatching(/healthy|degraded/), why: expect.any(Array), failures: expect.any(Object) }));
    const since = (await get(`/live/summary/reliability?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).body;
    expect(new Date(since.window.from).getTime()).toBeGreaterThan(Date.now() - 120_000);
  });

  it("repeated reads of every endpoint write ZERO semantic events and change ZERO business rows", async () => {
    await publish(pool);
    const events = Number((await q(`SELECT count(*)::int AS n FROM event`))[0].n);
    const fp = await businessFingerprint();
    const seq = Number((await q(`SELECT COALESCE(max(seq), 0) AS s FROM live_event`))[0].s);
    for (let i = 0; i < 10; i++) {
      for (const p of ["/live/snapshot", "/live/snapshot?area=Career", "/live/contract", `/live/events?after=${seq - 5}`, "/live/history?limit=50&order=desc",
        `/live/history?entityType=followup&entityId=${finagaiWait}`, "/live/summary/reliability?days=1", "/live/summary/reliability?days=7"]) expect((await get(p)).status).toBe(200);
      await (await fetch(`${base}/live/stream?after=${seq}`, { headers: { authorization: `Bearer ${await token()}` } })).text();
    }
    expect(Number((await q(`SELECT count(*)::int AS n FROM event`))[0].n)).toBe(events);
    expect(await businessFingerprint()).toEqual(fp);
    // the overdue wait was NOT swept by any read (the snapshot's verdict is computed without the sweep)
    expect((await q(`SELECT state FROM followup WHERE id = $1`, [unswept]))[0].state).toBe("waiting");
  }, 120_000);
});
