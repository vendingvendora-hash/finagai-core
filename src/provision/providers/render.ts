/** Render API v1 adapter. List endpoints return arrays of { <kind>, cursor } objects. */
import { api } from "../http.js";
import type { Secret } from "../secret.js";

export class Render {
  constructor(private readonly token: Secret, private readonly base = "https://api.render.com/v1") {}
  private call<T = any>(path: string, c: Parameters<typeof api>[2] = {}) {
    return api<T>("Render", this.base + path, { ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
  }
  async owners() { return (await this.call<Array<{ owner: { id: string; name: string; type: string } }>>("/owners?limit=20")).json.map((o) => o.owner); }
  async findEnvGroup(name: string, ownerId: string) {
    const r = (await this.call<Array<{ envGroup: { id: string; name: string } }>>(`/env-groups?ownerId=${ownerId}&name=${encodeURIComponent(name)}`)).json;
    return r.map((x) => x.envGroup).find((g) => g.name === name) ?? null;
  }
  async createEnvGroup(name: string, ownerId: string) {
    return (await this.call<{ id: string }>("/env-groups", { body: { name, ownerId, envVars: [] } })).json;
  }
  async groupVars(groupId: string): Promise<Map<string, string>> {
    const g = (await this.call<{ envVars: Array<{ key: string; value: string }> }>(`/env-groups/${groupId}`)).json;
    return new Map((g.envVars ?? []).map((v) => [v.key, v.value]));
  }
  async setGroupVar(groupId: string, key: string, value: string | Secret) {
    await this.call(`/env-groups/${groupId}/env-vars/${key}`, { method: "PUT", body: { value: typeof value === "string" ? value : value.reveal() } });
  }
  async findService(name: string, ownerId: string) {
    const r = (await this.call<Array<{ service: { id: string; name: string; serviceDetails?: { url?: string } } }>>(`/services?ownerId=${ownerId}&name=${encodeURIComponent(name)}`)).json;
    return r.map((x) => x.service).find((s) => s.name === name) ?? null;
  }
  async createService(spec: Record<string, unknown>) {
    return (await this.call<{ service: { id: string; serviceDetails?: { url?: string } } }>("/services", { body: spec })).json.service;
  }
  async service(id: string) { return (await this.call<{ id: string; serviceDetails?: { url?: string } }>(`/services/${id}`)).json; }
  async linkGroup(groupId: string, serviceId: string) { await this.call(`/env-groups/${groupId}/services/${serviceId}`, { method: "POST", ok: [200, 201, 204, 409] }); }
  async deploy(serviceId: string) { return (await this.call<{ id: string }>(`/services/${serviceId}/deploys`, { body: {} })).json.id; }
  async deployStatus(serviceId: string, deployId: string) { return (await this.call<{ status: string }>(`/services/${serviceId}/deploys/${deployId}`)).json.status; }
}
