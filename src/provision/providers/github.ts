/** GitHub REST adapter. Environment secrets are encrypted locally (libsodium sealed box) before upload. */
import sodium from "libsodium-wrappers";
import { api } from "../http.js";
import type { Secret } from "../secret.js";

export class GitHub {
  constructor(private readonly token: Secret, private readonly base = "https://api.github.com") {}
  private h() { return { authorization: `Bearer ${this.token.reveal()}`, "x-github-api-version": "2022-11-28" }; }
  private call<T = any>(path: string, c: Parameters<typeof api>[2] = {}) { return api<T>("GitHub", this.base + path, { ...c, headers: { ...this.h(), ...c.headers } }); }

  async user() { return (await this.call<{ login: string; id: number }>("/user")).json; }
  async repoExists(owner: string, repo: string) { return (await this.call(`/repos/${owner}/${repo}`, { ok: [200, 404] })).status === 200; }
  async createRepo(name: string) { await this.call("/user/repos", { body: { name, private: true, auto_init: false } }); }
  async hasBranch(owner: string, repo: string, branch: string) { return (await this.call(`/repos/${owner}/${repo}/branches/${branch}`, { ok: [200, 404] })).status === 200; }

  async ensureEnvironment(owner: string, repo: string, env: string, reviewerId: number) {
    await this.call(`/repos/${owner}/${repo}/environments/${env}`, { method: "PUT", body: { reviewers: [{ type: "User", id: reviewerId }], prevent_self_review: false } });
  }
  async hasEnvSecret(owner: string, repo: string, env: string, name: string) {
    return (await this.call(`/repos/${owner}/${repo}/environments/${env}/secrets/${name}`, { ok: [200, 404] })).status === 200;
  }
  async setEnvSecret(owner: string, repo: string, env: string, name: string, value: Secret) {
    const pk = (await this.call<{ key_id: string; key: string }>(`/repos/${owner}/${repo}/environments/${env}/secrets/public-key`)).json;
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(sodium.from_string(value.reveal()), sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL));
    await this.call(`/repos/${owner}/${repo}/environments/${env}/secrets/${name}`, { method: "PUT",
      body: { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: pk.key_id } });
  }
  async setEnvVar(owner: string, repo: string, env: string, name: string, value: string) {
    const exists = (await this.call(`/repos/${owner}/${repo}/environments/${env}/variables/${name}`, { ok: [200, 404] })).status === 200;
    if (exists) await this.call(`/repos/${owner}/${repo}/environments/${env}/variables/${name}`, { method: "PATCH", body: { name, value } });
    else await this.call(`/repos/${owner}/${repo}/environments/${env}/variables`, { body: { name, value } });
  }
  async protectMain(owner: string, repo: string, checks: string[]) {
    await this.call(`/repos/${owner}/${repo}/branches/main/protection`, { method: "PUT", body: {
      required_status_checks: { strict: true, contexts: checks }, enforce_admins: false, required_pull_request_reviews: null, restrictions: null } });
  }
  async dispatch(owner: string, repo: string, workflow: string) {
    await this.call(`/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, { body: { ref: "main" } });
  }
  async latestRun(owner: string, repo: string, workflow: string) {
    const r = (await this.call<{ workflow_runs: Array<{ id: number; status: string; conclusion: string | null; html_url: string; created_at: string }> }>(
      `/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=1`)).json;
    return r.workflow_runs[0] ?? null;
  }
}
