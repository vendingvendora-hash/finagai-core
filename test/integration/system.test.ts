/**
 * FULL-SYSTEM SIMULATION (pre-deployment). The closest local equivalent of production:
 *
 *   MCP client (SDK, over HTTP, bearer token) -> Finagai Core server -> J2 / J3 -> PostgreSQL
 *   -> governance approval page (OIDC session + WebAuthn) -> scheduler dispatch (real handlers)
 *   -> Resend adapter (real code) -> fake Resend API -> append-only audit log
 *
 * Model calls go through the REAL metered client and Postgres budget ledger; only the model provider is
 * scripted. Failure injection: process crash, model timeout, malformed model response, database conflict,
 * duplicate request, expired lease, authorization failure, provider timeout, budget exhaustion, sensitive
 * input, stale governance request. Ends with a synthetic cold start through approved promotion.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "../../src/config/index.js";
import { createPool, PgDeliveryStore, PgJobLedger, PgLlmCallRecorder } from "../../src/db/index.js";
import { createHandler } from "../../src/server/app.js";
import { createLogger } from "../../src/server/log.js";
import { buildMcpServer } from "../../src/tools/server.js";
import { registerJ3Tools } from "../../src/tools/j3Tools.js";
import { OidcClient } from "../../src/approval/oidc.js";
import { createApprovalHandler } from "../../src/approval/routes.js";
import { SESSION_COOKIE, signSession } from "../../src/approval/session.js";
import { mintEnrollmentCode } from "../../src/admin/enrollment.js";
import { MeteredModelClient } from "../../src/llm/metered.js";
import { TransientModelError, type ModelProvider, type ModelRequest, type ProviderResult } from "../../src/llm/types.js";
import { ResendSender } from "../../src/notify/resend.js";
import { dispatch, slotIdempotencyKey } from "../../src/jobs/dispatcher.js";
import { missedRunCheckHandler, weeklyReviewHandler } from "../../src/jobs/j3Handlers.js";
import { dailyMaintenanceHandler } from "../../src/jobs/maintenance.js";
import { placeholderHandlers } from "../../src/jobs/handlers.js";
import { runReview, type J3Deps } from "../../src/pipelines/j3/review.js";
import { makePromoter } from "../../src/pipelines/seed/seed.js";
import { parseDateExpression } from "../../src/pipelines/j2/dates.js";
import { zonedWallTimeToUtc } from "../../src/jobs/time.js";
import { SoftwareAuthenticator } from "../helpers/authenticator.js";

const url = process.env.INTEGRATION_DATABASE_URL_J3 ? process.env.INTEGRATION_DATABASE_URL_J3.replace("finagai_j3", "finagai_sys") : undefined;
const admin = process.env.INTEGRATION_ADMIN_URL;
const migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE;
const PRINCIPAL = "user_julian_sim";
const SECRET = "sim-session-secret-0123456789abcdefghijklm";
const TZ = "America/New_York";

// ---------------------------------------------------------------------------------------- simulated externals
/** Scripted model provider with failure injection; everything else (metering, budget, retries) is real. */
class SimulatedClaude implements ModelProvider {
  timeouts = 0;      // next N calls time out (transient)
  malformed = 0;     // next N calls return invalid JSON
  calls: string[] = [];
  async send(req: ModelRequest): Promise<ProviderResult> {
    this.calls.push(req.step);
    if (this.timeouts > 0) { this.timeouts--; throw new TransientModelError("model call timed out", undefined); }
    const usage = { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
    if (this.malformed > 0) { this.malformed--; return { text: "Sure! Here are the items: (not JSON)", model: req.model, stopReason: "end_turn", usage }; }
    const body = req.step === "extract" ? this.extract(req) : req.step === "classify" ? this.classify(req) : req.step === "compose" ? this.compose(req) : { pass: true, reason: "ok" };
    return { text: JSON.stringify(body), model: req.model, stopReason: "end_turn", usage };
  }
  private extract(req: ModelRequest) {
    const { text, received_at } = JSON.parse(req.messages[0]!.content) as { text: string; received_at: string };
    const candidates = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s && /[.!?]$/.test(s)).map((sentence, i) => {
      const quote = sentence.replace(/[.!?]$/, "");
      const base = { temp_id: `c${i}`, fields: {} as Record<string, string | null>, source_quote: quote, explicitly_stated: true, stated_by: "julian",
        epistemic_status: "user_provided", classification: "internal", source_visibility: "non_public", project_mention: null as string | null,
        date_expression: null as string | null, date_resolved: null as string | null, completion_stated: false };
      if (/diagnos|lawsuit|attorney/i.test(sentence)) return { ...base, item_type: "fact", classification: "highly_sensitive", fields: { claim: "sensitive" } };
      if (/^From now on/i.test(sentence)) return { ...base, item_type: "procedure_change", fields: { statement: quote.replace(/^From now on,?\s*/i, "") } };
      const proj = /^Project:\s*(.+)$/i.exec(quote);
      if (proj) return { ...base, item_type: "project", fields: { name: proj[1]! } };
      const forP = /^For (.+?): (.+)$/i.exec(quote);
      const title = forP ? forP[2]! : quote;
      const by = /\bby ([A-Z][a-z]+ \d{1,2})\b/.exec(title);
      let resolved: string | null = null;
      if (by) {
        const d = parseDateExpression(by[1]!, new Date(received_at), TZ, "en");
        if (d && !("contradiction" in d)) resolved = zonedWallTimeToUtc(d.year, d.month, d.day, 23, 59, TZ).toISOString();
      }
      return { ...base, item_type: by ? "deadline" : "task", fields: { title }, project_mention: forP ? forP[1]! : null,
        date_expression: by ? `by ${by[1]}` : null, date_resolved: resolved };
    });
    return { language: "en", candidates };
  }
  private classify(req: ModelRequest) {
    const items = JSON.parse(req.messages[0]!.content) as Array<{ temp_id: string; fields: Record<string, string>; matches: Array<{ id: string; text: string }> }>;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return { judgments: items.map((i) => {
      const same = i.matches.find((m) => norm(m.text) === norm(i.fields.title ?? i.fields.claim ?? i.fields.name ?? ""));
      return { temp_id: i.temp_id, relation: same ? "duplicate" : "new", target_id: same?.id ?? null, changed_fields: [], rationale: "simulated" };
    }) };
  }
  private compose(req: ModelRequest) {
    const items = JSON.parse(req.messages[0]!.content) as Array<{ id: string; section: string; must_mention: boolean; title: string; note: string | null }>;
    const sections = new Map<string, object[]>();
    for (const i of items) {
      const l = sections.get(i.section) ?? [];
      l.push({ item_ids: [i.id], headline: i.title.replace(/\b(by|due) [A-Z][a-z]+ \d{1,2}\b/g, "").trim() || "Item", why: null,
        urgency: i.must_mention ? "high" : "low", importance: i.must_mention ? "high" : "low", uncertainty: null });
      sections.set(i.section, l);
    }
    return { sections: [...sections].map(([section, entries]) => ({ section, entries })), nothing_material_changed: items.length === 0 };
  }
}

