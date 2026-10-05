/**
 * Phase 2A/2B (ADR-073) — capability/resource registry.
 *
 * What Finagai can use, as data: id, type, scope, access, operations, permissions, health, empirical
 * reliability/latency/cost, risk, freshness, authority. The catalog below declares WHAT exists; health and
 * evidence are DISCOVERED from live signals (Mac heartbeat probes, configured integrations, delivery records,
 * model-call records, task/step outcomes). Runtime components query the table — not prompt prose.
 */
import type pg from "pg";

export type CapType = "state" | "mac" | "external" | "agent" | "model";
export type Health = "healthy" | "degraded" | "down" | "unknown" | "not_configured";

export interface CapabilityDef {
  id: string; type: CapType; scope: string; access: "read" | "write" | "read_write";
  operations: string[]; permissions?: Record<string, unknown>; risk?: "low" | "medium" | "high";
  freshness?: string; authority?: number; costUsdPerUse?: number;
}

/** Declared catalog. Adding a capability = adding a line here (or registering one at runtime via upsertCapability). */
export const CATALOG: CapabilityDef[] = [
  // ---- Finagai state (Postgres; Finagai's own records) ----
  { id: "state.charter", type: "state", scope: "charter and approved preferences", access: "read", operations: ["get_charter"], authority: 95, freshness: "live" },
  { id: "state.projects", type: "state", scope: "projects, work items, knowledge, entities (J2 memory with provenance)", access: "read_write", operations: ["get_project", "search_state", "get_item", "capture"], authority: 80, freshness: "live" },
  { id: "state.areas", type: "state", scope: "Areas of Responsibility, Objectives, Follow-ups", access: "read_write", operations: ["areas", "objectives", "followups"], authority: 85, freshness: "live" },
  { id: "state.reviews", type: "state", scope: "operating reviews (J3)", access: "read", operations: ["get_latest_review"], authority: 70, freshness: "weekly" },
  { id: "state.artifacts", type: "state", scope: "charts, screenshots and files Finagai produced", access: "read_write", operations: ["recent_artifact", "send_artifact"], authority: 90, freshness: "live" },
  { id: "state.interactions", type: "state", scope: "past requests, outcomes, telemetry", access: "read", operations: ["execution_metrics", "pending_results"], authority: 90, freshness: "live" },
  // ---- Julian's Mac (via helper) ----
  { id: "mac.filesystem", type: "mac", scope: "files under the home folder; Spotlight search", access: "read_write", operations: ["mdfind", "read_file", "list_files", "move_file", "trash_file"], permissions: { approval: "per_write" }, risk: "medium", authority: 60, freshness: "live" },
  { id: "mac.local_parser", type: "mac", scope: "deterministic parsing of xlsx/csv/pdf/docx on the Mac", access: "read", operations: ["xlsx", "csv", "pdf_text"], authority: 85, freshness: "live" },
  { id: "mac.context", type: "mac", scope: "frontmost app/window, open document, selection, active tab", access: "read", operations: ["mac_get_context", "resolve_reference"], authority: 85, freshness: "snapshot:15s" },
  { id: "mac.screen", type: "mac", scope: "screen capture for perception", access: "read", operations: ["screenshot"], freshness: "live" },
  { id: "mac.accessibility", type: "mac", scope: "AX tree, ax_click, ax_set_value, menus, verified UI actions", access: "read_write", operations: ["ax_click", "ax_set_value", "menu_item", "observe"], permissions: { approval: "consequential_only" }, risk: "medium" },
  { id: "mac.app_scripting", type: "mac", scope: "AppleScript/System Events app control", access: "read_write", operations: ["activate_app", "open_app"], risk: "medium" },
  { id: "mac.keyboard_mouse", type: "mac", scope: "coordinate clicks and keystrokes (last resort)", access: "write", operations: ["click", "type", "key", "scroll"], permissions: { approval: "consequential_only" }, risk: "high" },
  { id: "mac.browser", type: "mac", scope: "active tab URL/title, page text, open URL (no DOM actions yet)", access: "read", operations: ["browser_read", "open_url"], freshness: "live" },
  { id: "mac.imessage", type: "mac", scope: "send/receive iMessages to Julian and allow-listed contacts", access: "read_write", operations: ["send_message", "send_artifact"], permissions: { approval: "per_send_to_contacts" }, risk: "high" },
  // ---- External services ----
  { id: "google.gmail", type: "external", scope: "Gmail search (read-only)", access: "read", operations: ["gmail_search"], authority: 75, freshness: "on-demand" },
  { id: "google.calendar", type: "external", scope: "Calendar search (read-only)", access: "read", operations: ["calendar_search"], authority: 90, freshness: "on-demand" },
  { id: "google.drive", type: "external", scope: "Drive search (read-only)", access: "read", operations: ["drive_search"], authority: 70, freshness: "on-demand" },
  { id: "resend.email", type: "external", scope: "outbound email to Julian (reviews, alerts)", access: "write", operations: ["send_email"], risk: "medium" },
  // ---- Agents / workflows ----
  { id: "agent.m01_chart", type: "agent", scope: "deterministic workbook → chart workflow with artifact verification", access: "read", operations: ["make_mac_chart"], authority: 85 },
  { id: "agent.j6_planner", type: "agent", scope: "general Mac operator (plan-act-observe-verify)", access: "read_write", operations: ["control_mac"], risk: "medium" },
  { id: "agent.j3_review", type: "agent", scope: "operating review composer", access: "read", operations: ["operating_review"] },
  // ---- Models ----
  { id: "model.anthropic", type: "model", scope: "Claude models (planner, grader, extraction, review)", access: "read", operations: ["complete"] },
];

