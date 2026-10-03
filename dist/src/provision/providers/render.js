/** Render API v1 adapter. List endpoints return arrays of { <kind>, cursor } objects. */
import { api } from "../http.js";
export class Render {
    token;
    base;
    constructor(token, base = "https://api.render.com/v1") {
        this.token = token;
        this.base = base;
    }
    call(path, c = {}) {
        return api("Render", this.base + path, { ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
    }
    async owners() { return (await this.call("/owners?limit=20")).json.map((o) => o.owner); }
    async findEnvGroup(name, ownerId) {
        const r = (await this.call(`/env-groups?ownerId=${ownerId}&name=${encodeURIComponent(name)}`)).json;
        return r.map((x) => x.envGroup).find((g) => g.name === name) ?? null;
    }
    async createEnvGroup(name, ownerId) {
        return (await this.call("/env-groups", { body: { name, ownerId, envVars: [] } })).json;
    }
    async groupVars(groupId) {
        const g = (await this.call(`/env-groups/${groupId}`)).json;
        return new Map((g.envVars ?? []).map((v) => [v.key, v.value]));
    }
    async setGroupVar(groupId, key, value) {
        await this.call(`/env-groups/${groupId}/env-vars/${key}`, { method: "PUT", body: { value: typeof value === "string" ? value : value.reveal() } });
    }
    async findService(name, ownerId) {
        const r = (await this.call(`/services?ownerId=${ownerId}&name=${encodeURIComponent(name)}`)).json;
        return r.map((x) => x.service).find((s) => s.name === name) ?? null;
    }
    async createService(spec) {
        return (await this.call("/services", { body: spec })).json.service;
    }
    async service(id) { return (await this.call(`/services/${id}`)).json; }
    async linkGroup(groupId, serviceId) { await this.call(`/env-groups/${groupId}/services/${serviceId}`, { method: "POST", ok: [200, 201, 204, 409] }); }
    async deploy(serviceId) { return (await this.call(`/services/${serviceId}/deploys`, { body: {} })).json.id; }
    async deployStatus(serviceId, deployId) { return (await this.call(`/services/${serviceId}/deploys/${deployId}`)).json.status; }
}
//# sourceMappingURL=render.js.map