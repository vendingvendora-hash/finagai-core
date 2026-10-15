/**
 * A minimal OIDC/OAuth provider for tests (authorization code + PKCE + RFC 8707 resource + refresh), standing in for
 * WorkOS AuthKit. It signs ID and access tokens with one ES256 key whose JWKS the fixture Core also trusts.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface FakeOidcOptions {
  clientId: string; clientSecret: string; subject: string;
  /** when false, the access token's audience is the client id (what a provider that ignores `resource` would do) */
  honorResource?: boolean;
  accessTtlSec?: number;
  clientIdClaim?: string;
}

export async function startFakeOidc(opts: FakeOidcOptions) {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "fake-1", alg: "ES256", use: "sig" };
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string; resource: string | null }>();
  const refreshes = new Set<string>();
  const issued: string[] = [];
  let issuer = "";
  const state = { honorResource: opts.honorResource ?? true, subject: opts.subject, refreshCalls: 0 };

  const access = async (resource: string | null) => {
    const t = await new SignJWT({ client_id: opts.clientIdClaim ?? opts.clientId }).setProtectedHeader({ alg: "ES256", kid: "fake-1" }).setIssuer(issuer)
      .setSubject(state.subject).setAudience(state.honorResource && resource ? resource : opts.clientId).setIssuedAt().setExpirationTime(`${opts.accessTtlSec ?? 300}s`).sign(pair.privateKey);
    issued.push(t); return t;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (url.pathname === "/.well-known/openid-configuration") return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== opts.clientId || p.get("code_challenge_method") !== "S256") return json(400, { error: "invalid_request" });
      const code = randomBytes(16).toString("hex");
      codes.set(code, { challenge: p.get("code_challenge")!, nonce: p.get("nonce")!, redirect: p.get("redirect_uri")!, resource: p.get("resource") });
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(p.get("state")!)}` }); return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      if (f.get("client_id") !== opts.clientId || f.get("client_secret") !== opts.clientSecret) return json(401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code") ?? ""); codes.delete(f.get("code") ?? "");
        if (!c || c.redirect !== f.get("redirect_uri") || createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json(400, { error: "invalid_grant" });
        const id = await new SignJWT({ nonce: c.nonce }).setProtectedHeader({ alg: "ES256", kid: "fake-1" }).setIssuer(issuer).setSubject(state.subject).setAudience(opts.clientId).setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
        const refresh = randomBytes(16).toString("hex"); refreshes.add(refresh); issued.push(refresh, id);
        return json(200, { token_type: "Bearer", access_token: await access(c.resource), id_token: id, refresh_token: refresh, expires_in: opts.accessTtlSec ?? 300 });
      }
      if (f.get("grant_type") === "refresh_token") {
        state.refreshCalls++;
        if (!refreshes.has(f.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant" });
        refreshes.delete(f.get("refresh_token")!); const refresh = randomBytes(16).toString("hex"); refreshes.add(refresh); issued.push(refresh);
        return json(200, { token_type: "Bearer", access_token: await access(f.get("resource")), refresh_token: refresh, expires_in: opts.accessTtlSec ?? 300 });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, jwk, privateKey: pair.privateKey, state, issued, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A cookie-keeping client that follows redirects like a browser (per-host cookie jar, manual redirects). */
export function browserLike() {
  const jar = new Map<string, Map<string, string>>();
  const bodies: string[] = []; const headers: string[] = [];
  async function go(url: string, init: RequestInit = {}, hops = 10): Promise<{ status: number; url: string; text: string; res: Response }> {
    const u = new URL(url);
    const cookies = [...(jar.get(u.host) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string> ?? {}), ...(cookies ? { cookie: cookies } : {}) } });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";"); const [k, ...v] = kv!.split("="); const m = jar.get(u.host) ?? new Map<string, string>(); jar.set(u.host, m);
      if (/Max-Age=0/i.test(sc)) m.delete(k!); else m.set(k!, v.join("="));
    }
    headers.push(JSON.stringify([...res.headers.entries()]));
    if (res.status >= 300 && res.status < 400 && res.headers.get("location") && hops > 0) return go(new URL(res.headers.get("location")!, url).toString(), {}, hops - 1);
    const isStream = (res.headers.get("content-type") ?? "").includes("event-stream");
    const text = isStream ? "" : await res.text();
    if (!isStream) bodies.push(text);
    return { status: res.status, url, text, res };
  }
  return { go, jar, bodies, headers, cookieHeader: (host: string) => [...(jar.get(host) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join("; ") };
}
