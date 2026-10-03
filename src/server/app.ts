/**
 * Core's HTTP surface.
 *   GET  /health                                      liveness only; never touches the database
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata for claude.ai discovery
 *   ANY  /mcp                                         bearer token required (M3); tools arrive in M3/M4
 *   ANY  /approve/*                                   approval-page session cookie only; bearer tokens refused
 * Authentication failures always return 401 with the resource_metadata challenge on /mcp, as
 * Anthropic's connector client requires. Responses never include configuration or secrets.
 */
import http from "node:http";
import { Readable } from "node:stream";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import type { JWTVerifyGetKey } from "jose";
import type { Config } from "../config/index.js";
import { AuthError, extractBearer, verifyAccessToken, type VerifiedPrincipal } from "../auth/bearer.js";
import { readCookie, SESSION_COOKIE, verifySession } from "../approval/session.js";
import type { LogFn } from "./log.js";

export interface AppInfo {
  version: string;
  startedAt: Date;
}

export interface AppDeps {
  keys: JWTVerifyGetKey;
  nowSec?: () => number;
  /** MCP tool handler; when absent, authenticated /mcp requests get 501 (used before tools existed). */
  mcp?: McpHttpHandler;
  /** Called once per newly seen MCP client ID while no client is pinned (audit event for provisioning). */
  onClientObserved?: (clientId: string) => Promise<void>;
  /** M5 approval page; when absent, /approve/* only validates the session (pre-M5 behavior). */
  approval?: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>;
  /** J5 helper API (ADR-044); its own bearer secret, checked inside the handler. */
  concierge?: (req: http.IncomingMessage, res: http.ServerResponse, path: string) => Promise<void>;
  /** J6 control API (ADR-050); same helper secret. */
  control?: (req: http.IncomingMessage, res: http.ServerResponse, path: string) => Promise<void>;
}

const MAX_MCP_BODY_BYTES = 1_000_000;

async function toWebRequest(req: http.IncomingMessage, url: string): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_MCP_BODY_BYTES) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const method = req.method ?? "GET";
  return new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
}

async function writeWebResponse(res: http.ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = { ...SECURITY_HEADERS };
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  if (!r.body) { res.end(); return; }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(r.body as never).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

export function protectedResourceMetadata(cfg: Pick<Config, "FINAGAI_MCP_RESOURCE_URL" | "OAUTH_ISSUER">) {
  return {
    resource: cfg.FINAGAI_MCP_RESOURCE_URL,
    authorization_servers: [cfg.OAUTH_ISSUER], // Claude uses only the first entry
    bearer_methods_supported: ["header"],
  };
}

export function metadataUrl(cfg: Pick<Config, "FINAGAI_PUBLIC_BASE_URL">): string {
  return new URL("/.well-known/oauth-protected-resource", cfg.FINAGAI_PUBLIC_BASE_URL).toString();
}

export function createHandler(cfg: Config, info: AppInfo, log: LogFn, deps: AppDeps): http.RequestListener {
  const mcpPath = new URL(cfg.FINAGAI_MCP_RESOURCE_URL).pathname;
  const observed = new Set<string>();
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const challenge = (error: "unauthorized" | "invalid_token") =>
    `Bearer error="${error}", error_description="Authorization needed", resource_metadata="${metadataUrl(cfg)}"`;

  async function authenticateMcp(req: http.IncomingMessage): Promise<VerifiedPrincipal> {
    if (req.headers.cookie && readCookie(req.headers.cookie, SESSION_COOKIE)) {
      // An approval session must never authorize MCP calls (separation of authentication paths).
      throw new AuthError("missing_token");
    }
    const token = extractBearer(req.headers.authorization);
    return verifyAccessToken(token, {
      issuer: cfg.OAUTH_ISSUER,
      audience: cfg.FINAGAI_MCP_RESOURCE_URL,
      principalSubject: cfg.PRINCIPAL_SUBJECT,
      allowedClientIds: cfg.ALLOWED_MCP_CLIENT_IDS,
      keys: deps.keys,
    });
  }

  return (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const started = Date.now();
    // Access log: path only. Query strings are never logged (approval links carry single-use nonces).
    if (path !== "/health") res.on("finish", () => log("http", { requestId, method: req.method, path, status: res.statusCode, ms: Date.now() - started }));

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, {
        status: "ok",
        service: "finagai-core",
        version: info.version,
        uptimeSeconds: Math.round((Date.now() - info.startedAt.getTime()) / 1000),
      });
    }

    if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" ||
        path === `/.well-known/oauth-protected-resource${mcpPath}`)) {
      return send(res, 200, protectedResourceMetadata(cfg));
    }

    if (path === mcpPath) {
      authenticateMcp(req).then(
        async (principal) => {
          if (cfg.ALLOWED_MCP_CLIENT_IDS.length === 0) {
            log("mcp client id observed (not yet pinned)", { requestId, clientId: principal.clientId });
            // Recorded once per client ID so provisioning can pin it without anyone copying logs.
            if (principal.clientId && deps.onClientObserved && !observed.has(principal.clientId)) {
              observed.add(principal.clientId);
              deps.onClientObserved(principal.clientId).catch(() => observed.delete(principal.clientId!));
            }
          }
          if (!deps.mcp) {
            send(res, 501, { error: "not_implemented", error_description: "Finagai tools are not available yet" });
            return;
          }
          try {
            const webReq = await toWebRequest(req, new URL(req.url ?? "/", cfg.FINAGAI_PUBLIC_BASE_URL).toString());
            const token = extractBearer(req.headers.authorization);
            const response = await deps.mcp.fetch(webReq, { authInfo: {
              token, clientId: principal.clientId ?? "unknown", scopes: [], expiresAt: Math.floor(principal.expiresAt.getTime() / 1000),
              extra: { subject: principal.subject },
            } });
            await writeWebResponse(res, response);
          } catch (err) {
            log("mcp request failed", { requestId, error: err instanceof Error ? err.name : "error" });
            if (!res.headersSent) send(res, 500, { error: "internal_error" });
          }
        },
        (err: unknown) => {
          const code = err instanceof AuthError ? err.code : "malformed_token";
          log("mcp request rejected", { requestId, reason: code });
          const status = code === "keys_unavailable" ? 503 : 401;
          send(res, status, { error: status === 503 ? "temporarily_unavailable" : "unauthorized" },
            status === 401 ? { "www-authenticate": challenge(code === "missing_token" ? "unauthorized" : "invalid_token") } : {});
        },
      );
      return;
    }

    if (path === "/approve" || path.startsWith("/approve/")) {
      if (req.headers.authorization) {
        log("approval request rejected: bearer credentials are never accepted here", { requestId });
        return send(res, 401, { error: "bearer_not_accepted" });
      }
      if (deps.approval) {
        void deps.approval(req, res, new URL(req.url ?? "/", cfg.FINAGAI_PUBLIC_BASE_URL));
        return;
      }
      const session = verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), cfg.SESSION_SECRET, cfg.PRINCIPAL_SUBJECT, nowSec());
      if (!session) return send(res, 401, { error: "sign_in_required" });
      // Session valid. Sign-in, WebAuthn ceremony, and execution are implemented in M5.
      return send(res, 501, { error: "not_implemented" });
    }

    if (path.startsWith("/concierge/") && deps.concierge) {
      void deps.concierge(req, res, path);
      return;
    }

    if ((path.startsWith("/control/") || path.startsWith("/mac/")) && deps.control) {
      void deps.control(req, res, path);
      return;
    }

    return send(res, 404, { error: "not_found" });
  };
}