export interface DiscoveryEnv {
  googleConfigured: boolean;
  /** Live probe: which Google account the refresh token belongs to (makes a wrong-account setup visible). */
  googleAccount?: () => Promise<string>;
  resendConfigured: boolean;
  models: Record<string, string>;
}

let ACCOUNT_CACHE: { at: number; value?: string; error?: string } | null = null;
const ACCOUNT_TTL_MS = 10 * 60_000;
async function probeAccount(fn: () => Promise<string>): Promise<string> {
  if (ACCOUNT_CACHE && Date.now() - ACCOUNT_CACHE.at < ACCOUNT_TTL_MS) {
    if (ACCOUNT_CACHE.error) throw new Error(ACCOUNT_CACHE.error);
    return ACCOUNT_CACHE.value!;
  }
  try { const v = await fn(); ACCOUNT_CACHE = { at: Date.now(), value: v }; return v; }
  catch (e) { ACCOUNT_CACHE = { at: Date.now(), error: String((e as Error)?.message ?? e) }; throw e; }
}
export function resetAccountCache(): void { ACCOUNT_CACHE = null; }

let ENV: DiscoveryEnv = { googleConfigured: false, resendConfigured: false, models: {} };
/** Called once at startup with what is configured; discovery reads it (no config plumbing through every caller). */
export function configureRegistry(env: DiscoveryEnv): void { ENV = env; }

const MIN_SAMPLES = 5;   // do not let one anecdote define reliability (Phase 6F rule, applied from day one)

interface Observed { health: Health; reason: string; source: "static" | "discovered" | "probe"; reliability?: number | null; samples?: number; latencyP50?: number | null; meta?: Record<string, unknown> }

