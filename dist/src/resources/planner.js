import { listCapabilities } from "./registry.js";
import { writeTrace } from "./trace.js";
export const MAX_SOURCES = 6;
export const RELEVANCE_FLOOR = 0.35;
const words = (s) => s.toLowerCase().match(/[a-z0-9áéíóúñü]+/g) ?? [];
/** Known Finagai state mentioned in the request (projects, people/orgs, areas) — retrieved, never re-asked (R01). */
export async function knownEntities(pool, request) {
    const r = await pool.query(`SELECT 'project' AS kind, name, id::text FROM project WHERE archived_at IS NULL AND length(name) >= 3 AND $1 ILIKE '%' || name || '%'
     UNION ALL
     SELECT 'entity', name, id::text FROM entity WHERE archived_at IS NULL AND length(name) >= 3
       AND ($1 ILIKE '%' || name || '%' OR EXISTS (SELECT 1 FROM unnest(coalesce(aliases, '{}'::text[])) a WHERE length(a) >= 3 AND $1 ILIKE '%' || a || '%'))
     UNION ALL
     SELECT 'area', name, id::text FROM area WHERE archived_at IS NULL AND length(name) >= 3 AND $1 ILIKE '%' || name || '%'
     LIMIT 20`, [request]);
    return r.rows;
}
/** Slot-level signals: what kinds of information the request needs. */
export function slotsFor(request) {
    const r = request.toLowerCase();
    const s = new Set();
    if (/\b(prepare|prep|brief me|get me ready|ready for)\b/.test(r)) {
        s.add("schedule");
        s.add("correspondence");
        s.add("project_state");
        s.add("prior_work");
        s.add("documents");
    }
    if (/\b(meeting|interview|call|calendar|schedule|when is|tomorrow|today|this week|next week)\b/.test(r))
        s.add("schedule");
    if (/\b(email|e-mail|inbox|reply|replied|recruiter|thread|wrote|sent me)\b/.test(r))
        s.add("correspondence");
    if (/\b(project|status|waiting on|follow[- ]?up|next action|objective|area)\b/.test(r))
        s.add("project_state");
    if (/\b(chart|artifact|last|previous|that (chart|file|report))\b/.test(r))
        s.add("prior_work");
    if (/\b(file|document|spreadsheet|workbook|xlsx|csv|pdf|docx|deck|report|template)\b/.test(r))
        s.add("documents");
    if (/\b(this|on my screen|open (window|tab|document)|what i'?m looking at|current (tab|page|window))\b/.test(r))
        s.add("current_context");
    if (/\b(text|imessage|message (to|from))\b|\bsend\b[^.?!]{0,40}\bto\b/.test(r))
        s.add("messaging");
    return s;
}
/** Which capability answers which slot, with the slot's authority order (highest first) — R09. */
const SLOT_SOURCES = {
    schedule: ["google.calendar", "state.projects", "google.gmail"],
    correspondence: ["google.gmail", "mac.imessage"],
    project_state: ["state.areas", "state.projects"],
    prior_work: ["state.artifacts", "state.interactions"],
    documents: ["mac.local_parser", "mac.filesystem", "google.drive"],
    current_context: ["mac.context", "mac.browser", "mac.screen"],
    messaging: ["mac.imessage"],
};
/** Generic lexical relevance of a capability's declared scope/operations to the request (makes new capabilities usable, R08). */
function lexical(cap, request) {
    const req = new Set(words(request));
    const toks = [...words(cap.scope), ...cap.operations.flatMap((o) => words(o.replace(/_/g, " ")))].filter((t) => t.length >= 4);
    if (!toks.length)
        return 0;
    const hits = new Set(toks.filter((t) => req.has(t)));
    return Math.min(1, hits.size / 2);
}
const usable = (h) => h === "healthy" || h === "unknown";
export function isTrivial(request) {
    const r = request.trim().toLowerCase();
    return r.length < 60 && /^(what time is it|what('?s| is) (the )?(time|date|day)|what day is it|hi|hello|thanks|thank you|what is \d|convert \d|how do you say)\b/.test(r);
}
export async function planResources(pool, request, opts = {}) {
    const caps = opts.caps ?? await listCapabilities(pool);
    const byId = new Map(caps.map((c) => [c.id, c]));
    const plan = { request, intent: "general", entities: [], use: [], skip: [], unavailable: [], authoritative: {}, missing: [], askJulian: null };
    if (isTrivial(request)) { // R06: no over-retrieval
        plan.intent = "trivial";
        plan.skip = caps.map((c) => ({ capabilityId: c.id, why: "trivial request — answerable without retrieval" }));
        return plan;
    }
    plan.entities = await knownEntities(pool, request);
    const slots = slotsFor(request);
    if (plan.entities.some((e) => e.kind === "project" || e.kind === "area"))
        slots.add("project_state");
    plan.intent = /\b(prepare|prep|brief me|ready for)\b/i.test(request) ? "prepare"
        : slots.has("current_context") ? "act_on_screen" : slots.has("documents") ? "act_on_file"
            : slots.has("messaging") ? "communicate" : slots.size ? "lookup" : "general";
    const score = new Map();
    const bump = (id, rel, why) => {
        if (!byId.has(id))
            return;
        const cur = score.get(id) ?? { rel: 0, why: [] };
        score.set(id, { rel: Math.max(cur.rel, rel), why: [...cur.why, why] });
    };
    for (const slot of slots) {
        const order = SLOT_SOURCES[slot] ?? [];
        order.forEach((id, i) => bump(id, 0.9 - i * 0.15, `needed for ${slot.replace(/_/g, " ")}`));
        // R09: the most authoritative HEALTHY source for the slot answers it.
        const best = order.map((id) => byId.get(id)).filter((c) => !!c && usable(c.health))
            .sort((a, b) => b.authority - a.authority)[0];
        if (best)
            plan.authoritative[slot] = best.id;
    }
    for (const e of plan.entities)
        bump(e.kind === "area" ? "state.areas" : "state.projects", 0.95, `Finagai already knows "${e.name}" (${e.kind})`);
    if (slots.has("documents")) {
        bump("mac.local_parser", 0.9, "parse the document directly (no UI)");
        bump("mac.filesystem", 0.85, "locate the file by name with Spotlight — no path needed");
    }
    for (const c of caps) {
        const l = lexical(c, request);
        if (l >= 0.5)
            bump(c.id, l * 0.8, "request matches this capability's declared scope");
    } // R08
    // A source Julian NAMES ("the Drive deck", "my Gmail", "in Notion") outranks anything inferred.
    const req = new Set(words(request));
    const NAMED = { "google.drive": ["drive"], "google.gmail": ["gmail", "inbox"], "google.calendar": ["calendar"], "mac.imessage": ["imessage", "imessages"] };
    for (const c of caps) {
        const names = NAMED[c.id] ?? c.id.split(".").slice(1).flatMap((x) => x.split("_")).filter((x) => x.length >= 4);
        if (names.some((n) => req.has(n)))
            bump(c.id, 1.0, "explicitly requested by Julian");
    }
    const ranked = [...score.entries()].sort((a, b) => b[1].rel - a[1].rel || (byId.get(b[0]).authority - byId.get(a[0]).authority));
    for (const [id, s] of ranked) {
        const c = byId.get(id);
        if (s.rel < RELEVANCE_FLOOR) {
            plan.skip.push({ capabilityId: id, why: "low expected value for this request" });
            continue;
        }
        if (!usable(c.health)) {
            plan.unavailable.push({ capabilityId: id, why: `${c.health}: ${c.health_reason ?? "no reason recorded"}` });
            continue;
        }
        if (plan.use.length >= MAX_SOURCES) {
            plan.skip.push({ capabilityId: id, why: `bounded: ${MAX_SOURCES} higher-value sources already planned` });
            continue;
        }
        plan.use.push({ capabilityId: id, relevance: Number(s.rel.toFixed(3)), why: [...new Set(s.why)].join("; "), authority: c.authority, health: c.health,
            ...(plan.entities.length ? { query: plan.entities.map((e) => e.name).join(" ") } : {}) });
    }
    // Everything not considered relevant is an explicit skip with a reason (R10 trace completeness).
    for (const c of caps)
        if (!score.has(c.id))
            plan.skip.push({ capabilityId: c.id, why: "no expected incremental value for this request" });
    // If the preferred source for a slot is down, fall back to the next healthy one (R05) — authoritative already
    // excludes unhealthy ones; record the fallback explicitly.
    for (const slot of slots) {
        const order = SLOT_SOURCES[slot] ?? [];
        const first = byId.get(order[0] ?? "");
        if (first && !usable(first.health) && plan.authoritative[slot])
            plan.unavailable.push({ capabilityId: first.id, why: `preferred for ${slot} but ${first.health}; using ${plan.authoritative[slot]} instead` });
        if (!plan.authoritative[slot])
            plan.missing.push(slot);
    }
    // Retrieve before ask (R07): only a slot that NO healthy relevant source can fill becomes a question.
    if (plan.missing.length)
        plan.askJulian = `I couldn't find a working source for: ${plan.missing.map((m) => m.replace(/_/g, " ")).join(", ")}. Can you point me to it?`;
    return plan;
}
/** Trace rows for a plan (R10): used / skipped / unavailable, each with its reason. */
export function planTraceRows(plan) {
    return [
        ...plan.use.map((u) => ({ capabilityId: u.capabilityId, decision: "used", reason: u.why, relevance: u.relevance })),
        ...plan.unavailable.map((u) => ({ capabilityId: u.capabilityId, decision: "unavailable", reason: u.why })),
        ...plan.skip.slice(0, 30).map((s) => ({ capabilityId: s.capabilityId, decision: "skipped", reason: s.why })),
    ];
}
export async function planAndTrace(pool, request, ctx) {
    const plan = await planResources(pool, request);
    await writeTrace(pool, { ...ctx, request }, planTraceRows(plan));
    return plan;
}
/** One planner-prompt block: what to retrieve first and from where; questions only for genuinely missing slots. */
export function planPromptBlock(plan) {
    if (plan.intent === "trivial" || (!plan.use.length && !plan.missing.length))
        return "";
    const use = plan.use.map((u) => `${u.capabilityId} (${u.why})`).join("; ");
    const known = plan.entities.length ? ` Already known to Finagai: ${plan.entities.map((e) => `${e.name} [${e.kind}]`).join(", ")} — do not ask Julian about these.` : "";
    return `Resource plan: retrieve from ${use || "—"} BEFORE asking Julian anything.${known}${plan.missing.length ? ` Genuinely missing: ${plan.missing.join(", ")}.` : ""}`;
}
//# sourceMappingURL=planner.js.map