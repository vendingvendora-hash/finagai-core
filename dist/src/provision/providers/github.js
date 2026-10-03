/** GitHub REST adapter. Environment secrets are encrypted locally (libsodium sealed box) before upload. */
import sodium from "libsodium-wrappers";
import { api } from "../http.js";
export class GitHub {
    token;
    base;
    constructor(token, base = "https://api.github.com") {
        this.token = token;
        this.base = base;
    }
    h() { return { authorization: `Bearer ${this.token.reveal()}`, "x-github-api-version": "2022-11-28" }; }
    call(path, c = {}) { return api("GitHub", this.base + path, { ...c, headers: { ...this.h(), ...c.headers } }); }
    async user() { return (await this.call("/user")).json; }
    async repoExists(owner, repo) { return (await this.call(`/repos/${owner}/${repo}`, { ok: [200, 404] })).status === 200; }
    async createRepo(name) { await this.call("/user/repos", { body: { name, private: true, auto_init: false } }); }
    async hasBranch(owner, repo, branch) { return (await this.call(`/repos/${owner}/${repo}/branches/${branch}`, { ok: [200, 404] })).status === 200; }
    async ensureEnvironment(owner, repo, env, reviewerId) {
        await this.call(`/repos/${owner}/${repo}/environments/${env}`, { method: "PUT", body: { reviewers: [{ type: "User", id: reviewerId }], prevent_self_review: false } });
    }
    async hasEnvSecret(owner, repo, env, name) {
        return (await this.call(`/repos/${owner}/${repo}/environments/${env}/secrets/${name}`, { ok: [200, 404] })).status === 200;
    }
    async setEnvSecret(owner, repo, env, name, value) {
        const pk = (await this.call(`/repos/${owner}/${repo}/environments/${env}/secrets/public-key`)).json;
        await sodium.ready;
        const sealed = sodium.crypto_box_seal(sodium.from_string(value.reveal()), sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL));
        await this.call(`/repos/${owner}/${repo}/environments/${env}/secrets/${name}`, { method: "PUT",
            body: { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: pk.key_id } });
    }
    async setEnvVar(owner, repo, env, name, value) {
        const exists = (await this.call(`/repos/${owner}/${repo}/environments/${env}/variables/${name}`, { ok: [200, 404] })).status === 200;
        if (exists)
            await this.call(`/repos/${owner}/${repo}/environments/${env}/variables/${name}`, { method: "PATCH", body: { name, value } });
        else
            await this.call(`/repos/${owner}/${repo}/environments/${env}/variables`, { body: { name, value } });
    }
    async protectMain(owner, repo, checks) {
        await this.call(`/repos/${owner}/${repo}/branches/main/protection`, { method: "PUT", body: {
                required_status_checks: { strict: true, contexts: checks }, enforce_admins: false, required_pull_request_reviews: null, restrictions: null
            } });
    }
    async dispatch(owner, repo, workflow) {
        await this.call(`/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, { body: { ref: "main" } });
    }
    async latestRun(owner, repo, workflow) {
        const r = (await this.call(`/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=1`)).json;
        return r.workflow_runs[0] ?? null;
    }
}
//# sourceMappingURL=github.js.map