/** Fake Resend: idempotency keys retained 24 h, payload-conflict 409, injectable timeout-after-accept. */
class FakeResend {
  inbox: Array<{ subject: string; text: string; key: string }> = [];
  private keys = new Map<string, string>();
  hangNext = 0;
  server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const key = String(req.headers["idempotency-key"] ?? "");
    const prior = this.keys.get(key);
    if (prior !== undefined && prior !== body) { res.statusCode = 409; res.end(JSON.stringify({ name: "invalid_idempotent_request" })); return; }
    if (prior === undefined) { this.keys.set(key, body); const m = JSON.parse(body); this.inbox.push({ subject: m.subject, text: m.text, key }); }
    if (this.hangNext > 0) { this.hangNext--; return; } // accepted, but the client never hears back
    res.end(JSON.stringify({ id: `em_${this.inbox.length}` }));
  });
}

// ---------------------------------------------------------------------------------------- system under test
let server: http.Server, idp: http.Server;
let base = "", idpBase = "";
let idpKey: CryptoKey, jwk: JWK;
let pool: pg.Pool, resend: FakeResend, claude: SimulatedClaude;
let j3: J3Deps, jobs: { handlers: Parameters<typeof dispatch>[1]["handlers"] };
let device: SoftwareAuthenticator, session = "";
const idpCodes = new Map<string, { sub: string; nonce: string }>();

