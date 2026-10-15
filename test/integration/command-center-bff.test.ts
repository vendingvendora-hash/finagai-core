/**
 * ADR-089 slice 1 — the auth/stream path end to end, against a real Core HTTP handler (real bearer rules, real /live)
 * and a stand-in OIDC provider:
 *   browser → BFF session → BFF-held Core token (audience = Core's resource) → Core /live/snapshot and /live/stream (SSE)
 *   → BFF → browser, unbuffered; Last-Event-ID resume without loss or duplicates; tokens never reach the browser;
 *   fail closed when the provider will not issue a token for Core, when the account is not Julian, or when Core's client
 *   allow-list does not include the Command Center.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet } from "jose";
import { materialize } from "../../eval/runner/j3cases.js";
import { loadConfig } from "../../src/config/index.js";
import { ensureArea } from "../../src/cos/operating.js";
import { appendEvent } from "../../src/db/index.js";
import { liveHandler } from "../../src/live/http.js";
import { causalChain, publish } from "../../src/live/stream.js";
import { createHandler } from "../../src/server/app.js";
import { createLogger } from "../../src/server/log.js";
import { createBff } from "../../command/server/index.js";
import { browserLike, startFakeOidc } from "../support/fake-oidc.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
let db: Awaited<ReturnType<typeof materialize>>; let pool: pg.Pool;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const servers: http.Server[] = [];
const listen = async (h: http.RequestListener) => { const s = http.createServer(h); servers.push(s); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
const coreEnv = { NODE_ENV: "test", DATABASE_URL: "postgres://unused", ANTHROPIC_API_KEY: "unused", PRINCIPAL_SUBJECT: "user_julian", APPROVAL_CLIENT_ID: "c", APPROVAL_CLIENT_SECRET: "s",
  SESSION_SECRET: "x".repeat(40), RESEND_API_KEY: "r", NOTIFY_FROM: "Finagai <review@notify.example.test>", NOTIFY_TO: "julian@example.test", NOTIFY_REPLY_TO: "julian@example.test" };

/** Start a Core HTTP server (real handler) bound to a free port, trusting the given provider. */
async function startCore(issuer: string, jwk: import("jose").JWK, allowed: string) {
  const s = http.createServer(); servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const cfg = loadConfig({ ...coreEnv, FINAGAI_PUBLIC_BASE_URL: base, FINAGAI_MCP_RESOURCE_URL: `${base}/mcp`, OAUTH_ISSUER: issuer, OAUTH_JWKS_URL: `${issuer}/jwks`, ALLOWED_MCP_CLIENT_IDS: allowed });
  s.on("request", createHandler(cfg, { version: "test", startedAt: new Date() }, createLogger(cfg, () => {}),
    { keys: createLocalJWKSet({ keys: [jwk] }), live: liveHandler(pool, { pollMs: 100, heartbeatMs: 1000, maxStreamMs: 20_000 }) }));
  return base;
}
const bffLogs: string[] = [];
async function startBff(core: string, issuer: string, staticDir: string) {
  let base = "";
  const s = http.createServer(); servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const cfg = (await import("../../command/server/config.js")).loadConfig({ CC_PUBLIC_URL: base, OAUTH_ISSUER: issuer, CC_CLIENT_ID: "cc-client", CC_CLIENT_SECRET: "cc-secret",
    CORE_URL: core, CORE_RESOURCE: `${core}/mcp`, PRINCIPAL_SUBJECT: "user_julian", CC_STATE_SECRET: "s".repeat(40), CC_INSECURE_COOKIES: "1", CC_STATIC_DIR: staticDir });
  const bff = createBff(cfg, { log: (m, f) => { bffLogs.push(JSON.stringify({ msg: m, ...f })); } });
  s.on("request", bff.handler);
  return { base, bff };
}
/** Read an SSE response until `n` events arrived or `ms` passed; returns ids and the time each id arrived. */
async function readSse(res: Response, n: number, ms: number) {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ""; const ids: number[] = []; const at: number[] = []; const raw: string[] = [];
  const deadline = Date.now() + ms;
  while (ids.length < n && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((x) => setTimeout(() => x({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))]);
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true }); raw.push(dec.decode(r.value));
    let i; while ((i = buf.indexOf("\n\n")) >= 0) { const msg = buf.slice(0, i); buf = buf.slice(i + 2); const id = /^id: (\d+)$/m.exec(msg); if (id && /^data: /m.test(msg)) { ids.push(Number(id[1])); at.push(Date.now()); } }
  }
  await reader.cancel().catch(() => {});
  return { ids, at, raw: raw.join("") };
}

