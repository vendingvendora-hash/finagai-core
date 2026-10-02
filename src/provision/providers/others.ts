/** Resend, WorkOS, Cloudflare, and Anthropic adapters (each a thin layer over its official REST API). */
import { api, ProviderError } from "../http.js";
import type { Secret } from "../secret.js";

export interface DnsRecord { type: string; name: string; value: string; priority?: number }

export class Resend {
  constructor(private readonly token: Secret, private readonly base = "https://api.resend.com") {}
  private call<T = any>(path: string, c: Parameters<typeof api>[2] = {}) {
    return api<T>("Resend", this.base + path, { ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
  }
  async findDomain(name: string) { return (await this.call<{ data: Array<{ id: string; name: string; status: string }> }>("/domains")).json.data.find((d) => d.name === name) ?? null; }
  async createDomain(name: string) { return (await this.call<{ id: string }>("/domains", { body: { name } })).json; }
  async domain(id: string) {
    const d = (await this.call<{ status: string; records: Array<{ type: string; name: string; value: string; priority?: number }> }>(`/domains/${id}`)).json;
    return { status: d.status, records: d.records.map((r) => ({ type: r.type, name: r.name, value: r.value, ...(r.priority !== undefined ? { priority: r.priority } : {}) })) };
  }
  async verify(id: string) { await this.call(`/domains/${id}/verify`, { method: "POST", ok: [200, 202] }); }
  async keys() { return (await this.call<{ data: Array<{ id: string; name: string }> }>("/api-keys")).json.data; }
  async createSendingKey(name: string, domainId: string) {
    return (await this.call<{ id: string; token: string }>("/api-keys", { body: { name, permission: "sending_access", domain_id: domainId } })).json;
  }
  async deleteKey(id: string) { await this.call(`/api-keys/${id}`, { method: "DELETE", ok: [200, 204] }); }
}

export class WorkOS {
  constructor(private readonly token: Secret, private readonly base = "https://api.workos.com") {}
  private call<T = any>(path: string, c: Parameters<typeof api>[2] = {}) {
    return api<T>("WorkOS", this.base + path, { ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
  }
  async userByEmail(email: string) { return (await this.call<{ data: Array<{ id: string; email: string }> }>(`/user_management/users?email=${encodeURIComponent(email)}`)).json.data[0] ?? null; }
  async pendingInvitation(email: string) {
    return (await this.call<{ data: Array<{ id: string; state: string }> }>(`/user_management/invitations?email=${encodeURIComponent(email)}`)).json.data.find((i) => i.state === "pending") ?? null;
  }
  async invite(email: string) { await this.call("/user_management/invitations", { body: { email } }); }
}

/** Discovery and credential probes against the AuthKit domain (no management key needed). */
export async function authkitDiscovery(issuer: string) {
  const oidc = (await api<{ issuer: string; token_endpoint: string; authorization_endpoint: string; jwks_uri: string }>("WorkOS", `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)).json;
  const as = (await api<{ code_challenge_methods_supported?: string[]; client_id_metadata_document_supported?: boolean; registration_endpoint?: string }>(
    "WorkOS", `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`)).json;
  return { oidc, as };
}

/** invalid_grant on a bogus code means the client ID and secret are right; invalid_client means they are not. */
export async function probeClientSecret(tokenEndpoint: string, clientId: string, secret: Secret, redirectUri: string): Promise<string | null> {
  try {
    await api("WorkOS", tokenEndpoint, { form: { grant_type: "authorization_code", code: "finagai-probe", redirect_uri: redirectUri,
      client_id: clientId, client_secret: secret.reveal() }, ok: [200] });
    return null;
  } catch (err) {
    if (err instanceof ProviderError && /invalid_grant/.test(err.message)) return null;
    if (err instanceof ProviderError && /invalid_client|unauthorized_client/.test(err.message)) return "WorkOS rejected that client ID and secret";
    return err instanceof Error ? err.message : "could not verify";
  }
}

export class Cloudflare {
  constructor(private readonly token: Secret, private readonly base = "https://api.cloudflare.com/client/v4") {}
  private call<T = any>(path: string, c: Parameters<typeof api>[2] = {}) {
    return api<T>("Cloudflare", this.base + path, { ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
  }
  async zoneId(apex: string) {
    const z = (await this.call<{ result: Array<{ id: string; name: string }> }>(`/zones?name=${encodeURIComponent(apex)}`)).json.result[0];
    if (!z) throw new Error(`Cloudflare token cannot see zone ${apex}`);
    return z.id;
  }
  async ensureRecord(zoneId: string, r: DnsRecord) {
    const existing = (await this.call<{ result: Array<{ id: string; content: string }> }>(`/zones/${zoneId}/dns_records?type=${r.type}&name=${encodeURIComponent(r.name)}`)).json.result;
    if (existing.some((e) => e.content.replace(/"/g, "") === r.value.replace(/"/g, ""))) return false;
    await this.call(`/zones/${zoneId}/dns_records`, { body: { type: r.type, name: r.name, content: r.value, ttl: 1, ...(r.priority !== undefined ? { priority: r.priority } : {}) } });
    return true;
  }
}

/** Anthropic: keys are created by Julian in the Console; this only validates one, at no cost (model listing). */
export async function validateAnthropicKey(key: Secret, base = "https://api.anthropic.com"): Promise<string | null> {
  try {
    await api("Anthropic", `${base}/v1/models?limit=1`, { headers: { "x-api-key": key.reveal(), "anthropic-version": "2023-06-01" } });
    return null;
  } catch (err) {
    return err instanceof ProviderError && err.status === 401 ? "Anthropic rejected that key" : (err instanceof Error ? err.message : "could not verify");
  }
}
