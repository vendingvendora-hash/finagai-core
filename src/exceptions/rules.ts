/**
 * Phase 7 (ADR-086) — Julian's own "tell me when …" rules. A rule only OBSERVES and NOTIFIES: it never acts, never
 * changes a policy, and never puts a task on Julian's plate. Closed registry of metrics and events; edge-triggered
 * (fires when the condition becomes true, re-arms when it becomes false), so a rule never repeats itself.
 */
import { recordTransition, rowState } from "../db/state-events.js";
import type pg from "pg";
import { appendEvent } from "../db/index.js";
import type { EscalationNeed } from "../events/types.js";
import { areaHealth } from "../cos/areas.js";
import { budgetReader, type DetectorDeps } from "./detectors.js";

type Db = Pick<pg.Pool, "query">;
const STATUSES = ["discovered", "analyzed", "shortlisted", "preparing", "ready_for_review", "applied", "interviewing", "offer", "rejected", "withdrawn", "closed"] as const;
type Ctx = { areaId: string | null; params: Record<string, unknown>; now: Date; deps: DetectorDeps };

export interface MetricDef { describe: string; area: "required" | "optional" | "none"; params?: { status?: true }; compute(db: Db, c: Ctx): Promise<number> }
export const METRICS: Record<string, MetricDef> = {
  spend_month_usd: { describe: "model spend this month, USD", area: "none",
    async compute(_db, c) { const read = c.deps.budget ?? budgetReader(); return read ? (await read()).monthToDateUsd : NaN; } },
  open_escalations: { describe: "things currently needing Julian", area: "none",
    async compute(db) { return Number((await db.query(`SELECT count(*)::int AS n FROM escalation WHERE status = 'open' AND needs <> 'requested'`)).rows[0].n); } },
  overdue_followups: { describe: "overdue follow-ups", area: "optional",
    async compute(db, c) { return Number((await db.query(`SELECT count(*)::int AS n FROM followup f LEFT JOIN project p ON p.id = f.project_id WHERE f.state = 'overdue' AND ($1::uuid IS NULL OR COALESCE(f.area_id, p.area_id) = $1)`, [c.areaId])).rows[0].n); } },
  area_health: { describe: "Area health: 0 = service levels met, 2 = red (a service level is breached)", area: "required",
    async compute(db, c) { const h = await areaHealth(db as pg.Pool, c.areaId!); return !h ? NaN : !h.healthy ? 2 : 0; } },
  jobs_in_status: { describe: "opportunities currently in a status (e.g. interviewing, offer)", area: "required", params: { status: true },
    async compute(db, c) { return Number((await db.query(`SELECT count(*)::int AS n FROM opportunity WHERE archived_at IS NULL AND area_id = $1 AND status = $2`, [c.areaId, c.params.status])).rows[0].n); } },
  applications_last_7d: { describe: "applications submitted in the last 7 days", area: "required",
    async compute(db, c) { return Number((await db.query(`SELECT count(DISTINCT o.id)::int AS n FROM opportunity o JOIN opportunity_event e ON e.opportunity_id = o.id AND e.kind = 'application'
        WHERE o.area_id = $1 AND e.at > $2::timestamptz - interval '7 days'`, [c.areaId, c.now])).rows[0].n); } },
  open_exceptions: { describe: "operating exceptions currently open", area: "none",
    async compute(db) { return Number((await db.query(`SELECT count(*)::int AS n FROM operating_exception WHERE status = 'open'`)).rows[0].n); } },
  mac_offline_minutes: { describe: "minutes since the Mac last checked in", area: "none",
    async compute(db, c) { const m = (await db.query(`SELECT last_heartbeat_at FROM mac_runtime WHERE id = 'primary'`)).rows[0]; return m ? Math.round((c.now.getTime() - new Date(m.last_heartbeat_at).getTime()) / 60_000) : NaN; } },
};
/** Events a rule can watch: each new matching record fires once. */
export const EVENTS: Record<string, { describe: string; area: "required" | "optional"; params?: { status?: true } }> = {
  opportunity_status: { describe: "an opportunity moves to a status (e.g. interviewing, offer, rejected)", area: "optional", params: { status: true } },
};
const OPS = { ">": (a: number, b: number) => a > b, ">=": (a: number, b: number) => a >= b, "<": (a: number, b: number) => a < b, "<=": (a: number, b: number) => a <= b, "=": (a: number, b: number) => a === b } as const;
export const MAX_ACTIVE_RULES = 50;

export interface RuleInput { statement: string; metric?: string; event?: string; area?: string | null; status?: string | null; op?: keyof typeof OPS; value?: number }

async function areaIdOf(db: Db, name: string | null | undefined): Promise<string | null | { error: string }> {
  if (!name) return null;
  const a = (await db.query(`SELECT id FROM area WHERE archived_at IS NULL AND lower(name) = lower($1)`, [name.trim()])).rows[0];
  return a ? String(a.id) : { error: `There is no "${name}" area.` };
}