describe.skipIf(!admin || !migT || !appT)("Command Center BFF — auth and live stream path (ADR-089 slice 1)", () => {
  let provider: Awaited<ReturnType<typeof startFakeOidc>>; let core = ""; let bff: Awaited<ReturnType<typeof startBff>>; let staticDir = "";
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_ccbff_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    await ensureArea(pool, "Career");
    provider = await startFakeOidc({ clientId: "cc-client", clientSecret: "cc-secret", subject: "user_julian", accessTtlSec: 3600 });
    core = await startCore(provider.issuer, provider.jwk, "claude-connector,cc-client");
    staticDir = mkdtempSync(join(tmpdir(), "cc-static-")); writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Finagai</title><div id=root></div>");
    bff = await startBff(core, provider.issuer, staticDir);
  }, 120_000);
  afterAll(async () => { for (const s of servers) s.close(); await provider?.close(); await pool?.end(); await db?.drop(); });

  it("signs Julian in through the provider and serves Core's snapshot through the BFF; signed-out requests get nothing", async () => {
    const anon = browserLike();
    expect((await anon.go(`${bff.base}/api/live/snapshot`)).status).toBe(401);
    const b = browserLike();
    const home = await b.go(`${bff.base}/`);                              // → /auth/login → provider → /auth/callback → /
    expect(home.status).toBe(200);
    expect(home.text).toContain("<title>Finagai</title>");
    expect((await b.go(`${bff.base}/api/session`)).text).toContain('"signedIn":true');
    const snap = await b.go(`${bff.base}/api/live/snapshot`);
    expect(snap.status).toBe(200);
    const body = JSON.parse(snap.text);
    expect(body).toEqual(expect.objectContaining({ v: 2, cursor: expect.any(Number) }));
    // read-only: no other method, no other path
    expect((await b.go(`${bff.base}/api/live/snapshot`, { method: "POST" })).status).toBe(405);
    for (const path of ["chain/abc", "chain/1/x", "chain/", "consequences/1", "acceptance"]) expect((await b.go(`${bff.base}/api/live/${path}`)).status).toBe(404);
    // Slice 3: the Why inspector's chain is served through the BFF exactly as Core computes it
    const a = await appendEvent(pool, { actor: "cos", action: "work_invoked", causeIds: [], after: { what: "engine:tick" } });
    const c = await appendEvent(pool, { actor: "cos", action: "escalation_opened", entityType: "escalation", entityId: "00000000-0000-4000-8000-0000000000e1", causeIds: [a], after: { key: "k", needs: "judgment", summary: "s" } });
    const via = await b.go(`${bff.base}/api/live/chain/${c}`);
    expect(via.status).toBe(200);
    expect((JSON.parse(via.text).chain as Array<{ eventId: number }>).map((e) => e.eventId)).toEqual((await causalChain(pool, c)).map((e) => e.eventId));
    expect((JSON.parse(via.text).chain as Array<{ eventId: number }>).map((e) => e.eventId)).toEqual([a, c]);
    expect((await b.go(`${bff.base}/api/live/chain/${c}`, { method: "POST" })).status).toBe(405);
    // the browser never sees a Core token or refresh token: not in any body, header or cookie it received
    for (const t of provider.issued) {
      for (const x of [...b.bodies, ...b.headers]) expect(x.includes(t)).toBe(false);
      for (const m of b.jar.values()) for (const v of m.values()) expect(v.includes(t)).toBe(false);
    }
  });

  it("a deep link survives sign-in (Slice 3: /?why=…), and the return address can only ever be the app's own root", async () => {
    const b = browserLike();
    const deep = await b.go(`${bff.base}/?why=escalation:00000000-0000-4000-8000-0000000000e1&diag`);
    expect(deep.status).toBe(200);
    expect(deep.url).toBe(`${bff.base}/?why=escalation:00000000-0000-4000-8000-0000000000e1&diag`);
    expect([...(b.jar.get(new URL(bff.base).host)?.keys() ?? [])].some((k) => /return/.test(k))).toBe(false);   // used once, then cleared
    for (const evil of ["//evil.example/x", "https://evil.example/", "/auth/logout", "/\\evil.example", "/?a=<script>"]) {
      const c = browserLike();
      const r = await c.go(`${bff.base}/auth/login?return=${encodeURIComponent(evil)}`);
      expect(r.url).toBe(`${bff.base}/`);
    }
    const { returnPath } = await import("../../command/server/index.js");
    expect(returnPath("/?why=123")).toBe("/?why=123");
    expect(returnPath("/?why=escalation:ab-12&diag")).toBe("/?why=escalation:ab-12&diag");
    for (const v of ["", "//x", "/x", "https://x", "/?why=a b", "/?x=\"", `/?${"a".repeat(400)}`]) expect(returnPath(v)).toBeNull();
  });

  it("streams live events through the BFF unbuffered, and resumes with Last-Event-ID without loss or duplicates", async () => {
    const b = browserLike(); await b.go(`${bff.base}/`);
    await publish(pool);
    const cursor = JSON.parse((await b.go(`${bff.base}/api/live/snapshot`)).text).cursor as number;
    const res = await fetch(`${bff.base}/api/live/stream?after=${cursor}`, { headers: { cookie: b.cookieHeader(new URL(bff.base).host) } });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    // events appended while the connection is open arrive promptly (no buffering until the response ends)
    const stamps: number[] = [];
    const writer = (async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 400)); const t0 = Date.now(); await appendEvent(pool, { actor: "cos", action: "followup_updated", entityType: "followup", after: { n: i } }); await publish(pool); stamps.push(t0); } })();
    const first = await readSse(res, 3, 8000);
    await writer;
    expect(first.ids.length).toBe(3);
    first.at.forEach((t, i) => expect(t - stamps[i]!).toBeLessThan(2500));      // Core polls every 100 ms here; production 1 s
    // disconnected: 4 events happen; reconnecting with Last-Event-ID delivers exactly those, once, in order
    const last = first.ids[first.ids.length - 1]!;
    for (let i = 0; i < 4; i++) await appendEvent(pool, { actor: "cos", action: "followup_updated", entityType: "followup", after: { missed: i } });
    await publish(pool);
    const res2 = await fetch(`${bff.base}/api/live/stream`, { headers: { cookie: b.cookieHeader(new URL(bff.base).host), "last-event-id": String(last) } });
    const second = await readSse(res2, 4, 8000);
    expect(second.ids.length).toBe(4);
    expect(second.ids[0]).toBe(last + 1);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(7);
    expect(second.ids).toEqual([...second.ids].sort((a, c) => a - c));
    for (const t of provider.issued) expect(first.raw.includes(t) || second.raw.includes(t)).toBe(false);
  }, 30_000);

  it("refreshes Core's token server-side when it expires", async () => {
    const p2 = await startFakeOidc({ clientId: "cc-client", clientSecret: "cc-secret", subject: "user_julian", accessTtlSec: 30 });   // < 60 s: every call refreshes
    const core2 = await startCore(p2.issuer, p2.jwk, "");
    const bff2 = await startBff(core2, p2.issuer, staticDir);
    const b = browserLike(); await b.go(`${bff2.base}/`);
    expect((await b.go(`${bff2.base}/api/live/contract`)).status).toBe(200);
    expect((await b.go(`${bff2.base}/api/live/contract`)).status).toBe(200);
    expect(p2.state.refreshCalls).toBeGreaterThanOrEqual(2);
    // each renewal is logged as operational evidence (timings, rotation) — and no log line carries a token
    const renewals = bffLogs.filter((l) => l.includes('"access renewed"')).map((l) => JSON.parse(l));
    expect(renewals.length).toBeGreaterThanOrEqual(2);
    expect(renewals[0]).toEqual(expect.objectContaining({ forced: false, refreshRotated: true, validForSeconds: expect.any(Number), secondsLeftBefore: expect.any(Number) }));
    for (const t of p2.issued) for (const l of bffLogs) expect(l.includes(t)).toBe(false);
    // the browser saw none of the renewed tokens either
    for (const t of p2.issued) { for (const x of [...b.bodies, ...b.headers]) expect(x.includes(t)).toBe(false); for (const m of b.jar.values()) for (const v of m.values()) expect(v.includes(t)).toBe(false); }
    await p2.close();
  });

  it("fails closed: no Core audience, not Julian, or a client Core does not allow → no session / no data", async () => {
    const noAud = await startFakeOidc({ clientId: "cc-client", clientSecret: "cc-secret", subject: "user_julian", honorResource: false });
    const bffA = await startBff(core, noAud.issuer, staticDir);
    const a = browserLike(); const r = await a.go(`${bffA.base}/`);
    expect(r.status).toBe(401);
    expect(r.text).toMatch(/did not issue the token for Core/);
    expect((await a.go(`${bffA.base}/api/session`)).text).toContain('"signedIn":false');
    await noAud.close();

    const stranger = await startFakeOidc({ clientId: "cc-client", clientSecret: "cc-secret", subject: "user_someone_else" });
    const bffB = await startBff(core, stranger.issuer, staticDir);
    const s = await browserLike().go(`${bffB.base}/`);
    expect(s.status).toBe(401); expect(s.text).toMatch(/not Finagai(&#39;|')s principal/);
    await stranger.close();

    // Core's client allow-list without the Command Center: Core refuses its token, so the BFF serves no data
    const p3 = await startFakeOidc({ clientId: "cc-client", clientSecret: "cc-secret", subject: "user_julian" });
    const pinned = await startCore(p3.issuer, p3.jwk, "claude-connector");
    const bffC = await startBff(pinned, p3.issuer, staticDir);
    const c = browserLike(); await c.go(`${bffC.base}/`);
    expect((await c.go(`${bffC.base}/api/live/snapshot`)).status).toBe(401);
    await p3.close();
  });

  it("serving the Command Center writes no events in Core", async () => {
    const n = Number((await q(`SELECT count(*)::int AS n FROM event`))[0].n);
    const b = browserLike(); await b.go(`${bff.base}/`);
    for (let i = 0; i < 5; i++) for (const p of ["snapshot", "contract", "history?limit=20&order=desc", "summary/reliability?days=1"]) expect((await b.go(`${bff.base}/api/live/${p}`)).status).toBe(200);
    expect(Number((await q(`SELECT count(*)::int AS n FROM event`))[0].n)).toBe(n);
  });
});
