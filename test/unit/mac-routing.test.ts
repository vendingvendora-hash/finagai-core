/**
 * Regression: /mac/* paths must be dispatched to the control handler, not 404'd by app.ts.
 * The M01 chart failed in production with "/mac/chart -> HTTP 404" because app.ts only forwarded
 * "/control/*". This locks the fix.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../../src/server/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createLogger } from "../../src/server/log.js";

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
} as Record<string, string>;

describe("/mac/* routing (M01 404 regression)", () => {
  let server: http.Server; let baseUrl = "";
  const seen: string[] = [];
  beforeAll(async () => {
    const cfg = loadConfig(env);
    const control = async (_req: http.IncomingMessage, res: http.ServerResponse, path: string) => {
      seen.push(path);
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" }));
    };
    server = http.createServer(createHandler(cfg, { version: "test", startedAt: new Date() }, createLogger(cfg, () => {}), { control } as never));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("dispatches /mac/chart to the control handler (401, not 404)", async () => {
    const r = await fetch(`${baseUrl}/mac/chart`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);           // reached the handler (which requires auth), not a 404
    expect(seen).toContain("/mac/chart");
  });
  it("dispatches /control/next to the control handler too", async () => {
    const r = await fetch(`${baseUrl}/control/next`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(seen).toContain("/control/next");
  });
  it("dispatches /artifact/* and /interaction/* to the control handler (not 404)", async () => {
    for (const path of ["/artifact/register", "/artifact/recent", "/interaction/claim", "/action/claim", "/action/report", "/mac/diag"]) {
      const r = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(r.status).toBe(401);          // reached the handler, not a 404
      expect(seen).toContain(path);
    }
  });
});