/** Validate and store a rule. The current value is reported; a condition already true now does not fire until it re-arms. */
export async function addRule(db: Db, input: RuleInput, deps: DetectorDeps = {}, now = new Date()) {
  const statement = String(input.statement ?? "").replace(/\s+/g, " ").trim();
  if (statement.length < 3 || statement.length > 300) return { error: "Say the rule in 3–300 characters." };
  if (Number((await db.query(`SELECT count(*)::int AS n FROM watch_rule WHERE status = 'active'`)).rows[0].n) >= MAX_ACTIVE_RULES) return { error: `At most ${MAX_ACTIVE_RULES} active rules.` };
  const area = await areaIdOf(db, input.area);
  if (area && typeof area === "object") return area;
  const status = input.status ? String(input.status).toLowerCase() : null;
  if (status && !(STATUSES as readonly string[]).includes(status)) return { error: `Unknown status "${input.status}". Known: ${STATUSES.join(", ")}.` };
  if (input.event) {
    const ev = EVENTS[input.event];
    if (!ev) return { error: `Unknown event "${input.event}". Known: ${Object.keys(EVENTS).join(", ")}.` };
    if (ev.area === "required" && !area) return { error: `${input.event} needs an area.` };
    if (ev.params?.status && !status) return { error: `${input.event} needs a status.` };
    // High-water mark = the newest audit event id now (ids, not timestamps: a JS Date drops microseconds and would re-fire).
    const mark = Number((await db.query(`SELECT COALESCE(max(id), 0) AS m FROM event`)).rows[0].m);
    const r = (await db.query(`INSERT INTO watch_rule (statement, kind, metric, area_id, params, last_checked_at, last_value) VALUES ($1, 'event', $2, $3, $4::jsonb, $5, $6) RETURNING id, code`,
      [statement, input.event, area, JSON.stringify(status ? { status } : {}), now, mark])).rows[0];
    await appendEvent(db, { actor: "julian", action: "watch_rule_added", entityType: "watch_rule", entityId: String(r.id), areaId: area ?? null, after: { code: Number(r.code), statement, event: input.event, status } });
    return { rule: Number(r.code), statement, watching: `${EVENTS[input.event]!.describe}${status ? ` → ${status}` : ""}`, from: now.toISOString(), note: "Notification only — Finagai tells you, it does not act on it." };
  }
  const m = input.metric ? METRICS[input.metric] : undefined;
  if (!m) return { error: `Unknown metric "${input.metric}". Known: ${Object.entries(METRICS).map(([k, v]) => `${k} (${v.describe})`).join("; ")}.` };
  if (m.area === "required" && !area) return { error: `${input.metric} needs an area.` };
  if (m.area === "none" && area) return { error: `${input.metric} is not per area.` };
  if (m.params?.status && !status) return { error: `${input.metric} needs a status.` };
  if (!input.op || !(input.op in OPS)) return { error: "op must be one of >, >=, <, <=, =" };
  const value = Number(input.value);
  if (!Number.isFinite(value) || Math.abs(value) > 1e7) return { error: "value must be a number" };
  const current = await m.compute(db, { areaId: area, params: status ? { status } : {}, now, deps });
  const holds = Number.isFinite(current) && OPS[input.op](current, value);
  const r = (await db.query(`INSERT INTO watch_rule (statement, kind, metric, area_id, params, op, value, armed, last_value, last_checked_at) VALUES ($1, 'metric', $2, $3, $4::jsonb, $5, $6, $7, $8, $9) RETURNING id, code`,
    [statement, input.metric, area, JSON.stringify(status ? { status } : {}), input.op, value, !holds, Number.isFinite(current) ? current : null, now])).rows[0];
  await appendEvent(db, { actor: "julian", action: "watch_rule_added", entityType: "watch_rule", entityId: String(r.id), areaId: area ?? null, after: { code: Number(r.code), statement, metric: input.metric, op: input.op, value } });
  return { rule: Number(r.code), statement, watching: `${input.metric}${status ? `[${status}]` : ""} ${input.op} ${value}`, currentValue: Number.isFinite(current) ? current : null,
    note: holds ? "This is already true right now; you'll be told the next time it becomes true after it stops being true." : "You'll be told once when it becomes true (and again only after it has cleared)." };
}

