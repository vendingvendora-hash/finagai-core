import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { appendEvent } from "../db/index.js";
import { getTaskResult, latestTask } from "../pipelines/j6/control.js";
import { capResponse, filterByTier } from "../guards/output.js";
import { runCapture } from "../pipelines/j2/capture.js";
import { stageGovernanceRequest } from "../governance/stage.js";
import { addSource, answer, openBatch, questions } from "../pipelines/seed/seed.js";
import { approvalStatus, currentCharter, isItemTable, itemWithProvenance, openConflicts, pendingProposals, projectDetail, searchState, stateOverview, } from "./queries.js";
/** G19 on any nested array of rows that carry a classification. */
function filterDeep(value) {
    if (Array.isArray(value)) {
        const rows = value;
        const classified = rows.every((r) => r && typeof r === "object" && "classification" in r);
        const kept = classified ? filterByTier(rows).rows : rows;
        return kept.map(filterDeep);
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
        const o = value;
        if (o.classification && !["public", "internal", "confidential"].includes(String(o.classification)))
            return null;
        return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, filterDeep(v)]));
    }
    return value;
}
export function buildMcpServer(deps) {
    const server = new McpServer({ name: "finagai-core", version: "0.1.0" });
    const now = deps.now ?? (() => new Date());
    const audit = (tool, outcome) => appendEvent(deps.pool, {
        actor: "system", action: "tool_called", entityType: "tool", reason: tool, after: { tool, outcome }, client: deps.client
    });
    const helpers = {
        ok: async (tool, data) => {
            await audit(tool, "ok");
            const filtered = filterDeep(JSON.parse(JSON.stringify(data)));
            let text = JSON.stringify(filtered);
            if (Buffer.byteLength(text) > 48_000 && Array.isArray(filtered)) {
                const capped = capResponse(filtered);
                text = JSON.stringify({ items: capped.items, truncated: capped.truncated, omitted: capped.omitted });
            }
            else if (Buffer.byteLength(text) > 48_000) {
                text = JSON.stringify({ error: "response too large; narrow the request" });
            }
            return { content: [{ type: "text", text }] };
        },
        fail: async (tool, message) => {
            await audit(tool, "error");
            return { isError: true, content: [{ type: "text", text: message }] };
        },
    };
    const { ok, fail } = helpers;
    server.registerTool("get_charter", {
        description: "Finagai's current charter version and Julian's approved preferences. Read before acting on Julian's behalf.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    }, async () => {
        const c = await currentCharter(deps.pool);
        return ok("get_charter", c.charter ? c : { ...c, note: "No charter has been approved yet." });
    });
    server.registerTool("capture", {
        description: "Capture new context from Julian into Finagai (J2). Use when Julian states tasks, deadlines, decisions, facts, corrections, preferences, or project updates. Returns what was stored, what needs his attention, and what was refused. Never paraphrase: pass his words.",
        inputSchema: z.object({
            text: z.string().min(1).max(30_000),
            source_type: z.enum(["conversation", "note", "document", "correction"]).default("conversation"),
            mode: z.enum(["inline", "explicit", "end_of_session", "audit"]).default("inline"),
            project_hint: z.string().max(200).optional(),
            idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
                .describe("A new opaque ID (for example a UUID) generated once for THIS capture event. Reuse it unchanged only when retrying the same call; never reuse it for a later statement, even if the words are identical."),
        }),
    }, async (args) => {
        const key = args.idempotency_key; // event identity, never derived from content (ADR-038)
        try {
            const summary = await runCapture(deps.j2, {
                text: args.text, sourceType: args.source_type, mode: args.mode, client: deps.client, idempotencyKey: key,
                ...(args.project_hint ? { projectHint: args.project_hint } : {}),
            });
            return ok("capture", summary);
        }
        catch (err) {
            return fail("capture", err instanceof Error ? err.message : "capture failed");
        }
    });
    server.registerTool("get_state_overview", {
        description: "Active projects with open, overdue, and next-due counts; open conflicts, pending proposals and approvals; deferred captures; model-spend status.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    }, async () => ok("get_state_overview", await stateOverview(deps.pool, {
        timezone: deps.cfg.FINAGAI_TIMEZONE, targetUsd: deps.cfg.MODEL_BUDGET_TARGET_USD_MONTH,
        ceilingUsd: deps.cfg.MODEL_HARD_CEILING_USD_MONTH, now: now()
    })));
    server.registerTool("get_project", {
        description: "One project by ID or exact name: its work items, current knowledge, and recent changes.",
        inputSchema: z.object({ project: z.string().min(1).max(200) }),
        annotations: { readOnlyHint: true },
    }, async ({ project }) => {
        const d = await projectDetail(deps.pool, project);
        return d ? ok("get_project", d) : fail("get_project", "No active project with that ID or name.");
    });
    server.registerTool("search_state", {
        description: "Full-text search across work items, knowledge, entities, and projects. Returns IDs and short text.",
        inputSchema: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(50).default(20) }),
        annotations: { readOnlyHint: true },
    }, async ({ query, limit }) => ok("search_state", await searchState(deps.pool, query, limit)));
    server.registerTool("get_item", {
        description: "Any record with its provenance: the capture and verbatim quote that created it, and every change event.",
        inputSchema: z.object({ type: z.string(), id: z.string().uuid() }),
        annotations: { readOnlyHint: true },
    }, async ({ type, id }) => {
        if (!isItemTable(type))
            return fail("get_item", "Unknown record type.");
        const r = await itemWithProvenance(deps.pool, type, id);
        return r ? ok("get_item", r) : fail("get_item", "No record with that ID.");
    });
    server.registerTool("list_open_conflicts", {
        description: "Open conflicts with both values and the source of the new value. Conflicts change nothing until Julian approves a resolution.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    }, async () => ok("list_open_conflicts", await openConflicts(deps.pool)));
    server.registerTool("list_pending_proposals", {
        description: "Pending preference, procedure, and classification proposals awaiting Julian's decision.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    }, async () => ok("list_pending_proposals", await pendingProposals(deps.pool)));
    const staged = async (tool, input) => {
        const r = await stageGovernanceRequest(deps.pool, deps.cfg, input);
        return ok(tool, {
            approval_id: r.approvalId, approval_url: r.approvalUrl, expires_at: r.expiresAt,
            note: "Nothing has changed yet. Julian must open the link, sign in, and confirm with his passkey.",
        });
    };
    server.registerTool("request_conflict_resolution", {
        description: "Stage Julian's chosen resolution of an open conflict. Does NOT change anything: returns an approval link Julian must confirm himself.",
        inputSchema: z.object({
            conflict_id: z.string().uuid(),
            resolution: z.enum(["keep_existing", "accept_new", "both_valid", "custom"]),
            custom_value: z.string().max(2000).optional(),
            rationale: z.string().min(1).max(1000),
        }),
    }, async (a) => {
        if (a.resolution === "custom" && !a.custom_value)
            return fail("request_conflict_resolution", "custom_value is required for a custom resolution.");
        const c = (await deps.pool.query(`SELECT id, version, existing_type, existing_id, field, existing_value, new_value, explanation FROM conflict WHERE id = $1 AND status = 'open'`, [a.conflict_id])).rows[0];
        if (!c)
            return fail("request_conflict_resolution", "No open conflict with that ID.");
        const existing = isItemTable(c.existing_type)
            ? (await deps.pool.query(`SELECT version FROM ${c.existing_type} WHERE id = $1`, [c.existing_id])).rows[0] : undefined;
        const targets = [{ type: "conflict", id: c.id, version: c.version }];
        if (existing)
            targets.push({ type: c.existing_type, id: c.existing_id, version: existing.version });
        return staged("request_conflict_resolution", {
            action: "resolve_conflict", targets, rationale: a.rationale, client: deps.client, sourceRef: { conflict_id: c.id },
            before: { field: c.field, existing_value: c.existing_value, new_value: c.new_value, explanation: c.explanation },
            after: { resolution: a.resolution, ...(a.custom_value ? { custom_value: a.custom_value } : {}) },
        });
    });
    server.registerTool("request_proposal_decision", {
        description: "Stage Julian's decision on a pending proposal. Does NOT change anything: returns an approval link Julian must confirm himself.",
        inputSchema: z.object({ proposal_id: z.string().uuid(), decision: z.enum(["approve", "reject"]), rationale: z.string().min(1).max(1000) }),
    }, async (a) => {
        const p = (await deps.pool.query(`SELECT id, version, kind, current_text, proposed_text FROM proposal WHERE id = $1 AND status = 'pending'`, [a.proposal_id])).rows[0];
        if (!p)
            return fail("request_proposal_decision", "No pending proposal with that ID.");
        return staged("request_proposal_decision", {
            action: "decide_proposal", targets: [{ type: "proposal", id: p.id, version: p.version }], rationale: a.rationale,
            client: deps.client, sourceRef: { proposal_id: p.id },
            before: { status: "pending", kind: p.kind, current_text: p.current_text },
            after: { status: a.decision === "approve" ? "approved" : "rejected", ...(a.decision === "approve" ? { new_text: p.proposed_text } : {}) },
        });
    });
    const ARCHIVABLE = ["work_item", "knowledge_item", "entity", "external_ref", "project"];
    server.registerTool("request_archival", {
        description: "Stage archival of records (for example third-party information past its review date). Archival is never deletion. Does NOT change anything until Julian confirms.",
        inputSchema: z.object({
            records: z.array(z.object({ type: z.enum(ARCHIVABLE), id: z.string().uuid() })).min(1).max(50),
            rationale: z.string().min(1).max(1000),
        }),
    }, async (a) => {
        const targets = [];
        const before = [];
        for (const r of a.records) {
            const row = (await deps.pool.query(`SELECT id, version, archived_at FROM ${r.type} WHERE id = $1`, [r.id])).rows[0];
            if (!row || row.archived_at)
                return fail("request_archival", `Record ${r.id} does not exist or is already archived.`);
            targets.push({ type: r.type, id: r.id, version: row.version });
            before.push({ type: r.type, id: r.id, archived: false });
        }
        return staged("request_archival", { action: "archive_records", targets, rationale: a.rationale, client: deps.client,
            before, after: targets.map((t) => ({ type: t.type, id: t.id, archived: true })) });
    });
    server.registerTool("request_seed_promotion", {
        description: "Stage promotion of a reviewed seeding batch into live state. Does NOT change anything until Julian confirms.",
        inputSchema: z.object({ batch_id: z.string().uuid(), rationale: z.string().min(1).max(1000) }),
    }, async (a) => {
        const b = (await deps.pool.query(`SELECT id, version, status FROM seed_batch WHERE id = $1 AND status = 'review'`, [a.batch_id])).rows[0];
        if (!b)
            return fail("request_seed_promotion", "No seeding batch awaiting review with that ID.");
        const staged_ = (await deps.pool.query(`SELECT count(*) FILTER (WHERE cc.confirmation = 'confirmed')::int AS confirmed, count(*)::int AS total
         FROM capture_candidate cc JOIN capture c ON c.id = cc.capture_id
        WHERE c.seed_batch_id = $1 AND cc.outcome = 'staged'`, [b.id])).rows[0];
        return staged("request_seed_promotion", { action: "promote_seed_batch", targets: [{ type: "seed_batch", id: b.id, version: b.version }],
            rationale: a.rationale, client: deps.client, before: { status: "review", staged: staged_ },
            after: { status: "promoted", promote: "confirmed items only" } });
    });
    server.registerTool("get_approval_request", {
        description: "Status of a staged governance request: pending, approved, rejected, expired, superseded, executed, or failed.",
        inputSchema: z.object({ approval_id: z.string().uuid() }),
        annotations: { readOnlyHint: true },
    }, async ({ approval_id }) => {
        const r = await approvalStatus(deps.pool, approval_id);
        return r ? ok("get_approval_request", r) : fail("get_approval_request", "No approval request with that ID.");
    });
    // ---------------------------------------------------------------- M7 seeding (staging only)
    server.registerTool("seed_add_source", {
        description: "Cold-start seeding: add one document or note about Julian's CURRENT projects to the open seeding batch. Everything is staged, nothing becomes live until Julian approves promotion with his passkey. Prefer a few important sources over bulk history.",
        inputSchema: z.object({
            text: z.string().min(1).max(30_000),
            title: z.string().max(200).optional(),
            idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).describe("A new opaque ID for this source; reuse only when retrying the same call."),
        }),
    }, async (a) => {
        try {
            const s = await addSource(deps.j2, { text: a.text, idempotencyKey: a.idempotency_key, ...(a.title ? { title: a.title } : {}) });
            return ok("seed_add_source", { batch_id: s.batchId, status: s.status, staged: s.stagedCount,
                rejected: s.rejected, not_stored: s.notStored, date_flags: s.dateFlags, message: s.message });
        }
        catch (err) {
            return fail("seed_add_source", err instanceof Error ? err.message : "could not add source");
        }
    });
    server.registerTool("seed_questions", {
        description: "The seeding confirmation interview: code-generated questions grouped by project (conflicts, unverified or missing dates, missing projects, duplicates), plus items clear enough for bulk confirmation.",
        inputSchema: z.object({ batch_id: z.string().uuid().optional() }),
        annotations: { readOnlyHint: false },
    }, async (a) => ok("seed_questions", await questions(deps.j2, a.batch_id ?? await openBatch(deps.pool))));
    server.registerTool("seed_answer", {
        description: "Record Julian's answers to seeding questions: confirm or reject staged items, set a project, or set a due date in his own words. Changes staging only.",
        inputSchema: z.object({
            batch_id: z.string().uuid(),
            answers: z.array(z.union([
                z.object({ candidate_id: z.string().uuid(), action: z.enum(["confirm", "reject"]) }),
                z.object({ candidate_id: z.string().uuid(), action: z.literal("set_project"), value: z.string().min(1).max(200) }),
                z.object({ candidate_id: z.string().uuid(), action: z.literal("set_due"), value: z.string().min(1).max(100) }),
            ])).min(1).max(200),
        }),
    }, async (a) => ok("seed_answer", await answer(deps.j2, a.batch_id, a.answers)));
    server.registerTool("control_mac", {
        description: "Start a task that operates Julian's Mac for him (J6): open apps, click, type, run commands, use his logged-in sessions. Finagai works step by step and asks Julian to approve anything that changes or sends something. Use when Julian asks you to DO something on his computer, not just look it up.",
        inputSchema: z.object({ request: z.string().min(1).max(4000) }),
    }, async ({ request }) => {
        const t = await deps.pool.query(`INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id, code`, [request.slice(0, 4000)]);
        const row = t.rows[0];
        await appendEvent(deps.pool, { actor: "julian", action: "control_task_created", entityType: "control_task", entityId: row.id,
            after: { code: Number(row.code), request: request.slice(0, 200) }, client: deps.client });
        return ok("control_mac", { taskCode: Number(row.code),
            note: "Task queued. Finagai's Mac helper will carry it out and message Julian to approve any step that changes something." });
    });
    server.registerTool("make_mac_chart", {
        description: "Find a spreadsheet on Julian's Mac by (approximate) name, read it, detect the best trend, generate a real chart, and return the chart image. Use when Julian asks to chart/visualize data from a named local Excel/workbook. After calling this, read the result with control_result to show the image.",
        inputSchema: z.object({ filename: z.string().min(1).max(200), title: z.string().max(200).optional() }),
    }, async ({ filename, title }) => {
        const t = await deps.pool.query(`INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id, code`, [`mac_chart:${filename}${title ? `::${title}` : ""}`]);
        const row = t.rows[0];
        await appendEvent(deps.pool, { actor: "julian", action: "control_task_created", entityType: "control_task", entityId: row.id, after: { code: Number(row.code), kind: "mac_chart", filename } });
        // Same-turn: wait for the Mac helper to find->parse->chart->return (bounded). Then hand back the image.
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2500));
            const q = await deps.pool.query(`SELECT status, result_summary, result_image_b64 FROM control_task WHERE id = $1`, [row.id]);
            const t0 = q.rows[0];
            if (t0 && (t0.status === "done" || t0.status === "failed")) {
                await audit("make_mac_chart", "ok");
                const content = [{ type: "text", text: JSON.stringify({ taskCode: Number(row.code), status: t0.status, summary: t0.result_summary, hasImage: Boolean(t0.result_image_b64) }) }];
                if (t0.result_image_b64)
                    content.push({ type: "image", data: t0.result_image_b64, mimeType: "image/png" });
                return { content };
            }
        }
        return ok("make_mac_chart", { taskCode: Number(row.code), note: "Started; the Mac helper is still working. Read control_result with this taskCode in a moment to show the image." });
    });
    server.registerTool("control_result", {
        description: "Read the result of a Mac task started with control_mac. Returns its status and, when finished, the summary, the information Finagai gathered, AND the final screenshot/chart image so you can show it to Julian directly in the chat. Omit task_code to read the most recent task.",
        inputSchema: z.object({ task_code: z.number().int().positive().optional() }),
    }, async ({ task_code }) => {
        const r = task_code ? await getTaskResult(deps.pool, task_code) : await latestTask(deps.pool);
        if (!r)
            return ok("control_result", { found: false, note: "No such task." });
        const note = r.status === "done" ? "Task finished. Summary, detail, and (if present) the final image are included — show the image to Julian."
            : r.status === "waiting_approval" ? "Finagai is waiting for Julian to approve a step in his Messages thread."
                : r.status === "active" ? "Still running; check again shortly." : `Task is ${r.status}.`;
        await audit("control_result", "ok");
        const content = [{ type: "text",
                text: JSON.stringify({ found: true, status: r.status, request: r.request, done: r.status === "done", summary: r.summary, detail: r.detail, hasImage: Boolean(r.imageB64), note }) }];
        if (r.imageB64)
            content.push({ type: "image", data: r.imageB64, mimeType: "image/png" });
        return { content };
    });
    deps.extend?.(server, helpers);
    return server;
}
//# sourceMappingURL=server.js.map