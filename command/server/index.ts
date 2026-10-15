/**
 * Finagai Command Center — backend-for-frontend (ADR-089, slice 1).
 *
 *   GET  /healthz                 liveness + version (no auth, no data)
 *   GET  /auth/login              start OIDC sign-in (code + PKCE + Core resource)
 *   GET  /auth/callback           finish sign-in → opaque session cookie
 *   POST /auth/logout             end the session (same-origin only)
 *   GET  /api/session             { signedIn } — never a token, never the principal id
 *   GET  /api/live/<allowed>      proxy to Core /live/<allowed> with the session's Core token; SSE streamed unbuffered
 *                                 (contract, snapshot, events, history, stream, summary/reliability, chain/<eventId>)
 *   GET  /*                       the SPA (signed-in only; otherwise → /auth/login)
 *
 * Read-only toward Core: only GET, only the allow-listed /live paths. Tokens are added server-side and never echoed.
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadConfig, type CcConfig } from "./config.js";
import { Oidc, SignInError } from "./oidc.js";
import { Sessions } from "./session.js";

// Slice 3: chain/<eventId> (the Why inspector's causal chain; a SELECT in Core). Still GET-only, still allow-listed.
const LIVE_PATHS = /^\/api\/live\/(contract|snapshot|events|history|stream|summary\/reliability|chain\/\d{1,15})$/;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };
const BASE_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cross-origin-opener-policy": "same-origin" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export function createBff(cfg: CcConfig, deps: { fetchFn?: typeof fetch; log?: (m: string, f?: Record<string, unknown>) => void } = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const log = deps.log ?? ((m, f) => console.log(JSON.stringify({ level: "info", msg: m, ...f })));
  const oidc = new Oidc(cfg, fetchFn);
  const sessions = new Sessions(oidc, cfg.sessionIdleMs, undefined, log);
  const SESSION = cfg.secureCookies ? "__Host-fcc" : "fcc";
  const STATE = cfg.secureCookies ? "__Host-fcc-signin" : "fcc-signin";
  const RETURN = cfg.secureCookies ? "__Host-fcc-return" : "fcc-return";
  // SameSite=Lax (not Strict): the sign-in callback is a top-level navigation coming back from the identity provider;
  // a Strict cookie would not be sent on that redirect chain and sign-in would loop. The app exposes no state-changing
  // GET, and the only POST (logout) checks Origin, so Lax gives the same protection here.
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${cfg.secureCookies ? "; Secure" : ""}; Max-Age=${maxAge}`;
  const sid = (req: http.IncomingMessage) => readCookie(req.headers.cookie, SESSION);

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...BASE_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  };
  const page = (res: http.ServerResponse, status: number, title: string, text: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP, ...BASE_HEADERS, ...headers });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/notice.css"></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/auth/login">Sign in again</a></p></main></body></html>`);
  };

  async function proxyLive(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const id = sid(req);
    let token = await sessions.accessToken(id);
    if (!token) return send(res, 401, { error: "signed_out" });
    const corePath = url.pathname.replace(/^\/api/, "");
    const target = `${cfg.coreUrl}${corePath}${url.search.length < 2000 ? url.search : ""}`;
    const isStream = corePath === "/live/stream";
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const call = (t: string) => fetchFn(target, { headers: { authorization: `Bearer ${t}`, accept: isStream ? "text/event-stream" : "application/json",
      ...(isStream && req.headers["last-event-id"] ? { "last-event-id": String(req.headers["last-event-id"]).slice(0, 20) } : {}) }, signal: ac.signal });
    let up: Response;
    try {
      up = await call(token);
      if (up.status === 401) { await up.body?.cancel(); token = await sessions.accessToken(id, true); if (!token) return send(res, 401, { error: "signed_out" }); up = await call(token); }
    } catch (e) {
      if (ac.signal.aborted) return;
      log("core unreachable", { path: corePath, error: String((e as Error)?.message ?? e).slice(0, 120) });
      return send(res, 502, { error: "core_unreachable" });
    }
    if (up.status === 401) { await up.body?.cancel(); return send(res, 401, { error: "signed_out" }); }
    if (!isStream || !up.ok) {
      const body = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...BASE_HEADERS });
      return res.end(body);
    }
    // SSE: pass bytes through as they arrive — no buffering, no compression, no transformation
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...BASE_HEADERS });
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    const reader = up.body!.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise<void>((r) => res.once("drain", () => r()));
      }
    } catch { /* client or Core went away */ }
    finally { ac.abort(); res.end(); }
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const signedIn = sessions.has(sid(req));
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const isAsset = rel.startsWith("/assets/") || rel === "/notice.css" || rel === "/favicon.svg";
    if (!signedIn && !isAsset) {
      // Slice 3: a deep link (e.g. /?why=escalation:<id>) survives sign-in — only a same-origin "/?<query>" is ever kept
      const back = returnPath(`${url.pathname}${url.search}`);
      res.writeHead(302, { location: back && back !== "/" ? `/auth/login?return=${encodeURIComponent(back)}` : "/auth/login", "cache-control": "no-store", ...BASE_HEADERS });
      return res.end();
    }
    let file = join(cfg.staticDir, rel);
    if (!file.startsWith(cfg.staticDir)) return send(res, 404, { error: "not_found" });
    const exists = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (!exists) { if (isAsset) return send(res, 404, { error: "not_found" }); file = join(cfg.staticDir, "index.html"); }   // SPA route
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, { error: "not_found" });
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
      ...(type.startsWith("text/html") ? { "content-security-policy": CSP } : {}), ...BASE_HEADERS });
    res.end(body);
  }

  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", cfg.publicUrl);
    void (async () => {
      try {
        if (url.pathname === "/healthz") return send(res, 200, { ok: true, version: cfg.version });
        if (url.pathname === "/auth/login" && req.method === "GET") {
          const { redirect, stateCookie } = await oidc.begin();
          const back = returnPath(url.searchParams.get("return") ?? "");
          res.writeHead(302, { location: redirect, "set-cookie": [cookie(STATE, stateCookie, 600), ...(back ? [cookie(RETURN, encodeURIComponent(back), 600)] : [cookie(RETURN, "", 0)])], "cache-control": "no-store", ...BASE_HEADERS });
          return res.end();
        }
        if (url.pathname === "/auth/callback" && req.method === "GET") {
          const err = url.searchParams.get("error");
          if (err) return page(res, 401, "Sign-in did not complete", `The identity provider answered: ${err}${url.searchParams.get("error_description") ? ` — ${url.searchParams.get("error_description")}` : ""}`);
          try {
            const tokens = await oidc.complete(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "", readCookie(req.headers.cookie, STATE));
            const id = sessions.create(tokens);
            log("signed in", { sessions: sessions.size });
            const back = returnPath(safeDecode(readCookie(req.headers.cookie, RETURN) ?? "")) ?? "/";
            res.writeHead(302, { location: back, "set-cookie": [cookie(SESSION, id, Math.floor(cfg.sessionIdleMs / 1000)), cookie(STATE, "", 0), cookie(RETURN, "", 0)], "cache-control": "no-store", ...BASE_HEADERS });
            return res.end();
          } catch (e) {
            const why = e instanceof SignInError ? e.message : "sign-in failed";
            log("sign-in refused", { reason: why });
            return page(res, 401, "Sign-in refused", why, { "set-cookie": cookie(STATE, "", 0) });
          }
        }
        if (url.pathname === "/auth/logout" && req.method === "POST") {
          if (req.headers.origin !== cfg.publicUrl) return send(res, 403, { error: "cross_origin" });
          sessions.destroy(sid(req));
          return send(res, 200, { signedOut: true }, { "set-cookie": cookie(SESSION, "", 0) });
        }
        if (url.pathname === "/api/session") return send(res, 200, { signedIn: sessions.has(sid(req)), version: cfg.version });
        if (url.pathname.startsWith("/api/")) {
          if (req.method !== "GET") return send(res, 405, { error: "read_only" }, { allow: "GET" });
          if (!LIVE_PATHS.test(url.pathname)) return send(res, 404, { error: "not_found" });
          return await proxyLive(req, res, url);
        }
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "read_only" }, { allow: "GET" });
        return await serveStatic(req, res, url);
      } catch (e) {
        log("request failed", { path: url.pathname, error: String((e as Error)?.message ?? e).slice(0, 160) });
        if (!res.headersSent) send(res, 500, { error: "internal_error" }); else res.end();
      }
    })();
  };
  return { handler, sessions };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("="); }
  return undefined;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const { handler } = createBff(cfg);
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000; server.requestTimeout = 0;   // SSE connections are long-lived
  server.listen(cfg.port, () => console.log(JSON.stringify({ level: "info", msg: "command center listening", port: cfg.port, version: cfg.version })));
}

/**
 * Where to land after sign-in: only the app's own root with a plain query ("/?why=escalation:<id>&diag"), never another
 * path, origin or scheme — so it can never become an open redirect. Anything else → null (land on "/").
 */
export function returnPath(v: string): string | null {
  return /^\/(\?[A-Za-z0-9_=&:.%-]{1,300})?$/.test(v) ? v : null;
}
function safeDecode(v: string) { try { return decodeURIComponent(v); } catch { return ""; } }