export async function removeRule(db: Db, ref: string | number, reason = "Julian asked") {
  const code = Number(ref);
  const row = Number.isInteger(code) && code > 0
    ? (await db.query(`SELECT id, code, statement FROM watch_rule WHERE code = $1 AND status = 'active'`, [code])).rows[0]
    : (await db.query(`SELECT id, code, statement FROM watch_rule WHERE status = 'active' AND statement ILIKE '%' || $1 || '%' ORDER BY code DESC LIMIT 1`, [String(ref)])).rows[0];
  if (!row) return { error: `No active rule matches "${ref}".` };
  const before = await rowState(db, "watch_rule", String(row.id));
  await db.query(`UPDATE watch_rule SET status = 'removed', removed_at = now(), removed_reason = $2 WHERE id = $1`, [row.id, reason.slice(0, 200)]);
  await recordTransition(db, { actor: "julian", action: "watch_rule_removed", table: "watch_rule", id: String(row.id), before, context: { code: Number(row.code), statement: row.statement, reason: reason.slice(0, 200) } });
  return { removed: Number(row.code), statement: row.statement };
}

export async function listRules(db: Db) {
  return (await db.query(`SELECT code, statement, kind, metric, params, op, value, armed, last_value, last_fired_at, fired_count FROM watch_rule WHERE status = 'active' ORDER BY code`)).rows
    .map((r) => ({ rule: Number(r.code), statement: r.statement, watching: r.kind === "event" ? `${r.metric}${r.params?.status ? ` → ${r.params.status}` : ""}` : `${r.metric}${r.params?.status ? `[${r.params.status}]` : ""} ${r.op} ${Number(r.value)}`,
      now: r.kind === "metric" && r.last_value !== null ? Number(r.last_value) : null, lastTold: r.last_fired_at, timesTold: r.fired_count }));
}

/** Evaluate every active rule; firings become 'requested' notifications (once each). */
export async function evaluateRules(pool: pg.Pool, now: Date, dryRun: boolean, deps: DetectorDeps = {}): Promise<{ needs: EscalationNeed[]; fired: string[]; problems: string[] }> {
  const out = { needs: [] as EscalationNeed[], fired: [] as string[], problems: [] as string[] };
  const rules = (await pool.query(`SELECT r.*, a.name AS area FROM watch_rule r LEFT JOIN area a ON a.id = r.area_id WHERE r.status = 'active' ORDER BY r.code`)).rows;
  for (const r of rules) {
    try {
      if (r.kind === "metric") {
        const m = METRICS[r.metric]; if (!m) continue;
        const v = await m.compute(pool, { areaId: r.area_id, params: r.params ?? {}, now, deps });
        if (!Number.isFinite(v)) continue;
        const holds = OPS[r.op as keyof typeof OPS](v, Number(r.value));
        const fire = holds && r.armed;
        if (fire) {
          const n = Number(r.fired_count) + 1;
          out.fired.push(r.statement);
          out.needs.push({ key: `rule:${r.code}:${n}`, needs: "requested", areaId: r.area_id, summary: `You asked to be told: “${r.statement}” — now ${fmt(v)} (${r.metric} ${r.op} ${Number(r.value)})` });
        }
        if (!dryRun) {
          const before = await rowState(pool, "watch_rule", String(r.id));
          await pool.query(`UPDATE watch_rule SET last_value = $2, last_checked_at = $3, armed = $4, last_fired_at = CASE WHEN $5 THEN $3 ELSE last_fired_at END,
            fired_count = fired_count + CASE WHEN $5 THEN 1 ELSE 0 END WHERE id = $1`, [r.id, v, now, !holds, fire]);
          await recordTransition(pool, { actor: "cos", action: "watch_rule_state", table: "watch_rule", id: String(r.id), before, areaId: r.area_id ?? null, context: { value: v, fired: fire } });
        }
      } else {
        const mark = Number(r.last_value ?? 0);
        const evs = (await pool.query(`SELECT ev.id, ev.occurred_at, ev.after, o.org, o.title, o.area_id FROM event ev JOIN opportunity o ON o.id = ev.entity_id
            WHERE ev.action = 'opportunity_status' AND ev.id > $1 AND ($2::uuid IS NULL OR o.area_id = $2) AND ev.after->>'status' = $3
            ORDER BY ev.id LIMIT 5`, [mark, r.area_id, r.params?.status])).rows;
        const top = evs.length ? Number(evs[evs.length - 1].id) : Number((await pool.query(`SELECT COALESCE(max(id), 0) AS m FROM event WHERE action = 'opportunity_status' AND id > $1`, [mark])).rows[0].m) || mark;
        for (const e of evs) {
          out.fired.push(r.statement);
          out.needs.push({ key: `rule:${r.code}:ev${e.id}`, needs: "requested", areaId: e.area_id, summary: `You asked to be told: “${r.statement}” — ${e.org} — ${e.title} is now ${r.params.status}` });
        }
        if (!dryRun) await pool.query(`UPDATE watch_rule SET last_checked_at = $2, last_value = $4, last_fired_at = CASE WHEN $3 > 0 THEN $2 ELSE last_fired_at END, fired_count = fired_count + $3 WHERE id = $1`, [r.id, now, evs.length, top]);
      }
    } catch (e) { out.problems.push(`rule ${r.code}: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
  }
  return out;
}
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
