/**
 * Finagai bootstrapper steps (ADR-041). Each step: detect -> act on what is missing -> verify -> record.
 * Steps pause only for actions that inherently need Julian (accounts, billing, first keys, passkeys,
 * OAuth/app authorization, dashboard-only security settings, environment approvals).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { mintEnrollmentCode } from "../admin/enrollment.js";
import { migrate } from "../db/migrator.js";
import { ProviderError } from "./http.js";
import type { Log, Prompter } from "./io.js";
import { GitHub } from "./providers/github.js";
import { Neon } from "./providers/neon.js";
import { authkitDiscovery, Cloudflare, probeClientSecret, Resend, validateAnthropicKey, WorkOS } from "./providers/others.js";
import { Render } from "./providers/render.js";
import { Secret } from "./secret.js";
import type { StateFile } from "./state.js";

export interface Endpoints { github?: string; neon?: string; render?: string; resend?: string; workos?: string; cloudflare?: string; anthropic?: string }

export interface Ctx {
  state: StateFile;
  prompt: Prompter & { showSecretOnce(label: string, s: Secret): Promise<void> };
  log: Log;
  ep: Endpoints;
  repoDir: string;
  exec: { ghToken(): Promise<Secret | null>; ghLogin(): Promise<void>; gitPush(remote: string, token: Secret): Promise<void> };
  db: { ssl: boolean; port?: number; name?: string };
  vault: Map<string, Secret>;
  pollMs: number;
  waitDeploy?: boolean;
}

export interface Step { id: string; title: string; run(ctx: Ctx): Promise<string> }

const REPO = "finagai-core", ENV = "production", GROUP = "finagai-core", WEB = "finagai-core", CRON = "finagai-scheduler";
const gen = () => new Secret(randomBytes(32).toString("base64url"));
const need = (ctx: Ctx, k: string) => { const v = ctx.state.get(k); if (!v) throw new Error(`missing ${k}: run the earlier steps first`); return v; };

async function secret(ctx: Ctx, key: string, question: string, validate?: (s: Secret) => Promise<string | null>): Promise<Secret> {
  const cached = ctx.vault.get(key);
  if (cached) return cached;
  const s = await ctx.prompt.askSecret(key, question, validate);
  ctx.vault.set(key, s);
  return s;
}

async function gh(ctx: Ctx): Promise<GitHub> {
  let token = await ctx.exec.ghToken();
  if (!token) { await ctx.exec.ghLogin(); token = await ctx.exec.ghToken(); }
  if (!token) throw new Error("GitHub sign-in did not complete");
  ctx.vault.set("github_token", token);
  return new GitHub(token, ctx.ep.github);
}

const dbUrl = (ctx: Ctx, user: string, password: Secret, host: string) =>
  new Secret(`postgres://${user}:${encodeURIComponent(password.reveal())}@${host}${ctx.db.port ? `:${ctx.db.port}` : ""}/${ctx.db.name ?? "finagai"}${ctx.db.ssl ? "?sslmode=require" : ""}`);

async function withMigrator<T>(ctx: Ctx, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const url = ctx.vault.get("migrator_url");
  if (!url) throw new Error("the Neon step must run in this session before database work (it reveals the migrator password)");
  const c = new pg.Client({ connectionString: url.reveal(), ...(ctx.db.ssl ? { ssl: { rejectUnauthorized: true } } : {}) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function neonClient(ctx: Ctx) {
  return new Neon(await secret(ctx, "neon_api_key", "Neon API key (Console > Account settings > API keys)",
    async (s) => { try { await new Neon(s, ctx.ep.neon).orgs(); return null; } catch (e) { return e instanceof Error ? e.message : "invalid"; } }), ctx.ep.neon);
}

async function renderClient(ctx: Ctx) {
  return new Render(await secret(ctx, "render_api_key", "Render API key (Dashboard > Account settings > API keys)",
    async (s) => { try { await new Render(s, ctx.ep.render).owners(); return null; } catch (e) { return e instanceof Error ? e.message : "invalid"; } }), ctx.ep.render);
}

/** Resets finagai_app's password and writes it to BOTH destinations, so they never disagree. */
async function rotateAppPassword(ctx: Ctx): Promise<Secret> {
  const pw = gen();
  await withMigrator(ctx, (c) => c.query(`ALTER ROLE finagai_app WITH PASSWORD '${pw.reveal()}'`));
  const url = dbUrl(ctx, "finagai_app", pw, need(ctx, "neon_host"));
  const g = await gh(ctx);
  await g.setEnvSecret(need(ctx, "github_owner"), REPO, ENV, "APP_DATABASE_URL", url);
  const groupId = ctx.state.get("render_group_id");
  if (groupId) await (await renderClient(ctx)).setGroupVar(groupId, "DATABASE_URL", url);
  ctx.vault.set("app_url", url);
  return url;
}

