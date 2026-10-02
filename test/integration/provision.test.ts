/**
 * Bootstrapper end to end (ADR-041), against FAKE provider APIs that model each official endpoint the
 * bootstrapper uses, with real libsodium decryption of GitHub secrets and a real local Postgres standing in
 * for Neon. Runs provisioning twice: the second run must create nothing. Checks that no secret reaches the
 * logs or the state file, and that every Render variable Core requires is set.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import sodium from "libsodium-wrappers";
import { configSchema } from "../../src/config/index.js";
import { Secret } from "../../src/provision/secret.js";
import { StateFile } from "../../src/provision/state.js";
import { STEPS, type Ctx } from "../../src/provision/steps.js";
import type { HumanAction } from "../../src/provision/io.js";

const admin = process.env.INTEGRATION_ADMIN_URL;
const port = admin ? Number(new URL(admin).port) : 0;
const DB = "finagai_prov";
let base = "";
let fake: http.Server;
let keys: { publicKey: Uint8Array; privateKey: Uint8Array };

// ------------------------------------------------------------------------------------------- fake providers
const W = {
  creates: { repo: 0, project: 0, group: 0, service: 0, domain: 0, sendingKey: 0, invitation: 0 },
  gh: { repo: false, pushed: false, env: null as unknown, secrets: new Map<string, string>(), vars: new Map<string, string>(), runs: new Map<string, Array<{ id: number; status: string; conclusion: string; html_url: string }>>() },
  neon: { project: false, protected: false, roles: new Set<string>(), dbs: new Set<string>() },
  render: { group: null as null | { id: string; vars: Map<string, string> }, services: new Map<string, string>(), repoAccess: false, deploys: 0 },
  resend: { domain: null as null | { id: string; checks: number }, keys: new Map<string, string>([["kb", "finagai-bootstrap"]]) },
  workos: { user: false, invited: false, cimd: false },
};

async function adminQuery(sql: string) { const c = new pg.Client({ connectionString: admin }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }

function route(req: http.IncomingMessage, body: any): [number, unknown] | Promise<[number, unknown]> {
  const u = new URL(req.url ?? "/", "http://x"); const p = u.pathname; const m = req.method;
  // GitHub
  if (p === "/gh/user") return [200, { login: "julian", id: 42 }];
  if (p === "/gh/user/repos" && m === "POST") { W.gh.repo = true; W.creates.repo++; return [201, {}]; }
  if (p === "/gh/repos/julian/finagai-core") return W.gh.repo ? [200, {}] : [404, {}];
  if (p === "/gh/repos/julian/finagai-core/branches/main") return W.gh.pushed ? [200, {}] : [404, {}];
  if (p === "/gh/repos/julian/finagai-core/branches/main/protection") return [200, {}];
  if (p === "/gh/repos/julian/finagai-core/environments/production") { W.gh.env = body; return [200, {}]; }
  if (p.endsWith("/secrets/public-key")) return [200, { key_id: "k1", key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL) }];
  let mm = /\/environments\/production\/secrets\/(\w+)$/.exec(p);
  if (mm) {
    if (m === "PUT") { W.gh.secrets.set(mm[1]!, sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey))); return [201, {}]; }
    return W.gh.secrets.has(mm[1]!) ? [200, {}] : [404, {}];
  }
  mm = /\/environments\/production\/variables(?:\/(\w+))?$/.exec(p);
  if (mm) { if (m === "GET") return W.gh.vars.has(mm[1]!) ? [200, {}] : [404, {}]; W.gh.vars.set(body.name, body.value); return [m === "POST" ? 201 : 204, {}]; }
  mm = /\/actions\/workflows\/([\w.]+)\/(dispatches|runs)$/.exec(p);
  if (mm) {
    const list = W.gh.runs.get(mm[1]!) ?? [];
    if (mm[2] === "dispatches") { list.unshift({ id: list.length + 1, status: "completed", conclusion: "success", html_url: `https://github.com/run/${mm[1]}/${list.length + 1}` }); W.gh.runs.set(mm[1]!, list); return [204, {}]; }
    return [200, { workflow_runs: list.slice(0, 1) }];
  }
  // Neon (the "Neon" database is the local test cluster)
  if (p === "/neon/users/me/organizations") return [200, { organizations: [{ id: "org1", name: "Julian" }] }];
  if (p === "/neon/projects" && m === "GET") return [200, { projects: W.neon.project ? [{ id: "proj1", name: "finagai" }] : [] }];
  if (p === "/neon/projects" && m === "POST") { W.neon.project = true; W.creates.project++; return [201, { project: { id: "proj1", name: "finagai" } }]; }
  if (p === "/neon/projects/proj1/branches") return [200, { branches: [{ id: "br1", name: "main", default: true, protected: W.neon.protected }] }];
  if (p === "/neon/projects/proj1/branches/br1" && m === "PATCH") { W.neon.protected = body.branch.protected; return [200, {}]; }
  if (p === "/neon/projects/proj1/endpoints") return [200, { endpoints: [{ host: "127.0.0.1", branch_id: "br1", type: "read_write" }] }];
  if (p === "/neon/projects/proj1/branches/br1/roles" && m === "POST") { W.neon.roles.add(body.role.name); return [201, {}]; }
  mm = /\/roles\/(\w+)(\/reveal_password)?$/.exec(p);
  if (mm) return mm[2] ? [200, { password: "neon-migrator-password" }] : (W.neon.roles.has(mm[1]!) ? [200, {}] : [404, {}]);
  if (p === "/neon/projects/proj1/branches/br1/databases") {
    if (m === "GET") return [200, { databases: [...W.neon.dbs].map((name) => ({ name })) }];
    return adminQuery(`CREATE DATABASE ${body.database.name} OWNER finagai_migrator`).then(() => { W.neon.dbs.add(body.database.name); return [201, {}] as [number, unknown]; });
  }
  // Render
  if (p === "/render/owners") return [200, [{ owner: { id: "own1", name: "Julian", type: "user" } }]];
  if (p === "/render/env-groups" && m === "GET") return [200, W.render.group ? [{ envGroup: { id: W.render.group.id, name: "finagai-core" } }] : []];
  if (p === "/render/env-groups" && m === "POST") { W.render.group = { id: "evg1", vars: new Map() }; W.creates.group++; return [201, { id: "evg1" }]; }
  if (p === "/render/env-groups/evg1") return [200, { envVars: [...W.render.group!.vars].map(([key, value]) => ({ key, value })) }];
  mm = /\/render\/env-groups\/evg1\/env-vars\/(\w+)$/.exec(p);
  if (mm) { W.render.group!.vars.set(mm[1]!, body.value); return [200, {}]; }
  if (/\/render\/env-groups\/evg1\/services\//.test(p)) return [200, {}];
  if (p === "/render/services" && m === "GET") { const n = u.searchParams.get("name")!; return [200, W.render.services.has(n) ? [{ service: { id: W.render.services.get(n), name: n } }] : []]; }
  if (p === "/render/services" && m === "POST") {
    if (!W.render.repoAccess) return [400, { message: "repository not accessible: install the Render GitHub app" }];
    const id = `srv-${body.name}`; W.render.services.set(body.name, id); W.creates.service++;
    return [201, { service: { id, name: body.name } }];
  }
  mm = /\/render\/services\/([\w-]+)(\/deploys(?:\/(\w+))?)?$/.exec(p);
  if (mm) {
    if (!mm[2]) return [200, { id: mm[1], serviceDetails: { url: "https://finagai-core.onrender.com" } }];
    if (mm[3]) return [200, { status: "live" }];
    W.render.deploys++; return [201, { id: `dep${W.render.deploys}` }];
  }
  // Resend
  if (p === "/resend/domains" && m === "GET") return [200, { data: W.resend.domain ? [{ id: W.resend.domain.id, name: "notify.vendora.example", status: "pending" }] : [] }];
  if (p === "/resend/domains" && m === "POST") { W.resend.domain = { id: "dom1", checks: 0 }; W.creates.domain++; return [201, { id: "dom1" }]; }
  if (p === "/resend/domains/dom1") return [200, { status: W.resend.domain!.checks >= 2 ? "verified" : "pending",
    records: [{ type: "TXT", name: "resend._domainkey.notify", value: "p=MIGf..." }, { type: "MX", name: "send.notify", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 }] }];
  if (p === "/resend/domains/dom1/verify") { W.resend.domain!.checks++; return [200, {}]; }
  if (p === "/resend/api-keys" && m === "GET") return [200, { data: [...W.resend.keys].map(([id, name]) => ({ id, name })) }];
  if (p === "/resend/api-keys" && m === "POST") { W.creates.sendingKey++; W.resend.keys.set("ks", body.name); return [201, { id: "ks", token: "re_sending_scoped_token_123456" }]; }
  mm = /\/resend\/api-keys\/(\w+)$/.exec(p);
  if (mm && m === "DELETE") { W.resend.keys.delete(mm[1]!); return [200, {}]; }
  // WorkOS management API and AuthKit
  if (p === "/workos/user_management/users") return [200, { data: W.workos.user ? [{ id: "user_julian", email: "julian@example.test" }] : [] }];
  if (p === "/workos/user_management/invitations" && m === "GET") return [200, { data: W.workos.invited ? [{ id: "inv1", state: "pending" }] : [] }];
  if (p === "/workos/user_management/invitations" && m === "POST") { W.workos.invited = true; W.creates.invitation++; return [201, {}]; }
  if (p === "/authkit/.well-known/openid-configuration") return [200, { issuer: `${base}/authkit`, token_endpoint: `${base}/authkit/oauth2/token`, authorization_endpoint: `${base}/authkit/oauth2/authorize`, jwks_uri: `${base}/authkit/oauth2/jwks` }];
  if (p === "/authkit/.well-known/oauth-authorization-server") return [200, { code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: W.workos.cimd, ...(W.workos.cimd ? {} : { registration_endpoint: "x" }) }];
  if (p === "/authkit/oauth2/token") return body.client_id === "client_approval" && body.client_secret === "approval-secret-value" ? [400, { error: "invalid_grant" }] : [401, { error: "invalid_client" }];
  // Anthropic
  if (p === "/anthropic/v1/models") return String(req.headers["x-api-key"]).startsWith("sk-ant-good") ? [200, { data: [] }] : [401, { error: "invalid" }];
  return [404, { error: `unmodelled ${m} ${p}` }];
}

beforeAll(async () => {
  if (!admin) return;
  await sodium.ready;
  keys = sodium.crypto_box_keypair();
  await adminQuery(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await adminQuery(`ALTER ROLE finagai_migrator CREATEROLE`);
  // On Neon, finagai_migrator CREATES finagai_app and so holds ADMIN OPTION on it (Postgres 16). Here the
  // superuser created it for the other tests, so grant the same (no inheritance of its privileges).
  await adminQuery(`GRANT finagai_app TO finagai_migrator WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`).catch(() => {});
  fake = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? (String(req.headers["content-type"]).includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {};
    const [status, out] = await route(req, body);
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => { fake?.close(); });

// ------------------------------------------------------------------------------------------- scripted Julian
const SECRETS: Record<string, string[]> = {
  neon_api_key: ["neon-key-abcdef123"], render_api_key: ["render-key-abcdef123"], workos_api_key: ["sk_workos_abcdef123"],
  resend_bootstrap_key: ["re_bootstrap_abcdef123"], anthropic_eval_key: ["sk-ant-bad-0000000", "sk-ant-good-eval-123456"],
  anthropic_runtime_key: ["sk-ant-good-runtime-123456"], approval_client_secret: ["wrong-secret-000000", "approval-secret-value"],
};
const ANSWERS: Record<string, string> = { sender_domain: "vendora.example", julian_email: "julian@example.test", approval_client_id: "client_approval", dns_cloudflare: "no" };

function makeCtx(dir: string, logs: string[], shown: Secret[], acts: string[]): Ctx {
  const used = new Map<string, number>();
  return {
    state: new StateFile(join(dir, "state.json")), log: (l) => logs.push(l), repoDir: process.cwd(), vault: new Map(), pollMs: 5,
    db: { ssl: false, port, name: DB },
    ep: { github: `${base}/gh`, neon: `${base}/neon`, render: `${base}/render`, resend: `${base}/resend`, workos: `${base}/workos`, anthropic: `${base}/anthropic` },
    exec: { ghToken: async () => new Secret("gho_github_token_abcdef"), ghLogin: async () => {}, gitPush: async () => { W.gh.pushed = true; } },
    prompt: {
      ask: async (id) => (id === "authkit_domain" ? `${base}/authkit` : ANSWERS[id] ?? (() => { throw new Error(`unexpected question ${id}`); })()),
      askSecret: async (id, _q, validate) => {
        for (;;) {
          const n = used.get(id) ?? 0; used.set(id, n + 1);
          const v = SECRETS[id]?.[Math.min(n, SECRETS[id]!.length - 1)];
          if (!v) throw new Error(`unexpected secret prompt ${id}`);
          const s = new Secret(v);
          if (!validate || !(await validate(s))) return s;
          logs.push(`  not accepted (${id})`);
        }
      },
      act: async (id: string, a: HumanAction) => {
        acts.push(id);
        if (id === "render_github_app") W.render.repoAccess = true;
        if (id === "workos_settings") W.workos.cimd = true;
        if (id === "workos_invitation") W.workos.user = true;
        if (id === "approval_passkey") {
          const c = new pg.Client({ connectionString: admin!.replace(/\/postgres$/, `/${DB}`) }); await c.connect();
          await c.query(`INSERT INTO finagai.webauthn_credential (principal_subject, credential_id, public_key, enrolled_via) VALUES ('user_julian', 'cred', '\\x01', 'admin_enrollment_code')`);
          await c.end();
        }
        if (id === "claude_connector") {
          const c = new pg.Client({ connectionString: admin!.replace(/\/postgres$/, `/${DB}`) }); await c.connect();
          await c.query(`INSERT INTO finagai.event (actor, action, after) VALUES ('system', 'mcp_client_observed', '{"client_id":"https://claude.ai/oauth/claude-code-client-metadata"}')`);
          await c.end();
        }
        if (a.waitFor) for (let i = 0; i < 50 && !(await a.waitFor()); i++) await new Promise((r) => setTimeout(r, 5));
      },
      showSecretOnce: async (_l, s) => { shown.push(s); },
    },
  };
}

async function runAll(ctx: Ctx) { for (const s of STEPS) ctx.state.step(s.id, "done", await s.run(ctx)); }

describe.skipIf(!admin)("bootstrapper (fake providers, real encryption, real Postgres)", () => {
  const dir = mkdtempSync(join(tmpdir(), "finagai-prov-"));
  const logs: string[] = [], shown: Secret[] = [], acts: string[] = [];

  it("provisions everything, pausing only for human-only actions", async () => {
    await runAll(makeCtx(dir, logs, shown, acts));
    expect(acts).toEqual(["anthropic_workspace", "render_github_app", "workos_settings", "workos_invitation", "workos_oauth_app",
      "dns_records", "approval_passkey", "claude_connector", "approve_backup.yml", "approve_readiness.yml"]);
    // Validation rejected the wrong Anthropic key and the wrong WorkOS client secret before accepting the right ones.
    expect(logs.filter((l) => l.includes("not accepted"))).toEqual(["  not accepted (anthropic_eval_key)", "  not accepted (approval_client_secret)"]);
  });

  it("put every secret in its destination, encrypted for GitHub and never anywhere else", async () => {
    expect(W.gh.secrets.get("ANTHROPIC_EVAL_API_KEY")).toBe("sk-ant-good-eval-123456");
    expect(W.gh.secrets.get("MIGRATOR_DATABASE_URL")).toBe(`postgres://finagai_migrator:neon-migrator-password@127.0.0.1:${port}/${DB}`);
    expect(W.gh.secrets.get("APP_DATABASE_URL")).toMatch(new RegExp(`^postgres://finagai_app:[A-Za-z0-9_-]{43}@127\\.0\\.0\\.1:${port}/${DB}$`));
    expect(Buffer.from(W.gh.secrets.get("BACKUP_ENCRYPTION_KEY")!, "base64")).toHaveLength(32);
    expect(shown.map((s) => s.reveal())).toEqual([W.gh.secrets.get("BACKUP_ENCRYPTION_KEY")]);
    const v = W.render.group!.vars;
    expect(v.get("DATABASE_URL")).toBe(W.gh.secrets.get("APP_DATABASE_URL"));
    expect(v.get("RESEND_API_KEY")).toBe("re_sending_scoped_token_123456");
    expect(v.get("APPROVAL_CLIENT_SECRET")).toBe("approval-secret-value");
    expect(v.get("ANTHROPIC_API_KEY")).toBe("sk-ant-good-runtime-123456");
    expect(v.get("SESSION_SECRET")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(v.get("ALLOWED_MCP_CLIENT_IDS")).toBe("https://claude.ai/oauth/claude-code-client-metadata");
    expect(v.get("NOTIFY_FROM")).toBe("Finagai <review@notify.vendora.example>");
    expect(v.get("FINAGAI_MCP_RESOURCE_URL")).toBe("https://finagai-core.onrender.com/mcp");

    const allSecrets = [...W.gh.secrets.values(), ...["RESEND_API_KEY", "APPROVAL_CLIENT_SECRET", "ANTHROPIC_API_KEY", "SESSION_SECRET", "DATABASE_URL"].map((k) => v.get(k)!),
      ...Object.values(SECRETS).flat(), "gho_github_token_abcdef", "neon-migrator-password"];
    const stateText = readFileSync(join(dir, "state.json"), "utf8"), logText = logs.join("\n");
    for (const s of allSecrets) { expect(stateText).not.toContain(s); expect(logText).not.toContain(s); }
  });

  it("satisfies Core's configuration schema with the Render environment group", async () => {
    const env = Object.fromEntries(W.render.group!.vars);
    expect(() => configSchema.parse(env)).not.toThrow();
  });

  it("applied every migration, created finagai_app by SQL without DELETE, and cleaned up the bootstrap key", async () => {
    const c = new pg.Client({ connectionString: admin!.replace(/\/postgres$/, `/${DB}`) }); await c.connect();
    const n = Number((await c.query(`SELECT count(*) AS n FROM public.finagai_schema_migrations`)).rows[0].n);
    expect(n).toBe(readdirSync("migrations").filter((f) => /^0\d+.*\.sql$/.test(f)).length);
    expect((await c.query(`SELECT has_table_privilege('finagai_app', 'finagai.event', 'DELETE') AS d`)).rows[0].d).toBe(false);
    await c.end();
    expect([...W.resend.keys.values()]).toEqual(["finagai-core"]); // bootstrap key deleted, scoped key kept
    expect(W.neon.protected).toBe(true);
    expect(W.gh.env).toMatchObject({ reviewers: [{ type: "User", id: 42 }] });
  });

  it("a second run creates nothing, rotates nothing, and asks only for provider keys it needs to look things up", async () => {
    const before = { ...W.creates }, appUrl = W.gh.secrets.get("APP_DATABASE_URL"), deploys = W.render.deploys;
    const logs2: string[] = [], acts2: string[] = [];
    await runAll(makeCtx(dir, logs2, [], acts2));
    expect(W.creates).toEqual(before);
    expect(W.gh.secrets.get("APP_DATABASE_URL")).toBe(appUrl);
    expect(W.render.deploys).toBe(deploys); // unchanged configuration: no redeploy
    expect(acts2).toEqual(["approve_readiness.yml"]); // only a fresh readiness run needs your approval
  });
});
