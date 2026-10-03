import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { AuthError, extractBearer, verifyAccessToken } from "../auth/bearer.js";
import { readCookie, SESSION_COOKIE, verifySession } from "../approval/session.js";
const MAX_MCP_BODY_BYTES = 1_000_000;
async function toWebRequest(req, url) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > MAX_MCP_BODY_BYTES)
            throw new Error("request body too large");
        chunks.push(c);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined)
            continue;
        for (const one of Array.isArray(v) ? v : [v])
            headers.append(k, one);
    }
    const method = req.method ?? "GET";
    return new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
}
async function writeWebResponse(res, r) {
    const headers = { ...SECURITY_HEADERS };
    r.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(r.status, headers);
    if (!r.body) {
        res.end();
        return;
    }
    await new Promise((resolve, reject) => {
        Readable.fromWeb(r.body).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
    });
}
const SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
};
function send(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
}
export function protectedResourceMetadata(cfg) {
    return {
        resource: cfg.FINAGAI_MCP_RESOURCE_URL,
        authorization_servers: [cfg.OAUTH_ISSUER], // Claude uses only the first entry
        bearer_methods_supported: ["header"],
    };
}
export function metadataUrl(cfg) {
    return new URL("/.well-known/oauth-protected-resource", cfg.FINAGAI_PUBLIC_BASE_URL).toString();
}
export function createHandler(cfg, info, log, deps) {
    const mcpPath = new URL(cfg.FINAGAI_MCP_RESOURCE_URL).pathname;
    const observed = new Set();
    const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
    const challenge = (error) => `Bearer error="${error}", error_description="Authorization needed", resource_metadata="${metadataUrl(cfg)}"`;
    async function authenticateMcp(req) {
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
        if (path !== "/health")
            res.on("finish", () => log("http", { requestId, method: req.method, path, status: res.statusCode, ms: Date.now() - started }));
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
            authenticateMcp(req).then(async (principal) => {
                if (cfg.ALLOWED_MCP_CLIENT_IDS.length === 0) {
                    log("mcp client id observed (not yet pinned)", { requestId, clientId: principal.clientId });
                    // Recorded once per client ID so provisioning can pin it without anyone copying logs.
                    if (principal.clientId && deps.onClientObserved && !observed.has(principal.clientId)) {
                        observed.add(principal.clientId);
                        deps.onClientObserved(principal.clientId).catch(() => observed.delete(principal.clientId));
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
                }
                catch (err) {
                    log("mcp request failed", { requestId, error: err instanceof Error ? err.name : "error" });
                    if (!res.headersSent)
                        send(res, 500, { error: "internal_error" });
                }
            }, (err) => {
                const code = err instanceof AuthError ? err.code : "malformed_token";
                log("mcp request rejected", { requestId, reason: code });
                const status = code === "keys_unavailable" ? 503 : 401;
                send(res, status, { error: status === 503 ? "temporarily_unavailable" : "unauthorized" }, status === 401 ? { "www-authenticate": challenge(code === "missing_token" ? "unauthorized" : "invalid_token") } : {});
            });
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
            if (!session)
                return send(res, 401, { error: "sign_in_required" });
            // Session valid. Sign-in, WebAuthn ceremony, and execution are implemented in M5.
            return send(res, 501, { error: "not_implemented" });
        }
        if (path.startsWith("/concierge/") && deps.concierge) {
            void deps.concierge(req, res, path);
            return;
        }
        if ((path.startsWith("/control/") || path.startsWith("/mac/") || path.startsWith("/artifact/") || path.startsWith("/interaction/")) && deps.control) {
            void deps.control(req, res, path);
            return;
        }
        return send(res, 404, { error: "not_found" });
    };
}
//# sourceMappingURL=app.js.map