export const STEPS: Step[] = [
  {
    id: "decisions", title: "Your decisions and contact address",
    async run(ctx) {
      if (!ctx.state.get("sender_domain")) {
        for (;;) {
          const d = (await ctx.prompt.ask("sender_domain", "Domain that will send Finagai's email (one you control, for example vendora.com):")).toLowerCase();
          if (/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) { ctx.state.set("sender_domain", d); break; }
          ctx.log("  That is not a domain name.");
        }
      }
      if (!ctx.state.get("julian_email")) {
        for (;;) {
          const e = await ctx.prompt.ask("julian_email", "Your email address (review emails go here; WorkOS invites it):");
          if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { ctx.state.set("julian_email", e); break; }
        }
      }
      return `sender notify.${ctx.state.get("sender_domain")}`;
    },
  },
  {
    id: "github", title: "GitHub repository, environment, and CI protection",
    async run(ctx) {
      const g = await gh(ctx);
      const me = await g.user();
      ctx.state.set("github_owner", me.login);
      ctx.state.set("github_user_id", String(me.id));
      if (!(await g.repoExists(me.login, REPO))) { await g.createRepo(REPO); ctx.log(`  created private repository ${me.login}/${REPO}`); }
      if (!(await g.hasBranch(me.login, REPO, "main"))) {
        await ctx.exec.gitPush(`https://github.com/${me.login}/${REPO}.git`, ctx.vault.get("github_token")!);
        ctx.log("  pushed the code to main");
      }
      await g.ensureEnvironment(me.login, REPO, ENV, me.id);
      await g.protectMain(me.login, REPO, ["test", "migrations"]);
      if (!(await g.hasEnvSecret(me.login, REPO, ENV, "BACKUP_ENCRYPTION_KEY"))) {
        const key = new Secret(randomBytes(32).toString("base64"));
        await g.setEnvSecret(me.login, REPO, ENV, "BACKUP_ENCRYPTION_KEY", key);
        await ctx.prompt.showSecretOnce("Backup encryption key: save it in your password manager now. Without it, backups cannot be restored if GitHub is ever lost. It is shown only once", key);
      }
      return `${me.login}/${REPO}, environment ${ENV}`;
    },
  },
  {
    id: "neon", title: "Neon project, roles, database, and migrations",
    async run(ctx) {
      const neon = await neonClient(ctx);
      let orgId = ctx.state.get("neon_org_id");
      if (!orgId) {
        const orgs = await neon.orgs();
        if (orgs.length === 0) throw new Error("this Neon key sees no organization");
        if (orgs.length === 1) orgId = orgs[0]!.id;
        else {
          const pick = (await ctx.prompt.ask("neon_org", `Neon organization to use (${orgs.map((o) => o.name).join(", ")}):`)).toLowerCase();
          orgId = orgs.find((o) => o.name.toLowerCase() === pick)?.id;
        }
        if (!orgId) throw new Error("unknown Neon organization");
        ctx.state.set("neon_org_id", orgId);
      }
      let project = await neon.findProject("finagai", orgId);
      if (!project) {
        try { project = await neon.createProject("finagai", orgId); }
        catch (e) {
          if (e instanceof ProviderError && (e.status === 402 || /plan|limit|billing/i.test(e.message))) {
            await ctx.prompt.act("neon_billing", { title: "Neon billing", steps: ["Upgrade the Neon organization to the Launch plan and add a payment method."], url: "https://console.neon.tech/app/billing" });
            project = await neon.createProject("finagai", orgId);
          } else throw e;
        }
        ctx.log("  created Neon project finagai (US East, Postgres 16, 7-day history, 0.25-0.5 CU)");
      }
      ctx.state.set("neon_project_id", project.id);
      const branch = await neon.defaultBranch(project.id);
      if (!branch.protected) await neon.protectBranch(project.id, branch.id);
      ctx.state.set("neon_branch_id", branch.id);
      const host = await neon.host(project.id, branch.id);
      ctx.state.set("neon_host", host);
      if (!(await neon.roleExists(project.id, branch.id, "finagai_migrator"))) await neon.createRole(project.id, branch.id, "finagai_migrator");
      await neon.ensureDatabase(project.id, branch.id, ctx.db.name ?? "finagai", "finagai_migrator");
      const migratorUrl = dbUrl(ctx, "finagai_migrator", new Secret(await neon.revealPassword(project.id, branch.id, "finagai_migrator")), host);
      ctx.vault.set("migrator_url", migratorUrl);

      // finagai_app by SQL, never by API or console: no extra built-in privileges (preflight enforces).
      const created = await withMigrator(ctx, async (c) => {
        const exists = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'finagai_app'`)).rowCount === 1;
        if (exists) return null;
        const pw = gen();
        await c.query(`CREATE ROLE finagai_app WITH LOGIN PASSWORD '${pw.reveal()}'`);
        return pw;
      });
      const g = await gh(ctx);
      const owner = need(ctx, "github_owner");
      if (created) {
        const appUrl = dbUrl(ctx, "finagai_app", created, host);
        ctx.vault.set("app_url", appUrl);
        await g.setEnvSecret(owner, REPO, ENV, "APP_DATABASE_URL", appUrl);
      } else if (!(await g.hasEnvSecret(owner, REPO, ENV, "APP_DATABASE_URL"))) {
        await rotateAppPassword(ctx);
      }
      if (!(await g.hasEnvSecret(owner, REPO, ENV, "MIGRATOR_DATABASE_URL"))) await g.setEnvSecret(owner, REPO, ENV, "MIGRATOR_DATABASE_URL", migratorUrl);

      const m = await migrate(migratorUrl.reveal(), join(ctx.repoDir, "migrations"), ctx.db.ssl);
      const unsafe = await withMigrator(ctx, async (c) => (await c.query<{ bad: boolean }>(
        `SELECT pg_has_role('finagai_app', 'pg_write_all_data', 'member') OR has_table_privilege('finagai_app', 'finagai.event', 'DELETE') AS bad`)).rows[0]!.bad);
      if (unsafe) throw new Error("finagai_app can delete data: it must be created by SQL with no inherited privileges");
      return `${m.applied.length} migrations applied, ${m.skipped} already present; app role verified without DELETE`;
    },
  },
  {
    id: "anthropic", title: "Anthropic workspace and evaluation key",
    async run(ctx) {
      const g = await gh(ctx);
      const owner = need(ctx, "github_owner");
      if (await g.hasEnvSecret(owner, REPO, ENV, "ANTHROPIC_EVAL_API_KEY")) return "evaluation key already stored";
      await ctx.prompt.act("anthropic_workspace", { title: "Anthropic Console (no API exists for these)", url: "https://console.anthropic.com/settings/workspaces", steps: [
        "Create workspace \"finagai\" and set its monthly spend limit to $36.",
        "Make sure the organization has credits.",
        "In that workspace create two API keys: \"finagai-core-runtime\" and \"finagai-eval\". Keep the page open; you will type each into the next prompts.",
      ] });
      const evalKey = await secret(ctx, "anthropic_eval_key", "The finagai-eval key", (s) => validateAnthropicKey(s, ctx.ep.anthropic));
      await g.setEnvSecret(owner, REPO, ENV, "ANTHROPIC_EVAL_API_KEY", evalKey);
      await secret(ctx, "anthropic_runtime_key", "The finagai-core-runtime key", (s) => validateAnthropicKey(s, ctx.ep.anthropic));
      return "evaluation key stored in GitHub; runtime key held for Render";
    },
  },
  {
    id: "render_services", title: "Render environment group and services",
    async run(ctx) {
      const r = await renderClient(ctx);
      let ownerId = ctx.state.get("render_owner_id");
      if (!ownerId) {
        const owners = await r.owners();
        if (owners.length === 1) ownerId = owners[0]!.id;
        else {
          const pick = (await ctx.prompt.ask("render_owner", `Render workspace to use (${owners.map((o) => o.name).join(", ")}):`)).toLowerCase();
          ownerId = owners.find((o) => o.name.toLowerCase() === pick)?.id;
        }
        if (!ownerId) throw new Error("unknown Render workspace");
        ctx.state.set("render_owner_id", ownerId);
      }
      const group = (await r.findEnvGroup(GROUP, ownerId)) ?? (await r.createEnvGroup(GROUP, ownerId));
      ctx.state.set("render_group_id", group.id);
      const repo = `https://github.com/${need(ctx, "github_owner")}/${REPO}`;
      const build = "npm ci --include=dev && npm run build";
      const specs = [
        { name: WEB, type: "web_service", details: { runtime: "node", plan: "starter", region: "virginia", healthCheckPath: "/health",
          envSpecificDetails: { buildCommand: build, startCommand: "node dist/src/server/index.js" } } },
        { name: CRON, type: "cron_job", details: { runtime: "node", plan: "starter", region: "virginia", schedule: "*/15 * * * *",
          envSpecificDetails: { buildCommand: build, startCommand: "node dist/src/jobs/scheduler.js" } } },
      ];
      for (const s of specs) {
        let svc: { id: string; serviceDetails?: { url?: string } } | null = await r.findService(s.name, ownerId);
        if (!svc) {
          const create = () => r.createService({ type: s.type, name: s.name, ownerId, repo, branch: "main", autoDeploy: "yes", serviceDetails: s.details });
          try { svc = await create(); }
          catch (e) {
            if (!(e instanceof ProviderError)) throw e;
            if (/repo|github|access|permission/i.test(e.message)) {
              await ctx.prompt.act("render_github_app", { title: "Let Render read the repository", url: "https://github.com/apps/render/installations/new",
                steps: [`Install the Render GitHub app and grant it access to ${need(ctx, "github_owner")}/${REPO} only.`] });
            } else if (e.status === 402 || /payment|billing|card/i.test(e.message)) {
              await ctx.prompt.act("render_billing", { title: "Render billing", url: "https://dashboard.render.com/billing", steps: ["Add a payment method (Starter plan, about $7/month for the web service plus the cron)."] });
            } else throw e;
            svc = await create();
          }
          ctx.log(`  created Render ${s.type} ${s.name}`);
        }
        if (!svc) throw new Error(`Render service ${s.name} was not created`);
        await r.linkGroup(group.id, svc.id);
        ctx.state.set(`render_${s.name === WEB ? "web" : "cron"}_id`, svc.id);
      }
      const web = await r.service(need(ctx, "render_web_id"));
      const base = web.serviceDetails?.url;
      if (!base) throw new Error("Render has not assigned the service URL yet; re-run in a minute");
      ctx.state.set("base_url", base.replace(/\/$/, ""));
      return `service URL ${ctx.state.get("base_url")}`;
    },
  },
  {
    id: "workos", title: "WorkOS identity: settings, your user, approval application",
    async run(ctx) {
      const base = need(ctx, "base_url");
      if (!ctx.state.get("oauth_issuer")) {
        for (;;) {
          const issuer = (await ctx.prompt.ask("authkit_domain", "Your WorkOS AuthKit domain (https://<name>.authkit.app, shown in WorkOS > Authentication):")).replace(/\/$/, "");
          try { await authkitDiscovery(issuer); ctx.state.set("oauth_issuer", issuer); break; } catch { ctx.log("  That address does not answer as an AuthKit domain."); }
        }
      }
      const issuer = need(ctx, "oauth_issuer");
      const disco = await authkitDiscovery(issuer);
      ctx.state.set("oauth_jwks_url", disco.oidc.jwks_uri);
      const settingsOk = async () => { const d = await authkitDiscovery(issuer); return d.as.client_id_metadata_document_supported === true && !d.as.registration_endpoint; };
      if (!(await settingsOk()) || !ctx.state.get("workos_toggles_confirmed")) {
        await ctx.prompt.act("workos_settings", { title: "WorkOS security settings (dashboard only)", url: "https://dashboard.workos.com", steps: [
          "Production environment > Authentication: enable Passkeys; disable sign-up (invite only).",
          "Connect > Configuration: enable Client ID Metadata Documents; disable Dynamic Client Registration.",
        ], waitFor: settingsOk, pollMs: ctx.pollMs });
        ctx.state.set("workos_toggles_confirmed", "yes");
      }
      const email = need(ctx, "julian_email");
      if (!ctx.state.get("principal_subject")) {
        const w = new WorkOS(await secret(ctx, "workos_api_key", "WorkOS API key (Production environment > API Keys)",
          async (s) => { try { await new WorkOS(s, ctx.ep.workos).userByEmail("probe@example.invalid"); return null; } catch (e) { return e instanceof Error ? e.message : "invalid"; } }), ctx.ep.workos);
        let user = await w.userByEmail(email);
        if (!user) {
          if (!(await w.pendingInvitation(email))) await w.invite(email);
          await ctx.prompt.act("workos_invitation", { title: "Accept your WorkOS invitation", steps: [
            `Open the invitation sent to ${email}, sign up, and register a passkey when AuthKit asks.`,
          ], waitFor: async () => Boolean(await w.userByEmail(email)), pollMs: ctx.pollMs });
          user = await w.userByEmail(email);
        }
        ctx.state.set("principal_subject", user!.id);
      }
      const redirect = `${base}/approve/callback`;
      if (!ctx.state.get("approval_client_id")) {
        await ctx.prompt.act("workos_oauth_app", { title: "Create the approval-page application (dashboard only)", url: "https://dashboard.workos.com", steps: [
          "Applications > Create application > OAuth (confidential), named \"Finagai approval page\".",
          `Redirect URI: ${redirect}`,
          "Generate a client secret; keep the page open for the next two prompts.",
        ] });
        ctx.state.set("approval_client_id", await ctx.prompt.ask("approval_client_id", "Its client ID (client_...):"));
      }
      if (!ctx.vault.get("approval_client_secret") && !ctx.state.get("approval_secret_stored")) {
        await secret(ctx, "approval_client_secret", "Its client secret",
          (s) => probeClientSecret(disco.oidc.token_endpoint, need(ctx, "approval_client_id"), s, redirect));
      }
      return `issuer ${issuer}; principal ${ctx.state.get("principal_subject")}`;
    },
  },
  {
    id: "resend", title: "Resend sending domain, DNS, and scoped key",
    async run(ctx) {
      const sender = `notify.${need(ctx, "sender_domain")}`;
      if (ctx.state.get("resend_verified") === sender && ctx.state.get("resend_key_stored")) return `${sender} verified`;
      const resend = new Resend(await secret(ctx, "resend_bootstrap_key", "Resend full-access key named \"finagai-bootstrap\" (it is deleted automatically at the end)",
        async (s) => { try { await new Resend(s, ctx.ep.resend).keys(); return null; } catch (e) { return e instanceof Error ? e.message : "invalid"; } }), ctx.ep.resend);
      const domain = (await resend.findDomain(sender)) ?? (await resend.createDomain(sender));
      ctx.state.set("resend_domain_id", domain.id);
      let d = await resend.domain(domain.id);
      if (d.status !== "verified") {
        const apex = need(ctx, "sender_domain");
        const cf = (await ctx.prompt.ask("dns_cloudflare", `Is the DNS for ${apex} hosted on Cloudflare? (yes/no)`)).toLowerCase().startsWith("y");
        if (cf) {
          const c = new Cloudflare(await secret(ctx, "cloudflare_token", `Cloudflare API token limited to Zone > DNS > Edit for ${apex} only`), ctx.ep.cloudflare);
          const zone = await c.zoneId(apex);
          for (const r of d.records) {
            const name = r.name.endsWith(apex) ? r.name : `${r.name}.${apex}`;
            if (await c.ensureRecord(zone, { ...r, name })) ctx.log(`  added DNS ${r.type} ${name}`);
          }
        }
        await resend.verify(domain.id);
        await ctx.prompt.act("dns_records", { title: cf ? "DNS records added; waiting for verification" : `Add these DNS records at your DNS host for ${apex}`,
          steps: cf ? ["Nothing to do; DNS can take minutes to a few hours."] : d.records.map((r) => `${r.type}  ${r.name}  ${r.value}${r.priority !== undefined ? `  (priority ${r.priority})` : ""}`),
          waitFor: async () => { await resend.verify(domain.id).catch(() => {}); return (await resend.domain(domain.id)).status === "verified"; }, pollMs: ctx.pollMs });
        d = await resend.domain(domain.id);
      }
      ctx.state.set("resend_verified", sender);
      if (!ctx.vault.get("resend_sending_key") && !ctx.state.get("resend_key_stored")) {
        for (const k of (await resend.keys()).filter((k) => k.name === "finagai-core")) await resend.deleteKey(k.id); // token unrecoverable: replace
        const k = await resend.createSendingKey("finagai-core", domain.id);
        ctx.vault.set("resend_sending_key", new Secret(k.token));
      }
      return `${sender} verified; sending-only key scoped to it`;
    },
  },
  {
    id: "render_config", title: "Render configuration and deploy",
    async run(ctx) {
      const r = await renderClient(ctx);
      const groupId = need(ctx, "render_group_id");
      const base = need(ctx, "base_url");
      const have = await r.groupVars(groupId);
      let changed = false;
      const put = async (k: string, v: string | Secret) => { await r.setGroupVar(groupId, k, v); changed = true; };
      const plain: Record<string, string> = {
        NODE_ENV: "production", NODE_VERSION: "22", FINAGAI_TIMEZONE: "America/New_York",
        FINAGAI_PUBLIC_BASE_URL: base, FINAGAI_MCP_RESOURCE_URL: `${base}/mcp`,
        OAUTH_ISSUER: need(ctx, "oauth_issuer"), OAUTH_JWKS_URL: need(ctx, "oauth_jwks_url"), PRINCIPAL_SUBJECT: need(ctx, "principal_subject"),
        APPROVAL_CLIENT_ID: need(ctx, "approval_client_id"),
        NOTIFY_FROM: `Finagai <review@notify.${need(ctx, "sender_domain")}>`, NOTIFY_TO: need(ctx, "julian_email"), NOTIFY_REPLY_TO: need(ctx, "julian_email"),
        MODEL_BUDGET_TARGET_USD_MONTH: "30", MODEL_HARD_CEILING_USD_MONTH: "36", MAX_DEFERRED_CAPTURES: "200",
      };
      for (const [k, v] of Object.entries(plain)) if (have.get(k) !== v) await put(k, v);
      if (!have.has("ALLOWED_MCP_CLIENT_IDS")) await put("ALLOWED_MCP_CLIENT_IDS", "");
      if (!have.has("SESSION_SECRET")) await put("SESSION_SECRET", gen());
      if (!have.has("DATABASE_URL")) await put("DATABASE_URL", ctx.vault.get("app_url") ?? await rotateAppPassword(ctx));
      if (!have.has("ANTHROPIC_API_KEY")) {
        await put("ANTHROPIC_API_KEY", await secret(ctx, "anthropic_runtime_key", "The finagai-core-runtime Anthropic key", (s) => validateAnthropicKey(s, ctx.ep.anthropic)));
      }
      if (!have.has("APPROVAL_CLIENT_SECRET")) {
        const s = ctx.vault.get("approval_client_secret");
        if (!s) throw new Error("approval client secret not available in this session: re-run the workos step");
        await put("APPROVAL_CLIENT_SECRET", s);
      }
      ctx.state.set("approval_secret_stored", "yes");
      if (!have.has("RESEND_API_KEY")) {
        const s = ctx.vault.get("resend_sending_key");
        if (!s) throw new Error("Resend sending key not available in this session: re-run the resend step");
        await put("RESEND_API_KEY", s);
      }
      ctx.state.set("resend_key_stored", "yes");
      // The bootstrap key's only job is done.
      const bootstrap = ctx.vault.get("resend_bootstrap_key");
      if (bootstrap) {
        const resend = new Resend(bootstrap, ctx.ep.resend);
        for (const k of (await resend.keys()).filter((k) => k.name === "finagai-bootstrap")) await resend.deleteKey(k.id).catch(() => {});
        ctx.vault.delete("resend_bootstrap_key");
      }
      if (changed || !ctx.state.get("render_deployed")) { await deployAndWait(ctx, r); ctx.state.set("render_deployed", "yes"); return "configured and deployed"; }
      return "configuration unchanged; no redeploy";
    },
  },
  {
    id: "passkey", title: "Your approval passkey",
    async run(ctx) {
      const principal = need(ctx, "principal_subject");
      const has = () => withMigrator(ctx, async (c) => (await c.query(
        `SELECT 1 FROM finagai.webauthn_credential WHERE principal_subject = $1 AND revoked_at IS NULL`, [principal])).rowCount! > 0);
      if (await has()) return "passkey already registered";
      const code = await withMigrator(ctx, async (c) => {
        const pool = { query: (q: string, p: unknown[]) => c.query(q, p) } as unknown as pg.Pool;
        return mintEnrollmentCode(pool, principal);
      });
      await ctx.prompt.act("approval_passkey", { title: "Register your Finagai approval passkey", url: `${need(ctx, "base_url")}/approve/enroll`,
        steps: ["Open the link and sign in with WorkOS.", `Enter this one-time code (valid 15 minutes): ${code}`, "Register the passkey when your device asks."],
        waitFor: has, pollMs: ctx.pollMs });
      return "passkey registered";
    },
  },
  {
    id: "connector", title: "Claude connector and client pinning",
    async run(ctx) {
      const r = await renderClient(ctx);
      const groupId = need(ctx, "render_group_id");
      const pinned = ctx.state.get("pinned_client_id");
      if (pinned) return `pinned ${pinned}`;
      const observed = () => withMigrator(ctx, async (c) => (await c.query<{ id: string }>(
        `SELECT after->>'client_id' AS id FROM finagai.event WHERE action = 'mcp_client_observed' ORDER BY id DESC LIMIT 1`)).rows[0]?.id ?? null);
      if (!(await observed())) {
        await ctx.prompt.act("claude_connector", { title: "Connect Claude (claude.ai has no API for this)", url: "https://claude.ai/settings/connectors", steps: [
          `Add custom connector. URL: ${need(ctx, "base_url")}/mcp`,
          "Connect, and sign in with WorkOS.",
          "In a new chat, ask Claude: \"Use Finagai's get_state_overview.\"",
        ], waitFor: async () => Boolean(await observed()), pollMs: ctx.pollMs });
      }
      const clientId = (await observed())!;
      await r.setGroupVar(groupId, "ALLOWED_MCP_CLIENT_IDS", clientId);
      await deployAndWait(ctx, r);
      ctx.state.set("pinned_client_id", clientId);
      return `pinned ${clientId}`;
    },
  },
  {
    id: "readiness", title: "First backup and the readiness workflow",
    async run(ctx) {
      const g = await gh(ctx);
      const owner = need(ctx, "github_owner");
      await g.setEnvVar(owner, REPO, ENV, "FINAGAI_BASE_URL", need(ctx, "base_url"));
      await g.setEnvVar(owner, REPO, ENV, "OAUTH_ISSUER", need(ctx, "oauth_issuer"));
      const results: string[] = [];
      for (const wf of ["backup.yml", "readiness.yml"]) {
        const before = await g.latestRun(owner, REPO, wf);
        if (wf === "backup.yml" && before?.conclusion === "success") { results.push("backup: success"); continue; }
        await g.dispatch(owner, REPO, wf);
        let run = before;
        await ctx.prompt.act(`approve_${wf}`, { title: `Approve the ${wf.replace(".yml", "")} run`, url: `https://github.com/${owner}/${REPO}/actions`,
          steps: ["Open the newest run, choose Review deployments, approve production."],
          waitFor: async () => { run = await g.latestRun(owner, REPO, wf); return Boolean(run && run.id !== before?.id && run.status === "completed"); },
          pollMs: ctx.pollMs });
        results.push(`${wf.replace(".yml", "")}: ${run?.conclusion} (${run?.html_url})`);
      }
      return results.join("; ");
    },
  },
];

async function deployAndWait(ctx: Ctx, r: Render) {
  const id = await r.deploy(need(ctx, "render_web_id"));
  await r.deploy(need(ctx, "render_cron_id")).catch(() => {});
  if (ctx.waitDeploy === false) return;
  for (let i = 0; i < 120; i++) {
    const s = await r.deployStatus(need(ctx, "render_web_id"), id);
    if (s === "live") return;
    if (/failed|canceled|deactivated/.test(s)) throw new Error(`deploy ${s}: open the Render deploy log (preflight explains any refusal to start)`);
    await new Promise((res) => setTimeout(res, ctx.pollMs));
  }
  throw new Error("deploy did not go live within the waiting time; re-run to keep waiting");
}
