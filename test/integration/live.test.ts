/**
 * ADR-087 — the Live State Stream on a FRESH database: ordered (even when commits arrive out of id order), resumable,
 * attributable (causal chains from the real-world input to the state change), safe (no secrets, read-only, authenticated),
 * and consistent with authoritative state (snapshot + replay agree).
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
import { appendEvent, PgDeliveryStore, withCause } from "../../src/db/index.js";
import { runTick } from "../../src/events/index.js";
import type { AreaModule } from "../../src/events/types.js";
import { liveHandler } from "../../src/live/http.js";
import { causalChain, history, publish, readAfter, snapshot, type LiveEvent } from "../../src/live/stream.js";
import type { EmailMessage, EmailSender } from "../../src/notify/delivery.js";
import { createHandler } from "../../src/server/app.js";
import { createLogger } from "../../src/server/log.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
let db: { appUrl: string; drop: () => Promise<void> } | undefined;
let pool: pg.Pool;
let careerId: string;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const all = async (after = 0): Promise<LiveEvent[]> => { await publish(pool); const out: LiveEvent[] = []; let c = after;
  for (;;) { const r = await readAfter(pool, c, {}, 200); if (r.reset) throw new Error(r.reason); out.push(...r.events); c = r.cursor; if (!r.more) return out; } };
const sent: EmailMessage[] = [];
const sender: EmailSender = { async send(m) { sent.push(m); return `m${sent.length}`; } };

// HTTP
let server: http.Server; let base = ""; let key: CryptoKey; let jwk: JWK;
const env = { NODE_ENV: "test", FINAGAI_PUBLIC_BASE_URL: "http://127.0.0.1", FINAGAI_MCP_RESOURCE_URL: "http://127.0.0.1/mcp", DATABASE_URL: "postgres://unused", ANTHROPIC_API_KEY: "unused",
  OAUTH_ISSUER: "https://auth.example.test", OAUTH_JWKS_URL: "https://auth.example.test/jwks", PRINCIPAL_SUBJECT: "user_julian_test", APPROVAL_CLIENT_ID: "c", APPROVAL_CLIENT_SECRET: "s",
  SESSION_SECRET: "x".repeat(40), RESEND_API_KEY: "r", NOTIFY_FROM: "Finagai <review@notify.example.test>", NOTIFY_TO: "julian@example.test", NOTIFY_REPLY_TO: "julian@example.test" };
const token = (sub = "user_julian_test") => new SignJWT({ client_id: "cc-test" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(env.OAUTH_ISSUER)
  .setAudience(`${base}/mcp`).setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(key);

describe.skipIf(!admin || !migT || !appT)("Live State Stream (ADR-087)", () => {
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_live_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    careerId = (await ensureArea(pool, "Career")).id;
    const pair = await generateKeyPair("ES256", { extractable: true }); key = pair.privateKey; jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
    server = http.createServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cfg = loadConfig({ ...env, FINAGAI_PUBLIC_BASE_URL: base, FINAGAI_MCP_RESOURCE_URL: `${base}/mcp` });
    server.on("request", createHandler(cfg, { version: "test", startedAt: new Date() }, createLogger(cfg, () => {}),
      { keys: createLocalJWKSet({ keys: [jwk] }), live: liveHandler(pool, { pollMs: 50, heartbeatMs: 200, maxStreamMs: 1500 }) }));
  }, 60_000);
  afterAll(async () => { server?.close(); await pool?.end(); await db?.drop(); });

  it("ordered and gap-free even when a lower event id commits AFTER a higher one", async () => {
    await all();                                                                     // drain anything from setup
    const before = (await q(`SELECT COALESCE(max(seq), 0) AS s FROM live_event`))[0].s;
    const slow = await pool.connect();
    await slow.query("BEGIN");
    const low = await appendEvent(slow, { actor: "cos", action: "project_completed", after: { name: "slow tx" } });   // id allocated first …
    const high = await appendEvent(pool, { actor: "cos", action: "project_reopened", after: { name: "fast tx" } });  // … committed first
    expect(high).toBeGreaterThan(low);
    const p1 = await all(Number(before));
    expect(p1.map((e) => e.eventId)).toEqual([high]);                                 // the in-flight one is not visible yet
    await slow.query("COMMIT"); slow.release();
    const p2 = await all(p1[0]!.seq);                                                 // resume from where the consumer stopped
    expect(p2.map((e) => e.eventId)).toEqual([low]);                                  // NOT lost although its id is lower
    expect(p2[0]!.seq).toBeGreaterThan(p1[0]!.seq);                                   // stream order = commit order
    const both = await all(Number(before));
    expect(both.map((e) => e.seq)).toEqual([...both.map((e) => e.seq)].sort((a, b) => a - b));
    expect(new Set(both.map((e) => e.seq)).size).toBe(both.length);
  });

  it("resumable and idempotent: any cursor continues exactly after itself; re-publishing changes nothing", async () => {
    for (let i = 0; i < 7; i++) await appendEvent(pool, { actor: "cos", action: "objective_set", areaId: careerId, after: { name: `o${i}` } });
    const full = await all();
    const mid = full[Math.floor(full.length / 2)]!.seq;
    const rest = await all(mid);
    expect(rest.map((e) => e.seq)).toEqual(full.filter((e) => e.seq > mid).map((e) => e.seq));
    const n = (await q(`SELECT count(*)::int AS n FROM live_event`))[0].n;
    expect((await publish(pool)).published).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM live_event`))[0].n).toBe(n);
  });

  it("a cursor older than the retained stream is told to re-snapshot (never silently skips)", async () => {
    const oldest = Number((await q(`SELECT min(seq) AS s FROM live_event`))[0].s);
    await q(`DELETE FROM live_event WHERE seq < $1`, [oldest + 3]);                  // simulate retention pruning
    const r = await readAfter(pool, oldest, {});
    expect(r).toEqual(expect.objectContaining({ reset: true, reason: expect.stringMatching(/take a new snapshot/) }));
  });

  it("attributable: real-world input → classified → workflow → state change → escalation → notification, one correlation, causal links", async () => {
    sent.length = 0;
    const mod: AreaModule = {
      watchers: [{ name: "testmail", everyMs: 0, async poll() { return { events: [{ source: "testmail", kind: "mail.received", externalId: "m-1", occurredAt: new Date().toISOString(), summary: "Altarum — final round", payload: { from: "Beth <beth@altarum.org>" } }], cursors: [], problems: [] }; } }],
      subscriptions: [{ id: "career.test", area: "Career", workflow: "career.test", async match() { return "job evidence"; } }],
      workflows: [{ name: "career.test", async run(ctx) {
        await appendEvent(ctx.pool, { actor: "cos", action: "opportunity_status", entityType: "opportunity", areaId: careerId, before: { status: "applied" }, after: { status: "interviewing", org: "Altarum" } });
        return { changes: ["Altarum → interviewing"], escalations: [{ key: "test:offer-call", needs: "judgment" as const, summary: "Altarum wants a call — your decision", areaId: careerId }] };
      } }],
    };
    const t = new Date("2026-10-12T15:00:00Z");                                        // 11:00 ET
    await runTick(pool, { now: t, dryRun: false }, { modules: [mod], exceptions: { budget: async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 }) },
      notify: { store: new PgDeliveryStore(pool), sender, timezone: "America/New_York" } }, "manual");
    const evs = await history(pool, { from: new Date(Date.now() - 60_000).toISOString() });
    const byAction = (a: string) => evs.filter((e) => e.action === a);
    const observed = byAction("evidence_observed")[0]!, routed = byAction("evidence_routed")[0]!, started = byAction("workflow_started").at(-1)!;
    const status = byAction("opportunity_status").at(-1)!, done = byAction("workflow_completed").at(-1)!, esc = byAction("escalation_opened").at(-1)!, told = byAction("notification_delivered").at(-1)!;
    expect(routed.cause.eventIds).toEqual([observed.eventId]);
    expect(started.cause.eventIds).toEqual([routed.eventId]);
    expect(status.cause.eventIds).toEqual([started.eventId]);                         // the state change knows what caused it
    expect(done.cause.eventIds).toEqual([started.eventId]);
    const corr = observed.cause.correlationId;
    expect(corr).toBeTruthy();
    for (const e of [routed, started, status, done, esc, told]) expect(e.cause.correlationId).toBe(corr);
    expect(routed.area).toEqual({ id: careerId, name: "Career" });
    expect(esc).toEqual(expect.objectContaining({ class: "escalation.opened", nextOwner: "julian" }));
    expect(told.class).toBe("notification.delivered");
    expect(status).toEqual(expect.objectContaining({ class: "entity.state_changed", before: { status: "applied" }, after: { status: "interviewing", org: "Altarum" } }));
    const chain = await causalChain(pool, status.eventId);
    expect(chain.map((e) => e.action)).toEqual(["evidence_observed", "evidence_routed", "workflow_started", "opportunity_status"]);
    expect(byAction("area_health_changed").map((e) => e.after)).toEqual([expect.objectContaining({ color: "green", area: "Career" })]);   // baseline recorded once
  });

  it("safe: secrets never leave, the principal is never exposed, human authorization is a boolean", async () => {
    await appendEvent(pool, { actor: "julian", action: "passkey_enrolled", after: { credentialId: "abc", publicKey: "zzz", accessToken: "secret-1", nested: { password: "hunter2", note: "Bearer abcdefghijklmnopqrstuvwxyz0123" }, jwt: "x", fine: "ok" }, principal: "user_julian_test" });
    const e = (await all()).find((x) => x.action === "passkey_enrolled")!;
    const text = JSON.stringify(e);
    expect(text).not.toMatch(/secret-1|hunter2|abcdefghijklmnopqrstuvwxyz0123|user_julian_test/);
    expect(e.after).toEqual(expect.objectContaining({ accessToken: "[redacted]", fine: "ok", nested: { password: "[redacted]", note: "[redacted]" } }));
    expect(e.humanAuthorized).toBe(false);
    expect(Object.keys(e)).not.toContain("principal");
  });

  it("consistent with authoritative state: replaying escalation events reproduces the snapshot's open set", async () => {
    await pool.query(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Dana', 'Dana Lee', 'waiting', now() - interval '1 day', 'julian')`, [careerId]);
    await runTick(pool, { now: new Date("2026-10-12T17:00:00Z"), dryRun: false }, { modules: [], exceptions: { budget: async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 }) } }, "manual");
    const snap = await snapshot(pool);
    const stream = await all();
    expect(stream.at(-1)!.seq).toBeGreaterThanOrEqual(snap.cursor);
    const open = new Map<string, boolean>();
    for (const e of stream.filter((x) => x.domain === "escalation")) { const k = String((e.after as { key: string }).key); open.set(k, e.verb === "opened"); }
    const replayed = [...open].filter(([, o]) => o).map(([k]) => k).sort();
    expect(replayed).toEqual(snap.needsJulian.map((n: { key: string }) => n.key).sort());
    expect(replayed.some((k) => k.startsWith("overdue:"))).toBe(true);           // the overdue wait became a need, in both views
    expect(replayed).toContain("test:offer-call");
  });

  it("filtering by Area and class; low-value bursts are coalesced with a count", async () => {
    for (let i = 0; i < 6; i++) await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", reason: "pipeline", after: { tool: "pipeline", outcome: "ok" } });
    await publish(pool);
    const oldest = Number((await q(`SELECT min(seq) AS s FROM live_event`))[0].s);
    const r = await readAfter(pool, oldest - 1, { classes: ["escalation"], area: "Career" }, 2000);
    expect(r.reset).toBe(false);
    if (!r.reset) { expect(r.events.length).toBeGreaterThan(0); expect(r.events.every((e) => e.domain === "escalation" && e.area?.name === "Career")).toBe(true); }
    const res = await fetch(`${base}/live/events?after=${oldest - 1}&class=tool&limit=2000`, { headers: { authorization: `Bearer ${await token()}` } });
    const body = await res.json() as { events: Array<LiveEvent & { coalesced?: { count: number } }> };
    expect(body.events.find((e) => e.coalesced)?.coalesced?.count).toBe(6);
  });

  it("HTTP: authenticated, GET-only, SSE resumable with Last-Event-ID; viewing changes nothing", async () => {
    expect((await fetch(`${base}/live/snapshot`)).status).toBe(401);                 // no token
    expect((await fetch(`${base}/live/snapshot`, { headers: { authorization: `Bearer ${await token("user_someone_else")}` } })).status).toBe(401);
    const auth = { authorization: `Bearer ${await token()}` };
    expect((await fetch(`${base}/live/snapshot`, { method: "POST", headers: auth })).status).toBe(405);
    const counts = async () => (await q(`SELECT (SELECT count(*) FROM event)::int AS e, (SELECT count(*) FROM escalation)::int AS x, (SELECT count(*) FROM followup)::int AS f`))[0];
    await publish(pool);
    const c0 = await counts();
    const snap = await (await fetch(`${base}/live/snapshot?area=Career`, { headers: auth })).json() as { cursor: number; areas: Array<{ name: string }> };
    expect(snap.areas.map((a) => a.name)).toEqual(["Career"]);
    // SSE from an earlier cursor, then resume with Last-Event-ID
    const from = Math.max(0, snap.cursor - 3);
    const text = await (await fetch(`${base}/live/stream?after=${from}`, { headers: auth })).text();     // server ends after maxStreamMs
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBeGreaterThan(from);
    const last = ids.at(-1)!;
    const resumed = await (await fetch(`${base}/live/stream`, { headers: { ...auth, "last-event-id": String(last) } })).text();
    expect([...resumed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])).every((i) => i > last)).toBe(true);
    expect(await counts()).toEqual(c0);                                               // observing wrote no operational state
    const contract = await (await fetch(`${base}/live/contract`, { headers: auth })).json() as { v: number; safety: string };
    expect(contract.v).toBe(1); expect(contract.safety).toMatch(/read-only/);
  });

  it("a preview tick (dry run) leaves no trace in the stream", async () => {
    await publish(pool);
    const n = (await q(`SELECT count(*)::int AS n FROM event`))[0].n;
    const mod: AreaModule = { watchers: [{ name: "testmail2", everyMs: 0, async poll() { return { events: [{ source: "testmail2", kind: "mail.received", externalId: "p-1", occurredAt: new Date().toISOString(), summary: "preview only", payload: {} }], cursors: [], problems: [] }; } }], subscriptions: [], workflows: [] };
    await runTick(pool, { now: new Date(), dryRun: true }, { modules: [mod] }, "preview");
    expect((await q(`SELECT count(*)::int AS n FROM event`))[0].n).toBe(n);
  });

  it("withCause nests: inner work keeps the outer correlation and records its own cause", async () => {
    await withCause({ correlationId: "11111111-1111-4111-8111-111111111111" }, async () => {
      const a = await appendEvent(pool, { actor: "cos", action: "workflow_started", after: { workflow: "outer" } });
      await withCause({ causeIds: [a] }, async () => { await appendEvent(pool, { actor: "cos", action: "workflow_completed", after: { workflow: "outer" } }); });
    });
    const rows = await q(`SELECT action, correlation_id, cause_ids FROM event WHERE correlation_id = '11111111-1111-4111-8111-111111111111' ORDER BY id`);
    expect(rows.map((r) => r.action)).toEqual(["workflow_started", "workflow_completed"]);
    expect(rows[1].cause_ids.map(Number)).toEqual([Number((await q(`SELECT id FROM event WHERE correlation_id = '11111111-1111-4111-8111-111111111111' AND action = 'workflow_started'`))[0].id)]);
  });
});
