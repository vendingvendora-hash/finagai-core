import { writeTrace } from "./trace.js";
const MAX_ITEMS = 5, MAX_CHARS = 600;
const clip = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
function terms(plan) {
    if (plan.entities.length)
        return plan.entities.map((e) => e.name);
    const stop = new Set(["prepare", "me", "for", "the", "a", "an", "my", "and", "to", "of", "what", "is", "on", "with", "please", "find", "show", "get", "give"]);
    return (plan.request.toLowerCase().match(/[a-z0-9áéíóúñ]{3,}/g) ?? []).filter((w) => !stop.has(w)).slice(0, 4);
}
export async function retrieve(pool, plan, deps = {}) {
    const out = [];
    const t = terms(plan);
    for (const u of plan.use) {
        const id = u.capabilityId;
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
             FROM followup f WHERE f.state NOT IN ('done','cancelled') ORDER BY f.due_at NULLS LAST LIMIT $1`, [MAX_ITEMS]);
                out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: x.title, detail: clip(x.detail), source: "Finagai follow-ups" })) });
            }
            else if (id === "state.artifacts") {
                const r = await pool.query(`SELECT kind, summary, created_at FROM artifact WHERE state <> 'expired' ORDER BY created_at DESC LIMIT $1`, [MAX_ITEMS]);
                out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: `${x.kind} (${new Date(x.created_at).toISOString().slice(0, 10)})`, detail: clip(x.summary), source: "Finagai artifacts" })) });
            }
            else if (id === "state.interactions") {
                const r = await pool.query(`SELECT origin_message, state, result_summary FROM interaction WHERE result_summary IS NOT NULL ORDER BY created_at DESC LIMIT $1`, [MAX_ITEMS]);
                out.push({ capabilityId: id, status: r.rowCount ? "ok" : "empty", items: r.rows.map((x) => ({ title: clip(x.origin_message).slice(0, 80), detail: clip(`${x.state}: ${x.result_summary}`), source: "past Finagai requests" })) });
            }
            else if (id.startsWith("google.")) {
                const g = deps.google;
                const fn = id === "google.gmail" ? g?.gmail : id === "google.calendar" ? g?.calendar : id === "google.drive" ? g?.drive : undefined;
                if (!g || !fn) {
                    out.push({ capabilityId: id, status: "failed", items: [], note: "Google client not available in this process" });
                    continue;
                }
                const rows = await fn.call(g, t);
                out.push({ capabilityId: id, status: rows.length ? "ok" : "empty", items: rows.slice(0, MAX_ITEMS).map((x) => ({ title: x.name, detail: clip(x.text), source: `${id} ${x.modified ?? ""}`.trim() })) });
            }
            else {
                out.push({ capabilityId: id, status: "delegated", items: [], note: "Mac-side source: the Mac operator retrieves it" });
            }
        }
        catch (e) {
            out.push({ capabilityId: id, status: "failed", items: [], note: String(e?.message ?? e).slice(0, 200) });
        }
    }
    return out;
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