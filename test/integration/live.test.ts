/**
 * ADR-087 — the Live State Stream on a FRESH database: ordered (even when commits arrive out of id order), resumable,
 * attributable (causal chains from the real-world input to the state change), safe (no secrets, read-only, authenticated),
 * and consistent with authoritative state (snapshot + replay agree).
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
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
import { liveAcceptance } from "../../src/live/acceptance.js";
import { lifecycleTick, recordOnJob, trackOpportunity } from "../../src/cos/opportunities.js";
import { closeFollowup, markWaiting, sweepOverdue } from "../../src/cos/followups.js";
import { recordTransition, rowState } from "../../src/db/state-events.js";
import { isOwnMail } from "../../src/events/engine.js";
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

  it("a cursor older than the stream window is told to re-snapshot (never silently skips)", async () => {
    const b = (await q(`SELECT min(seq) AS lo, max(seq) AS hi FROM live_event`))[0];
    const later = new Date(Date.now() + 31 * 86_400_000);                           // everything published so far is now outside the window
    const r = await readAfter(pool, Number(b.lo), {}, 500, later);
    expect(r).toEqual(expect.objectContaining({ reset: true, reason: expect.stringMatching(/take a new snapshot/) }));
    expect((await readAfter(pool, Number(b.hi), {}, 500, later)).reset).toBe(false);   // a cursor at the head is still fine
  });

  it("archive-only invariant: the app role holds no DELETE privilege anywhere (Core's preflight refuses to start otherwise)", async () => {
    const del = (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'finagai' AND c.relkind = 'r' AND has_table_privilege(current_user, c.oid, 'DELETE')`)).map((r) => r.relname);
    expect(del).toEqual([]);
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
    // the escalation is caused by the workflow run that raised it, the notification by the escalations it carried
    expect(esc.cause.eventIds).toEqual([done.eventId]);
    expect(told.cause.eventIds).toContain(esc.eventId);
    expect((await causalChain(pool, told.eventId)).map((e) => e.action))
      .toEqual(expect.arrayContaining(["evidence_observed", "evidence_routed", "workflow_started", "workflow_completed", "escalation_opened", "notification_delivered"]));
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

  // ------------------------------------------------------------------------------------------------ hotfix 34
  let since34 = new Date();
  it("hotfix 34 — the Vantage case: a real-shaped email that reschedules a follow-up emits that transition, with object, before/after, unit of work and cause", async () => {
    since34 = new Date(Date.now() - 1000);
    const T0 = new Date("2026-10-01T15:00:00Z"), T1 = new Date("2026-10-12T14:40:00Z");
    // production calls arrive as a unit of work (a tool call); the test does the same
    const asTool = <T,>(name: string, fn: () => Promise<T>) => withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: `tool:${name}` } }, fn);
    const tracked = await asTool("track_opportunity", () => trackOpportunity(pool, { employer: "Vantage Network", title: "Staff Accountant", status: "applied", at: T0.toISOString(), source: "julian" }, T0)) as { jobId: string };
    const f0 = (await q(`SELECT id, due_at FROM followup WHERE opportunity_id = $1 AND state IN ('open','waiting')`, [tracked.jobId]))[0];
    expect(f0).toBeTruthy();
    const mod: AreaModule = {
      watchers: [{ name: "gmail", everyMs: 0, async poll() { return { events: [{ source: "gmail", kind: "mail.received", externalId: "acct:m-vantage-viewed", occurredAt: T1.toISOString(),
        summary: "LinkedIn — Your application was viewed by Vantage Network", payload: { from: "LinkedIn <jobs-noreply@linkedin.com>" } }], cursors: [], problems: [] }; } }],
      subscriptions: [{ id: "career.viewed", area: "Career", workflow: "career.viewed", async match() { return "job evidence (viewed — Vantage Network)"; } }],
      workflows: [{ name: "career.viewed", async run(ctx) {
        await recordOnJob(ctx.pool, tracked.jobId, { kind: "application", at: T1, source: "gmail", sourceId: "gmail:m-vantage-viewed", summary: "Your application was viewed by Vantage Network" }, ctx.now);
        return { changes: ["Vantage viewed"], escalations: [{ key: "test:vantage-call", needs: "judgment" as const, summary: "Vantage asked for a call — your decision", areaId: careerId }] };
      } }],
    };
    sent.length = 0;
    await runTick(pool, { now: T1, dryRun: false }, { modules: [mod], exceptions: { budget: async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 }) },
      notify: { store: new PgDeliveryStore(pool), sender, timezone: "America/New_York" } }, "manual");
    const evs = await history(pool, { from: since34.toISOString() });
    const one = (a: string, pred: (e: LiveEvent) => boolean = () => true) => evs.filter((e) => e.action === a && pred(e)).at(-1)!;
    const observed = one("evidence_observed", (e) => (e.after as { summary: string }).summary.includes("Vantage"));
    const routed = one("evidence_routed", (e) => e.cause.eventIds.includes(observed.eventId));
    const started = one("workflow_started", (e) => e.cause.eventIds.includes(routed.eventId));
    const corr = observed.cause.correlationId;
    // the follow-up moved: its own event, the object, the due date before and after, the tick, the workflow run as cause
    const moved = one("followup_updated");
    expect(moved).toEqual(expect.objectContaining({ class: "wait.updated", entity: { type: "followup", id: f0.id } }));
    expect(new Date((moved.before as { due_at: string }).due_at).toISOString()).toBe(new Date(f0.due_at).toISOString());
    expect((moved.after as { due_at: string }).due_at.slice(0, 10)).toBe("2026-10-26");
    expect(moved.cause).toEqual(expect.objectContaining({ correlationId: corr, eventIds: [started.eventId] }));
    expect(moved.area).toEqual({ id: careerId, name: "Career" });
    // the new piece of job history: its own event about the job
    const hist = one("opportunity_evidence_added");
    expect(hist).toEqual(expect.objectContaining({ class: "evidence.attached", entity: { type: "opportunity", id: tracked.jobId } }));
    expect(hist.after).toEqual(expect.objectContaining({ kind: "application", transition: null }));
    expect(hist.cause.eventIds).toEqual([started.eventId]);
    // only the evidence date moved on the job itself (not a semantic field): no extra job event, and nothing silent (see acceptance)
    // escalation -> notification, causally linked
    const done = one("workflow_completed", (e) => e.cause.eventIds.includes(started.eventId));
    const esc = one("escalation_opened", (e) => (e.after as { key: string }).key === "test:vantage-call");
    const told = one("notification_delivered", (e) => e.cause.eventIds.includes(esc.eventId));
    expect(esc.cause.eventIds).toEqual([done.eventId]);
    expect(told).toBeTruthy();
    expect(one("escalation_notified", (e) => e.entity.id === esc.entity.id).cause.eventIds).toEqual([told.eventId]);
    expect(sent.length).toBe(1);
  });

  it("hotfix 34 — a follow-up passing its date is its own event (before → after, cites the follow-up's previous event)", async () => {
    const unit = <T,>(fn: () => Promise<T>) => withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:track_waiting" } }, fn);
    const f = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Lee', 'Lee', 'waiting', now() - interval '1 hour', 'julian') RETURNING id`, [careerId]))[0];
    const created = await unit(() => appendEvent(pool, { actor: "julian", action: "followup_created", entityType: "followup", entityId: f.id, after: { summary: "Waiting on Lee", state: "waiting" } }));
    await unit(() => sweepOverdue(pool));
    const ev = (await history(pool, { from: since34.toISOString() })).filter((e) => e.action === "followup_overdue" && e.entity.id === f.id).at(-1)!;
    expect(ev).toEqual(expect.objectContaining({ class: "wait.expired", before: { state: "waiting" }, after: expect.objectContaining({ state: "overdue" }) }));
    // cause: the unit of work that swept it (a tool call here; the engine's workflow run in production)
    const [cause] = ev.cause.eventIds;
    expect((await q(`SELECT action, after->>'what' AS what FROM event WHERE id = $1`, [cause]))[0]).toEqual({ action: "work_invoked", what: "tool:track_waiting" });
    expect(cause).toBeGreaterThan(created);
  });

  it("hotfix 34 — a held (quiet-hours) notification cites the escalation it holds", async () => {
    const mod: AreaModule = { watchers: [], subscriptions: [], workflows: [] };
    const kim = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Kim', 'Kim', 'waiting', now() - interval '2 days', 'julian') RETURNING id`, [careerId]))[0];
    await withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:track_waiting" } },
      () => appendEvent(pool, { actor: "julian", action: "followup_created", entityType: "followup", entityId: kim.id, after: { summary: "Waiting on Kim", state: "waiting" } }));
    await runTick(pool, { now: new Date("2026-10-13T03:00:00Z"), dryRun: false }, { modules: [mod], exceptions: { budget: async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 }) },
      notify: { store: new PgDeliveryStore(pool), sender, timezone: "America/New_York" } }, "manual");     // 23:00 ET
    const evs = await history(pool, { from: since34.toISOString() });
    const held = evs.filter((e) => e.action === "notification_suppressed").at(-1)!;
    const escIds = evs.filter((e) => e.action === "escalation_opened").map((e) => e.eventId);
    expect(held.after).toEqual(expect.objectContaining({ reason: "quiet hours" }));
    expect(held.cause.eventIds.some((id) => escIds.includes(id))).toBe(true);
  });

  it("hotfix 34 — Finagai's own outgoing mail is observed but never routed as evidence", async () => {
    process.env.NOTIFY_FROM = "Finagai <review@notify.example.test>";
    expect(isOwnMail({ from: "Finagai <review@notify.example.test>" })).toBe(true);
    expect(isOwnMail({ from: "LinkedIn <jobs-noreply@linkedin.com>" })).toBe(false);
    const mod: AreaModule = {
      watchers: [{ name: "gmail", everyMs: 0, async poll() { return { events: [{ source: "gmail", kind: "mail.received", externalId: "acct:m-own-review", occurredAt: new Date().toISOString(),
        summary: "Finagai — Finagai weekly review", payload: { from: "Finagai <review@notify.example.test>" } }], cursors: [], problems: [] }; } }],
      subscriptions: [{ id: "career.all", area: "Career", workflow: "career.all", async match() { return "from/about a live job (Beth Young)"; } }],
      workflows: [{ name: "career.all", async run() { throw new Error("must not run on Finagai's own mail"); } }],
    };
    const r = await runTick(pool, { now: new Date(), dryRun: false }, { modules: [mod] }, "manual");
    expect(r.events.find((e) => e.summary.includes("weekly review"))).toEqual(expect.objectContaining({ status: "ignored", reason: expect.stringMatching(/own outgoing/) }));
    expect(r.workflows).toEqual([]);
    delete process.env.NOTIFY_FROM;
  });

  it("the live acceptance self-check passes every property it can prove on this database (and never changes state)", async () => {
    const r = await liveAcceptance(pool, { version: "test", port: Number(new URL(base).port), since: since34 });
    const c = r.checks as Record<string, { pass: boolean | null } & Record<string, unknown>>;
    for (const k of ["noDeletePrivilege", "ordering", "snapshotCorrespondsToStream", "needsMeAgreement", "emailToStateChain", "escalationNotificationChain", "stateEventQuality", "noSilentStateChanges", "resume", "expiredCursor", "protections"])
      expect({ k, pass: c[k]!.pass, detail: c[k]!.pass ? null : c[k] }).toEqual({ k, pass: true, detail: null });
    expect((c.protections!.redaction as { storedEventsWithSecretShapedFields: number }).storedEventsWithSecretShapedFields).toBeGreaterThan(0);   // there was something to redact
    const proof = c.emailToStateChain!.proof as { stateChanges: Array<{ action: string }>; defects: string[] };
    expect(proof.stateChanges.map((x) => x.action)).toEqual(expect.arrayContaining(["followup_updated", "opportunity_evidence_added"]));
    expect((c.escalationNotificationChain!.latest as { fromEmail: boolean; notification: unknown }).fromEmail).toBe(true);
  }, 30_000);

  it("the self-check is strict: an internal (non-email) input or a state change with no event is never a pass", async () => {
    const r0 = await liveAcceptance(pool, { version: "test", port: Number(new URL(base).port), since: new Date(Date.now() + 60_000) });   // nothing after "since"
    const c0 = r0.checks as Record<string, { pass: boolean | null }>;
    expect(c0.emailToStateChain!.pass).toBeNull();
    expect(c0.escalationNotificationChain!.pass).toBeNull();
    expect(r0.allPass).toBe(false);
    // a silent write (bypassing the event writer) is caught at runtime
    await new Promise((r) => setTimeout(r, 1500));
    const t = new Date(Date.now() - 500);
    await q(`UPDATE followup SET due_at = due_at + interval '1 day', updated_at = now() WHERE summary = 'Waiting on Lee'`);
    const r1 = await liveAcceptance(pool, { version: "test", port: Number(new URL(base).port), since: t });
    expect((r1.checks as Record<string, { pass: boolean | null; silent?: string[] }>).noSilentStateChanges).toEqual(expect.objectContaining({ pass: false, silent: [expect.stringMatching(/^followup .* with no event$/)] }));
  }, 30_000);

  it("hotfix 35 — state transitions say what they moved FROM: follow-up waiting/done, escalation told, area health baseline", async () => {
    const unit = <T,>(fn: () => Promise<T>) => withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:track_waiting" } }, fn);
    const from = new Date(Date.now() - 1000).toISOString();
    const f = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Ana', 'Ana', 'open', now() + interval '3 days', 'julian') RETURNING id, due_at`, [careerId]))[0];
    await unit(() => appendEvent(pool, { actor: "julian", action: "followup_created", entityType: "followup", entityId: f.id, after: { summary: "Waiting on Ana", state: "open" } }));
    const due = new Date(Date.now() + 9 * 86_400_000);
    await unit(() => markWaiting(pool, f.id, due));
    await unit(() => closeFollowup(pool, f.id, "Ana replied"));
    const evs = (await history(pool, { from })).filter((e) => e.entity.id === f.id);
    const waiting = evs.find((e) => e.action === "followup_waiting")!, done = evs.find((e) => e.action === "followup_done")!;
    expect(waiting.before).toEqual({ state: "open", due_at: new Date(f.due_at).toISOString() });
    expect(waiting.after).toEqual(expect.objectContaining({ state: "waiting", due_at: due.toISOString() }));
    expect(done.before).toEqual({ state: "waiting", closed_at: null, outcome: null });
    expect(done.after).toEqual(expect.objectContaining({ state: "done", outcome: "Ana replied" }));
    // the "you asked to be told" escalation from the earlier tests was notified → resolved as told, from open
    const told = (await history(pool, { from: since34.toISOString() })).filter((e) => e.action === "escalation_resolved");
    for (const e of told) expect(e.before).toEqual(expect.objectContaining({ status: "open" }));
    // an Area's first health reading is an explicit "none recorded before", not a missing before-state
    const baseline = (await history(pool, { from: new Date(0).toISOString() })).find((e) => e.action === "area_health_changed")!;
    expect(baseline.before).toEqual({ color: null });
  });

  it("hotfix 35 — a transition is filed under the OBJECT's Area, and a sync reconciles every job it touched (canary 2 findings)", async () => {
    const testArea = (await ensureArea(pool, "Finagai Test")).id;
    const asTool = <T,>(fn: () => Promise<T>) => withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:track_opportunity" } }, fn);
    const T0 = new Date("2026-10-01T15:00:00Z");
    const job = await asTool(() => trackOpportunity(pool, { employer: "ADR087-CANARY-IT", title: "Acceptance Canary", status: "applied", at: T0.toISOString(), source: "julian", area: "Finagai Test" } as Parameters<typeof trackOpportunity>[1], T0)) as { jobId: string };
    expect((await q(`SELECT area_id FROM opportunity WHERE id = $1`, [job.jobId]))[0].area_id).toBe(testArea);
    // a Career workflow (career.sync) moves the test job — the event belongs to Finagai Test, not Career
    const before = await rowState(pool, "opportunity", job.jobId);
    await q(`UPDATE opportunity SET status = 'offer', updated_at = now() WHERE id = $1`, [job.jobId]);
    const id = await asTool(() => recordTransition(pool, { actor: "cos", action: "opportunity_status", table: "opportunity", id: job.jobId, before, areaId: careerId }));
    const ev = (await q(`SELECT area_id, before, after FROM event WHERE id = $1`, [id]))[0];
    expect(ev.area_id).toBe(testArea);
    expect(ev.before).toEqual({ status: "applied" });
    // the Career-scoped lifecycle tick still reconciles a job the sync touched in another Area
    const scoped = await lifecycleTick(pool, new Date(), { areaId: careerId });
    const withTouched = await lifecycleTick(pool, new Date(), { areaId: careerId, alsoIds: [job.jobId] });
    expect(withTouched.jobsChecked).toBe(scoped.jobsChecked + 1);
  });

  it("hotfix 35 — the self-check fails a transition that omits its before-state when the object had one", async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const t = new Date(Date.now() - 200);
    const f = (await q(`SELECT id FROM followup WHERE summary = 'Waiting on Ana'`))[0];
    await withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:resolve_waiting" } },
      () => appendEvent(pool, { actor: "cos", action: "followup_updated", entityType: "followup", entityId: f.id, after: { note: "no before here" } }));
    const r = await liveAcceptance(pool, { version: "test", port: Number(new URL(base).port), since: t });
    const sq = (r.checks as Record<string, { pass: boolean | null; violations?: string[] }>).stateEventQuality!;
    expect(sq.pass).toBe(false);
    expect(sq.violations).toEqual([expect.stringMatching(/followup_updated: .*transition without before-state/)]);
  }, 30_000);

  it("live 2026-10-12 21:04Z: work events about non-state objects (Mac step proposals) cite their unit of work", async () => {
    const t0 = new Date(Date.now() - 1000);
    const stepId = randomUUID();
    await withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "j6", what: "mac:/control/next" } },
      () => appendEvent(pool, { actor: "j6", action: "control_step_proposed", entityType: "control_step", entityId: stepId, after: { code: 1, kind: "scroll", risk: "write", summary: "scroll" } }));
    // a read-only tool call's audit row still leaves no root behind
    await withCause({ correlationId: randomUUID(), causeIds: [], root: { actor: "julian", what: "tool:waiting_on" } },
      () => appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "waiting_on", outcome: "ok" } }));
    const step = (await q(`SELECT cause_ids FROM event WHERE entity_id = $1`, [stepId]))[0];
    expect(step.cause_ids.length).toBe(1);
    expect((await q(`SELECT action, after->>'what' AS what FROM event WHERE id = $1`, [step.cause_ids[0]]))[0]).toEqual({ action: "work_invoked", what: "mac:/control/next" });
    expect(await q(`SELECT 1 FROM event WHERE action = 'work_invoked' AND after->>'what' = 'tool:waiting_on' AND occurred_at > $1`, [t0])).toEqual([]);
    const r = await liveAcceptance(pool, { version: "test", port: Number(new URL(base).port), since: t0 });
    expect((r.checks as Record<string, { pass: boolean | null; violations?: string[] }>).stateEventQuality).toEqual(expect.objectContaining({ pass: true, violations: [] }));
  }, 30_000);
});
