/**
 * ADR-087 — the Live State Stream (read side). The authoritative `event` table is the only source of truth:
 *   publish()   assigns a commit-ordered, gap-free stream sequence (live_event.seq) to events as they become visible
 *   readAfter() ordered incremental envelopes after a cursor (resume = pass the last seq you applied)
 *   snapshot()  the current authoritative state + the cursor it is consistent with
 *   history()   semantic replay over all stored events ("show me how Finagai got here")
 * Everything here is read-only except publish(), which only writes the stream index. No secrets ever leave: payloads
 * are sanitized, the authenticated principal is never exposed (only whether a human authorization was involved).
 */
import type pg from "pg";
import { classify, type Classified } from "./ontology.js";
import { areaStatusRead } from "../cos/operating.js";
import { TEST_AREA } from "../cos/opportunities.js";
import { RULE_NEEDS } from "../cos/lifecycle.js";

type Db = Pick<pg.Pool, "query">;
/** v2 (ADR-089 slice 0, additive): snapshot areas[].internal/health, waits[].owner/project_id/escalated,
 *  needsJulian[].followup_id/subject; history filters before its limit and pages newest-first. */
export const CONTRACT_VERSION = 2;
export const RETENTION_DAYS = 30;
/** Ids allocated by a transaction that commits later than others still surface: published as soon as visible. */
const LATE_COMMIT_WINDOW = 20_000;
const PUBLISH_LOCK = 87_001;

export interface LiveEvent {
  v: 1; seq: number; eventId: number; at: string;
  class: string; domain: Classified["domain"]; verb: string; action: string; actor: string;
  area: { id: string; name: string | null } | null;
  entity: { type: string | null; id: string | null };
  summary: string;
  before: unknown; after: unknown;
  cause: { correlationId: string | null; eventIds: number[]; requestId: string | null };
  nextOwner: "finagai" | "julian" | null; humanAuthorized: boolean; verified: boolean | null; confidence: number | null;
  lowValue: boolean;
}

// ---------------------------------------------------------------------------------------------------- publishing
/** Assign stream positions to every newly visible event. Single publisher at a time; safe to call from anywhere. */
export async function publish(pool: pg.Pool): Promise<{ published: number; lastSeq: number | null; skipped?: string }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const got = (await c.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [PUBLISH_LOCK])).rows[0]?.ok;
    if (!got) { await c.query("ROLLBACK"); return { published: 0, lastSeq: null, skipped: "another publisher is running" }; }
    const r = await c.query(`INSERT INTO live_event (event_id)
        SELECT e.id FROM event e
         WHERE e.id > (SELECT COALESCE(max(event_id), 0) - $1 FROM live_event)
           AND e.occurred_at > now() - make_interval(days => $2)
           AND NOT EXISTS (SELECT 1 FROM live_event l WHERE l.event_id = e.id)
         ORDER BY e.id
        ON CONFLICT (event_id) DO NOTHING RETURNING seq`, [LATE_COMMIT_WINDOW, RETENTION_DAYS]);
    await c.query("COMMIT");
    return { published: r.rowCount ?? 0, lastSeq: r.rows.length ? Math.max(...r.rows.map((x) => Number(x.seq))) : null };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

/** Retention is a READ window, not deletion: the app role is archive-only (no DELETE anywhere — Core's preflight
 *  refuses to start otherwise). Positions older than the window cannot be resumed from; the rows themselves are tiny. */

// ---------------------------------------------------------------------------------------------------- envelopes
/**
 * A key is secret when one of its WORDS is a secret word (camelCase / snake_case / kebab-case split), or it names a
 * key pair like apiKey / private_key. Words, not substrings (Phase 8 live acceptance: the substring "pass" redacted the
 * self-check's own `allPass` and `passed` verdict fields on the stream; "token" would also hide `inputTokens` counts).
 */
const SECRET_WORDS = new Set(["password", "passwords", "passwd", "passcode", "passphrase", "secret", "secrets", "token", "tokens", "cookie", "cookies",
  "authorization", "authorisation", "auth", "credential", "credentials", "apikey", "otp", "verifier", "session", "nonce", "challenge", "b64", "base64", "signature", "ssn", "jwt", "bearer"]);
