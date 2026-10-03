/**
 * GATE 2 (local): Claude/tool call -> governance request staged -> no authoritative change ->
 * Julian-authenticated approval -> fresh WebAuthn assertion -> content/version re-check ->
 * atomic execution -> immutable event. Real HTTP server, real Postgres, real @simplewebauthn/server;
 * a fake OIDC provider and a TEST-ONLY software authenticator stand in for WorkOS and Julian's device.
 */
import http from "node:http";
import { messageText } from "../../src/llm/content.js";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { loadConfig } from "../../src/config/index.js";
import { createPool } from "../../src/db/index.js";
import { createHandler } from "../../src/server/app.js";
import { createLogger } from "../../src/server/log.js";
import { OidcClient } from "../../src/approval/oidc.js";
import { createApprovalHandler } from "../../src/approval/routes.js";
import { signSession, SESSION_COOKIE } from "../../src/approval/session.js";
import { stageGovernanceRequest } from "../../src/governance/stage.js";
import { mintEnrollmentCode, revokeCredential } from "../../src/admin/enrollment.js";
import { SoftwareAuthenticator } from "../helpers/authenticator.js";
import { makePromoter, addSource, questions, answer } from "../../src/pipelines/seed/seed.js";
import type { J2Deps } from "../../src/pipelines/j2/capture.js";
import type { ModelRequest, ModelResult } from "../../src/llm/types.js";
import type { Candidate } from "../../src/guards/extraction.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const migratorUrl = process.env.INTEGRATION_MIGRATOR_URL;
const pool = url ? createPool(url) : undefined;
const migrator = migratorUrl ? new pg.Pool({ connectionString: migratorUrl, max: 1 }) : undefined;
const PRINCIPAL = "user_julian_m5";
const SECRET = "m5-session-secret-0123456789abcdefghijkl";

let server: http.Server, idp: http.Server;
let base = "", idpBase = "", rpId = "127.0.0.1";
let idpKey: CryptoKey, idpJwk: JWK;
const codes = new Map<string, { sub: string; nonce: string }>();
let device: SoftwareAuthenticator;
let activeDevice: SoftwareAuthenticator; // the passkey still valid after the revocation test
let session = "";
let cfg: ReturnType<typeof loadConfig>;

