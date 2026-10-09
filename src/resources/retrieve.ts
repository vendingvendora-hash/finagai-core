/**
 * Phase 2D (ADR-074) — retrieve before ask.
 * Executes the Core-side sources of a ResourcePlan (Finagai state, Google) and returns bounded snippets with
 * provenance, so whoever does the work — the chat surface or the Mac operator — starts from what Finagai can
 * already know. Mac-side sources (files, screen) stay with the Mac operator; they are reported as "delegated".
 * Failures are recorded per source (never hidden), and a source that fails falls back per the plan.
 */
import type pg from "pg";
import type { CareerSources } from "../cos/career-evidence.js";
import { SLOT_SOURCES, type ResourcePlan } from "./planner.js";
import { writeTrace } from "./trace.js";

export interface Retrieved { capabilityId: string; status: "ok" | "empty" | "failed" | "delegated"; items: Array<{ title: string; detail: string; source: string }>; note?: string }
export interface GoogleSearch extends CareerSources { search?(terms: string[]): Promise<Array<{ name: string; path: string; modified?: string; text: string }>>;
  gmail?(terms: string[]): Promise<Array<{ name: string; path: string; modified?: string; text: string }>>;
  calendar?(terms: string[]): Promise<Array<{ name: string; path: string; modified?: string; text: string }>>;
  drive?(terms: string[]): Promise<Array<{ name: string; path: string; modified?: string; text: string }>> }

const MAX_ITEMS = 5, MAX_CHARS = 600, MAX_SUMMARY_CHARS = 3000, MAX_GMAIL_ITEMS = 8;
const clip = (s: unknown, max = MAX_CHARS) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Request verbs and filler that never identify WHAT is being asked about (live fix ADR-075). */
const STOP = new Set(["prepare", "prep", "me", "for", "the", "a", "an", "my", "and", "to", "of", "what", "whats", "is", "on", "with",
  "please", "find", "show", "get", "give", "summarize", "summarise", "summary", "status", "chart", "send", "open", "pull", "read", "tell",
  "about", "can", "you", "how", "when", "where", "who", "which", "this", "that", "these", "those", "spreadsheet", "workbook", "file",
  "document", "doc", "deck", "report", "brief", "ready", "latest", "last", "previous", "recent", "any", "from", "in", "it", "its", "do", "did"]);

/** Search groups: known entity names, else ONE group of the request's content words (matched together). */
export function terms(plan: Pick<ResourcePlan, "entities" | "request">): string[] {
  if (plan.entities.length) return [...new Set(plan.entities.map((e) => e.name))];
  const raw = (plan.request.match(/[A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]{3,}/g) ?? []).filter((w) => !STOP.has(w.toLowerCase()));
  // Names Julian capitalizes ("Northwind Analytics", "Degree of Leverage Analysis") identify the subject; descriptive
  // words around them ("interview", "application") are not required to appear in a matching email or file.
  const proper = raw.filter((w) => /^[A-ZÁÉÍÓÚÑ0-9]/.test(w));
  const words = (proper.length ? proper : raw).map((w) => w.toLowerCase()).slice(0, 4);
  return words.length ? [words.join(" ")] : [];
}

/**
 * Live fix (R09: "When is my Altarum interview?" returned Capital One and Canva mail): a Google result counts only
 * if it mentions the request's content — every word of at least one group (live R02: "half" let résumé JSONs through).
 */
export function relevant<T extends { name: string; text: string }>(rows: T[], groups: string[]): T[] {
  if (!groups.length) return rows;
  return rows.filter((x) => {
    const hay = `${x.name} ${x.text}`.toLowerCase();
    return groups.some((g) => {
      const w = g.toLowerCase().split(/\s+/).filter((y) => y.length >= 3);
      const hits = w.filter((y) => hay.includes(y)).length;
      return hits === w.length;
    });
  });
}

