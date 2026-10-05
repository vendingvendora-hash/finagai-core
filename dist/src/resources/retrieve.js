import { SLOT_SOURCES } from "./planner.js";
import { writeTrace } from "./trace.js";
const MAX_ITEMS = 5, MAX_CHARS = 600, MAX_SUMMARY_CHARS = 3000, MAX_GMAIL_ITEMS = 8;
const clip = (s, max = MAX_CHARS) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
/** Request verbs and filler that never identify WHAT is being asked about (live fix ADR-075). */
const STOP = new Set(["prepare", "prep", "me", "for", "the", "a", "an", "my", "and", "to", "of", "what", "whats", "is", "on", "with",
    "please", "find", "show", "get", "give", "summarize", "summarise", "summary", "status", "chart", "send", "open", "pull", "read", "tell",
    "about", "can", "you", "how", "when", "where", "who", "which", "this", "that", "these", "those", "spreadsheet", "workbook", "file",
    "document", "doc", "deck", "report", "brief", "ready", "latest", "last", "previous", "recent", "any", "from", "in", "it", "its", "do", "did"]);
/** Search groups: known entity names, else ONE group of the request's content words (matched together). */
export function terms(plan) {
    if (plan.entities.length)
        return [...new Set(plan.entities.map((e) => e.name))];
    const words = (plan.request.toLowerCase().match(/[a-z0-9áéíóúñ]{3,}/g) ?? []).filter((w) => !STOP.has(w)).slice(0, 4);
    return words.length ? [words.join(" ")] : [];
}
/**
 * Live fix (R09: "When is my Altarum interview?" returned Capital One and Canva mail): a Google result counts only
 * if it mentions the request's content — every word of an entity/one-word group, or at least half of a multi-word group.
 */