/** Discover health + evidence for every catalog entry from live signals. Pure-ish: reads only. */
export async function discover(pool: pg.Pool, env: DiscoveryEnv = ENV): Promise<Map<string, Observed>> {
  const out = new Map<string, Observed>();
  // DB reachable → state.* healthy
  let dbOk = true;
  try { await pool.query("SELECT 1"); } catch { dbOk = false; }
  for (const c of CATALOG.filter((x) => x.type === "state")) out.set(c.id, { health: dbOk ? "healthy" : "down", reason: dbOk ? "database reachable" : "database unreachable", source: "probe" });

  // Mac: heartbeat freshness + the helper's own capability probes
  const rt = (await pool.query(`SELECT last_heartbeat_at, capabilities FROM mac_runtime WHERE id = 'primary'`)).rows[0] as { last_heartbeat_at: Date | null; capabilities: Record<string, string> | null } | undefined;
  const ageS = rt?.last_heartbeat_at ? (Date.now() - new Date(rt.last_heartbeat_at).getTime()) / 1000 : Infinity;
  const online = ageS < 45;
  const caps = rt?.capabilities ?? {};
  const probe = (k: string): Health => (!online ? "down" : caps[k] === "PASS" ? "healthy" : caps[k] ? "down" : "unknown");
  const macMap: Record<string, string> = { "mac.filesystem": "filesystem", "mac.screen": "screenCapture", "mac.accessibility": "accessibility", "mac.app_scripting": "accessibility",
    "mac.keyboard_mouse": "accessibility", "mac.browser": "browser", "mac.context": "activeWindow" };
  for (const c of CATALOG.filter((x) => x.type === "mac")) {
    const key = macMap[c.id];
    const h: Health = key ? probe(key) : online ? "healthy" : "down";
    out.set(c.id, { health: h, source: "probe", reason: !online ? `Mac offline (last heartbeat ${Number.isFinite(ageS) ? Math.round(ageS) + "s" : "never"} ago)` : key ? `helper probe ${key}=${caps[key] ?? "unknown"}` : "Mac online" });
  }

  // External: configuration is discovered; health is only claimed with evidence
  let google: Observed;
  if (!env.googleConfigured) google = { health: "not_configured", reason: "Google credentials not configured", source: "discovered" };
  else if (!env.googleAccount) google = { health: "unknown", reason: "configured; not probed", source: "discovered" };
  else {
    try { const account = await probeAccount(env.googleAccount); google = { health: "healthy", reason: `connected as ${account}`, source: "probe", meta: { account } }; }
    catch (e) { google = { health: "degraded", reason: `probe failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`, source: "probe" }; }
  }
  for (const id of ["google.gmail", "google.calendar", "google.drive"]) out.set(id, google);
  if (!env.resendConfigured) out.set("resend.email", { health: "not_configured", reason: "RESEND_API_KEY missing", source: "discovered" });
  else {
    const d = (await pool.query(`SELECT count(*) FILTER (WHERE status = 'sent')::int AS ok, count(*)::int AS n FROM outbound_delivery WHERE created_at > now() - interval '30 days'`)).rows[0] as { ok: number; n: number };
    out.set("resend.email", { health: d.n === 0 ? "unknown" : d.ok / d.n >= 0.8 ? "healthy" : "degraded", reason: d.n === 0 ? "configured; no deliveries in 30 days" : `${d.ok}/${d.n} deliveries sent in 30 days`, source: "discovered",
      reliability: d.n >= MIN_SAMPLES ? d.ok / d.n : null, samples: d.n });
  }

  // Models: recent successful calls are the evidence
  const m = (await pool.query(`SELECT count(*) FILTER (WHERE status = 'ok')::int AS ok, count(*) FILTER (WHERE status IN ('ok','error','schema_invalid'))::int AS n
      FROM llm_call WHERE called_at > now() - interval '24 hours'`)).rows[0] as { ok: number; n: number };
  out.set("model.anthropic", { health: m.n === 0 ? "unknown" : m.ok / m.n >= 0.8 ? "healthy" : "degraded",
    reason: m.n === 0 ? "no model calls in 24h" : `${m.ok}/${m.n} model calls ok in 24h`, source: "discovered",
    reliability: m.n >= MIN_SAMPLES ? m.ok / m.n : null, samples: m.n, meta: { models: env.models } });

  // Agents: empirical reliability from task outcomes (30 days)
  const taskStats = async (where: string) => (await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'done')::int AS ok, count(*) FILTER (WHERE status IN ('done','failed'))::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (updated_at - created_at)) * 1000) FILTER (WHERE status = 'done') AS p50
       FROM control_task WHERE created_at > now() - interval '30 days' AND ${where}`)).rows[0] as { ok: number; n: number; p50: number | null };
  const chart = await taskStats(`request LIKE 'mac_chart:%'`);
  const j6 = await taskStats(`request NOT LIKE 'mac_chart:%' AND request NOT LIKE 'mac_ping%' AND request NOT LIKE 'mac_diag_test%'`);
  const ev = (s: { ok: number; n: number; p50: number | null }, label: string): Observed => ({
    health: online ? (s.n >= MIN_SAMPLES && s.ok / s.n < 0.5 ? "degraded" : "healthy") : "down",
    reason: `${label}: ${s.ok}/${s.n} completed in 30 days${online ? "" : "; Mac offline"}`, source: "discovered",
    reliability: s.n >= MIN_SAMPLES ? s.ok / s.n : null, samples: s.n, latencyP50: s.p50 != null ? Math.round(Number(s.p50)) : null });
  out.set("agent.m01_chart", ev(chart, "chart tasks"));
  out.set("agent.j6_planner", ev(j6, "Mac operator tasks"));
  out.set("agent.j3_review", { health: dbOk ? "healthy" : "down", reason: "runs on Core", source: "probe" });

  // Step-level evidence refines Mac capabilities (verified vs not), when there is enough of it
  const stepStats = async (kinds: string[]) => (await pool.query(
    `SELECT count(*) FILTER (WHERE result LIKE 'verified:%')::int AS ok, count(*) FILTER (WHERE result ~ '^(verified|unverified|error):')::int AS n
       FROM control_step WHERE kind = ANY($1) AND created_at > now() - interval '30 days'`, [kinds])).rows[0] as { ok: number; n: number };
  for (const [id, kinds] of [["mac.filesystem", ["move_file", "trash_file"]], ["mac.accessibility", ["ax_click", "ax_set_value", "menu_item", "activate_app"]]] as const) {
    const s = await stepStats([...kinds]);
    const cur = out.get(id)!;
    out.set(id, { ...cur, reliability: s.n >= MIN_SAMPLES ? s.ok / s.n : null, samples: s.n, reason: `${cur.reason}; ${s.ok}/${s.n} verified steps in 30 days` });
  }
  return out;
}

/** Discover + upsert every capability. Returns the number of rows written. */
export async function refreshRegistry(pool: pg.Pool, env: DiscoveryEnv = ENV): Promise<number> {
  const obs = await discover(pool, env);
  let n = 0;
  for (const c of CATALOG) {
    const o = obs.get(c.id) ?? { health: "unknown" as Health, reason: "no signal", source: "static" as const };
    await pool.query(
      `INSERT INTO capability (id, type, scope, access, operations, permissions, health, health_reason, reliability, samples, latency_p50_ms, cost_usd_per_use, risk, freshness, authority, source, last_probe, updated_at, meta)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now(), $17::jsonb)
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, scope = EXCLUDED.scope, access = EXCLUDED.access, operations = EXCLUDED.operations,
         permissions = EXCLUDED.permissions, health = EXCLUDED.health, health_reason = EXCLUDED.health_reason, reliability = EXCLUDED.reliability,
         samples = EXCLUDED.samples, latency_p50_ms = EXCLUDED.latency_p50_ms, cost_usd_per_use = EXCLUDED.cost_usd_per_use, risk = EXCLUDED.risk,
         freshness = EXCLUDED.freshness, authority = EXCLUDED.authority, source = EXCLUDED.source, last_probe = now(), updated_at = now(),
         meta = capability.meta || EXCLUDED.meta`,
      [c.id, c.type, c.scope, c.access, c.operations, JSON.stringify(c.permissions ?? {}), o.health, o.reason, o.reliability ?? null, o.samples ?? 0,
       o.latencyP50 ?? null, c.costUsdPerUse ?? null, c.risk ?? "low", c.freshness ?? null, c.authority ?? 50, o.source, JSON.stringify(o.meta ?? {})]);
    n++;
  }
  return n;
}

/** Register (or update) a capability discovered at runtime — e.g. a newly added MCP connector (R08). */
export async function upsertCapability(pool: pg.Pool, c: CapabilityDef & { health?: Health; reason?: string }): Promise<void> {
  await pool.query(
    `INSERT INTO capability (id, type, scope, access, operations, permissions, health, health_reason, risk, freshness, authority, source, last_probe)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,'discovered', now())
     ON CONFLICT (id) DO UPDATE SET scope = EXCLUDED.scope, operations = EXCLUDED.operations, health = EXCLUDED.health, health_reason = EXCLUDED.health_reason, last_probe = now(), updated_at = now()`,
    [c.id, c.type, c.scope, c.access, c.operations, JSON.stringify(c.permissions ?? {}), c.health ?? "unknown", c.reason ?? "registered at runtime", c.risk ?? "low", c.freshness ?? null, c.authority ?? 50]);
}

export interface CapabilityRow {
  id: string; type: CapType; scope: string; access: string; operations: string[]; permissions: Record<string, unknown>;
  health: Health; health_reason: string | null; reliability: string | null; samples: number; latency_p50_ms: number | null;
  risk: string; freshness: string | null; authority: number; last_probe: Date | null;
}

export async function listCapabilities(pool: pg.Pool, filter?: { type?: CapType; healthyOnly?: boolean }): Promise<CapabilityRow[]> {
  const r = await pool.query<CapabilityRow>(
    `SELECT id, type, scope, access, operations, permissions, health, health_reason, reliability, samples, latency_p50_ms, risk, freshness, authority, last_probe
       FROM capability WHERE ($1::text IS NULL OR type = $1) AND (NOT $2 OR health IN ('healthy','unknown')) ORDER BY type, id`,
    [filter?.type ?? null, !!filter?.healthyOnly]);
  return r.rows;
}

/** Throttled refresh for hot paths (heartbeat): at most once per interval per process. */
let lastRefresh = 0;
export async function maybeRefresh(pool: pg.Pool, env: DiscoveryEnv = ENV, intervalMs = 60_000): Promise<boolean> {
  if (Date.now() - lastRefresh < intervalMs) return false;
  lastRefresh = Date.now();
  await refreshRegistry(pool, env);
  return true;
}
