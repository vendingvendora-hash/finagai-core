/**
 * End-to-end: SDK MCP client -> HTTP -> bearer verification -> stateless MCP handler -> tools -> Postgres.
 * Tokens are signed with locally generated keys (no WorkOS identifiers); the model is scripted.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "../../src/config/index.js";
import { createPool } from "../../src/db/index.js";
import { createHandler } from "../../src/server/app.js";
import { createLogger } from "../../src/server/log.js";
import { buildMcpServer } from "../../src/tools/server.js";
import type { ModelRequest, ModelResult } from "../../src/llm/types.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const pool = url ? createPool(url) : undefined;
let server: http.Server;
let base = "";
let key: CryptoKey;
let jwk: JWK;
const env = {
  NODE_ENV: "test", FINAGAI_PUBLIC_BASE_URL: "http://127.0.0.1", FINAGAI_MCP_RESOURCE_URL: "http://127.0.0.1/mcp",
  DATABASE_URL: url ?? "postgres://unused", ANTHROPIC_API_KEY: "unused", OAUTH_ISSUER: "https://auth.example.test",
  OAUTH_JWKS_URL: "https://auth.example.test/jwks", PRINCIPAL_SUBJECT: "user_julian_test", APPROVAL_CLIENT_ID: "c",
  APPROVAL_CLIENT_SECRET: "s", SESSION_SECRET: "x".repeat(40), RESEND_API_KEY: "r", NOTIFY_FROM: "Finagai <review@notify.example.test>",
  NOTIFY_TO: "julian@example.test", NOTIFY_REPLY_TO: "julian@example.test",
};

/** Scripted model: extracts one task whose quote is the whole input. */
const model = {
  async complete(req: ModelRequest): Promise<ModelResult> {
    const text = JSON.parse(req.messages[0]!.content).text as string;
    const body = req.step === "extract"
      ? { language: "en", candidates: [{ temp_id: "c1", item_type: "task", fields: { title: text.slice(0, 80) }, source_quote: text,
          explicitly_stated: true, stated_by: "julian", epistemic_status: "user_provided", classification: "internal",
          source_visibility: "non_public", project_mention: null, date_expression: null, date_resolved: null, completion_stated: false }] }
      : { judgments: [] };
    return { text: JSON.stringify(body), model: req.model, stopReason: "end_turn", costUsd: 0, retries: 0, latencyMs: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  },
};

beforeAll(async () => {
  if (!pool) return;
  const pair = await generateKeyPair("ES256", { extractable: true });
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cfg = loadConfig({ ...env, FINAGAI_PUBLIC_BASE_URL: base, FINAGAI_MCP_RESOURCE_URL: `${base}/mcp` });
  const mcp = createMcpHandler(() => buildMcpServer({ pool, cfg, client: "claude_ai", j2: { pool, model, cfg } }));
  server.on("request", createHandler(cfg, { version: "test", startedAt: new Date() }, createLogger(cfg, () => {}),
    { keys: createLocalJWKSet({ keys: [jwk] }), mcp }));
});
afterAll(async () => { server?.close(); await pool?.end(); });

async function token(sub = "user_julian_test") {
  return new SignJWT({ client_id: "claude-test" }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(env.OAUTH_ISSUER)
    .setAudience(`${base}/mcp`).setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(key);
}
async function connect(bearer?: string) {
  const client = new Client({ name: "finagai-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),
    bearer ? { requestInit: { headers: { authorization: `Bearer ${bearer}` } } } : {}));
  return client;
}
const json = (r: { content: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

describe.skipIf(!url)("MCP tool layer end to end", () => {
  it("lists exactly the approved tools (16 here; the 2 J3 tools are added in production), and no write-capable extras", async () => {
    const client = await connect(await token());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "capture", "get_approval_request", "get_charter", "get_item", "get_project", "get_state_overview", "list_open_conflicts",
      "list_pending_proposals", "request_archival", "request_conflict_resolution", "request_proposal_decision",
      "request_seed_promotion", "search_state", "seed_add_source", "seed_answer", "seed_questions",
    ]);
    for (const forbidden of ["delete", "approve", "resolve_conflict", "decide_proposal", "send_email", "sql"]) {
      expect(names.some((n) => n.includes(forbidden) && !n.startsWith("request_") && n !== "list_open_conflicts")).toBe(false);
    }
    await client.close();
  });

  it("refuses a client without a valid token for Julian", async () => {
    await expect(connect()).rejects.toThrow();
    await expect(connect(await token("someone_else"))).rejects.toThrow();
  });

  it("captures through J2 and reads the result back with provenance", async () => {
    const client = await connect(await token());
    const text = "I need to confirm the machine delivery window with Harbor Lights Bar.";
    const s = json(await client.callTool({ name: "capture", arguments: { text, idempotency_key: `mcp-${Date.now()}` } }));
    expect(s.status).toBe("processed");
    const id = s.applied[0].id;
    const item = json(await client.callTool({ name: "get_item", arguments: { type: "work_item", id } }));
    expect(item.provenance.sourceQuote).toBe(text);
    expect(item.events.map((e: { action: string }) => e.action)).toContain("create");
    const found = json(await client.callTool({ name: "search_state", arguments: { query: "Harbor Lights delivery" } }));
    expect(found.map((r: { id: string }) => r.id)).toContain(id);
    const overview = json(await client.callTool({ name: "get_state_overview", arguments: {} }));
    expect(overview.queues).toHaveProperty("deferred_captures");
    expect(overview.budget).toMatchObject({ targetUsd: 30, ceilingUsd: 36 });
    await client.close();
  });

  it("governance tools only stage: nothing changes until Julian approves", async () => {
    const client = await connect(await token());
    const procBefore = (await pool!.query(`SELECT count(*)::int AS n FROM procedure`)).rows[0].n;
    const p = await pool!.query<{ id: string }>(
      `INSERT INTO proposal (kind, proposed_text, rationale) VALUES ('procedure_change', 'Draft outreach in Spanish first', 'test') RETURNING id`);
    const res = json(await client.callTool({ name: "request_proposal_decision",
      arguments: { proposal_id: p.rows[0]!.id, decision: "approve", rationale: "Julian said yes in chat (unverified)" } }));
    expect(res.approval_url).toMatch(new RegExp(`^${base}/approve/[0-9a-f-]{36}\\?n=`));
    expect(res.note).toMatch(/Nothing has changed yet/);
    expect((await pool!.query(`SELECT status FROM proposal WHERE id = $1`, [p.rows[0]!.id])).rows[0].status).toBe("pending");
    expect((await pool!.query(`SELECT count(*)::int AS n FROM procedure`)).rows[0].n).toBe(procBefore);
    const gr = (await pool!.query(`SELECT status, decided_by_principal, nonce_hash FROM governance_request WHERE id = $1`, [res.approval_id])).rows[0];
    expect(gr).toMatchObject({ status: "pending", decided_by_principal: null });
    expect(res.approval_url).not.toContain(gr.nonce_hash); // only the hash is stored
    const status = json(await client.callTool({ name: "get_approval_request", arguments: { approval_id: res.approval_id } }));
    expect(status.status).toBe("pending");
    await client.close();
  });

  it("writes an audit event for every tool call", async () => {
    const before = (await pool!.query(`SELECT count(*)::int AS n FROM event WHERE action = 'tool_called'`)).rows[0].n;
    const client = await connect(await token());
    await client.callTool({ name: "get_charter", arguments: {} });
    await client.callTool({ name: "list_open_conflicts", arguments: {} });
    await client.close();
    const after = (await pool!.query(`SELECT count(*)::int AS n FROM event WHERE action = 'tool_called'`)).rows[0].n;
    expect(after - before).toBe(2);
  });
});
