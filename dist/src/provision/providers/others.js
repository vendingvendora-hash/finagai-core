/** Resend, WorkOS, Cloudflare, and Anthropic adapters (each a thin layer over its official REST API). */
import { api, ProviderError } from "../http.js";
export class Resend {
    token;
    base;
    constructor(token, base = "https://api.resend.com") {
        this.token = token;
        this.base = base;
    }
    call(path, c = {}) {
        return api("Resend", this.base + path, { ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
    }
    async findDomain(name) { return (await this.call("/domains")).json.data.find((d) => d.name === name) ?? null; }
    async createDomain(name) { return (await this.call("/domains", { body: { name } })).json; }
    async domain(id) {
        const d = (await this.call(`/domains/${id}`)).json;
        return { status: d.status, records: d.records.map((r) => ({ type: r.type, name: r.name, value: r.value, ...(r.priority !== undefined ? { priority: r.priority } : {}) })) };
    }
    async verify(id) { await this.call(`/domains/${id}/verify`, { method: "POST", ok: [200, 202] }); }
    async keys() { return (await this.call("/api-keys")).json.data; }
    async createSendingKey(name, domainId) {
        return (await this.call("/api-keys", { body: { name, permission: "sending_access", domain_id: domainId } })).json;
    }
    async deleteKey(id) { await this.call(`/api-keys/${id}`, { method: "DELETE", ok: [200, 204] }); }
}
export class WorkOS {
    token;
    base;
    constructor(token, base = "https://api.workos.com") {
        this.token = token;
        this.base = base;
    }
    call(path, c = {}) {
        return api("WorkOS", this.base + path, { ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
    }
    async userByEmail(email) { return (await this.call(`/user_management/users?email=${encodeURIComponent(email)}`)).json.data[0] ?? null; }
    async pendingInvitation(email) {
        return (await this.call(`/user_management/invitations?email=${encodeURIComponent(email)}`)).json.data.find((i) => i.state === "pending") ?? null;
    }
    async invite(email) { await this.call("/user_management/invitations", { body: { email } }); }
}
/** Discovery and credential probes against the AuthKit domain (no management key needed). */
export async function authkitDiscovery(issuer) {
    const oidc = (await api("WorkOS", `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)).json;
    const as = (await api("WorkOS", `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`)).json;
    return { oidc, as };
}
/** invalid_grant on a bogus code means the client ID and secret are right; invalid_client means they are not. */
export async function probeClientSecret(tokenEndpoint, clientId, secret, redirectUri) {
    try {
        await api("WorkOS", tokenEndpoint, { form: { grant_type: "authorization_code", code: "finagai-probe", redirect_uri: redirectUri,
                client_id: clientId, client_secret: secret.reveal() }, ok: [200] });
        return null;
    }
    catch (err) {
        if (err instanceof ProviderError && /invalid_grant/.test(err.message))
            return null;
        if (err instanceof ProviderError && /invalid_client|unauthorized_client/.test(err.message))
            return "WorkOS rejected that client ID and secret";
        return err instanceof Error ? err.message : "could not verify";
    }
}
export class Cloudflare {
    token;
    base;
    constructor(token, base = "https://api.cloudflare.com/client/v4") {
        this.token = token;
        this.base = base;
    }
    call(path, c = {}) {
        return api("Cloudflare", this.base + path, { ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
    }
    async zoneId(apex) {
        const z = (await this.call(`/zones?name=${encodeURIComponent(apex)}`)).json.result[0];
        if (!z)
            throw new Error(`Cloudflare token cannot see zone ${apex}`);
        return z.id;
    }
    async ensureRecord(zoneId, r) {
        const existing = (await this.call(`/zones/${zoneId}/dns_records?type=${r.type}&name=${encodeURIComponent(r.name)}`)).json.result;
        if (existing.some((e) => e.content.replace(/"/g, "") === r.value.replace(/"/g, "")))
            return false;
        await this.call(`/zones/${zoneId}/dns_records`, { body: { type: r.type, name: r.name, content: r.value, ttl: 1, ...(r.priority !== undefined ? { priority: r.priority } : {}) } });
        return true;
    }
}
/** Anthropic: keys are created by Julian in the Console; this only validates one, at no cost (model listing). */
export async function validateAnthropicKey(key, base = "https://api.anthropic.com") {
    try {
        await api("Anthropic", `${base}/v1/models?limit=1`, { headers: { "x-api-key": key.reveal(), "anthropic-version": "2023-06-01" } });
        return null;
    }
    catch (err) {
        return err instanceof ProviderError && err.status === 401 ? "Anthropic rejected that key" : (err instanceof Error ? err.message : "could not verify");
    }
}
//# sourceMappingURL=others.js.map