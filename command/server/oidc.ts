/**
 * OIDC authorization code + PKCE against the existing identity provider, requesting an access token for Core's
 * resource (RFC 8707 `resource` = Core's FINAGAI_MCP_RESOURCE_URL), exactly the audience Core already verifies.
 *
 * Fail closed: the sign-in completes only if (a) the ID token is for this client, carries our nonce and names Julian,
 * and (b) the access token is a JWT that verifies against the provider's keys, was issued by the same issuer, names
 * Julian, and has Core's resource in its audience. Otherwise the user sees the exact reason and no session exists.
 * Tokens never leave this process.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { CcConfig } from "./config.js";

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
export interface Tokens { access: string; refresh: string | null; accessExp: number }

export class SignInError extends Error {}

export class Oidc {
  private disco?: Discovery;
  private keys?: JWTVerifyGetKey;
  constructor(private readonly cfg: CcConfig, private readonly fetchFn: typeof fetch = fetch) {}

  private async discovery(): Promise<Discovery> {
    if (this.disco) return this.disco;
    const r = await this.fetchFn(`${this.cfg.issuer}/.well-known/openid-configuration`);
    if (!r.ok) throw new SignInError(`identity provider discovery failed (${r.status})`);
    const d = (await r.json()) as Discovery;
    if (d.issuer.replace(/\/$/, "") !== this.cfg.issuer) throw new SignInError("identity provider issuer mismatch");
    this.disco = d;
    this.keys = createRemoteJWKSet(new URL(d.jwks_uri));
    return d;
  }

  get redirectUri() { return `${this.cfg.publicUrl}/auth/callback`; }

  /** The provider URL to send the browser to, and the signed (HttpOnly) cookie holding state, nonce and PKCE verifier. */
  async begin(): Promise<{ redirect: string; stateCookie: string }> {
    const d = await this.discovery();
    const state = randomBytes(24).toString("base64url"), nonce = randomBytes(24).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    const url = new URL(d.authorization_endpoint);
    const params: Record<string, string> = {
      response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.redirectUri, scope: "openid offline_access",
      state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      resource: this.cfg.coreResource,
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const payload = JSON.stringify({ state, nonce, verifier, exp: Math.floor(Date.now() / 1000) + 600 });
    return { redirect: url.toString(), stateCookie: sign(payload, this.cfg.stateSecret) };
  }

  async complete(code: string, state: string, stateCookie: string | undefined): Promise<Tokens> {
    const raw = stateCookie ? unsign(stateCookie, this.cfg.stateSecret) : null;
    if (!raw) throw new SignInError("sign-in expired or was not started here");
    const pending = JSON.parse(raw) as { state: string; nonce: string; verifier: string; exp: number };
    if (pending.exp < Math.floor(Date.now() / 1000)) throw new SignInError("sign-in expired");
    if (!eq(pending.state, state)) throw new SignInError("sign-in state mismatch");
    const tok = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri, code_verifier: pending.verifier, resource: this.cfg.coreResource });
    if (!tok.id_token) throw new SignInError("the provider returned no ID token");
    const { payload: id } = await jwtVerify(tok.id_token, this.keys!, { issuer: this.disco!.issuer, audience: this.cfg.clientId, algorithms: ["RS256", "ES256", "EdDSA"], clockTolerance: 60 });
    if (id.nonce !== pending.nonce) throw new SignInError("sign-in nonce mismatch");
    if (id.sub !== this.cfg.principalSubject) throw new SignInError("this account is not Finagai's principal");
    return this.checkAccess(tok);
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    const tok = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken, resource: this.cfg.coreResource });
    return this.checkAccess({ ...tok, refresh_token: tok.refresh_token ?? refreshToken });
  }

  /** The access token must be one Core will accept: verified JWT, same issuer, Julian, Core's resource in `aud`. */
  private async checkAccess(tok: { access_token?: string; refresh_token?: string; expires_in?: number }): Promise<Tokens> {
    if (!tok.access_token) throw new SignInError("the provider returned no access token");
    let claims;
    try { claims = decodeJwt(tok.access_token); } catch { throw new SignInError("the provider's access token is not a JWT Core can verify"); }
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!aud.includes(this.cfg.coreResource)) throw new SignInError(`the provider did not issue the token for Core (audience ${JSON.stringify(aud)}; Core requires ${this.cfg.coreResource})`);
    await jwtVerify(tok.access_token, this.keys!, { algorithms: ["RS256", "ES256", "EdDSA"], clockTolerance: 60 })
      .catch(() => { throw new SignInError("the access token did not verify against the provider's keys"); });
    if (String(claims.iss ?? "").replace(/\/$/, "") !== this.cfg.issuer) throw new SignInError("the access token has a different issuer than Core trusts");
    if (claims.sub !== this.cfg.principalSubject) throw new SignInError("the access token is not for Finagai's principal");
    const exp = typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + (tok.expires_in ?? 300) * 1000;
    return { access: tok.access_token, refresh: tok.refresh_token ?? null, accessExp: exp };
  }

  private async token(form: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number }> {
    const d = await this.discovery();
    const r = await this.fetchFn(d.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...form, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }).toString(),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new SignInError(`the provider refused the token request: ${String(body.error ?? r.status)}${body.error_description ? ` — ${String(body.error_description).slice(0, 200)}` : ""}`);
    return body as never;
  }
}

function sign(payload: string, secret: string) {
  const b = Buffer.from(payload).toString("base64url");
  return `${b}.${createHmac("sha256", secret).update(b).digest("base64url")}`;
}
function unsign(v: string, secret: string): string | null {
  const [b, mac] = v.split(".");
  if (!b || !mac) return null;
  return eq(createHmac("sha256", secret).update(b).digest("base64url"), mac) ? Buffer.from(b, "base64url").toString() : null;
}
function eq(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