export function relevant(rows, groups) {
    if (!groups.length)
        return rows;
    return rows.filter((x) => {
        const hay = `${x.name} ${x.text}`.toLowerCase();
        return groups.some((g) => {
            const w = g.toLowerCase().split(/\s+/).filter((y) => y.length >= 3);
            const hits = w.filter((y) => hay.includes(y)).length;
            return w.length <= 1 ? hits === w.length : hits >= Math.ceil(w.length / 2);
        });
    });
}
/** Deictic requests ("that chart", "the last report") mean recency, not content match. */
const deictic = (r) => /\b(that|those|last|latest|previous|recent|just)\b/i.test(r);
/** SQL ILIKE ALL patterns: every content word must appear (with one entity this is just the entity name). */
function likePatterns(groups) {
    return groups.flatMap((g) => g.split(/\s+/)).filter((w) => w.length >= 3).map((w) => `%${w.replace(/[%_\\]/g, "")}%`);
}
export async function retrieve(pool, plan, deps = {}) {
    const out = [];
    for (const u of plan.use)
        out.push(await retrieveOne(pool, plan, u.capabilityId, deps));
    // Live fix: the most authoritative source for a need may be configured, healthy — and EMPTY (e.g. interview
    // dates that live only in recruiter emails, not on the calendar). Then the next source for that need answers.
    for (const [slot, auth] of Object.entries(plan.authoritative)) {
        const a = out.find((r) => r.capabilityId === auth);
        if (a && a.status === "ok")
            continue;
        for (const next of (SLOT_SOURCES[slot] ?? []).filter((id) => id !== auth)) {
            if (plan.unavailable.some((u) => u.capabilityId === next))
                continue;
            let r = out.find((x) => x.capabilityId === next);
            if (!r) {
                r = await retrieveOne(pool, plan, next, deps);
                out.push(r);
            }
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
export function effectiveAuthority(plan, results) {
    const out = {};
    for (const slot of Object.keys(plan.authoritative)) {
        const order = [plan.authoritative[slot], ...(SLOT_SOURCES[slot] ?? []).filter((x) => x !== plan.authoritative[slot])];
        const hit = order.find((id) => results.some((r) => r.capabilityId === id && r.status === "ok"));
        const authR = results.find((r) => r.capabilityId === plan.authoritative[slot]);
        if (authR?.status === "delegated") { // live fix: "delegated" is pending, not "had nothing"
            out[slot] = { source: plan.authoritative[slot], note: `retrieved by the Mac operator when the task runs${hit && hit !== plan.authoritative[slot] ? `; ${hit} has supplementary matches` : ""}` };
            continue;
        }
        out[slot] = hit === plan.authoritative[slot] ? { source: hit ?? null }
            : { source: hit ?? null, note: `${plan.authoritative[slot]} had nothing${hit ? `; answered by ${hit}` : "; no source had data"}` };
    }
    return out;
}
async function retrieveOne(pool, plan, id, deps) {
    const t = terms(plan);
    const out = [];
    {
        try {
            if (id === "state.projects") {
                const names = plan.entities.filter((e) => e.kind === "project" || e.kind === "entity").map((e) => e.name);
                const r = await pool.query(`SELECT 'project' AS k, p.name AS title, concat_ws(' · ', p.status, p.description) AS detail FROM project p
             WHERE p.archived_at IS NULL AND (p.name = ANY($1) OR p.search @@ plainto_tsquery('simple', $2))
           UNION ALL
           SELECT 'work_item', w.title, concat_ws(' · ', w.status, w.detail, 'due ' || w.due_at::date) FROM work_item w JOIN project p ON p.id = w.project_id
             WHERE w.archived_at IS NULL AND (p.name = ANY($1)) AND w.status NOT IN ('done','cancelled')
           LIMIT $3`, [names, t.join(" "), MAX_ITEMS * 2]);
                out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: `${x.k}: ${x.title}`, detail: clip(x.detail), source: "Finagai project memory" })) });
            }
            else if (id === "state.areas") {
                const r = await pool.query(`SELECT f.summary AS title, concat_ws(' · ', 'waiting on ' || f.counterparty, f.state, 'due ' || f.due_at::date) AS detail
             FROM followup f WHERE f.state NOT IN ('done','cancelled')
               AND (cardinality($2::text[]) = 0 OR concat_ws(' ', f.summary, f.counterparty) ILIKE ALL ($2::text[]))
             ORDER BY f.due_at NULLS LAST LIMIT $1`, [MAX_ITEMS, deictic(plan.request) ? [] : likePatterns(t)]);
                out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: x.title, detail: clip(x.detail), source: "Finagai follow-ups" })) });
            }
            else if (id === "state.artifacts") {
                // Live fix: unrelated recent artifacts (move-file tests) were returned as "prior work" for Altarum.
                // "that chart" means the most recent CHART, not the most recent anything.
                const kind = deictic(plan.request) ? (plan.request.toLowerCase().match(/\b(chart|screenshot|pdf|report|file)\b/)?.[1] ?? null) : null;
                const r = await pool.query(`SELECT kind, summary, created_at FROM artifact WHERE state <> 'expired'
            AND ($3::text IS NULL OR kind = $3)
            AND (cardinality($2::text[]) = 0 OR summary ILIKE ALL ($2::text[])) ORDER BY created_at DESC LIMIT $1`, [MAX_ITEMS, deictic(plan.request) ? [] : likePatterns(t), kind]);
                out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: `${x.kind} (${new Date(x.created_at).toISOString().slice(0, 10)})`, detail: clip(x.summary), source: "Finagai artifacts" })) });
            }
            else if (id === "state.interactions") {
                const r = await pool.query(`SELECT origin_message, state, result_summary FROM interaction WHERE result_summary IS NOT NULL
            AND (cardinality($2::text[]) = 0 OR concat_ws(' ', origin_message, result_summary) ILIKE ALL ($2::text[])) ORDER BY created_at DESC LIMIT $1`, [MAX_ITEMS, deictic(plan.request) ? [] : likePatterns(t)]);
                out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: clip(x.origin_message).slice(0, 80), detail: clip(`${x.state}: ${x.result_summary}`), source: "past Finagai requests" })) });
            }
            else if (id.startsWith("google.")) {
                const g = deps.google;
                const fn = id === "google.gmail" ? g?.gmail : id === "google.calendar" ? g?.calendar : id === "google.drive" ? g?.drive : undefined;
                if (!g || !fn) {
                    out.push({ capabilityId: id, status: "failed", items: [], note: "Google client not available in this process" });
                    return out[0];
                }
                const rows = relevant(await fn.call(g, t), t);
                const cap = id === "google.gmail" ? MAX_GMAIL_ITEMS : MAX_ITEMS;
                out.push({ capabilityId: id, status: rows.length ? "ok" : "empty", items: rows.slice(0, cap).map((x) => ({ title: x.name,
                        detail: clip(x.text, /\[meeting summary\]/.test(x.text) ? MAX_SUMMARY_CHARS : MAX_CHARS), source: `${id} ${x.modified ?? ""}`.trim() })) });
            }
            else {
                out.push({ capabilityId: id, status: "delegated", items: [], note: id.startsWith("mac.")
                        ? "Mac-side source: the Mac operator retrieves it"
                        : "action capability: exercised when the task runs; not a data source" });
            }
        }
        catch (e) {
            out.push({ capabilityId: id, status: "failed", items: [], note: String(e?.message ?? e).slice(0, 200) });
        }
    }
    return out[0];
}
/** Record what retrieval actually returned (R10: the trace explains the outcome, not just the intent). */
export async function traceRetrieval(pool, ctx, results) {
    await writeTrace(pool, ctx, results.filter((r) => r.status !== "delegated").map((r) => ({
        capabilityId: r.capabilityId, decision: r.status === "ok" ? "used" : r.status === "failed" ? "unavailable" : "considered",
        reason: r.status === "ok" ? `retrieved ${r.items.length} item(s)` : r.status === "empty" ? "queried; nothing relevant found" : `retrieval failed: ${r.note ?? "unknown"}`
    })));
}
/** Prompt block for the Mac operator / chat: what Finagai already found, with provenance. */
export function retrievedBlock(results) {
    const ok = results.filter((r) => r.status === "ok");
    if (!ok.length)
        return "";
    return "Retrieved context (already looked up — use it, do not ask Julian for it):\n" + ok.map((r) => `[${r.capabilityId}]\n` + r.items.map((i) => `- ${i.title}: ${i.detail} (${i.source})`).join("\n")).join("\n").slice(0, 3500);
}
//# sourceMappingURL=retrieve.js.map