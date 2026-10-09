import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { loadConfig, type Config } from "../../src/config/index.js";
import { createHandler } from "../../src/server/app.js";
import { createLogger } from "../../src/server/log.js";
import { signSession, SESSION_COOKIE } from "../../src/approval/session.js";

const env = {
  NODE_ENV: "test",
  FINAGAI_PUBLIC_BASE_URL: "https://core.example.test",
  FINAGAI_MCP_RESOURCE_URL: "https://core.example.test/mcp",
  DATABASE_URL: "postgres://finagai_app:canary-db-secret-123@db.example.test/finagai",
  ANTHROPIC_API_KEY: "canary-anthropic-secret-123",
  OAUTH_ISSUER: "https://auth.example.test",
  OAUTH_JWKS_URL: "https://auth.example.test/oauth2/jwks",
  PRINCIPAL_SUBJECT: "user_julian_test",
  APPROVAL_CLIENT_ID: "client_test",
  APPROVAL_CLIENT_SECRET: "canary-approval-secret-123",
  SESSION_SECRET: "canary-session-secret-0123456789abcdef",
  RESEND_API_KEY: "canary-resend-secret-123",
  NOTIFY_FROM: "Finagai <review@notify.example.test>",
  NOTIFY_TO: "julian@example.test",
  NOTIFY_REPLY_TO: "julian@example.test",
};

let issuerKey: CryptoKey;
let attackerKey: CryptoKey;
let jwk: JWK;
const logLines: string[] = [];

async function serve(cfg: Config) {
  const server = http.createServer(createHandler(cfg, { version: "test", startedAt: new Date() },
    createLogger(cfg, (l) => logLines.push(l)), { keys: createLocalJWKSet({ keys: [jwk] }) }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const cfg = loadConfig(env);
let base = "";
let server: http.Server;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  issuerKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256" };
  attackerKey = (await generateKeyPair("ES256")).privateKey;
  ({ server, base } = await serve(cfg));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

interface TokenOpts { iss?: string; aud?: string; sub?: string; exp?: number; client_id?: string; key?: CryptoKey }
async function token(o: TokenOpts = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ client_id: o.client_id ?? "https://claude.ai/oauth/client-metadata" })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(o.iss ?? env.OAUTH_ISSUER).setAudience(o.aud ?? env.FINAGAI_MCP_RESOURCE_URL)
    .setSubject(o.sub ?? env.PRINCIPAL_SUBJECT).setIssuedAt(now).setExpirationTime(o.exp ?? now + 300)
    .sign(o.key ?? issuerKey);
}
const mcp = (b: string, headers: Record<string, string> = {}) => fetch(`${b}/mcp`, { method: "POST", headers, body: "{}" });

describe("public endpoints", () => {
  it("serves allow-listed browser test fixtures only (Phase 1 live acceptance)", async () => {
    const ok = await fetch(`${base}/fixtures/apply.html`);
    expect(ok.status).toBe(200); expect(ok.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(await ok.text()).toContain("Submit application");
    expect((await fetch(`${base}/fixtures/../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/fixtures/secret.txt`)).status).toBe(404);
  });
  it("serves /health without configuration or secrets", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: "ok", service: "finagai-core" });
    expect(text).not.toMatch(/canary|auth\.example\.test/);
  });

  it("publishes protected-resource metadata whose resource equals the MCP URL exactly", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(await (await fetch(base + path)).json()).toEqual({
        resource: "https://core.example.test/mcp", authorization_servers: ["https://auth.example.test"], bearer_methods_supported: ["header"],
      });
    }
  });

  it("returns 404 elsewhere and sets security headers", async () => {
    const res = await fetch(`${base}/anything`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("M3 bearer verification on /mcp", () => {
  it("accepts Julian's valid token (tools not implemented yet: 501)", async () => {
    expect((await mcp(base, { authorization: `Bearer ${await token()}` })).status).toBe(501);
  });

  it("challenges a request with no token, pointing at the metadata", async () => {
    const res = await mcp(base);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="unauthorized"');
    expect(res.headers.get("www-authenticate")).toContain('resource_metadata="https://core.example.test/.well-known/oauth-protected-resource"');
  });

  const rejected: Array<[string, () => Promise<string>]> = [
    ["wrong issuer", () => token({ iss: "https://evil.example.test" })],
    ["wrong audience", () => token({ aud: "https://other.example.test/mcp" })],
    ["audience differing only by trailing slash", () => token({ aud: "https://core.example.test/mcp/" })],
    ["expired", () => token({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ["another user", () => token({ sub: "user_someone_else" })],
    ["signed by an unknown key", () => token({ key: attackerKey })],
    ["symmetric algorithm", async () => new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer(env.OAUTH_ISSUER)
      .setAudience(env.FINAGAI_MCP_RESOURCE_URL).setSubject(env.PRINCIPAL_SUBJECT).setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-shared-secret-that-must-not-work"))],
  ];
  for (const [name, make] of rejected) {
    it(`rejects a token with ${name}`, async () => {
      const res = await mcp(base, { authorization: `Bearer ${await make()}` });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    });
  }

  it("rejects malformed authorization headers", async () => {
    for (const h of ["Basic abc", "Bearer not-a-jwt", "Bearer a.b"]) {
      expect((await mcp(base, { authorization: h })).status).toBe(401);
    }
  });

  it("enforces the pinned Claude client ID once configured", async () => {
    const pinned = await serve(loadConfig({ ...env, ALLOWED_MCP_CLIENT_IDS: "https://claude.ai/oauth/client-metadata" }));
    try {
      expect((await mcp(pinned.base, { authorization: `Bearer ${await token()}` })).status).toBe(501);
      expect((await mcp(pinned.base, { authorization: `Bearer ${await token({ client_id: "other-client" })}` })).status).toBe(401);
    } finally {
      pinned.server.close();
    }
  });
});

describe("separation of MCP and approval authentication", () => {
  const now = Math.floor(Date.now() / 1000);
  const session = (sub = env.PRINCIPAL_SUBJECT, exp = now + 600) => signSession({ sub, authTime: now, exp }, env.SESSION_SECRET);

  it("refuses bearer tokens on approval endpoints, even Julian's valid MCP token", async () => {
    const res = await fetch(`${base}/approve/x`, { headers: { authorization: `Bearer ${await token()}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bearer_not_accepted" });
  });

  it("refuses an approval session cookie on /mcp", async () => {
    const res = await mcp(base, { cookie: `${SESSION_COOKIE}=${session()}` });
    expect(res.status).toBe(401);
  });

  it("requires a valid, unexpired, correctly signed session for Julian on /approve", async () => {
    const get = (cookie?: string) => fetch(`${base}/approve/x`, cookie ? { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } } : {});
    expect((await get()).status).toBe(401);
    expect((await get(session())).status).toBe(501); // authenticated; flow arrives in M5
    expect((await get(session("user_someone_else"))).status).toBe(401);
    expect((await get(session(env.PRINCIPAL_SUBJECT, now - 1))).status).toBe(401);
    const tampered = session().replace(/\.[^.]+$/, ".AAAA");
    expect((await get(tampered)).status).toBe(401);
    const forged = signSession({ sub: env.PRINCIPAL_SUBJECT, authTime: now, exp: now + 600 }, "a-different-secret-0123456789abcdef");
    expect((await get(forged)).status).toBe(401);
  });

  it("never logs secrets or tokens", () => {
    expect(logLines.join("\n")).not.toMatch(/canary|eyJ/);
  });
});
