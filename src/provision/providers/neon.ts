/** Neon API v2 adapter. */
import { api, ProviderError } from "../http.js";
import type { Secret } from "../secret.js";

/**
 * True when Neon refused because the organization's plan is below Launch (ADR-028). Neon reports this as 402,
 * or as a 400 naming a setting above the plan's maximum (Free allows 6 hours of history; we request 7 days).
 */
export function needsPlanUpgrade(e: unknown): boolean {
  if (!(e instanceof ProviderError)) return false;
  return e.status === 402 || /plan|limit|billing|exceeds allowed maximum/i.test(e.message);
}

export interface NeonProject { id: string; name: string }
export class Neon {
  constructor(private readonly token: Secret, private readonly base = "https://console.neon.tech/api/v2") {}
  private call<T = any>(path: string, c: Parameters<typeof api>[2] = {}) {
    // 423: the project still has operations running (for example right after creation); wait instead of failing.
    return api<T>("Neon", this.base + path, { busy: [423], ...c, headers: { authorization: `Bearer ${this.token.reveal()}`, ...c.headers } });
  }
  async orgs() { return (await this.call<{ organizations: Array<{ id: string; name: string }> }>("/users/me/organizations")).json.organizations; }
  async findProject(name: string, orgId: string) {
    const r = (await this.call<{ projects: NeonProject[] }>(`/projects?org_id=${encodeURIComponent(orgId)}&search=${encodeURIComponent(name)}`)).json;
    return r.projects.find((p) => p.name === name) ?? null;
  }
  async createProject(name: string, orgId: string) {
    return (await this.call<{ project: NeonProject }>("/projects", { body: { project: {
      name, org_id: orgId, region_id: "aws-us-east-1", pg_version: 16, history_retention_seconds: 604_800,
      default_endpoint_settings: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.5, suspend_timeout_seconds: 0 },
    } } })).json.project;
  }
  async defaultBranch(projectId: string) {
    const r = (await this.call<{ branches: Array<{ id: string; name: string; default: boolean; protected: boolean }> }>(`/projects/${projectId}/branches`)).json;
    const b = r.branches.find((x) => x.default);
    if (!b) throw new Error("Neon project has no default branch");
    return b;
  }
  async protectBranch(projectId: string, branchId: string) {
    await this.call(`/projects/${projectId}/branches/${branchId}`, { method: "PATCH", body: { branch: { protected: true } } });
  }
  async host(projectId: string, branchId: string) {
    const r = (await this.call<{ endpoints: Array<{ host: string; branch_id: string; type: string }> }>(`/projects/${projectId}/endpoints`)).json;
    const e = r.endpoints.find((x) => x.branch_id === branchId && x.type === "read_write");
    if (!e) throw new Error("Neon branch has no read-write compute endpoint");
    return e.host; // the direct host, not the pooler (Core sets connection options the pooler rejects)
  }
  async roleExists(projectId: string, branchId: string, role: string) {
    return (await this.call(`/projects/${projectId}/branches/${branchId}/roles/${role}`, { ok: [200, 404] })).status === 200;
  }
  async createRole(projectId: string, branchId: string, role: string) {
    await this.call(`/projects/${projectId}/branches/${branchId}/roles`, { body: { role: { name: role } } });
  }
  async revealPassword(projectId: string, branchId: string, role: string) {
    return (await this.call<{ password: string }>(`/projects/${projectId}/branches/${branchId}/roles/${role}/reveal_password`)).json.password;
  }
  async ensureDatabase(projectId: string, branchId: string, name: string, owner: string) {
    const r = (await this.call<{ databases: Array<{ name: string }> }>(`/projects/${projectId}/branches/${branchId}/databases`)).json;
    if (!r.databases.some((d) => d.name === name)) {
      await this.call(`/projects/${projectId}/branches/${branchId}/databases`, { body: { database: { name, owner_name: owner } } });
    }
  }
}
