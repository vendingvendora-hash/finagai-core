/**
 * Finagai Core MCP tool surface (implementation plan section 8, ADR-019).
 * Reads are broad; writes happen only through `capture` (J2 rules), and governance tools only STAGE
 * requests. Every call: schema-validated input, G19 tier filter, G21 size cap, and an audit event.
 * Not exposed to any model: delete, direct record edits, charter/procedure/preference writes,
 * classification lowering, sending messages, raw SQL, configuration, secrets, web access.
 */
import type pg from "pg";
import { getRuntime, macOnline, deriveLifecycle, macStatus } from "../mac/runtime.js";
import { openInteraction, linkTask, undelivered, markDelivered } from "../concierge/interactions.js";
import { sweepHumanWaits } from "../concierge/human-wait.js";
import { registerCosTools } from "./cosTools.js";
import { observed, reportLifecycleError, recentLifecycleErrors } from "../ops/lifecycle-errors.js";
import { getContext, resolveFromMac } from "../mac/context.js";
import { route } from "../mac/router.js";
import { listCapabilities, refreshRegistry } from "../resources/registry.js";
import { writeTrace, routeTraceRows } from "../resources/trace.js";
import { planAndTrace } from "../resources/planner.js";
import { retrieve, traceRetrieval, effectiveAuthority } from "../resources/retrieve.js";
import { z } from "zod";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { appendEvent } from "../db/index.js";
import { getTaskResult, latestTask, createTask } from "../pipelines/j6/control.js";
import { capResponse, filterByTier, type Tier } from "../guards/output.js";
import { runCapture, type J2Deps } from "../pipelines/j2/capture.js";
import { stageGovernanceRequest, type TargetRef } from "../governance/stage.js";
import { addSource, answer, openBatch, questions } from "../pipelines/seed/seed.js";
import {
  approvalStatus, currentCharter, isItemTable, itemWithProvenance, openConflicts, pendingProposals, projectDetail, searchState, stateOverview,
} from "./queries.js";

export interface ToolConfig {
  FINAGAI_PUBLIC_BASE_URL: string;
  FINAGAI_TIMEZONE: string;
  GOVERNANCE_REQUEST_TTL_HOURS: number;
  MODEL_BUDGET_TARGET_USD_MONTH: number;
  MODEL_HARD_CEILING_USD_MONTH: number;
}

export interface ToolDeps {
  pool: pg.Pool;
  cfg: ToolConfig;
  j2: J2Deps;
  client: string;              // "claude_ai" for Client v1
  /** Read-only Google search (Phase 2D retrieval); absent when not configured. */
  google?: import("../resources/retrieve.js").GoogleSearch;
  now?: () => Date;
  /** Registered later by J3 (operating_review, get_latest_review). */
  extend?: (server: McpServer, helpers: ToolHelpers) => void;
}

export interface ToolHelpers {
  ok: (tool: string, data: unknown) => Promise<CallToolResult>;
  fail: (tool: string, message: string) => Promise<CallToolResult>;
}

type Row = Record<string, unknown> & { classification?: Tier };

/** G19 on any nested array of rows that carry a classification. */
function filterDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const rows = value as Row[];
    const classified = rows.every((r) => r && typeof r === "object" && "classification" in r);
    const kept = classified ? filterByTier(rows as Array<Row & { classification: Tier }>).rows : rows;
    return kept.map(filterDeep);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const o = value as Row;
    if (o.classification && !["public", "internal", "confidential"].includes(String(o.classification))) return null;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, filterDeep(v)]));
  }
  return value;
}