async function startIdp() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  idpKey = pair.privateKey;
  idpJwk = { ...(await exportJWK(pair.publicKey)), kid: "idp-1", alg: "ES256" };
  idp = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", idpBase);
    if (u.pathname === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token`, jwks_uri: `${idpBase}/jwks` }));
    } else if (u.pathname === "/token") {
      let body = ""; for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const entry = codes.get(p.get("code") ?? "");
      if (!entry || p.get("client_secret") !== "approval-secret" || !p.get("code_verifier")) { res.statusCode = 400; res.end("{}"); return; }
      const idToken = await new SignJWT({ nonce: entry.nonce, auth_time: Math.floor(Date.now() / 1000) })
        .setProtectedHeader({ alg: "ES256", kid: "idp-1" }).setIssuer(idpBase).setAudience("approval-client")
        .setSubject(entry.sub).setIssuedAt().setExpirationTime("5m").sign(idpKey);
      res.end(JSON.stringify({ id_token: idToken }));
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  if (!pool) return;
  await startIdp();
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfg = loadConfig({
    NODE_ENV: "test", FINAGAI_PUBLIC_BASE_URL: base, FINAGAI_MCP_RESOURCE_URL: `${base}/mcp`, DATABASE_URL: url!, ANTHROPIC_API_KEY: "unused",
    OAUTH_ISSUER: idpBase, OAUTH_JWKS_URL: `${idpBase}/jwks`, PRINCIPAL_SUBJECT: PRINCIPAL, APPROVAL_CLIENT_ID: "approval-client",
    APPROVAL_CLIENT_SECRET: "approval-secret", SESSION_SECRET: SECRET, RESEND_API_KEY: "r", NOTIFY_FROM: "Finagai <a@b.test>",
    NOTIFY_TO: "julian@example.test", NOTIFY_REPLY_TO: "julian@example.test",
  });
  const approval = createApprovalHandler({ pool, cfg: { publicBaseUrl: base, rpId, rpName: "Finagai", principalSubject: PRINCIPAL, sessionSecret: SECRET },
    promote: makePromoter({ FINAGAI_TIMEZONE: "America/New_York", RETENTION_CONFIDENTIAL_THIRD_PARTY_DAYS: 180 }),
    oidc: new OidcClient({ issuer: idpBase, clientId: "approval-client", clientSecret: "approval-secret", redirectUri: `${base}/approve/callback`,
      sessionSecret: SECRET, principalSubject: PRINCIPAL }, fetch as never, createLocalJWKSet({ keys: [idpJwk] })) });
  const mcpKeys = createLocalJWKSet({ keys: [idpJwk] });
  server.on("request", createHandler(cfg, { version: "test", startedAt: new Date() }, createLogger(cfg, () => {}), { keys: mcpKeys, approval }));
  device = new SoftwareAuthenticator();
});
afterAll(async () => { server?.close(); idp?.close(); await pool?.end(); await migrator?.end(); });

// ------------------------------------------------------------------------------ helpers
const cookieFrom = (res: Response, name: string) =>
  (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
const post = (path: string, body: unknown, over: { cookie?: string; origin?: string; headers?: Record<string, string> } = {}) =>
  fetch(base + path, { method: "POST", redirect: "manual", body: JSON.stringify(body), headers: {
    "content-type": "application/json", origin: over.origin ?? base, cookie: `${SESSION_COOKIE}=${over.cookie ?? session}`, ...(over.headers ?? {}) } });

async function signIn(sub = PRINCIPAL): Promise<Response> {
  const start = await fetch(`${base}/approve/login?return=/approve`, { redirect: "manual" });
  const loc = new URL(start.headers.get("location")!);
  const code = `code-${Math.random()}`;
  codes.set(code, { sub, nonce: loc.searchParams.get("nonce")! });
  return fetch(`${base}/approve/callback?code=${code}&state=${loc.searchParams.get("state")}`,
    { redirect: "manual", headers: { cookie: `finagai_login=${cookieFrom(start, "finagai_login")}` } });
}

async function newProposalRequest(text = "Draft outreach in Spanish first") {
  const p = (await pool!.query<{ id: string; version: number }>(
    `INSERT INTO proposal (kind, proposed_text, rationale) VALUES ('procedure_change', $1, 'from capture') RETURNING id, version`, [text])).rows[0]!;
  const staged = await stageGovernanceRequest(pool!, { FINAGAI_PUBLIC_BASE_URL: base, GOVERNANCE_REQUEST_TTL_HOURS: 72 }, {
    action: "decide_proposal", targets: [{ type: "proposal", id: p.id, version: p.version }], rationale: "Julian asked for this in chat",
    client: "claude_ai", before: { status: "pending" }, after: { status: "approved", new_text: text } });
  const u = new URL(staged.approvalUrl);
  return { proposalId: p.id, id: staged.approvalId, nonce: u.searchParams.get("n")!, contentHash: staged.contentHash, path: u.pathname };
}

async function challengeFor(r: { path: string; nonce: string; contentHash: string }, decision = "approve") {
  const res = await post(`${r.path}/challenge`, { nonce: r.nonce, contentHash: r.contentHash, decision });
  return { status: res.status, body: (await res.json()) as { challenge: string; error?: string } };
}
const decide = async (r: { path: string; nonce: string; contentHash: string }, response: unknown, over: object = {}) => {
  const res = await post(`${r.path}/decide`, { nonce: r.nonce, contentHash: r.contentHash, response, ...over });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

// ------------------------------------------------------------------------------ tests
describe.skipIf(!url || !migratorUrl)("GATE 2: governance approval, end to end", () => {
  it("signs Julian in through OIDC and refuses any other identity", async () => {
    const other = await signIn("user_someone_else");
    expect(other.status).toBe(400);
    expect(cookieFrom(other, SESSION_COOKIE)).toBe("");
    const ok = await signIn();
    expect(ok.status).toBe(200);
    session = cookieFrom(ok, SESSION_COOKIE);
    expect(session).not.toBe("");
  });

  it("enrolls the first passkey only with a one-time code minted by the migration role, and the code is single-use", async () => {
    expect((await post("/approve/enroll/begin", { code: "guessed-code" })).status).toBe(403);
    const code = await mintEnrollmentCode(migrator!, PRINCIPAL);
    const begin = await post("/approve/enroll/begin", { code });
    expect(begin.status).toBe(200);
    const { ceremonyId, options } = (await begin.json()) as { ceremonyId: string; options: { challenge: string } };
    const fin = await post("/approve/enroll/finish", { ceremonyId, response: device.register(options.challenge, base, rpId) });
    expect(fin.status).toBe(200);
    const row = (await pool!.query(`SELECT principal_subject, enrolled_via, public_key FROM webauthn_credential WHERE credential_id = $1`, [device.credentialId])).rows[0];
    expect(row).toMatchObject({ principal_subject: PRINCIPAL, enrolled_via: "admin_enrollment_code" });
    expect(Buffer.from(row.public_key).length).toBeGreaterThan(60); // only the PUBLIC key is stored
    expect((await post("/approve/enroll/begin", { code })).status).toBe(200); // now returns an assertion challenge, not registration
    const again = (await (await post("/approve/enroll/begin", { code })).json()) as { authenticate?: object };
    expect(again.authenticate).toBeDefined(); // later passkeys require an existing passkey, the code is no longer enough
  });

  it("stages without change, then executes atomically after a fresh WebAuthn approval, with an immutable event", async () => {
    const r = await newProposalRequest();
    const procBefore = (await pool!.query(`SELECT count(*)::int AS n FROM procedure`)).rows[0].n;
    expect((await pool!.query(`SELECT status FROM proposal WHERE id = $1`, [r.proposalId])).rows[0].status).toBe("pending");

    const page = await fetch(`${base}${r.path}?n=${r.nonce}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    expect(page.status).toBe(200);
    const htmlText = await page.text();
    expect(htmlText).toContain("Draft outreach in Spanish first");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");

    const ch = await challengeFor(r);
    expect(ch.status).toBe(200);
    const out = await decide(r, device.assert(ch.body.challenge, base, rpId));
    expect(out).toMatchObject({ status: 200, body: { result: "executed" } });

    const gr = (await pool!.query(`SELECT status, decided_by_principal, approval_credential_id, executed_event_id FROM governance_request WHERE id = $1`, [r.id])).rows[0];
    expect(gr).toMatchObject({ status: "executed", decided_by_principal: PRINCIPAL });
    expect(gr.approval_credential_id).not.toBeNull();
    expect((await pool!.query(`SELECT status FROM proposal WHERE id = $1`, [r.proposalId])).rows[0].status).toBe("approved");
    expect((await pool!.query(`SELECT count(*)::int AS n FROM procedure`)).rows[0].n).toBe(procBefore + 1);
    const evs = (await pool!.query(`SELECT action, approval_id, principal FROM event WHERE approval_id = $1 ORDER BY id`, [r.id])).rows;
    expect(evs.map((e) => e.action)).toEqual(["create", "proposal_decide", "governance_executed"]);
    expect(evs.every((e) => e.principal === PRINCIPAL)).toBe(true);
    await expect(pool!.query(`UPDATE event SET reason = 'x' WHERE approval_id = $1`, [r.id])).rejects.toThrow(/permission denied/);
  });

  it("refuses an MCP bearer credential on every approval endpoint", async () => {
    const r = await newProposalRequest("bearer attempt");
    const mcpToken = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "idp-1" }).setIssuer(idpBase)
      .setAudience(`${base}/mcp`).setSubject(PRINCIPAL).setExpirationTime("5m").sign(idpKey);
    for (const [path, method] of [[`${r.path}?n=${r.nonce}`, "GET"], [`${r.path}/challenge`, "POST"], [`${r.path}/decide`, "POST"], ["/approve/enroll/begin", "POST"]] as const) {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json", origin: base }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status).toBe(401);
    }
    expect((await pool!.query(`SELECT status FROM governance_request WHERE id = $1`, [r.id])).rows[0].status).toBe("pending");
  });

  it("refuses a session for the wrong principal, a forged session, and cross-origin posts", async () => {
    const r = await newProposalRequest("wrong principal");
    const now = Math.floor(Date.now() / 1000);
    const wrong = signSession({ sub: "user_someone_else", authTime: now, exp: now + 600 }, SECRET);
    expect((await post(`${r.path}/challenge`, { nonce: r.nonce, contentHash: r.contentHash, decision: "approve" }, { cookie: wrong })).status).toBe(401);
    const forged = signSession({ sub: PRINCIPAL, authTime: now, exp: now + 600 }, "a-different-secret-0123456789abcdefgh");
    expect((await post(`${r.path}/challenge`, { nonce: r.nonce, contentHash: r.contentHash, decision: "approve" }, { cookie: forged })).status).toBe(401);
    expect((await post(`${r.path}/challenge`, { nonce: r.nonce, contentHash: r.contentHash, decision: "approve" }, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("refuses a reused challenge: the same assertion cannot execute twice", async () => {
    const r = await newProposalRequest("replay");
    const ch = await challengeFor(r);
    const assertion = device.assert(ch.body.challenge, base, rpId);
    expect((await decide(r, assertion)).body.result).toBe("executed");
    const replay = await decide(r, assertion);
    expect(replay.status).toBe(403);
    expect(replay.body.reason).toMatch(/request_not_pending|challenge_reused/);
  });

  it("refuses an expired request", async () => {
    const r = await newProposalRequest("expiry");
    const ch = await challengeFor(r);
    await pool!.query(`UPDATE governance_request SET requested_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1`, [r.id]);
    const out = await decide(r, device.assert(ch.body.challenge, base, rpId));
    expect(out).toMatchObject({ status: 403, body: { reason: "request_expired" } });
    expect((await challengeFor(r)).status).toBe(409);
  });

  it("refuses mutated content at challenge time and at decision time", async () => {
    const r = await newProposalRequest("mutation");
    expect((await post(`${r.path}/challenge`, { nonce: r.nonce, contentHash: "0".repeat(64), decision: "approve" })).status).toBe(409);
    const ch = await challengeFor(r);
    const out = await decide(r, device.assert(ch.body.challenge, base, rpId), { contentHash: "f".repeat(64) });
    expect(out).toMatchObject({ status: 403, body: { reason: "content_changed" } });
    expect((await pool!.query(`SELECT status FROM proposal WHERE id = $1`, [r.proposalId])).rows[0].status).toBe("pending");
  });

  it("supersedes the request when a target changed after staging, applying nothing", async () => {
    const r = await newProposalRequest("stale version");
    const ch = await challengeFor(r);
    await pool!.query(`UPDATE proposal SET version = version + 1 WHERE id = $1`, [r.proposalId]);
    const out = await decide(r, device.assert(ch.body.challenge, base, rpId));
    expect(out).toMatchObject({ status: 409, body: { result: "superseded" } });
    expect((await pool!.query(`SELECT status FROM governance_request WHERE id = $1`, [r.id])).rows[0].status).toBe("superseded");
    expect((await pool!.query(`SELECT status FROM proposal WHERE id = $1`, [r.proposalId])).rows[0].status).toBe("pending");
  });

  it("refuses the wrong origin, the wrong RP ID, and a missing user-verification flag", async () => {
    const r = await newProposalRequest("ceremony checks");
    for (const opts of [{ origin: "https://evil.example" }, { rpId: "evil.example" }, { uv: false }]) {
      const ch = await challengeFor(r);
      const a = device.assert(ch.body.challenge, opts.origin ?? base, opts.rpId ?? rpId, { userVerified: opts.uv ?? true });
      expect((await decide(r, a)).status).toBe(403);
    }
    expect((await pool!.query(`SELECT status FROM governance_request WHERE id = $1`, [r.id])).rows[0].status).toBe("pending");
  });

  it("refuses a revoked credential, and a credential belonging to another principal", async () => {
    const r = await newProposalRequest("revoked");
    const ch = await challengeFor(r);
    const intruder = new SoftwareAuthenticator();
    await pool!.query(`INSERT INTO webauthn_credential (principal_subject, credential_id, public_key, enrolled_via) VALUES ('user_someone_else', $1, $2, 'admin_enrollment_code')`,
      [intruder.credentialId, Buffer.from(intruder.cosePublicKey)]);
    expect((await decide(r, intruder.assert(ch.body.challenge, base, rpId))).body.reason).toBe("credential_not_owned");
    const id = (await pool!.query(`SELECT id FROM webauthn_credential WHERE credential_id = $1`, [device.credentialId])).rows[0].id;
    expect(await revokeCredential(migrator!, id)).toBe(true);
    const out = await decide(r, device.assert(ch.body.challenge, base, rpId));
    expect(out).toMatchObject({ status: 403, body: { reason: "credential_revoked" } });
    expect((await pool!.query(`SELECT status FROM governance_request WHERE id = $1`, [r.id])).rows[0].status).toBe("pending");
  });

  it("executes a conflict resolution (accept the new due date) and an archival through the same flow", async () => {
    // Fresh passkey for this test (the main one was revoked above), enrolled with a new admin code.
    const fresh = new SoftwareAuthenticator();
    activeDevice = fresh;
    const code = await mintEnrollmentCode(migrator!, PRINCIPAL);
    const b = (await (await post("/approve/enroll/begin", { code })).json()) as { ceremonyId: string; options: { challenge: string } };
    expect((await post("/approve/enroll/finish", { ceremonyId: b.ceremonyId, response: fresh.register(b.options.challenge, base, rpId) })).status).toBe(200);

    const proj = (await pool!.query<{ id: string }>(`INSERT INTO project (name) VALUES ('M5 lease ${Date.now()}') RETURNING id`)).rows[0]!.id;
    const wi = (await pool!.query<{ id: string; version: number }>(
      `INSERT INTO work_item (project_id, kind, title, due_at, due_precision, due_owner, origin, disputed)
       VALUES ($1, 'deadline', 'Lease review', '2026-10-16T03:59:00Z', 'day', 'finagai', 'user_stated', true) RETURNING id, version`, [proj])).rows[0]!;
    const cap = (await pool!.query<{ id: string }>(`INSERT INTO capture (idempotency_key, client, mode, source_type, source_text, sanitized_at, status, pipeline_version)
      VALUES ($1, 'test', 'eval', 'note', 'due Oct 20', now(), 'processed', 't') RETURNING id`, [`m5-${Date.now()}`])).rows[0]!.id;
    const cand = (await pool!.query<{ id: string }>(`INSERT INTO capture_candidate (capture_id, item_type, payload, source_quote, outcome)
      VALUES ($1, 'deadline', '{}', 'due Oct 20', 'conflict') RETURNING id`, [cap])).rows[0]!.id;
    const conflict = (await pool!.query<{ id: string; version: number }>(`INSERT INTO conflict (existing_type, existing_id, candidate_id, field, new_value, explanation)
      VALUES ('work_item', $1, $2, 'due_at', '{"date_resolved":"2026-10-21T03:59:00Z"}', 'two dates') RETURNING id, version`, [wi.id, cand])).rows[0]!;
    const staged = await stageGovernanceRequest(pool!, { FINAGAI_PUBLIC_BASE_URL: base, GOVERNANCE_REQUEST_TTL_HOURS: 72 }, {
      action: "resolve_conflict", client: "claude_ai", rationale: "Julian confirmed Oct 20",
      targets: [{ type: "conflict", id: conflict.id, version: conflict.version }, { type: "work_item", id: wi.id, version: wi.version }],
      before: { field: "due_at", new_value: { date_resolved: "2026-10-21T03:59:00Z" } }, after: { resolution: "accept_new" } });
    const r = { path: new URL(staged.approvalUrl).pathname, nonce: new URL(staged.approvalUrl).searchParams.get("n")!, contentHash: staged.contentHash };
    const ch = await challengeFor(r);
    expect((await decide(r, fresh.assert(ch.body.challenge, base, rpId))).body.result).toBe("executed");
    const after = (await pool!.query(`SELECT due_at, disputed FROM work_item WHERE id = $1`, [wi.id])).rows[0];
    expect(after.due_at.toISOString()).toBe("2026-10-21T03:59:00.000Z");
    expect(after.disputed).toBe(false);
    expect((await pool!.query(`SELECT status FROM conflict WHERE id = $1`, [conflict.id])).rows[0].status).toBe("accept_new");

    const wiNow = (await pool!.query<{ version: number }>(`SELECT version FROM work_item WHERE id = $1`, [wi.id])).rows[0]!;
    const arch = await stageGovernanceRequest(pool!, { FINAGAI_PUBLIC_BASE_URL: base, GOVERNANCE_REQUEST_TTL_HOURS: 72 }, {
      action: "archive_records", client: "claude_ai", rationale: "done", targets: [{ type: "work_item", id: wi.id, version: wiNow.version }],
      before: [{ archived: false }], after: [{ archived: true }] });
    const a = { path: new URL(arch.approvalUrl).pathname, nonce: new URL(arch.approvalUrl).searchParams.get("n")!, contentHash: arch.contentHash };
    const ch2 = await challengeFor(a);
    expect((await decide(a, fresh.assert(ch2.body.challenge, base, rpId))).body.result).toBe("executed");
    expect((await pool!.query(`SELECT archived_at FROM work_item WHERE id = $1`, [wi.id])).rows[0].archived_at).not.toBeNull();
    expect((await pool!.query(`SELECT count(*)::int AS n FROM work_item WHERE id = $1`, [wi.id])).rows[0].n).toBe(1); // archived, never deleted
  });
});

// ------------------------------------------------------------------------------ M7 seeding (synthetic data only)
describe.skipIf(!url || !migratorUrl)("M7 seeding: staged until Julian's approved promotion", () => {
  const RECEIVED = new Date("2026-10-01T14:00:00Z");
  const cand = (over: Partial<Candidate>): Candidate => ({ temp_id: "c", item_type: "task", fields: {}, source_quote: "", explicitly_stated: true,
    stated_by: "julian", epistemic_status: "user_provided", classification: "internal", source_visibility: "non_public",
    project_mention: null, date_expression: null, date_resolved: null, completion_stated: false, ...over });
  const scripted = (candidates: Candidate[], relation: (t: { temp_id: string; matches: Array<{ id: string }> }) => object = (i) => ({ temp_id: i.temp_id, relation: "new", target_id: null, changed_fields: [], rationale: "new" })) => ({
    async complete(req: ModelRequest): Promise<ModelResult> {
      const body = req.step === "extract" ? { language: "en", candidates }
        : { judgments: (JSON.parse(messageText(req.messages[0]!.content)) as Array<{ temp_id: string; matches: Array<{ id: string }> }>).map(relation) };
      return { text: JSON.stringify(body), model: req.model, stopReason: "end_turn", costUsd: 0, retries: 0, latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    } });
  const j2 = (model: J2Deps["model"]): J2Deps => ({ pool: pool!, model, now: () => RECEIVED,
    cfg: { FINAGAI_TIMEZONE: "America/New_York", MODEL_J2_EXTRACT: "claude-sonnet-5-5", MODEL_J2_CLASSIFY: "claude-sonnet-5-5", MAX_DEFERRED_CAPTURES: 200, RETENTION_CONFIDENTIAL_THIRD_PARTY_DAYS: 180 } });
  const key = () => `seed-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  it("ingests, consolidates, asks, records answers, and promotes only after a WebAuthn-approved request", async () => {
    // A live fact the seeded source will contradict.
    const liveCap = (await pool!.query<{ id: string }>(`INSERT INTO capture (idempotency_key, client, mode, source_type, source_text, sanitized_at, status, pipeline_version)
      VALUES ($1,'test','eval','note','x',now(),'processed','t') RETURNING id`, [key()])).rows[0]!.id;
    const liveFact = (await pool!.query<{ id: string }>(`INSERT INTO knowledge_item (subject_type, claim, epistemic_status, source_visibility, as_of, source_capture_id, source_quote)
      VALUES ('julian', 'Seedtest supplier is Northwind Snacks', 'user_provided', 'non_public', now(), $1, 'x') RETURNING id`, [liveCap])).rows[0]!.id;

    const medical = "my cardiologist adjusted my beta blocker dose";
    const srcA = [
      "Seedtest Route Expansion is a current project.",
      "Confirm placement terms with Seedtest Harbor Lights by Oct 9.",
      "The Seedtest permit renewal deadline is coming up.",
      "Order Seedtest coin mechanisms.",
      `Personal: ${medical}.`,
    ].join(" ");
    const a = await addSource(j2(scripted([
      cand({ temp_id: "p", item_type: "project", fields: { name: "Seedtest Route Expansion" }, source_quote: "Seedtest Route Expansion is a current project" }),
      cand({ temp_id: "t1", fields: { title: "Confirm placement terms with Seedtest Harbor Lights" }, source_quote: "Confirm placement terms with Seedtest Harbor Lights by Oct 9",
        project_mention: "Seedtest Route Expansion", date_expression: "by Oct 9", date_resolved: "2026-10-09T23:59:00-04:00" }),
      cand({ temp_id: "d", item_type: "deadline", fields: { title: "Seedtest permit renewal" }, source_quote: "The Seedtest permit renewal deadline is coming up", project_mention: "Seedtest Route Expansion" }),
      cand({ temp_id: "t2", fields: { title: "Order Seedtest coin mechanisms" }, source_quote: "Order Seedtest coin mechanisms" }),
      cand({ temp_id: "m", item_type: "fact", fields: { claim: "x" }, classification: "highly_sensitive", source_quote: medical }),
    ])), { text: srcA, title: "Current work", idempotencyKey: key() });
    expect(a.stagedCount).toBe(4);
    const srcB = "Confirm placement terms with Seedtest Harbor Lights by Oct 12. Seedtest supplier is Tri-County Wholesale.";
    await addSource(j2(scripted([
      cand({ temp_id: "t1b", fields: { title: "Confirm placement terms with Seedtest Harbor Lights" }, source_quote: "Confirm placement terms with Seedtest Harbor Lights by Oct 12",
        project_mention: "Seedtest Route Expansion", date_expression: "by Oct 12", date_resolved: "2026-10-12T23:59:00-04:00" }),
      cand({ temp_id: "f", item_type: "fact", fields: { claim: "Seedtest supplier is Tri-County Wholesale" }, source_quote: "Seedtest supplier is Tri-County Wholesale" }),
    ], (i) => ({ temp_id: i.temp_id, relation: i.matches.some((m) => m.id === liveFact) ? "conflict" : "new", target_id: i.matches.some((m) => m.id === liveFact) ? liveFact : null, changed_fields: ["claim"], rationale: "r" }))),
      { text: srcB, idempotencyKey: key(), batchId: a.batchId });

    // Nothing is live yet, and the sensitive phrase is nowhere.
    const liveFromBatch = async () => (await pool!.query(`SELECT count(*)::int AS n FROM work_item w JOIN capture c ON c.id = w.source_capture_id WHERE c.seed_batch_id = $1`, [a.batchId])).rows[0].n;
    expect(await liveFromBatch()).toBe(0);
    expect((await pool!.query(`SELECT count(*)::int AS n FROM project WHERE name = 'Seedtest Route Expansion'`)).rows[0].n).toBe(0);
    for (const t of ["capture", "capture_candidate", "event"]) {
      expect((await pool!.query(`SELECT count(*)::int AS n FROM ${t} x WHERE x::text ILIKE '%beta blocker%'`)).rows[0].n).toBe(0);
    }

    const q = await questions(j2(scripted([])), a.batchId);
    const kinds = q.groups.flatMap((g) => g.questions.map((x) => x.kind)).sort();
    expect(kinds).toEqual(expect.arrayContaining(["conflict_in_batch", "conflict_with_existing", "missing_due_date", "missing_project"]));
    expect((await pool!.query(`SELECT status FROM seed_batch WHERE id = $1`, [a.batchId])).rows[0].status).toBe("review");

    const all = (await pool!.query<{ id: string; payload: Candidate; seed_overrides: Record<string, string> | null }>(
      `SELECT cc.id, cc.payload, cc.seed_overrides FROM capture_candidate cc JOIN capture c ON c.id = cc.capture_id WHERE c.seed_batch_id = $1 AND cc.outcome = 'staged'`, [a.batchId])).rows;
    const byTemp = (t: string) => all.find((x) => x.payload.temp_id === t)!.id;
    const res = await answer(j2(scripted([])), a.batchId, [
      { candidate_id: byTemp("d"), action: "set_due", value: "October 20" },
      { candidate_id: byTemp("t2"), action: "set_project", value: "Seedtest Route Expansion" },
      { candidate_id: byTemp("t1b"), action: "reject" },               // Julian: the Oct 9 source is right
      { candidate_id: byTemp("d"), action: "set_due", value: "whenever" }, // unreadable: refused, not guessed
      ...["p", "t1", "d", "t2", "f"].map((t) => ({ candidate_id: byTemp(t), action: "confirm" as const })),
    ]);
    expect(res.filter((r) => !r.ok).map((r) => r.error)).toEqual([expect.stringMatching(/could not read that date/)]);
    expect(await liveFromBatch()).toBe(0); // answers change staging only

    // Promotion: staged request, then Julian's passkey on the approval page.
    const batch = (await pool!.query<{ version: number }>(`SELECT version FROM seed_batch WHERE id = $1`, [a.batchId])).rows[0]!;
    const staged = await stageGovernanceRequest(pool!, { FINAGAI_PUBLIC_BASE_URL: base, GOVERNANCE_REQUEST_TTL_HOURS: 72 }, {
      action: "promote_seed_batch", client: "claude_ai", rationale: "Julian reviewed the seeding batch",
      targets: [{ type: "seed_batch", id: a.batchId, version: batch.version }], before: { status: "review" }, after: { status: "promoted" } });
    expect(await liveFromBatch()).toBe(0);
    const r = { path: new URL(staged.approvalUrl).pathname, nonce: new URL(staged.approvalUrl).searchParams.get("n")!, contentHash: staged.contentHash };
    const ch = await challengeFor(r);
    const out = await decide(r, activeDevice.assert(ch.body.challenge, base, rpId));
    expect(out.body).toMatchObject({ result: "executed", detail: { projects: 1, work_items: 3, conflicts: 1 } });

    const items = (await pool!.query(`SELECT w.title, w.due_at, p.name AS project FROM work_item w JOIN project p ON p.id = w.project_id
      JOIN capture c ON c.id = w.source_capture_id WHERE c.seed_batch_id = $1 ORDER BY w.title`, [a.batchId])).rows;
    expect(items.map((i) => [i.title, i.project])).toEqual([
      ["Confirm placement terms with Seedtest Harbor Lights", "Seedtest Route Expansion"],
      ["Order Seedtest coin mechanisms", "Seedtest Route Expansion"],
      ["Seedtest permit renewal", "Seedtest Route Expansion"],
    ]);
    expect(items[0].due_at.toISOString()).toBe("2026-10-10T03:59:00.000Z"); // Oct 9, code-verified
    expect(items[2].due_at.toISOString()).toBe("2026-10-21T03:59:00.000Z"); // Julian's "October 20"
    expect((await pool!.query(`SELECT status FROM knowledge_item WHERE id = $1`, [liveFact])).rows[0].status).toBe("active"); // conflict opened, not overwritten
    expect((await pool!.query(`SELECT count(*)::int AS n FROM conflict WHERE existing_id = $1 AND status = 'open'`, [liveFact])).rows[0].n).toBe(1);
    const evs = (await pool!.query(`SELECT count(*)::int AS n FROM event WHERE actor = 'seed' AND approval_id = $1 AND principal = $2`, [staged.approvalId, PRINCIPAL])).rows[0].n;
    expect(evs).toBeGreaterThanOrEqual(5);
    expect((await pool!.query(`SELECT status, promoted_at FROM seed_batch WHERE id = $1`, [a.batchId])).rows[0].status).toBe("promoted");
    // The rejected duplicate stays staged, never live.
    expect((await pool!.query(`SELECT outcome, confirmation FROM capture_candidate WHERE id = $1`, [byTemp("t1b")])).rows[0]).toEqual({ outcome: "staged", confirmation: "rejected" });
  });
});