/** Collapse timestamped copies (knowledge_base_backup_2026-…json, dossier_2026-…json, intel_…json): keep the first (newest). */
export function dedupeVersions<T extends { name: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((x) => {
    const k = x.name.toLowerCase().replace(/\d{4}-\d{2}-\d{2}t[\d-]+(\.\d+)?z?/g, "").replace(/_?backup_?/g, "").replace(/[\s_-]+/g, " ").trim();
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

/**
 * Live acceptance ("say no next round is scheduled"): from calendar lines "ISO | title | …", state the next
 * upcoming event, or that none is scheduled, plus the most recent past one — computed, never left to inference.
 */
export function scheduleNote(text: string, now: Date = new Date()): string | undefined {
  const ev = [...text.matchAll(/^(\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?) \| ([^|\n]*)/gm)].map((m) => ({ at: new Date(m[1]!), title: m[2]!.trim() }))
    .filter((e) => !Number.isNaN(e.at.getTime())).sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!ev.length) return undefined;
  const next = ev.find((e) => e.at >= now);
  const last = [...ev].reverse().find((e) => e.at < now);
  const d = (e: { at: Date; title: string }) => `${e.at.toISOString().slice(0, 10)} ${e.title}`;
  return `${next ? `next scheduled: ${d(next)}` : "no upcoming event is scheduled"}${last ? `; most recent: ${d(last)}` : ""}`;
}

/** Deictic requests ("that chart", "the last report") mean recency, not content match. */
const deictic = (r: string) => /\b(that|those|last|latest|previous|recent|just)\b/i.test(r);
/** SQL ILIKE ALL patterns: every content word must appear (with one entity this is just the entity name). */
function likePatterns(groups: string[]): string[] {
  return groups.flatMap((g) => g.split(/\s+/)).filter((w) => w.length >= 3).map((w) => `%${w.replace(/[%_\\]/g, "")}%`);
}

export async function retrieve(pool: pg.Pool, plan: ResourcePlan, deps: { google?: GoogleSearch } = {}): Promise<Retrieved[]> {
  const out: Retrieved[] = [];
  for (const u of plan.use) out.push(await retrieveOne(pool, plan, u.capabilityId, deps));
  // Live fix: the most authoritative source for a need may be configured, healthy — and EMPTY (e.g. interview
  // dates that live only in recruiter emails, not on the calendar). Then the next source for that need answers.
  for (const [slot, auth] of Object.entries(plan.authoritative)) {
    const a = out.find((r) => r.capabilityId === auth);
    if (a && a.status === "ok") continue;
    for (const next of (SLOT_SOURCES[slot] ?? []).filter((id) => id !== auth)) {
      if (plan.unavailable.some((u) => u.capabilityId === next)) continue;
      let r = out.find((x) => x.capabilityId === next);
      if (!r) { r = await retrieveOne(pool, plan, next, deps); out.push(r); }
      if (r.status === "ok") {
        r.note = a?.status === "delegated"
          ? `supplements ${slot.replace(/_/g, " ")} while ${auth} is retrieved by the Mac operator`
          : `answers ${slot.replace(/_/g, " ")}: ${auth} returned ${a?.status ?? "nothing"}`;
        break;
      }
    }
  }
  return out;
}

/** Slot → the source that actually answered it (declared authority if it had data, else the fallback). */
export function effectiveAuthority(plan: ResourcePlan, results: Retrieved[]): Record<string, { source: string | null; note?: string }> {
  const out: Record<string, { source: string | null; note?: string }> = {};
  for (const slot of Object.keys(plan.authoritative)) {
    const order = [plan.authoritative[slot]!, ...(SLOT_SOURCES[slot] ?? []).filter((x) => x !== plan.authoritative[slot])];
    const hit = order.find((id) => results.some((r) => r.capabilityId === id && r.status === "ok"));
    const authR = results.find((r) => r.capabilityId === plan.authoritative[slot]);
    if (authR?.status === "delegated") {         // live fix: "delegated" is pending, not "had nothing"
      out[slot] = { source: plan.authoritative[slot]!, note: `retrieved by the Mac operator when the task runs${hit && hit !== plan.authoritative[slot] ? `; ${hit} has supplementary matches` : ""}` };
      continue;
    }
    out[slot] = hit === plan.authoritative[slot] ? { source: hit ?? null }
      : { source: hit ?? null, note: `${plan.authoritative[slot]} had nothing${hit ? `; answered by ${hit}` : "; no source had data"}` };
  }
  return out;
}

const concatDetail = (xs: Array<string | null>) => xs.filter(Boolean).join(" · ");
async function retrieveOne(pool: pg.Pool, plan: ResourcePlan, id: string, deps: { google?: GoogleSearch }): Promise<Retrieved> {
  const t = terms(plan);
  const out: Retrieved[] = [];
  {
    try {
      if (id === "state.projects") {
        const names = plan.entities.filter((e) => e.kind === "project" || e.kind === "entity").map((e) => e.name);
        const r = await pool.query(
          `SELECT 'project' AS k, p.name AS title, concat_ws(' · ', p.status, p.description) AS detail FROM project p
             WHERE p.archived_at IS NULL AND (p.name = ANY($1) OR p.search @@ plainto_tsquery('simple', $2))
           UNION ALL
           SELECT 'work_item', w.title, concat_ws(' · ', w.status, w.detail, 'due ' || w.due_at::date) FROM work_item w JOIN project p ON p.id = w.project_id
             WHERE w.archived_at IS NULL AND (p.name = ANY($1)) AND w.status NOT IN ('done','cancelled')
           LIMIT $3`, [names, t.join(" "), MAX_ITEMS * 2]);
        out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: `${x.k}: ${x.title}`, detail: clip(x.detail), source: "Finagai project memory" })) });
      } else if (id === "state.areas") {
        const r = await pool.query(
          `SELECT f.summary AS title, concat_ws(' · ', 'waiting on ' || f.counterparty, f.state, 'due ' || f.due_at::date) AS detail
             FROM followup f WHERE f.state NOT IN ('done','cancelled')
               AND (cardinality($2::text[]) = 0 OR concat_ws(' ', f.summary, f.counterparty) ILIKE ALL ($2::text[]))
             ORDER BY f.due_at NULLS LAST LIMIT $1`, [MAX_ITEMS, deictic(plan.request) || plan.authoritative.commitments ? [] : likePatterns(t)]);
        out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: x.title, detail: clip(x.detail), source: "Finagai follow-ups" })) });
      } else if (id === "state.opportunities") {
        // Phase 4 (ADR-082): one row per JOB (never per employer), most engaged first.
        const pats = deictic(plan.request) ? [] : likePatterns(t);
        const r = await pool.query(
          `SELECT coalesce(e.name, o.org) AS employer, o.title, o.requisition_id, o.status, o.applied_at::date AS applied, o.last_evidence_at::date AS last, o.contact
             FROM opportunity o LEFT JOIN employer e ON e.id = o.employer_id
            WHERE o.archived_at IS NULL AND (cardinality($2::text[]) = 0 AND o.status IN ('preparing','applied','interviewing','offer')
                   OR cardinality($2::text[]) > 0 AND concat_ws(' ', e.name, o.org, o.title, o.requisition_id) ILIKE ANY ($2::text[]))
            ORDER BY CASE WHEN o.status IN ('offer','interviewing','preparing','applied') THEN 0 ELSE 1 END, o.last_evidence_at DESC NULLS LAST LIMIT $1`, [MAX_ITEMS * 2, pats]);
        out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: `${x.employer} — ${x.title}${x.requisition_id ? ` (${x.requisition_id})` : ""}`,
          detail: clip(concatDetail([x.status, x.applied ? `applied ${new Date(x.applied).toISOString().slice(0, 10)}` : null, x.last ? `last contact ${new Date(x.last).toISOString().slice(0, 10)}` : null, x.contact ? `contact ${x.contact}` : null])), source: "Finagai job pipeline" })) });
      } else if (id === "state.artifacts") {
        // Live fix: unrelated recent artifacts (move-file tests) were returned as "prior work" for Altarum.
        // "that chart" means the most recent CHART, not the most recent anything.
        const kind = deictic(plan.request) ? (plan.request.toLowerCase().match(/\b(chart|screenshot|pdf|report|file)\b/)?.[1] ?? null) : null;
        const r = await pool.query(`SELECT kind, summary, created_at FROM artifact WHERE state <> 'expired'
            AND ($3::text IS NULL OR kind = $3)
            AND (cardinality($2::text[]) = 0 OR summary ILIKE ALL ($2::text[])) ORDER BY created_at DESC LIMIT $1`,
          [MAX_ITEMS, deictic(plan.request) ? [] : likePatterns(t), kind]);
        out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: `${x.kind} (${new Date(x.created_at).toISOString().slice(0, 10)})`, detail: clip(x.summary), source: "Finagai artifacts" })) });
      } else if (id === "state.interactions") {
        const r = await pool.query(`SELECT origin_message, state, result_summary FROM interaction WHERE result_summary IS NOT NULL
            AND (cardinality($2::text[]) = 0 OR concat_ws(' ', origin_message, result_summary) ILIKE ALL ($2::text[])) ORDER BY created_at DESC LIMIT $1`,
          [MAX_ITEMS, deictic(plan.request) ? [] : likePatterns(t)]);
        out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: clip(x.origin_message).slice(0, 80), detail: clip(`${x.state}: ${x.result_summary}`), source: "past Finagai requests" })) });
      } else if (id.startsWith("google.")) {
        const g = deps.google;
        const fn = id === "google.gmail" ? g?.gmail : id === "google.calendar" ? g?.calendar : id === "google.drive" ? g?.drive : undefined;
        if (!g || !fn) { out.push({ capabilityId: id, status: "failed", items: [], note: "Google client not available in this process" }); return out[0]!; }
        const raw = relevant(await fn.call(g, t), t);
        const rows = id === "google.drive" ? dedupeVersions(raw) : raw;   // Gmail subjects legitimately repeat (9/21 vs 9/28 confirmations)
        const cap = id === "google.gmail" ? MAX_GMAIL_ITEMS : MAX_ITEMS;
        const sched = id === "google.calendar" ? scheduleNote(rows.map((x) => x.text).join("\n")) : undefined;
        out.push({ capabilityId: id, status: rows.length ? "ok" : "empty", items: rows.slice(0, cap).map((x) => ({ title: x.name,
          detail: clip(x.text, /\[meeting summary\]/.test(x.text) ? MAX_SUMMARY_CHARS : id === "google.calendar" ? MAX_SUMMARY_CHARS : MAX_CHARS), source: `${id} ${x.modified ?? ""}`.trim() })),
          ...(sched ? { note: sched } : {}) });
      } else {
        out.push({ capabilityId: id, status: "delegated", items: [], note: id.startsWith("mac.")
          ? "Mac-side source: the Mac operator retrieves it"
          : "action capability: exercised when the task runs; not a data source" });
      }
    } catch (e) {
      out.push({ capabilityId: id, status: "failed", items: [], note: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return out[0]!;
}

/** Record what retrieval actually returned (R10: the trace explains the outcome, not just the intent). */
export async function traceRetrieval(pool: pg.Pool, ctx: { interactionId?: string | null; taskId?: string | null; request: string }, results: Retrieved[]): Promise<void> {
  await writeTrace(pool, ctx, results.filter((r) => r.status !== "delegated").map((r) => ({
    capabilityId: r.capabilityId, decision: r.status === "ok" ? "used" as const : r.status === "failed" ? "unavailable" as const : "considered" as const,
    reason: r.status === "ok" ? `retrieved ${r.items.length} item(s)` : r.status === "empty" ? "queried; nothing relevant found" : `retrieval failed: ${r.note ?? "unknown"}` })));
}

/** Prompt block for the Mac operator / chat: what Finagai already found, with provenance. */
export function retrievedBlock(results: Retrieved[]): string {
  const ok = results.filter((r) => r.status === "ok");
  if (!ok.length) return "";
  return "Retrieved context (already looked up — use it, do not ask Julian for it):\n" + ok.map((r) =>
    `[${r.capabilityId}]\n` + r.items.map((i) => `- ${i.title}: ${i.detail} (${i.source})`).join("\n")).join("\n").slice(0, 3500);
}