const SECRET_PAIR = /api_?key|private_?key|secret_?key|access_?key|client_?secret/;
/** Count-like words: "inputTokens", "maxTokens" are usage numbers, not credentials. */
const COUNT_PREFIX = new Set(["input", "output", "max", "min", "cache", "cachewrite", "cacheread", "thinking", "total", "used", "prompt", "completion"]);
export function isSecretKey(k: string): boolean {
  const words = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_\-.]+/).map((w) => w.toLowerCase()).filter(Boolean);
  if (SECRET_PAIR.test(words.join("_")) || SECRET_PAIR.test(words.join(""))) return true;
  return words.some((w, i) => SECRET_WORDS.has(w) && !(w === "tokens" && i > 0 && COUNT_PREFIX.has(words[i - 1]!)));
}
const SECRET_VALUE = /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b|\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._-]{16,}/g;
/** Recursively remove secret-looking keys and values; bound sizes. Pure. */
export function sanitize(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === "string") return v.replace(SECRET_VALUE, "[redacted]").slice(0, 500);
  if (typeof v !== "object") return v;
  if (depth > 5) return "[…]";
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => sanitize(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) out[k] = isSecretKey(k) ? "[redacted]" : sanitize(x, depth + 1);
  return out;
}

const AREA_OF: Record<string, string> = {
  opportunity: `SELECT area_id FROM opportunity WHERE id = $1`, project: `SELECT area_id FROM project WHERE id = $1`,
  followup: `SELECT COALESCE(f.area_id, p.area_id) AS area_id FROM followup f LEFT JOIN project p ON p.id = f.project_id WHERE f.id = $1`,
  objective: `SELECT area_id FROM objective WHERE id = $1`, area: `SELECT id AS area_id FROM area WHERE id = $1`,
  operating_exception: `SELECT area_id FROM operating_exception WHERE id = $1`, lesson: `SELECT area_id FROM lesson WHERE id = $1`,
  escalation: `SELECT area_id FROM escalation WHERE id = $1`,
};

function summaryOf(row: Record<string, unknown>, c: Classified): string {
  const a = (row.after ?? {}) as Record<string, unknown>;
  const pick = (a.summary ?? a.statement ?? a.outcome ?? a.name ?? a.key ?? a.tool ?? a.workflow ?? a.status ?? "") as string;
  return `${c.class}${pick ? `: ${String(pick).slice(0, 200)}` : ""}`;
}

