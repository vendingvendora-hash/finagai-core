/**
 * Approval-page sign-in: a standard OIDC authorization-code flow with PKCE against the configured
 * identity provider (ADR-029: provider-neutral, OAuth/OIDC boundary only). Separate client from the
 * MCP connector; the result is Core's own session cookie, never a bearer token.
 *
 * Freshness: requests `prompt=login` and `max_age=0`. Whether the provider honors them is not
 * relied upon for authority: every approval also requires a fresh WebAuthn assertion (ADR-030).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  principalSubject: string;
}

interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class OidcClient {
  private discovery?: Discovery;
  private keys?: JWTVerifyGetKey;
  constructor(private readonly cfg: OidcConfig, private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
    keys?: JWTVerifyGetKey) { if (keys) this.keys = keys; }

  private async disco(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url = new URL(".well-known/openid-configuration", this.cfg.issuer.endsWith("/") ? this.cfg.issuer : `${this.cfg.issuer}/`);
    const r = await this.fetchFn(url.toString());
    if (!r.ok) throw new Error("identity provider discovery failed");
    const d = (await r.json()) as Discovery;
    if (d.issuer !== this.cfg.issuer) throw new Error("identity provider issuer mismatch");
    this.discovery = d;
    this.keys ??= createRemoteJWKSet(new URL(d.jwks_uri));
    return d;
  }

  /** Returns the provider URL to redirect to and a signed cookie holding state, nonce, and PKCE verifier. */
  async begin(returnTo: string): Promise<{ redirect: string; loginCookie: string }> {
    const d = await this.disco();
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri,
      scope: "openid", state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "login", max_age: "0" })) url.searchParams.set(k, v);
    const payload = JSON.stringify({ state, nonce, verifier, returnTo: safeReturn(returnTo), exp: Math.floor(Date.now() / 1000) + 600 });
    return { redirect: url.toString(), loginCookie: sign(payload, this.cfg.sessionSecret) };
  }

  /** Completes sign-in. Returns the authenticated subject and auth time, or throws. */
  async complete(code: string, state: string, loginCookie: string | undefined): Promise<{ sub: string; authTime: number; returnTo: string }> {
    const raw = loginCookie ? unsign(loginCookie, this.cfg.sessionSecret) : null;
    if (!raw) throw new Error("sign-in expired or was not started here");
    const pending = JSON.parse(raw) as { state: string; nonce: string; verifier: string; returnTo: string; exp: number };
    if (pending.exp < Math.floor(Date.now() / 1000)) throw new Error("sign-in expired");
    if (!eq(pending.state, state)) throw new Error("sign-in state mismatch");
    const d = await this.disco();
    const r = await this.fetchFn(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri,
        client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code_verifier: pending.verifier }).toString(),
    });
    if (!r.ok) throw new Error("token exchange failed");
    const tok = (await r.json()) as { id_token?: string };
    if (!tok.id_token) throw new Error("no id_token returned");
    const { payload } = await jwtVerify(tok.id_token, this.keys!, {
      issuer: this.cfg.issuer, audience: this.cfg.clientId, algorithms: ["RS256", "ES256", "EdDSA"], clockTolerance: 60,
    });
    if (payload.nonce !== pending.nonce) throw new Error("sign-in nonce mismatch");
    if (payload.sub !== this.cfg.principalSubject) throw new Error("not the principal");
    const authTime = typeof payload.auth_time === "number" ? payload.auth_time : Math.floor(Date.now() / 1000);
    return { sub: payload.sub, authTime, returnTo: pending.returnTo };
  }
}

/** Only same-site approval paths may be returned to (no open redirects). */
function safeReturn(p: string): string {
  return /^\/approve(\/[A-Za-z0-9\-/?=&_.%]*)?$/.test(p) ? p : "/approve";
}

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function sign(payload: string, secret: string): string {
  const body = Buffer.from(payload).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function unsign(value: string, secret: string): string | null {
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  return eq(mac, expected) ? Buffer.from(body, "base64url").toString("utf8") : null;
}
