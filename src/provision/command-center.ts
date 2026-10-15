/**
 * `npm run provision:command` — one-time setup of the Finagai Command Center (ADR-089), run on Julian's machine from
 * the repository, after the commit containing `command/` is on GitHub. Idempotent: re-running detects what exists.
 *
 *   1. Render web service `finagai-command` (root dir `command/`, same repo, auto-deploys main)
 *   2. its own WorkOS OAuth application (confidential) — a dashboard step only Julian can do
 *   3. the service's settings (Core URL, Core's resource, the client, a fresh state secret)
 *   4. Core's client allow-list gains the Command Center's client id, if Core pins clients (then Core redeploys)
 *   5. deploy and wait until the Command Center answers
 * Secrets are typed into hidden prompts and go straight to Render; nothing secret is written to disk or printed.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { api } from "./http.js";
import { consoleLog, TerminalPrompter } from "./io.js";
import { probeClientSecret, authkitDiscovery } from "./providers/others.js";
import { Render } from "./providers/render.js";
import { Secret } from "./secret.js";
import { StateFile } from "./state.js";

const NAME = "finagai-command";
const state = new StateFile(join(process.cwd(), ".finagai", "provision-state.json"));
const prompt = new TerminalPrompter(consoleLog);
const need = (k: string) => { const v = state.get(k); if (!v) throw new Error(`provisioning state has no ${k} — run this from the finagai-core folder you provisioned from`); return v; };

const key = await prompt.askSecret("render_api_key", "Render API key (Dashboard > Account settings > API keys)",
  async (s) => { try { await new Render(s).owners(); return null; } catch (e) { return e instanceof Error ? e.message : "invalid"; } });
const r = new Render(key);
const call = <T = any>(path: string, c: Parameters<typeof api>[2] = {}) => api<T>("Render", `https://api.render.com/v1${path}`, { ...c, headers: { authorization: `Bearer ${key.reveal()}`, ...c.headers } });

const ownerId = need("render_owner_id"), groupId = need("render_group_id"), coreId = need("render_web_id");
const group = await r.groupVars(groupId);
const coreUrl = need("base_url");
const issuer = group.get("OAUTH_ISSUER") ?? need("oauth_issuer");
const resource = group.get("FINAGAI_MCP_RESOURCE_URL") ?? `${coreUrl}/mcp`;
const principal = group.get("PRINCIPAL_SUBJECT") ?? need("principal_subject");

// 1. the service
consoleLog(`\n▶ Render service ${NAME}`);
let svc: { id: string; serviceDetails?: { url?: string } } | null = await r.findService(NAME, ownerId);
if (!svc) {
  svc = await r.createService({ type: "web_service", name: NAME, ownerId, repo: `https://github.com/${need("github_owner")}/finagai-core`, branch: "main", autoDeploy: "yes",
    rootDir: "command", serviceDetails: { runtime: "node", plan: "starter", region: "virginia", healthCheckPath: "/healthz",
      envSpecificDetails: { buildCommand: "npm ci --include=dev && npm run build", startCommand: "node dist/server/index.js" } } });
  consoleLog(`  created ${NAME}`);
}
let url = svc.serviceDetails?.url ?? (await r.service(svc.id)).serviceDetails?.url;
for (let i = 0; !url && i < 12; i++) { await new Promise((x) => setTimeout(x, 5000)); url = (await r.service(svc.id)).serviceDetails?.url; }
if (!url) throw new Error("Render has not assigned the Command Center URL yet; re-run in a minute");
url = url.replace(/\/$/, "");
state.set("command_service_id", svc.id); state.set("command_url", url);
consoleLog(`  ✓ ${url}`);

// 2. its own sign-in client
consoleLog(`\n▶ WorkOS application for the Command Center`);
const redirect = `${url}/auth/callback`;
if (!state.get("command_client_id")) {
  await prompt.act("command_oauth_app", { title: "Create the Command Center's sign-in application (WorkOS dashboard)", url: "https://dashboard.workos.com", steps: [
    "Applications > Create application > OAuth (confidential), named \"Finagai Command Center\".",
    `Redirect URI: ${redirect}`,
    "Generate a client secret and keep the page open for the next two prompts.",
  ] });
  state.set("command_client_id", await prompt.ask("command_client_id", "Its client ID (client_...):"));
}
const clientId = need("command_client_id");
const disco = await authkitDiscovery(issuer);
const clientSecret = await prompt.askSecret("command_client_secret", "Its client secret", (s) => probeClientSecret(disco.oidc.token_endpoint, clientId, s, redirect));

// 3. settings (service-level; replaces the service's own variables)
consoleLog(`\n▶ Settings`);
const vars = { CC_PUBLIC_URL: url, OAUTH_ISSUER: issuer, CC_CLIENT_ID: clientId, CC_CLIENT_SECRET: clientSecret.reveal(), CORE_URL: coreUrl, CORE_RESOURCE: resource,
  PRINCIPAL_SUBJECT: principal, CC_STATE_SECRET: new Secret(randomBytes(32).toString("base64url")).reveal(), NODE_VERSION: "22" };
await call(`/services/${svc.id}/env-vars`, { method: "PUT", body: Object.entries(vars).map(([k, value]) => ({ key: k, value })) });
consoleLog(`  ✓ ${Object.keys(vars).join(", ")}`);

// 4. Core's client allow-list (only if Core pins clients)
const allowed = (group.get("ALLOWED_MCP_CLIENT_IDS") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
if (allowed.length && !allowed.includes(clientId)) {
  consoleLog(`\n▶ Core's client allow-list`);
  await r.setGroupVar(groupId, "ALLOWED_MCP_CLIENT_IDS", [...allowed, clientId].join(","));
  const d = await r.deploy(coreId);
  consoleLog(`  ✓ added ${clientId}; Core is restarting to read it (deploy ${d})`);
  await waitLive(coreId, d, "Core");
}

// 5. deploy and check
consoleLog(`\n▶ Deploy`);
const dep = await r.deploy(svc.id);
await waitLive(svc.id, dep, "Command Center");
const h = await fetch(`${url}/healthz`).then((x) => x.json()).catch(() => null) as { ok?: boolean; version?: string } | null;
consoleLog(h?.ok ? `  ✓ Command Center is up (version ${h.version})` : "  ✗ the Command Center did not answer /healthz — tell Claude");
consoleLog(`\nOpen ${url}/spike.html and sign in with WorkOS. Then tell Claude "signed in".`);

async function waitLive(serviceId: string, deployId: string, label: string) {
  for (let i = 0; i < 120; i++) {
    const st = await r.deployStatus(serviceId, deployId);
    if (st === "live") { consoleLog(`  ✓ ${label} deploy is live`); return; }
    if (/failed|canceled|deactivated/.test(st)) throw new Error(`${label} deploy ${deployId} ended as ${st} — tell Claude`);
    await new Promise((x) => setTimeout(x, 10_000));
  }
  throw new Error(`${label} deploy ${deployId} did not finish in 20 minutes — tell Claude`);
}