export function buildMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "finagai-core", version: "0.1.0" });
  const now = deps.now ?? (() => new Date());

  const audit = (tool: string, outcome: string) => appendEvent(deps.pool, {
    actor: "system", action: "tool_called", entityType: "tool", reason: tool, after: { tool, outcome }, client: deps.client });

  const helpers: ToolHelpers = {
    ok: async (tool, data) => {
      await audit(tool, "ok");
      let payload: unknown = data;
      // WO2 async return: on ANY tool call, surface finished work whose result never reached the chat, so
      // Julian is never the polling mechanism. Marked delivered once surfaced.
      if (tool !== "pending_results") {
        const due = await undelivered(deps.pool, "chat").catch(() => []);
        if (due.length) {
          // An array result keeps its shape under `results` (spreading an array into an object destroyed it).
          payload = { ...(Array.isArray(data) ? { results: data } : (data as object)), finishedWhileYouWereAway: due.map((i) => ({ interactionId: i.id, state: i.state, result: i.resultSummary, hasImage: !!i.resultImageB64 })),
            instruction: "Before answering the current request, tell Julian these earlier requests finished and show their results (call pending_results to get any image)." };
          await markDelivered(deps.pool, due.filter((i) => !i.resultImageB64).map((i) => i.id)).catch(observed(deps.pool, "ok.markDelivered"));
        }
      }
      const filtered = filterDeep(JSON.parse(JSON.stringify(payload)));
      let text = JSON.stringify(filtered);
      if (Buffer.byteLength(text) > 48_000 && Array.isArray(filtered)) {
        const capped = capResponse(filtered);
        text = JSON.stringify({ items: capped.items, truncated: capped.truncated, omitted: capped.omitted });
      } else if (Buffer.byteLength(text) > 48_000) {
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
    } catch (err) {
      return fail("capture", err instanceof Error ? err.message : "capture failed");
    }
  });

  server.registerTool("get_state_overview", {
    description: "Active projects with open, overdue, and next-due counts; open conflicts, pending proposals and approvals; deferred captures; model-spend status.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => ok("get_state_overview", await stateOverview(deps.pool, {
    timezone: deps.cfg.FINAGAI_TIMEZONE, targetUsd: deps.cfg.MODEL_BUDGET_TARGET_USD_MONTH,
    ceilingUsd: deps.cfg.MODEL_HARD_CEILING_USD_MONTH, now: now() })));

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
    if (!isItemTable(type)) return fail("get_item", "Unknown record type.");
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

  const staged = async (tool: string, input: Parameters<typeof stageGovernanceRequest>[2]) => {
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
    if (a.resolution === "custom" && !a.custom_value) return fail("request_conflict_resolution", "custom_value is required for a custom resolution.");
    const c = (await deps.pool.query(
      `SELECT id, version, existing_type, existing_id, field, existing_value, new_value, explanation FROM conflict WHERE id = $1 AND status = 'open'`,
      [a.conflict_id])).rows[0];
    if (!c) return fail("request_conflict_resolution", "No open conflict with that ID.");
    const existing = isItemTable(c.existing_type)
      ? (await deps.pool.query(`SELECT version FROM ${c.existing_type} WHERE id = $1`, [c.existing_id])).rows[0] : undefined;
    const targets: TargetRef[] = [{ type: "conflict", id: c.id, version: c.version }];
    if (existing) targets.push({ type: c.existing_type, id: c.existing_id, version: existing.version });
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
    const p = (await deps.pool.query(
      `SELECT id, version, kind, current_text, proposed_text FROM proposal WHERE id = $1 AND status = 'pending'`, [a.proposal_id])).rows[0];
    if (!p) return fail("request_proposal_decision", "No pending proposal with that ID.");
    return staged("request_proposal_decision", {
      action: "decide_proposal", targets: [{ type: "proposal", id: p.id, version: p.version }], rationale: a.rationale,
      client: deps.client, sourceRef: { proposal_id: p.id },
      before: { status: "pending", kind: p.kind, current_text: p.current_text },
      after: { status: a.decision === "approve" ? "approved" : "rejected", ...(a.decision === "approve" ? { new_text: p.proposed_text } : {}) },
    });
  });

  const ARCHIVABLE = ["work_item", "knowledge_item", "entity", "external_ref", "project"] as const;
  server.registerTool("request_archival", {
    description: "Stage archival of records (for example third-party information past its review date). Archival is never deletion. Does NOT change anything until Julian confirms.",
    inputSchema: z.object({
      records: z.array(z.object({ type: z.enum(ARCHIVABLE), id: z.string().uuid() })).min(1).max(50),
      rationale: z.string().min(1).max(1000),
    }),
  }, async (a) => {
    const targets: TargetRef[] = [];
    const before: Array<Record<string, unknown>> = [];
    for (const r of a.records) {
      const row = (await deps.pool.query(`SELECT id, version, archived_at FROM ${r.type} WHERE id = $1`, [r.id])).rows[0];
      if (!row || row.archived_at) return fail("request_archival", `Record ${r.id} does not exist or is already archived.`);
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
    if (!b) return fail("request_seed_promotion", "No seeding batch awaiting review with that ID.");
    const staged_ = (await deps.pool.query(
      `SELECT count(*) FILTER (WHERE cc.confirmation = 'confirmed')::int AS confirmed, count(*)::int AS total
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
    } catch (err) {
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
    description: "Operate Julian's Mac step by step (J6): open apps, click, type, run commands, use logged-in sessions, for general desktop actions. IMPORTANT: do NOT use this to chart/plot/visualize data from a named local spreadsheet or Excel file — use make_mac_chart for that; it is deterministic, finds and reads the file, and returns the chart image directly.",
    inputSchema: z.object({ request: z.string().min(1).max(4000) }),
  }, async ({ request }) => {
    // HEALTH GATE (ADR-066): don't queue a Mac task for a Mac that isn't connected.
    const rt0 = await getRuntime(deps.pool);
    if (!macOnline(rt0)) {
      await audit("control_mac", "mac_offline");
      return ok("control_mac", { macOffline: true, lifecycle: "waiting_for_mac",
        lastHeartbeatSecondsAgo: rt0 ? Math.round((Date.now() - rt0.lastHeartbeatAt.getTime()) / 1000) : null,
        tellJulian: "Finagai's Mac runtime isn't connected right now. On the Mac run `launchctl kickstart -k gui/$(id -u)/com.finagai.imessage` and I'll pick this up immediately.",
        doNot: "Do not create a task, do not poll, do not ask Julian to upload anything." });
    }
    const ix = await openInteraction(deps.pool, { conversation: "chat", message: request });
    if (ix.reused && ix.interaction.taskIds.length) {
      // Equivalent request already owned: continue it instead of creating a duplicate task.
      const existing = await deps.pool.query<{ code: string; status: string }>(`SELECT code, status FROM control_task WHERE id = $1`, [ix.interaction.taskIds[ix.interaction.taskIds.length - 1]]);
      if (existing.rows[0] && existing.rows[0].status === "active")
        return ok("control_mac", { taskCode: Number(existing.rows[0].code), interactionId: ix.interaction.id, reused: true, note: "This request is already in progress; continuing it (no duplicate task)." });
    }
    // One creation path for every surface (Phase 0D): stores the acceptance contract and links the interaction.
    const created = await createTask(deps.pool, request, "chat", undefined, ix.interaction.id);
    const row = { id: created.id, code: String(created.code) };
    const routePlan = route(request, (await getRuntime(deps.pool))?.capabilities as never);
    await writeTrace(deps.pool, { interactionId: ix.interaction.id, taskId: row.id, request }, routeTraceRows(routePlan))
      .catch((e) => console.error("resource trace failed", e));
    return ok("control_mac", { taskCode: Number(row.code),
      note: "Task queued. Finagai's Mac helper will carry it out and message Julian to approve any step that changes something." });
  });

  server.registerTool("make_mac_chart", {
    description: "Find a spreadsheet on Julian's Mac by (approximate) name, read it, detect the best meaningful series, generate a verified chart, and return the chart image. Use when Julian asks to chart/visualize data from a named local Excel/workbook. It owns the request: it reuses an in-flight or recent task instead of creating duplicates, and waits for completion. If it returns stillRunning:true, immediately call control_result with the returned taskCode again in the SAME turn and keep doing so until the task is done or failed — never ask Julian to say 'check again'.",
    inputSchema: z.object({ filename: z.string().min(1).max(200), title: z.string().max(200).optional() }),
  }, async ({ filename, title }) => {
    const request = `mac_chart:${filename}${title ? `::${title}` : ""}`;
    // WO2: one durable interaction per logical request (reused on follow-ups, never duplicated).
    const ix = await openInteraction(deps.pool, { conversation: "chat", message: request, key: request });
    // HEALTH GATE (ADR-066): never queue work for a Mac that isn't connected. Fail fast with the truth.
    const rt0 = await getRuntime(deps.pool);
    if (!macOnline(rt0)) {
      await audit("make_mac_chart", "mac_offline");
      return ok("make_mac_chart", { macOffline: true, lifecycle: "waiting_for_mac",
        lastHeartbeatSecondsAgo: rt0 ? Math.round((Date.now() - rt0.lastHeartbeatAt.getTime()) / 1000) : null,
        tellJulian: "Finagai's Mac runtime isn't connected right now, so I can't reach the file. This is the one thing to check: on the Mac run `launchctl kickstart -k gui/$(id -u)/com.finagai.imessage`. I'll do the chart the moment it reconnects.",
        doNot: "Do not create a task, do not poll, do not ask Julian to upload the file." });
    }
    // INTERACTION COORDINATOR (ADR-065): one logical interaction per chart request.
    // Reuse an equivalent recent task so an impatient "retry" never spawns a duplicate (#9 vs #32).
    const existing = await deps.pool.query<{ id: string; code: string; status: string }>(
      `SELECT id, code, status FROM control_task
         WHERE request = $1 AND origin = 'chat' AND created_at > now() - interval '30 minutes'
           AND status IN ('done','active','waiting_approval')
         ORDER BY created_at DESC LIMIT 1`, [request]);
    let row: { id: string; code: string };
    const prior = existing.rows[0];
    if (prior && prior.status === "done") {
      const q = await deps.pool.query<{ status: string; result_summary: string | null; result_image_b64: string | null }>(
        `SELECT status, result_summary, result_image_b64 FROM control_task WHERE id = $1`, [prior.id]);
      const t0 = q.rows[0]!;
      await audit("make_mac_chart", "ok");
      const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify({ taskCode: Number(prior.code), status: t0.status, summary: t0.result_summary, hasImage: Boolean(t0.result_image_b64), reused: true }) }];
      if (t0.result_image_b64) content.push({ type: "image", data: t0.result_image_b64, mimeType: "image/png" });
      return { content };
    }
    if (prior && (prior.status === "active" || prior.status === "waiting_approval")) {
      row = { id: prior.id, code: prior.code };   // attach to the in-flight interaction, don't duplicate
    } else {
      const t = await deps.pool.query<{ id: string; code: string }>(
        `INSERT INTO control_task (request, origin) VALUES ($1, 'chat') RETURNING id, code`, [request]);
      row = t.rows[0]!;
      await appendEvent(deps.pool, { actor: "julian", action: "control_task_created", entityType: "control_task", entityId: row.id, after: { code: Number(row.code), kind: "mac_chart", filename } });
    }
    await linkTask(deps.pool, ix.interaction.id, row.id);
    await writeTrace(deps.pool, { interactionId: ix.interaction.id, taskId: row.id, request }, [
      { capabilityId: "agent.m01_chart", decision: "used", reason: "deterministic workbook→chart workflow with artifact verification" },
      { capabilityId: "mac.filesystem", decision: "used", reason: "Spotlight locates the workbook by name; no path needed from Julian" },
      { capabilityId: "mac.local_parser", decision: "used", reason: "series read by the parser, not by looking at the UI" },
      { capabilityId: "mac.keyboard_mouse", decision: "skipped", reason: "a parser path exists; visual control would be slower and less reliable" },
    ]).catch((e) => console.error("resource trace failed", e));
    // Own the request this turn, but return within the MCP transport timeout (~60s) — holding the call
    // open for minutes made the connector report "server isn't responding". We wait a transport-safe 45s
    // here; if it's not done, we return stillRunning and the model keeps ownership by calling
    // control_result again in the SAME turn (each such poll is fast). No long-held connection, no abandon.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      const q = await deps.pool.query<{ status: string; result_summary: string | null; result_image_b64: string | null }>(
        `SELECT status, result_summary, result_image_b64 FROM control_task WHERE id = $1`, [row.id]);
      const t0 = q.rows[0];
      if (t0 && (t0.status === "done" || t0.status === "failed")) {
        await audit("make_mac_chart", "ok");
        await markDelivered(deps.pool, [ix.interaction.id]).catch(observed(deps.pool, "chart.markDelivered", { interactionId: ix.interaction.id }));   // result reached the chat now
        const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify({ taskCode: Number(row.code), interactionId: ix.interaction.id, status: t0.status, summary: t0.result_summary, hasImage: Boolean(t0.result_image_b64) }) }];
        if (t0.result_image_b64) content.push({ type: "image", data: t0.result_image_b64, mimeType: "image/png" });
        return { content };
      }
    }
    // Still running after the wait: the interaction is NOT abandoned. Tell the model to immediately call
    // control_result for this same taskCode again (same turn) — never ask Julian to say "check again".
    const rtEnd = await getRuntime(deps.pool);
    const qEnd = await deps.pool.query<{ status: string; claimed_at: Date | null; last_progress_at: Date | null }>(`SELECT status, claimed_at, last_progress_at FROM control_task WHERE id = $1`, [row.id]);
    const lc = qEnd.rows[0] ? deriveLifecycle(qEnd.rows[0], rtEnd) : { lifecycle: "queued", evidence: "" };
    return ok("make_mac_chart", { taskCode: Number(row.code), ...lc, stillRunning: true,
      action: "call control_result with this taskCode again now; keep owning it until done or failed; do NOT ask Julian to check again",
      note: "If the task outlasts this turn, Finagai still delivers the finished chart to Julian's Messages automatically — tell him it's building and will arrive in Messages shortly; do not ask him to check again." });
  });

  server.registerTool("list_capabilities", {
    description: "Read-only: what Finagai can use right now — Finagai state, Mac capabilities, Google, email, iMessage, workflows and models — each with live health, why, permissions, empirical reliability (only with >=5 samples), p50 latency, risk, freshness and source authority. Refreshes discovery first. Use before saying Finagai can't do or find something.",
    inputSchema: z.object({ type: z.enum(["state", "mac", "external", "agent", "model"]).optional() }),
  }, async ({ type }) => {
    await refreshRegistry(deps.pool);
    const rows = await listCapabilities(deps.pool, type ? { type } : undefined);
    return helpers.ok("list_capabilities", { count: rows.length, capabilities: rows.map((r) => ({ id: r.id, health: r.health, why: r.health_reason, access: r.access,
      operations: r.operations, reliability: r.reliability != null ? Number(r.reliability) : null, samples: r.samples, p50ms: r.latency_p50_ms, risk: r.risk,
      freshness: r.freshness, authority: r.authority, permissions: r.permissions })) });
  });

  server.registerTool("plan_resources", {
    description: "Call FIRST for any substantive request (prepare me for X, what's going on with Y, find Z, handle this): Finagai decides which of its sources matter — its own project/area/follow-up memory, past artifacts and requests, Gmail/Calendar/Drive, Mac files and current screen — retrieves the Core-side ones now, and returns what it found with provenance, the authoritative source per need, what it skipped and why, and the only things genuinely missing. Never ask Julian for something this returns or could retrieve; ask only for items listed in askJulian.",
    inputSchema: z.object({ request: z.string().min(2).max(2000) }),
  }, async ({ request }) => {
    const plan = await planAndTrace(deps.pool, request, {});
    const results = plan.intent === "trivial" ? [] : await retrieve(deps.pool, plan, deps.google ? { google: deps.google } : {});
    await traceRetrieval(deps.pool, { request }, results).catch((e) => console.error("retrieval trace failed", e));
    const authority = effectiveAuthority(plan, results);
    // Live fix (ADR-075): say plainly which needs NOTHING answered, and which Google accounts were searched,
    // so an answer never presents unrelated items as the result and a wrong-account setup is visible.
    const notFound = Object.entries(authority).filter(([, v]) => !v.source).map(([slot]) => slot.replace(/_/g, " "));
    const googleScope = results.some((r) => r.capabilityId.startsWith("google."))
      ? ((await deps.pool.query<{ health_reason: string }>(`SELECT health_reason FROM capability WHERE id = 'google.gmail'`)).rows[0]?.health_reason ?? null) : null;
    const retrievedIds = new Set(results.map((r) => r.capabilityId));
    return helpers.ok("plan_resources", {
      intent: plan.intent, knownToFinagai: plan.entities, authoritativeSource: authority,
      used: plan.use.map((u) => ({ source: u.capabilityId, why: u.why })),
      retrieved: results.map((r) => ({ source: r.capabilityId, status: r.status, items: r.items, note: r.note })),
      skipped: plan.skip.filter((x) => !retrievedIds.has(x.capabilityId)).slice(0, 12), unavailable: plan.unavailable,
      missing: plan.missing, notFound, searchedGoogle: googleScope,
      schedule: results.find((r) => r.capabilityId === "google.calendar")?.note ?? null, askJulian: plan.askJulian,
      instruction: plan.askJulian ? "Ask Julian ONLY about askJulian."
        : notFound.length ? `Answer from what was retrieved. Nothing was found for: ${notFound.join(", ")}${googleScope ? ` (Google searched: ${googleScope})` : ""} — say so plainly; never present unrelated items as the answer.`
        : "Answer from what was retrieved; do not ask Julian for information Finagai already has.",
    });
  });

  server.registerTool("execution_metrics", {
    description: "Read-only operational telemetry (Phase 1D): daily aggregates per task class (completion, p50/p95 acknowledgement and completion seconds, false completions, recovery attempts, verification attempts, tool/model calls, cost) plus the most recent interactions with their outcome, failure class and terminal reason. Use to answer 'how is Finagai performing' with real numbers.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).optional(), recent: z.number().int().min(0).max(50).optional() }),
  }, async ({ days, recent }) => {
    const { metricsSummary, reconcileInteractions } = await import("../concierge/interactions.js");
    // Expire stale human waits even when the Mac is offline, then reconcile; failures are recorded, not hidden.
    const waits = await sweepHumanWaits(deps.pool, { deliver: false }).catch(async (e) => { await reportLifecycleError(deps.pool, "metrics.sweepHumanWaits", e); return null; });
    const rec = await reconcileInteractions(deps.pool).catch(async (e) => { await reportLifecycleError(deps.pool, "metrics.reconcileInteractions", e); return null; });
    const daily = await metricsSummary(deps.pool, days ?? 7);
    const rows = (await deps.pool.query(
      `SELECT i.created_at, i.task_class, i.state, i.failure_class, i.terminal_reason, i.false_completion, i.recovery_attempts,
              i.verification_attempts, i.tool_calls, i.model_calls, i.cost_usd, i.user_interventions,
              i.origin, i.verification_status, i.waiting_human_s,
              extract(epoch FROM (i.completed_at - i.created_at))::int AS completion_s,
              (SELECT array_agg(t.code ORDER BY t.code) FROM control_task t WHERE t.id = ANY(i.task_ids)) AS task_codes
         FROM interaction i ORDER BY i.created_at DESC LIMIT $1`, [recent ?? 15])).rows;
    const lifecycleErrors = await recentLifecycleErrors(deps.pool, 24);
    return helpers.ok("execution_metrics", { daily, recent: rows, lifecycle: { expiredNow: waits?.expired ?? null, reconcile: rec, errors24h: lifecycleErrors } });
  });

  server.registerTool("pending_results", {
    description: "Results of earlier Finagai requests that finished after their chat turn ended (charts, Mac task results). Returns each with its image and marks them delivered. Call when a tool response mentions finishedWhileYouWereAway, or when Julian asks what finished.",
    inputSchema: z.object({}),
  }, async () => {
    const due = await undelivered(deps.pool, "chat", 5);
    await audit("pending_results", "ok");
    const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify({ count: due.length,
      results: due.map((i) => ({ interactionId: i.id, state: i.state, result: i.resultSummary, requested: i.requestKey, hasImage: !!i.resultImageB64 })) }) }];
    for (const i of due) if (i.resultImageB64) content.push({ type: "image", data: i.resultImageB64, mimeType: "image/png" });
    await markDelivered(deps.pool, due.map((i) => i.id));
    return { content };
  });

  server.registerTool("mac_get_context", {
    description: "What Julian is looking at on his Mac right now: frontmost app, active window, open document path, selected Finder files, active browser tab (app/url/title), plus the most recent Finagai artifact and how fresh the snapshot is. Deterministic, ephemeral (no history). Use before acting on 'this', 'that', 'this page', 'the spreadsheet I have open'.",
    inputSchema: z.object({}),
  }, async () => {
    const { ctx, ageSeconds } = await getContext(deps.pool);
    const rt = await getRuntime(deps.pool);
    await audit("mac_get_context", "ok");
    return ok("mac_get_context", { macOnline: macOnline(rt), snapshotAgeSeconds: ageSeconds, ...ctx });
  });

  server.registerTool("resolve_reference", {
    description: "Deterministically resolve a vague reference — 'this', 'that', 'this file', 'this page', 'the spreadsheet I have open', 'the last chart', 'what I'm looking at' — to a concrete referent (file path, URL, document, or artifact) from Julian's current Mac context and recent artifacts. Returns resolved + candidates; ambiguous:true only when two referents are equally likely — ask then, never otherwise.",
    inputSchema: z.object({ phrase: z.string().min(1).max(300) }),
  }, async ({ phrase }) => {
    const r = await resolveFromMac(deps.pool, phrase);
    await audit("resolve_reference", r.resolved ? "resolved" : r.ambiguous ? "ambiguous" : "none");
    return ok("resolve_reference", r);
  });

  server.registerTool("mac_status", {
    description: "The truthful status of Finagai's Mac runtime: connected?, last heartbeat, capability matrix (screen capture, accessibility, filesystem, browser, clipboard, active window), current app/window, and the current task's real lifecycle (queued/waiting_for_mac/executing/stalled). Use when a Mac task isn't progressing or Julian asks whether Finagai can see/use his Mac. Real probes, no guesses.",
    inputSchema: z.object({}),
  }, async () => {
    await audit("mac_status", "ok");
    return ok("mac_status", await macStatus(deps.pool));
  });

  server.registerTool("control_result", {
    description: "Read the result of a Mac task started with control_mac. Returns its status and, when finished, the summary, the information Finagai gathered, AND the final screenshot/chart image so you can show it to Julian directly in the chat. Omit task_code to read the most recent task.",
    inputSchema: z.object({ task_code: z.number().int().positive().optional() }),
  }, async ({ task_code }) => {
    // Brief transport-safe wait so a same-turn re-poll advances the task instead of returning instantly.
    let r = task_code ? await getTaskResult(deps.pool, task_code) : await latestTask(deps.pool);
    if (r && r.status === "active") {
      const until = Date.now() + 40_000;
      while (Date.now() < until && r && r.status === "active") {
        await new Promise((res) => setTimeout(res, 2500));
        r = task_code ? await getTaskResult(deps.pool, task_code) : await latestTask(deps.pool);
      }
    }
    if (!r) return ok("control_result", { found: false, note: "No such task." });
    // WO2: mark delivered AFTER the wait loop — a task that finishes during the wait is shown now, so it must not
    // resurface later (live: V2/V3 kept reappearing in finishedWhileYouWereAway).
    if ((r.status === "done" || r.status === "failed" || r.status === "expired" || r.status === "cancelled")) {
      // WO2: the result is being shown in the chat now — mark the owning interaction delivered so it stops resurfacing.
      await deps.pool.query(`UPDATE interaction SET final_response_status = 'delivered', delivered_at = now(), updated_at = now()
        WHERE final_response_status = 'pending' AND id = (SELECT interaction_id FROM control_task WHERE code = $1)`, [r.code]).catch(observed(deps.pool, "control_result.markDelivered"));
    }

    // Truthful lifecycle (ADR-066): derive from worker heartbeat + claim + progress, never a bare row status.
    const rtNow = await getRuntime(deps.pool);
    const lcRow = await deps.pool.query<{ status: string; claimed_at: Date | null; last_progress_at: Date | null; progress_note: string | null }>(
      `SELECT status, claimed_at, last_progress_at, progress_note FROM control_task WHERE code = $1`, [r.code]);
    const lc = lcRow.rows[0] ? deriveLifecycle(lcRow.rows[0], rtNow) : null;
    if (lc && lc.lifecycle === "waiting_for_mac") {
      await audit("control_result", "mac_offline");
      return ok("control_result", { found: true, status: r.status, lifecycle: "waiting_for_mac", evidence: lc.evidence, done: false,
        tellJulian: "Finagai's Mac runtime isn't connected, so this task can't run yet. On the Mac: `launchctl kickstart -k gui/$(id -u)/com.finagai.imessage`. It will resume automatically.",
        doNot: "Do not keep polling. Do not ask Julian to upload the file." });
    }
    if (lc && lc.lifecycle === "stalled") {
      await audit("control_result", "stalled");
      return ok("control_result", { found: true, status: r.status, lifecycle: "stalled", evidence: lc.evidence, done: false,
        tellJulian: "The Mac worker stopped mid-task (no progress). Finagai will reclaim it; if it doesn't resume within a minute, restart the runtime: `launchctl kickstart -k gui/$(id -u)/com.finagai.imessage`." });
    }
    const note = r.status === "done" && r.verification === "needs_review" ? "Task finished but its outcome was NOT independently verified and something was changed — tell Julian plainly it needs his review; do not present it as done-and-verified."
      : r.status === "done" && r.verification === "unverified" ? "Task finished; the result was NOT independently verified — say so when you report it."
      : r.status === "done" ? "Task finished. Summary, detail, and (if present) the final image are included — show the image to Julian."
      : r.status === "expired" ? `This task expired while waiting for Julian (${r.awaitingReason ?? "approval"}). Nothing more ran. Julian can say "resume ${r.code}" in Messages to continue it.`
      : r.status === "waiting_approval" || r.status === "paused" ? `Finagai is waiting for Julian${r.awaitingReason ? `: ${r.awaitingReason}` : ""}${r.expiresAt ? ` (expires ${r.expiresAt})` : ""}. He answers in his Messages thread.`
      : r.status === "active" ? "Still running — call control_result with this task_code again now (same turn). Keep owning it until it is done or failed; never tell Julian to check again." : `Task is ${r.status}.`;
    await audit("control_result", "ok");
    const content: CallToolResult["content"] = [{ type: "text",
      text: JSON.stringify({ found: true, status: r.status, lifecycle: lc?.lifecycle ?? r.status, evidence: lc?.evidence ?? null, progress: lcRow.rows[0]?.progress_note ?? null,
        request: r.request, done: r.status === "done", verification: r.verification, awaiting: r.awaitingReason ? { reason: r.awaitingReason, expiresAt: r.expiresAt } : null,
        summary: r.summary, detail: r.detail, hasImage: Boolean(r.imageB64), note }) }];
    if (r.imageB64) content.push({ type: "image", data: r.imageB64, mimeType: "image/png" });
    return { content };
  });

  registerCosTools(server, helpers, deps.pool, deps.google);   // Phase 3 (ADR-079): employee layer reachable in plain language
  deps.extend?.(server, helpers);
  return server;
}
