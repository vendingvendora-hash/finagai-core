/** Entry point for the Render web service (render.yaml: node dist/src/server/index.js). */
import http from "node:http";
import { loadConfig } from "../config/index.js";
import { join } from "node:path";
import { remoteKeys } from "../auth/bearer.js";
import { criticalFailures, preflight } from "../ops/preflight.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { liveManifest } from "../tools/manifest.js";
import { appendEvent, createPool, PgLlmCallRecorder } from "../db/index.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { MeteredModelClient } from "../llm/metered.js";
import { buildMcpServer } from "../tools/server.js";
import { registerJ3Tools } from "../tools/j3Tools.js";
import { OidcClient } from "../approval/oidc.js";
import { createApprovalHandler } from "../approval/routes.js";
import { makePromoter } from "../pipelines/seed/seed.js";
import { runReview } from "../pipelines/j3/review.js";
import { createHandler } from "./app.js";
import { createConciergeHandler } from "../concierge/routes.js";
import { createControlHandler } from "../concierge/control-routes.js";
import { configureRegistry, refreshRegistry } from "../resources/registry.js";
import { MultiGoogleClient } from "../google/multi.js";
import { createLogger } from "./log.js";
const VERSION = process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? "dev";
async function main() {
    const cfg = loadConfig(process.env);
    const log = createLogger(cfg);
    const port = Number(process.env.PORT ?? 8787);
    const pool = createPool(cfg.DATABASE_URL);
    const checks = await preflight(pool, { migrationsDir: join(process.cwd(), "migrations"), issuer: cfg.OAUTH_ISSUER, jwksUrl: cfg.OAUTH_JWKS_URL });
    for (const c of checks)
        log("preflight", { check: c.name, ok: c.ok, critical: c.critical, detail: c.detail });
    if (cfg.NODE_ENV === "production" && criticalFailures(checks).length) {
        log("refusing to start: critical preflight failures", { failures: criticalFailures(checks).map((c) => c.name) });
        process.exit(1);
    }
    const model = new MeteredModelClient(new AnthropicProvider(cfg.ANTHROPIC_API_KEY), new PgLlmCallRecorder(pool, cfg.FINAGAI_TIMEZONE), { limits: { targetUsd: cfg.MODEL_BUDGET_TARGET_USD_MONTH, ceilingUsd: cfg.MODEL_HARD_CEILING_USD_MONTH } });
    // Stateless: a fresh MCP server per request; all state lives in Postgres (ADR-013).
    const recorder = new PgLlmCallRecorder(pool, cfg.FINAGAI_TIMEZONE);
    const j3 = {
        pool, model, modelId: cfg.MODEL_J3_COMPOSE,
        collect: { timezone: cfg.FINAGAI_TIMEZONE, stallThresholdDays: cfg.STALL_THRESHOLD_DAYS,
            upcomingWindowDays: cfg.UPCOMING_WINDOW_DAYS, priorityUpcomingWindowDays: cfg.PRIORITY_UPCOMING_WINDOW_DAYS },
        budget: async () => ({ monthToDateUsd: await recorder.monthToDateUsd(new Date()),
            targetUsd: cfg.MODEL_BUDGET_TARGET_USD_MONTH, ceilingUsd: cfg.MODEL_HARD_CEILING_USD_MONTH }),
    };
    // ADR-075: every authorized Google account is searched (primary + GOOGLE_REFRESH_TOKENS_EXTRA).
    const sharedGoogle = cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.GOOGLE_REFRESH_TOKEN
        ? MultiGoogleClient.fromConfig({ clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET,
            refreshTokens: [cfg.GOOGLE_REFRESH_TOKEN, ...(cfg.GOOGLE_REFRESH_TOKENS_EXTRA ?? "").split(",")] }) : undefined;
    const mcp = createMcpHandler(() => buildMcpServer({ pool, cfg, client: "claude_ai", j2: { pool, model, cfg }, ...(sharedGoogle ? { google: sharedGoogle } : {}),
        extend: registerJ3Tools(pool, j3) }));
    const base = new URL(cfg.FINAGAI_PUBLIC_BASE_URL);
    const approval = createApprovalHandler({
        pool,
        cfg: { publicBaseUrl: cfg.FINAGAI_PUBLIC_BASE_URL, rpId: cfg.WEBAUTHN_RP_ID ?? base.hostname, rpName: "Finagai",
            principalSubject: cfg.PRINCIPAL_SUBJECT, sessionSecret: cfg.SESSION_SECRET },
        oidc: new OidcClient({ issuer: cfg.OAUTH_ISSUER, clientId: cfg.APPROVAL_CLIENT_ID, clientSecret: cfg.APPROVAL_CLIENT_SECRET,
            redirectUri: new URL("/approve/callback", base).toString(), sessionSecret: cfg.SESSION_SECRET, principalSubject: cfg.PRINCIPAL_SUBJECT }),
        promote: makePromoter(cfg),
        // Seeding ends with a baseline J3 review (plan section 13); Julian checks it (acceptance A3).
        onExecuted: async (action) => { if (action === "promote_seed_batch")
            await runReview(j3, { kind: "baseline" }); },
    });
    const concierge = createConciergeHandler({ pool, model, modelId: cfg.MODEL_J5_CONCIERGE, maxSearches: cfg.CONCIERGE_MAX_SEARCHES,
        timezone: cfg.FINAGAI_TIMEZONE, homeBase: "Hyattsville, Maryland (Washington DC area; DCA, IAD and BWI airports)", log,
        ...(sharedGoogle ? { google: sharedGoogle } : {}) }, cfg.CONCIERGE_HELPER_TOKEN, log);
    // Phase 2B: capability registry — configured integrations are discovered here; health/evidence on refresh.
    configureRegistry({ googleConfigured: !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.GOOGLE_REFRESH_TOKEN), resendConfigured: !!cfg.RESEND_API_KEY,
        ...(sharedGoogle ? { googleAccount: () => sharedGoogle.account() } : {}),
        models: { planner: cfg.MODEL_J6_PLANNER, grader: cfg.MODEL_EVAL_GRADER, concierge: cfg.MODEL_J5_CONCIERGE, review: cfg.MODEL_J3_COMPOSE } });
    refreshRegistry(pool).then((n) => log("capability registry refreshed", { capabilities: n })).catch((e) => log("capability registry refresh failed", { error: String(e?.message ?? e).slice(0, 200) }));
    const control = createControlHandler({ pool, model, modelId: cfg.MODEL_J5_CONCIERGE, plannerModel: cfg.MODEL_J6_PLANNER, graderModel: cfg.MODEL_EVAL_GRADER, thinkingTokens: cfg.J6_THINKING_TOKENS, log, ...(sharedGoogle ? { google: sharedGoogle } : {}) }, cfg.CONCIERGE_HELPER_TOKEN, log);
    // ADR-083: build the tool surface once at startup so /health publishes the live manifest before any client connects.
    buildMcpServer({ pool, cfg, client: "startup", j2: { pool, model, cfg }, ...(sharedGoogle ? { google: sharedGoogle } : {}), extend: registerJ3Tools(pool, j3) });
    const toolNames = () => new Set(liveManifest()?.names ?? []);
    const handshakeSeen = new Map();
    const server = http.createServer(createHandler(cfg, { version: VERSION, startedAt: new Date(), tools: () => liveManifest() }, log, { keys: remoteKeys(cfg.OAUTH_JWKS_URL), mcp, approval, concierge, control,
        onMcpTraffic: async (msgs, clientId) => {
            for (const m of msgs) {
                if (m.method === "initialize" || m.method === "server/discover") { // server/discover: the 2026-07-28 revision's stateless handshake
                    const last = handshakeSeen.get(clientId) ?? 0; // at most one recorded handshake per client per 15 min
                    if (Date.now() - last < 15 * 60_000)
                        continue;
                    handshakeSeen.set(clientId, Date.now());
                    await appendEvent(pool, { actor: "system", action: "mcp_initialize", client: "claude_ai", after: { method: m.method, clientId, clientInfo: m.params?.clientInfo ?? null, protocolVersion: m.params?.protocolVersion ?? null, serverTools: liveManifest()?.digest ?? null } });
                }
                else if (m.method === "tools/list") {
                    await appendEvent(pool, { actor: "system", action: "mcp_tools_listed", client: "claude_ai", after: { clientId, served: liveManifest()?.digest ?? null, count: liveManifest()?.count ?? null, cursor: m.params?.cursor ?? null } });
                }
                else if (m.method === "tools/call") {
                    const name = String(m.params?.name ?? "");
                    if (!toolNames().has(name))
                        await appendEvent(pool, { actor: "system", action: "mcp_unknown_tool", entityType: "tool", reason: name, client: "claude_ai", after: { clientId } });
                }
            }
        },
        onClientObserved: async (clientId) => {
            const seen = await pool.query(`SELECT 1 FROM event WHERE action = 'mcp_client_observed' AND after->>'client_id' = $1 LIMIT 1`, [clientId]);
            if (!seen.rowCount)
                await appendEvent(pool, { actor: "system", action: "mcp_client_observed", after: { client_id: clientId }, client: "claude_ai" });
        } }));
    server.listen(port, () => log("finagai-core listening", { port, version: VERSION, env: cfg.NODE_ENV }));
    const shutdown = () => server.close(() => process.exit(0));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
main().catch((err) => { process.stderr.write(`startup failed: ${err instanceof Error ? err.name : "error"}\n`); process.exit(1); });
//# sourceMappingURL=index.js.map