beforeAll(async () => {
  if (!url || !admin || !migT) return;
  // Fresh database for the simulation.
  const a = new pg.Client({ connectionString: admin }); await a.connect();
  await a.query(`DROP DATABASE IF EXISTS finagai_sys WITH (FORCE)`); await a.query(`CREATE DATABASE finagai_sys OWNER finagai_migrator`); await a.end();
  const { readdirSync, readFileSync } = await import("node:fs");
  const m = new pg.Client({ connectionString: migT.replace("{db}", "finagai_sys") }); await m.connect();
  for (const f of readdirSync("migrations").filter((x) => /^0\d+.*\.sql$/.test(x)).sort()) await m.query(readFileSync(`migrations/${f}`, "utf8"));
  await m.end();
  pool = createPool(url);

  const pair = await generateKeyPair("ES256", { extractable: true });
  idpKey = pair.privateKey; jwk = { ...(await exportJWK(pair.publicKey)), kid: "sim", alg: "ES256" };
  idp = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", idpBase);
    if (u.pathname === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/jwks` }));
    let body = ""; for await (const c of req) body += c;
    const e = idpCodes.get(new URLSearchParams(body).get("code") ?? "");
    if (!e) { res.statusCode = 400; return res.end("{}"); }
    res.end(JSON.stringify({ id_token: await new SignJWT({ nonce: e.nonce }).setProtectedHeader({ alg: "ES256", kid: "sim" }).setIssuer(idpBase)
      .setAudience("approval-client").setSubject(e.sub).setIssuedAt().setExpirationTime("5m").sign(idpKey) }));
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  resend = new FakeResend();
  await new Promise<void>((r) => resend.server.listen(0, "127.0.0.1", r));
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const cfg = loadConfig({ NODE_ENV: "test", FINAGAI_PUBLIC_BASE_URL: base, FINAGAI_MCP_RESOURCE_URL: `${base}/mcp`, DATABASE_URL: url,
    ANTHROPIC_API_KEY: "unused", OAUTH_ISSUER: idpBase, OAUTH_JWKS_URL: `${idpBase}/jwks`, PRINCIPAL_SUBJECT: PRINCIPAL, APPROVAL_CLIENT_ID: "approval-client",
    APPROVAL_CLIENT_SECRET: "approval-secret", SESSION_SECRET: SECRET, RESEND_API_KEY: "re_sim", NOTIFY_FROM: "Finagai <review@notify.example.test>",
    NOTIFY_TO: "julian@example.test", NOTIFY_REPLY_TO: "julian@example.test" });
  claude = new SimulatedClaude();
  const recorder = new PgLlmCallRecorder(pool, TZ);
  const model = new MeteredModelClient(claude, recorder, { limits: { targetUsd: 30, ceilingUsd: 36 }, baseDelayMs: 1, sleep: async () => {} });
  j3 = { pool, model, modelId: "claude-sonnet-5-5", collect: { timezone: TZ, stallThresholdDays: 14, upcomingWindowDays: 14, priorityUpcomingWindowDays: 30 },
    budget: async () => ({ monthToDateUsd: await recorder.monthToDateUsd(new Date()), targetUsd: 30, ceilingUsd: 36 }) };
  const j2 = { pool, model, cfg };
  const sender = new ResendSender({ apiKey: "re_sim", endpoint: `http://127.0.0.1:${(resend.server.address() as AddressInfo).port}/emails`,
    from: cfg.NOTIFY_FROM, to: cfg.NOTIFY_TO, replyTo: cfg.NOTIFY_REPLY_TO }, fetch as never, 300);
  const jd = { pool, j3, store: new PgDeliveryStore(pool), sender, timezone: TZ, weeklyReviewTime: "07:00" };
  jobs = { handlers: { ...placeholderHandlers(), weekly_review: weeklyReviewHandler(jd), missed_run_check: missedRunCheckHandler(jd),
    daily_maintenance: dailyMaintenanceHandler(pool, () => j2) } };
  const mcp = createMcpHandler(() => buildMcpServer({ pool, cfg, client: "claude_ai", j2, extend: registerJ3Tools(pool, j3) }));
  const approval = createApprovalHandler({ pool, cfg: { publicBaseUrl: base, rpId: "127.0.0.1", rpName: "Finagai", principalSubject: PRINCIPAL, sessionSecret: SECRET },
    oidc: new OidcClient({ issuer: idpBase, clientId: "approval-client", clientSecret: "approval-secret", redirectUri: `${base}/approve/callback`,
      sessionSecret: SECRET, principalSubject: PRINCIPAL }, fetch as never, createLocalJWKSet({ keys: [jwk] })),
    promote: makePromoter(cfg), onExecuted: async (action) => { if (action === "promote_seed_batch") await runReview(j3, { kind: "baseline" }); } });
  server.on("request", createHandler(cfg, { version: "sim", startedAt: new Date() }, createLogger(cfg, () => {}), { keys: createLocalJWKSet({ keys: [jwk] }), mcp, approval }));
  device = new SoftwareAuthenticator();
});
afterAll(async () => { server?.close(); idp?.close(); resend?.server.close(); await pool?.end(); });