export async function toEnvelopes(db: Db, rows: Array<Record<string, unknown>>): Promise<LiveEvent[]> {
  const areaNames = new Map((await db.query(`SELECT id::text, name FROM area`)).rows.map((r) => [r.id, r.name as string]));
  const out: LiveEvent[] = [];
  for (const row of rows) {
    const c = classify({ action: String(row.action), entity_type: (row.entity_type as string) ?? null, after: (row.after as Record<string, unknown>) ?? null, before: (row.before as Record<string, unknown>) ?? null, approval_id: (row.approval_id as string) ?? null });
    let areaId = (row.area_id as string | null) ?? null;
    if (!areaId && row.entity_type && row.entity_id && AREA_OF[String(row.entity_type)])
      areaId = ((await db.query(AREA_OF[String(row.entity_type)]!, [row.entity_id])).rows[0]?.area_id as string | null) ?? null;
    out.push({
      v: 1, seq: Number(row.seq ?? 0), eventId: Number(row.id), at: new Date(row.occurred_at as string).toISOString(),
      class: c.class, domain: c.domain, verb: c.verb, action: String(row.action), actor: String(row.actor),
      area: areaId ? { id: areaId, name: areaNames.get(areaId) ?? null } : null,
      entity: { type: (row.entity_type as string) ?? null, id: (row.entity_id as string) ?? null },
      summary: summaryOf(row, c),
      before: sanitize(row.before ?? null), after: sanitize(row.after ?? null),
      cause: { correlationId: (row.correlation_id as string) ?? null, eventIds: ((row.cause_ids as Array<string | number> | null) ?? []).map(Number), requestId: (row.request_id as string) ?? null },
      nextOwner: c.nextOwner, humanAuthorized: !!row.approval_id, verified: c.verified, confidence: c.confidence, lowValue: c.lowValue,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- reading
export interface Filter { area?: string | null; classes?: string[]; entityType?: string | null; entityId?: string | null }
const EVENT_COLS = `e.id, e.occurred_at, e.actor, e.action, e.entity_type, e.entity_id, e.before, e.after, e.request_id, e.approval_id, e.correlation_id, e.cause_ids, e.area_id`;

async function resolveArea(db: Db, area: string | null | undefined): Promise<string | null | undefined> {
  if (!area) return undefined;
  if (/^[0-9a-f-]{36}$/i.test(area)) return area;
  return ((await db.query(`SELECT id::text FROM area WHERE lower(name) = lower($1)`, [area])).rows[0]?.id as string | undefined) ?? null;
}
function keep(e: LiveEvent, f: Filter, areaId: string | null | undefined) {
  if (areaId !== undefined && e.area?.id !== areaId) return false;
  if (f.classes?.length && !f.classes.some((c) => e.class === c || e.class.startsWith(`${c}.`) || e.domain === c)) return false;
  if (f.entityType && e.entity.type !== f.entityType) return false;
  if (f.entityId && e.entity.id !== f.entityId) return false;
  return true;
}

/** The stream's resumable range: positions published within the retention window. A cursor below `oldest` cannot
 *  be resumed: take a new snapshot. */
export async function streamBounds(db: Db, now: Date = new Date()) {
  const r = (await db.query(`SELECT (SELECT min(seq) FROM live_event WHERE published_at > $1::timestamptz - make_interval(days => $2)) AS oldest, max(seq) AS newest FROM live_event`, [now, RETENTION_DAYS])).rows[0];
  return { oldest: r.oldest === null ? null : Number(r.oldest), newest: r.newest === null ? 0 : Number(r.newest) };
}

export type ReadResult = { reset: true; reason: string; oldest: number | null } | { reset: false; events: LiveEvent[]; cursor: number; more: boolean };

/** Ordered events after a cursor (exclusive). Filtering never moves the cursor backwards: it advances over skipped rows. */
export async function readAfter(db: Db, after: number, f: Filter = {}, limit = 500, now: Date = new Date()): Promise<ReadResult> {
  const b = await streamBounds(db, now);
  const expired = after > 0 && after < b.newest && (b.oldest === null || after < b.oldest - 1);
  if (expired) return { reset: true, reason: `cursor ${after} is older than the ${RETENTION_DAYS}-day stream window (oldest resumable ${b.oldest ?? "none"}) — take a new snapshot`, oldest: b.oldest };
  // A fresh subscriber (after = 0) starts at the beginning of the window, not at the dawn of history.
  const from = after === 0 && b.oldest !== null ? b.oldest - 1 : after;
  const rows = (await db.query(`SELECT l.seq, ${EVENT_COLS} FROM live_event l JOIN event e ON e.id = l.event_id WHERE l.seq > $1 ORDER BY l.seq LIMIT $2`, [from, limit + 1])).rows;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const areaId = await resolveArea(db, f.area);
  const events = (await toEnvelopes(db, page)).filter((e) => keep(e, f, areaId));
  return { reset: false, events, cursor: page.length ? Number(page[page.length - 1].seq) : from, more };
}

/** Collapse runs of low-value events (same class + entity type) into one message carrying the count. Pure. */
export function coalesce(events: LiveEvent[], minRun = 3): Array<LiveEvent & { coalesced?: { count: number; firstSeq: number } }> {
  const out: Array<LiveEvent & { coalesced?: { count: number; firstSeq: number } }> = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i]!;
    let j = i + 1;
    if (e.lowValue) while (j < events.length && events[j]!.lowValue && events[j]!.class === e.class && events[j]!.entity.type === e.entity.type) j++;
    if (j - i >= minRun) { const last = events[j - 1]!; out.push({ ...last, summary: `${e.class} ×${j - i}`, coalesced: { count: j - i, firstSeq: e.seq } }); }
    else for (let k = i; k < j; k++) out.push(events[k]!);
    i = j;
  }
  return out;
}

/** Semantic history over ALL stored events (not limited to the stream's retention).
 *  ADR-089 slice 0: filters (area, class, entity) apply BEFORE the limit — the stored rows are scanned in pages until
 *  `limit` matching events are found (bounded scan) — and history can page newest-first (`order: "desc"`, `before`/
 *  `after` = event id). Before this, the limit was applied first, so a filtered read returned only the matches among the
 *  first 500 rows of all history. */
export async function history(db: Db, opts: { from?: string; to?: string; limit?: number; order?: "asc" | "desc"; before?: number; after?: number; maxScan?: number } & Filter = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const desc = opts.order === "desc";
  const areaId = await resolveArea(db, opts.area);
  const maxScan = opts.maxScan ?? 50_000;
  const out: LiveEvent[] = [];
  let lo = opts.after ?? null, hi = opts.before ?? null, scanned = 0;
  while (out.length < limit && scanned < maxScan) {
    const rows = (await db.query(`SELECT l.seq, ${EVENT_COLS} FROM event e LEFT JOIN live_event l ON l.event_id = e.id
        WHERE ($1::timestamptz IS NULL OR e.occurred_at >= $1) AND ($2::timestamptz IS NULL OR e.occurred_at <= $2)
          AND ($3::bigint IS NULL OR e.id > $3) AND ($4::bigint IS NULL OR e.id < $4)
          AND ($5::text IS NULL OR e.entity_type = $5) AND ($6::text IS NULL OR e.entity_id::text = $6)
        ORDER BY e.id ${desc ? "DESC" : "ASC"} LIMIT 500`,
      [opts.from ?? null, opts.to ?? null, lo, hi, opts.entityType ?? null, opts.entityId ?? null])).rows;
    if (!rows.length) break;
    scanned += rows.length;
    for (const e of (await toEnvelopes(db, rows)).filter((x) => keep(x, opts, areaId))) { if (out.length < limit) out.push(e); }
    const edge = Number(rows[rows.length - 1].id);
    if (desc) hi = edge; else lo = edge;
    if (rows.length < 500) break;
  }
  return out;
}

/** The causal chain behind one event: its causes, recursively (bounded). */
export async function causalChain(db: Db, eventId: number, depth = 8): Promise<LiveEvent[]> {
  const seen = new Set<number>(); let frontier = [eventId]; const rows: Array<Record<string, unknown>> = [];
  for (let d = 0; d < depth && frontier.length; d++) {
    const r = (await db.query(`SELECT l.seq, ${EVENT_COLS} FROM event e LEFT JOIN live_event l ON l.event_id = e.id WHERE e.id = ANY($1::bigint[])`, [frontier])).rows;
    frontier = [];
    for (const x of r) { if (seen.has(Number(x.id))) continue; seen.add(Number(x.id)); rows.push(x); frontier.push(...((x.cause_ids as Array<string | number> | null) ?? []).map(Number)); }
  }
  return (await toEnvelopes(db, rows.sort((a, b) => Number(a.id) - Number(b.id))));
}

// ---------------------------------------------------------------------------------------------------- snapshot
/** The current authoritative state, read in ONE repeatable-read snapshot together with the cursor it is consistent
 *  with: every change visible here has seq ≤ cursor or will arrive after it (consumers apply events idempotently). */
export async function snapshot(pool: pg.Pool, f: Pick<Filter, "area"> = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const areaId = await resolveArea(c, f.area);
    const A = areaId === undefined ? null : areaId;
    const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
    const cursor = Number((await q(`SELECT COALESCE(max(seq), 0) AS s FROM live_event`))[0].s);
    const areaRows = await q(`SELECT a.id, a.name, a.status, (SELECT count(*)::int FROM project p WHERE p.area_id = a.id AND p.status = 'active' AND p.archived_at IS NULL) AS active_projects
        FROM area a WHERE a.archived_at IS NULL AND ($1::uuid IS NULL OR a.id = $1) ORDER BY a.name`, [A]);
    // ADR-089 slice 0: the Area's verdict as Finagai computes it (same function as area_status, without its sweep), and
    // whether it is Finagai's own internal test Area (never shown as a normal Area).
    const areas = [];
    for (const a of areaRows) {
      const st = await areaStatusRead(c, { id: String(a.id), name: String(a.name) });
      areas.push({ ...a, internal: a.name === TEST_AREA, health: { color: st.color, breaches: st.breaches, warnings: st.warnings } });
    }
    const objectives = await q(`SELECT id, area_id, name, status, target_date FROM objective WHERE status = 'open' AND ($1::uuid IS NULL OR area_id = $1)`, [A]);
    const projects = await q(`SELECT id, area_id, name, status FROM project WHERE archived_at IS NULL AND status = 'active' AND ($1::uuid IS NULL OR area_id = $1) ORDER BY name LIMIT 200`, [A]);
    const waits = (await q(`SELECT f.id, COALESCE(f.area_id, p.area_id) AS area_id, f.summary, f.counterparty, f.state, f.due_at, f.origin, f.rule, f.opportunity_id,
        f.project_id,
        EXISTS (SELECT 1 FROM escalation x WHERE x.status = 'open' AND x.needs <> 'requested' AND (x.followup_id = f.id OR x.key LIKE 'overdue:' || f.id::text || ':%')) AS escalated,
        (f.origin = 'lifecycle' AND f.rule = ANY($2::text[])) AS julian_rule
        FROM followup f LEFT JOIN project p ON p.id = f.project_id WHERE f.state IN ('open','waiting','overdue') AND ($1::uuid IS NULL OR COALESCE(f.area_id, p.area_id) = $1) ORDER BY f.due_at NULLS LAST`, [A, Object.keys(RULE_NEEDS)]))
      // ADR-089 slice 0: who owns the next step, by the engine's own rule — a lifecycle step that needs Julian (RULE_NEEDS)
      // or any wait with an open escalation is Julian's; every other wait is Finagai watching it.
      .map(({ julian_rule, ...w }) => ({ ...w, owner: julian_rule || w.escalated ? "julian" : "finagai" }));
    const needsJulian = (await q(`SELECT id, key, area_id, needs, summary, due_at, notified_at, created_at, followup_id FROM escalation WHERE status = 'open' AND needs <> 'requested' AND ($1::uuid IS NULL OR area_id = $1)`, [A]))
      .map((e) => { const m = /@([a-z_]+):([0-9a-f-]{36})$/.exec(String(e.key)); return { ...e, subject: m ? { type: m[1], id: m[2] } : e.followup_id ? { type: "followup", id: e.followup_id } : null }; });
    const exceptions = await q(`SELECT key, detector, area_id, owner, severity, needs, summary, first_seen_at, remediation, remediation_attempts FROM operating_exception WHERE status = 'open' AND ($1::uuid IS NULL OR area_id = $1)`, [A]);
    const tasks = await q(`SELECT code, status, verification_status, awaiting_kind, left(request, 200) AS request, updated_at FROM control_task WHERE status IN ('active','waiting_approval','paused') ORDER BY code`);
    const lessons = await q(`SELECT key, kind, basis, status, area_id, left(statement, 300) AS statement, confidence, support, last_evidence_at, effect->>'type' AS effect FROM lesson
        WHERE status IN ('active','proposed','approved') AND ($1::uuid IS NULL OR area_id = $1 OR area_id IS NULL) ORDER BY confidence DESC LIMIT 200`, [A]);
    const rules = await q(`SELECT code, statement, kind, metric, armed, last_fired_at FROM watch_rule WHERE status = 'active'`);
    const opportunities = await q(`SELECT status, count(*)::int AS n FROM opportunity WHERE archived_at IS NULL AND ($1::uuid IS NULL OR area_id = $1) GROUP BY status`, [A]);
    const loop = (await q(`SELECT max(started_at) AS at FROM event_tick WHERE status IN ('done','running')`))[0]?.at ?? null;
    await c.query("COMMIT");
    return {
      v: CONTRACT_VERSION, cursor, takenAt: new Date().toISOString(),
      areas, objectives, projects, waits, needsJulian, exceptions, tasks, lessons: lessons.map((l) => ({ ...l, statement: sanitize(l.statement) })), rules,
      opportunitiesByStatus: Object.fromEntries(opportunities.map((o) => [o.status, o.n])), eventLoopLastTick: loop,
    };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

/** Background publisher: every 5 s (the stream endpoints also publish on demand). */
export function startLivePublisher(pool: pg.Pool, log: (m: string, f?: Record<string, unknown>) => void, everyMs = 5000) {
  const run = async () => {
    try { await publish(pool); }
    catch (e) { log("live publish failed", { error: String((e as Error)?.message ?? e).slice(0, 160) }); }
  };
  const t = setInterval(run, everyMs); t.unref();
  return () => clearInterval(t);
}