// ---------------------------------------------------------------------------------------- helpers
const mcpToken = (sub = PRINCIPAL) => new SignJWT({ client_id: "claude" }).setProtectedHeader({ alg: "ES256", kid: "sim" }).setIssuer(idpBase)
  .setAudience(`${base}/mcp`).setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(idpKey);
async function claudeClient(sub = PRINCIPAL) {
  const c = new Client({ name: "claude-sim", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await mcpToken(sub)}` } } }));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  return JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
};
const ev = async (action: string) => Number((await pool.query(`SELECT count(*) AS n FROM event WHERE action = $1`, [action])).rows[0].n);
const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", origin: base, cookie: `${SESSION_COOKIE}=${session}` } });
async function approve(approvalUrl: string) {
  const u = new URL(approvalUrl);
  const r = (await pool.query(`SELECT content_hash FROM governance_request WHERE id = $1`, [u.pathname.split("/")[2]])).rows[0];
  const ch = await (await post(`${u.pathname}/challenge`, { nonce: u.searchParams.get("n"), contentHash: r.content_hash, decision: "approve" })).json() as { challenge: string };
  return (await post(`${u.pathname}/decide`, { nonce: u.searchParams.get("n"), contentHash: r.content_hash, response: device.assert(ch.challenge, base, "127.0.0.1") })).json() as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------------------- the simulation
describe.skipIf(!url || !admin || !migT)("FULL-SYSTEM SIMULATION with failure injection", () => {
  let claudeC: Client;

  it("1. Claude captures context over MCP; a duplicate request and a duplicate statement change nothing", async () => {
    claudeC = await claudeClient();
    const key = randomUUID();
    const text = "Confirm the delivery window with Harbor Lights Bar by October 20. Order coin mechanisms for Copper Kettle.";
    const s = await call(claudeC, "capture", { text, idempotency_key: key });
    expect(s.status).toBe("processed");
    expect(s.applied).toHaveLength(2);
    expect((await call(claudeC, "capture", { text, idempotency_key: key })).status).toBe("already_captured");
    const again = await call(claudeC, "capture", { text: "Order coin mechanisms for Copper Kettle.", idempotency_key: randomUUID() });
    expect(again.duplicates).toHaveLength(1);
  });

  it("2. sensitive input is withheld everywhere, including the tool output", async () => {
    const s = await call(claudeC, "capture", { text: "I was diagnosed with a heart condition last week. Call the landlord about the lease.", idempotency_key: randomUUID() });
    expect(s.applied).toHaveLength(1);
    expect(JSON.stringify(s)).not.toMatch(/heart condition/);
    for (const t of ["capture", "capture_candidate", "event", "work_item", "knowledge_item"]) {
      expect(Number((await pool.query(`SELECT count(*) AS n FROM ${t} x WHERE x::text ILIKE '%heart condition%'`)).rows[0].n)).toBe(0);
    }
  });

  it("3. a malformed model response, then a model timeout: each fails cleanly and the same key then succeeds once", async () => {
    const key = randomUUID();
    const text = "Renew the county vending permit.";
    claude.malformed = 2; // initial answer and the schema-repair retry are both unusable
    expect((await call(claudeC, "capture", { text, idempotency_key: key })).status).toBe("failed");
    claude.timeouts = 4; // exhausts the client's retries
    expect((await call(claudeC, "capture", { text, idempotency_key: key })).status).toBe("failed");
    const ok = await call(claudeC, "capture", { text, idempotency_key: key });
    expect(ok.status).toBe("processed");
    expect(Number((await pool.query(`SELECT attempts FROM capture WHERE idempotency_key = $1`, [key])).rows[0].attempts)).toBe(3);
  });

  it("4. a process crash mid-capture is recovered by reclaiming the stale lease; nothing is processed twice", async () => {
    const key = randomUUID();
    await pool.query(`INSERT INTO capture (idempotency_key, client, mode, source_type, pipeline_version, status, processing_token, processing_until, payload_sha256)
      SELECT $1, 'claude_ai', 'inline', 'conversation', 'j2-v0', 'processing', gen_random_uuid(), now() - interval '1 minute', $2`,
      [key, (await import("../../src/pipelines/j2/capture.js")).capturePayloadHash({ sourceType: "conversation", mode: "inline", projectHint: null, redactedText: "Book the van for the Friday restock." })]);
    const s = await call(claudeC, "capture", { text: "Book the van for the Friday restock.", idempotency_key: key });
    expect(s.status).toBe("processed");
    expect(Number((await pool.query(`SELECT count(*) AS n FROM work_item w JOIN capture c ON c.id = w.source_capture_id WHERE c.idempotency_key = $1`, [key])).rows[0].n)).toBe(1);
  });

  it("5. a database conflict: concurrent identical requests produce exactly one capture", async () => {
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 5 }, () => call(claudeC, "capture", { text: "Print new price labels.", idempotency_key: key })));
    expect(rs.filter((r) => r.status === "processed")).toHaveLength(1);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM capture WHERE idempotency_key = $1`, [key])).rows[0].n)).toBe(1);
  });

  it("6. authorization failures: another identity on /mcp, and Claude's token on the approval page", async () => {
    await expect(claudeClient("someone_else")).rejects.toThrow();
    const res = await fetch(`${base}/approve/enroll/begin`, { method: "POST", headers: { authorization: `Bearer ${await mcpToken()}`, "content-type": "application/json", origin: base }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("7. the scheduler runs the weekly review once, emails it once, and ignores later ticks", async () => {
    const monday = new Date("2026-10-12T11:00:00Z");
    const ledger = new PgJobLedger(pool);
    const deps = { cfg: { FINAGAI_TIMEZONE: TZ, WEEKLY_REVIEW_DAY: 1, WEEKLY_REVIEW_TIME: "07:00", MISSED_RUN_CHECK_TIME: "09:00" }, handlers: jobs.handlers, log: () => {}, openLedger: async () => ledger };
    const r1 = await dispatch(monday, deps);
    expect(r1.ran.find((x) => x.job === "weekly_review")?.outcome.status).toBe("succeeded");
    await dispatch(new Date(monday.getTime() + 15 * 60_000), deps);
    const weekly = resend.inbox.filter((m) => m.subject === "Finagai weekly review");
    expect(weekly).toHaveLength(1);
    expect(weekly[0]!.text).toContain("Harbor Lights");
    expect(weekly[0]!.text).not.toMatch(/heart condition/);
  });

  it("8. provider timeout after accept: the delivery is uncertain, the missed-run check recovers it, and only one email exists", async () => {
    const monday = new Date("2026-10-19T11:00:00Z");
    const ledger = new PgJobLedger(pool);
    const deps = { cfg: { FINAGAI_TIMEZONE: TZ, WEEKLY_REVIEW_DAY: 1, WEEKLY_REVIEW_TIME: "07:00", MISSED_RUN_CHECK_TIME: "09:00" }, handlers: jobs.handlers, log: () => {}, openLedger: async () => ledger };
    const before = resend.inbox.length;
    resend.hangNext = 1;
    const r1 = await dispatch(monday, deps);
    expect(r1.ran.find((x) => x.job === "weekly_review")?.outcome.status).toBe("failed");
    expect((await pool.query(`SELECT status FROM outbound_delivery WHERE status = 'uncertain'`)).rows).toHaveLength(1);
    const check = await dispatch(new Date("2026-10-19T13:00:00Z"), deps); // 09:00 local
    expect(check.ran.find((x) => x.job === "missed_run_check")?.outcome.status).toBe("succeeded");
    const newMail = resend.inbox.slice(before).map((m) => m.subject);
    expect(newMail.filter((s) => s === "Finagai weekly review")).toHaveLength(1); // provider deduplicated the retry
  });

  it("9. an expired job lease after a scheduler crash is reclaimed by a later tick", async () => {
    const monday = new Date("2026-10-26T11:00:00Z");
    const ledger = new PgJobLedger(pool);
    await ledger.claim("weekly_review", monday, "crashed-process", 50);
    await new Promise((r) => setTimeout(r, 80));
    const r = await dispatch(new Date(monday.getTime() + 15 * 60_000), { cfg: { FINAGAI_TIMEZONE: TZ, WEEKLY_REVIEW_DAY: 1, WEEKLY_REVIEW_TIME: "07:00", MISSED_RUN_CHECK_TIME: "09:00" },
      handlers: jobs.handlers, log: () => {}, openLedger: async () => ledger });
    expect(r.ran.find((x) => x.job === "weekly_review")).toMatchObject({ attempt: 2, outcome: { status: "succeeded" } });
  });

  it("10. governance: Claude stages, Julian signs in and enrolls, a stale request is superseded, a fresh one executes", async () => {
    const start = await fetch(`${base}/approve/login`, { redirect: "manual" });
    const loc = new URL(start.headers.get("location")!);
    idpCodes.set("sim-code", { sub: PRINCIPAL, nonce: loc.searchParams.get("nonce")! });
    const cb = await fetch(`${base}/approve/callback?code=sim-code&state=${loc.searchParams.get("state")}`, { redirect: "manual",
      headers: { cookie: (start.headers.getSetCookie()[0] ?? "").split(";")[0]! } });
    session = cb.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.slice(SESSION_COOKIE.length + 1);
    const mig = new pg.Pool({ connectionString: migT!.replace("{db}", "finagai_sys"), max: 1 });
    const code = await mintEnrollmentCode(mig, PRINCIPAL); await mig.end();
    const b = await (await post("/approve/enroll/begin", { code })).json() as { ceremonyId: string; options: { challenge: string } };
    expect((await post("/approve/enroll/finish", { ceremonyId: b.ceremonyId, response: device.register(b.options.challenge, base, "127.0.0.1") })).status).toBe(200);

    const proposal = await call(claudeC, "capture", { text: "From now on, always draft outreach in Spanish first.", idempotency_key: randomUUID() });
    const pid = proposal.proposals[0].id;
    const stale = await call(claudeC, "request_proposal_decision", { proposal_id: pid, decision: "approve", rationale: "Julian said yes" });
    await pool.query(`UPDATE proposal SET version = version + 1 WHERE id = $1`, [pid]); // the target changes after staging
    expect((await approve(stale.approval_url)).result).toBe("superseded");
    const fresh = await call(claudeC, "request_proposal_decision", { proposal_id: pid, decision: "approve", rationale: "Julian said yes" });
    expect((await approve(fresh.approval_url)).result).toBe("executed");
    expect(Number((await pool.query(`SELECT count(*) AS n FROM procedure`)).rows[0].n)).toBe(1);
  });

  it("11. synthetic cold start: seed sources over MCP, answer questions, promote with a passkey, baseline review", async () => {
    const src = await call(claudeC, "seed_add_source", { title: "Current projects", idempotency_key: randomUUID(), text:
      "Project: Vendora Route Expansion. For Vendora Route Expansion: Sign placement agreement with Bluebird Lounge by November 6. " +
      "Project: Job Search. For Job Search: Prepare for the Crestline Capital interview by November 3. For Job Search: Send thank-you notes." });
    expect(src.staged).toBe(5);
    const q = await call(claudeC, "seed_questions", { batch_id: src.batch_id });
    const ids = q.groups.flatMap((g: { questions: Array<{ candidateId: string }>; clearForBulkConfirmation: Array<{ candidateId: string }> }) =>
      [...g.questions.map((x) => x.candidateId), ...g.clearForBulkConfirmation.map((x) => x.candidateId)]);
    await call(claudeC, "seed_answer", { batch_id: src.batch_id, answers: [...new Set(ids)].map((id) => ({ candidate_id: id, action: "confirm" })) });
    expect(Number((await pool.query(`SELECT count(*) AS n FROM project WHERE name IN ('Vendora Route Expansion','Job Search')`)).rows[0].n)).toBe(0);
    const req = await call(claudeC, "request_seed_promotion", { batch_id: src.batch_id, rationale: "Julian reviewed the batch" });
    const out = await approve(req.approval_url);
    expect(out).toMatchObject({ result: "executed", detail: { projects: 2, work_items: 3 } });
    await new Promise((r) => setTimeout(r, 300)); // baseline review runs after the response
    const baseline = (await pool.query(`SELECT rendered FROM review WHERE kind = 'baseline' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(baseline.rendered).toContain("Bluebird Lounge");
    expect(baseline.rendered).toContain("due: Fri, Nov 6, 2026");
  });

  it("12. budget exhaustion: captures are not persisted unclassified, and the weekly review degrades with zero model calls", async () => {
    await pool.query(`INSERT INTO llm_call (pipeline, step, model, prompt_version, status, cost_usd) VALUES ('j2','sim','claude-sonnet-5-5','sim','ok', 40)`);
    const callsBefore = claude.calls.length;
    const s = await call(claudeC, "capture", { text: "Call the supplier about the new snack line.", idempotency_key: randomUUID() });
    expect(s.status).toBe("budget_blocked_not_persisted");
    const monday = new Date("2026-11-02T12:00:00Z");
    const ledger = new PgJobLedger(pool);
    await dispatch(monday, { cfg: { FINAGAI_TIMEZONE: TZ, WEEKLY_REVIEW_DAY: 1, WEEKLY_REVIEW_TIME: "07:00", MISSED_RUN_CHECK_TIME: "09:00" },
      handlers: jobs.handlers, log: () => {}, openLedger: async () => ledger });
    expect(claude.calls.length).toBe(callsBefore); // nothing reached the model
    const degraded = resend.inbox.filter((m) => m.subject === "Finagai weekly review (degraded)");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.text).toMatch(/^DEGRADED REVIEW - model-spend limit reached/);
  });

  it("13. the audit log holds the whole story, append-only", async () => {
    expect(await ev("tool_called")).toBeGreaterThan(15);
    expect(await ev("review_generated")).toBeGreaterThanOrEqual(4);
    expect(await ev("governance_superseded")).toBe(1);
    expect(await ev("governance_executed")).toBe(2);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM event WHERE approval_id IS NOT NULL AND principal <> $1`, [PRINCIPAL])).rows[0].n)).toBe(0);
    await expect(pool.query(`DELETE FROM event`)).rejects.toThrow(/permission denied/);
    const now = Math.floor(Date.now() / 1000);
    expect(signSession({ sub: PRINCIPAL, authTime: now, exp: now + 60 }, "wrong-secret-0123456789abcdefghijklmn")).not.toBe(session);
  });
});
