/**
 * Phase 3 (ADR-079): the employee layer as MCP tools Julian reaches in plain language — names, never UUIDs.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type pg from "pg";
import type { ToolHelpers } from "./server.js";
import { applyBootstrap, compactProposal, proposeCareerBootstrap } from "../cos/bootstrap.js";
import { diagnosticResult, replayProposal, startStabilityJob, traceProposal } from "../cos/career-diagnostics.js";
import type { GoogleSearch } from "../resources/retrieve.js";
import { runCareerSync } from "../cos/career-sync.js";
import { toolRef } from "./manifest.js";
import { findOpportunity, inTx, pipelineSummary, recordOpportunityUpdate, trackOpportunity } from "../cos/opportunities.js";
import { addWaiting, areaStatus, ensureArea, executiveBriefV2, placeUnderArea, resolveWaiting, setObjective, waitingOn } from "../cos/operating.js";

export function registerCosTools(server: McpServer, { ok, fail }: ToolHelpers, pool: pg.Pool, google?: GoogleSearch) {
  const out = (tool: string, r: object) => ("error" in r && typeof (r as { error: unknown }).error === "string" ? fail(tool, (r as { error: string }).error) : ok(tool, r));

  server.registerTool("create_area", {
    description: "Create (or confirm) an Area of Responsibility Julian wants Finagai to manage continuously, by name — e.g. \"Create Career as an Area\". Idempotent by name. Never ask Julian for IDs.",
    inputSchema: z.object({ name: z.string().min(2).max(200), description: z.string().max(1000).optional() }),
  }, async ({ name, description }) => ok("create_area", await ensureArea(pool, name, description)));

  server.registerTool("set_objective", {
    description: "Record a desired outcome under an Area — e.g. \"My objective is to secure a strong finance role\" (area Career). If area is omitted and only one Area exists, it is used.",
    inputSchema: z.object({ objective: z.string().min(3).max(300), area: z.string().max(200).optional(), target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  }, async ({ objective, area, target_date }) => out("set_objective", await setObjective(pool, area ?? null, objective, target_date ?? null)));

  server.registerTool("place_under_area", {
    description: "Put a project/opportunity under an Area (and its objective) — e.g. \"Altarum belongs under Career\". Links the existing project of that name; creates it only if none exists.",
    inputSchema: z.object({ item: z.string().min(2).max(200), area: z.string().min(2).max(200), objective: z.string().max(300).optional() }),
  }, async ({ item, area, objective }) => out("place_under_area", await placeUnderArea(pool, item, area, objective ?? null)));

  server.registerTool("track_waiting", {
    description: "Track something Julian is waiting on — e.g. \"I'm waiting on Beth about Altarum\". Creates a follow-up (default due in 5 days) linked to the project/area when named. Use resolve_waiting when it arrives.",
    inputSchema: z.object({ counterparty: z.string().min(1).max(200), about: z.string().max(300).optional(), project: z.string().max(200).optional(),
      area: z.string().max(200).optional(), due: z.string().max(40).optional().describe("YYYY-MM-DD, 'tomorrow', 'in 5 days', 'next week', 'friday'"), channel: z.string().max(40).optional() }),
  }, async (a) => out("track_waiting", await addWaiting(pool, { counterparty: a.counterparty, about: a.about ?? null, project: a.project ?? null, area: a.area ?? null, due: a.due ?? null, channel: a.channel ?? null })));

  server.registerTool("resolve_waiting", {
    description: "Close what Julian was waiting on from someone (they replied / it happened) — e.g. \"Beth replied, next round on Oct 20\".",
    inputSchema: z.object({ counterparty: z.string().min(1).max(200), outcome: z.string().min(2).max(1000) }),
  }, async ({ counterparty, outcome }) => out("resolve_waiting", await resolveWaiting(pool, counterparty, outcome)));

  server.registerTool("waiting_on", {
    description: "\"What am I waiting on?\" — answered from Finagai's structured follow-up state (who, about what, since when, due, overdue), never from an inbox keyword search. Optional area filter.",
    inputSchema: z.object({ area: z.string().max(200).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ area }) => out("waiting_on", await waitingOn(pool, area ?? null)));

  server.registerTool("area_status", {
    description: "Health of an Area as green/yellow/red with every reason — answers \"Why is Career yellow?\". Red = a service level is breached (overdue follow-up, project without next action); yellow = early warning.",
    inputSchema: z.object({ area: z.string().max(200).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ area }) => out("area_status", await areaStatus(pool, area ?? null)));

  server.registerTool("bootstrap_area", {
    description: "ONE-TIME initial import (before Career exists in state). Not for syncing/refreshing/updating an already-bootstrapped area — use sync_career for that. Stage a bootstrap of real operational state for an Area from Julian's authorized sources (Career: the Career Copilot job-history sheet in Drive, interview/recruiter evidence in Gmail and Calendar, existing projects). Read-only: returns a concise PROPOSAL with a short code (pipeline counts, shortlist, active opportunities with evidence, proposed follow-ups, conflicts). Show it to Julian; nothing is written until he approves with apply_bootstrap.",
    inputSchema: z.object({ area: z.enum(["Career"]).default("Career") }),
    annotations: { readOnlyHint: true },
  }, async () => {
    if (!google?.sheetCsv) return fail("bootstrap_area", "Google is not connected, so the Career sources can't be read.");
    // Live (2026-10-09): "sync my Career pipeline" was routed here after #45 was applied, staging a useless proposal.
    // Once a bootstrap is applied, keeping Career current is sync_career's job.
    const applied = (await pool.query(`SELECT code FROM bootstrap_proposal WHERE area = 'Career' AND status = 'applied' ORDER BY applied_at DESC LIMIT 1`)).rows[0];
    if (applied) return ok("bootstrap_area", { alreadyBootstrapped: true, appliedProposal: Number(applied.code),
      instruction: `Career was already bootstrapped (proposal ${applied.code} applied). Do NOT stage another bootstrap. To bring it up to date ${toolRef("sync_career", {})}, and report its result.` });
    const r = await proposeCareerBootstrap(pool, google);
    const s = r.summary;
    return ok("bootstrap_area", { ...compactProposal(r.code, s), instruction: s.applicable?.ok === false
      ? `This proposal is NOT applicable (${s.applicable.why.join("; ")}). Tell Julian plainly; do not offer to apply it.`
      : `Show Julian this proposal concisely (objective to confirm, active opportunities, closed ones, conflicts, and what changed since the previous snapshot with the records that explain it). Apply only after he approves: apply_bootstrap {code:${r.code}}.` });
  });

  server.registerTool("bootstrap_trace", {
    description: "Explain exactly why an organization is (or is not) in a Career bootstrap proposal: every source record that mentions it, how each was acquired, classified and merged, and the final status transitions. Read-only.",
    inputSchema: z.object({ code: z.number().int().positive(), org: z.string().min(2).max(120) }),
    annotations: { readOnlyHint: true },
  }, async ({ code, org }) => out("bootstrap_trace", await traceProposal(pool, code, org)));

  server.registerTool("bootstrap_replay", {
    description: "Re-run the interpretation of a proposal's frozen input snapshot N times (record order permuted) and report whether every run produces identical digests and the stored result. Read-only.",
    inputSchema: z.object({ code: z.number().int().positive(), runs: z.number().int().min(1).max(50).default(10) }),
    annotations: { readOnlyHint: true },
  }, async ({ code, runs }) => out("bootstrap_replay", await replayProposal(pool, code, runs)));

  server.registerTool("bootstrap_stability", {
    description: "Run N consecutive LIVE Career bootstrap proposals (fresh acquisition each time) and report whether the opportunity set and statuses are identical, attributing any difference to specific new/removed source records. Writes no Career state. Returns a job code; read it with diagnostic_result.",
    inputSchema: z.object({ runs: z.number().int().min(2).max(20).default(10), trace: z.array(z.string().min(2).max(120)).max(6).optional() }),
  }, async ({ runs, trace }) => {
    if (!google?.gmailEnumerate) return fail("bootstrap_stability", "Google is not connected, so the Career sources can't be read.");
    return ok("bootstrap_stability", await startStabilityJob(pool, google, runs, trace ?? ["Immuta", "Transurban"]));
  });

  server.registerTool("diagnostic_result", {
    description: "Read a diagnostic job (e.g. a bootstrap stability run) by its code: status, per-run progress and the verdict.",
    inputSchema: z.object({ code: z.number().int().positive() }),
    annotations: { readOnlyHint: true },
  }, async ({ code }) => out("diagnostic_result", await diagnosticResult(pool, code)));

  server.registerTool("apply_bootstrap", {
    description: "Apply a bootstrap proposal Julian approved (by its short code): creates/links the Area, his confirmed objective, pipeline records, active-opportunity projects and their waiting follow-ups. Idempotent; links existing records instead of duplicating.",
    inputSchema: z.object({ code: z.number().int().positive(), objective: z.string().max(300).optional().describe("Julian's own wording of the objective, if he changed it"), skip_followups: z.boolean().optional() }),
  }, async ({ code, objective, skip_followups }) => out("apply_bootstrap", await applyBootstrap(pool, code, { objective: objective ?? null, skipFollowups: skip_followups === true })));


  // ---- Phase 4 (ADR-082): the opportunity lifecycle — one record per specific job/application, never per employer.
  server.registerTool("find_opportunity", {
    description: "Look up specific jobs in Julian's pipeline — \"Have I applied to Amazon's delivery finance role?\", \"What happened with Altarum?\", \"Is this posting one I already applied to?\" (pass its URL / requisition id). Each application is its own record with status, dates, contact, history and next step. Read-only; answers from structured state, not an inbox search.",
    inputSchema: z.object({ query: z.string().max(200).optional().describe("free text: employer and/or title words"), employer: z.string().max(200).optional(), title: z.string().max(200).optional(),
      req_id: z.string().max(60).optional(), url: z.string().max(500).optional(), status: z.enum(["analyzed", "shortlisted", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "closed"]).optional() }),
    annotations: { readOnlyHint: true },
  }, async (a) => {
    if (!a.query && !a.employer && !a.title && !a.req_id && !a.url && !a.status) return fail("find_opportunity", "Say which job (employer, title, requisition id or posting URL).");
    return ok("find_opportunity", await findOpportunity(pool, { query: a.query ?? null, employer: a.employer ?? null, title: a.title ?? null, reqId: a.req_id ?? null, url: a.url ?? null, status: a.status ?? null }));
  });

  server.registerTool("pipeline", {
    description: "\"Where am I with all my applications?\" — the job pipeline of an Area (default Career): offers, interviews, applications awaiting a response, silent ones, what changed in the last 7 days, and high-fit postings not applied to. Read-only.",
    inputSchema: z.object({ area: z.string().max(200).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ area }) => out("pipeline", await pipelineSummary(pool, area ?? "Career")));

  server.registerTool("track_opportunity", {
    description: "Track ONE specific job posting Julian is considering, preparing or has applied to (employer + title, plus requisition id / URL when known). Deduplicates against every job already known (same requisition, same LinkedIn id, or same employer+title = the same job) and says so if he ALREADY applied. Creates the job's project and next step when it is being prepared or applied to. Never submits anything.",
    inputSchema: z.object({ employer: z.string().min(2).max(200), title: z.string().min(2).max(200), req_id: z.string().max(60).optional(), url: z.string().max(500).optional(), location: z.string().max(120).optional(),
      status: z.enum(["shortlisted", "preparing", "applied", "interviewing"]).default("shortlisted"), fit_score: z.number().int().min(0).max(100).optional(), notes: z.string().max(500).optional(), contact: z.string().max(120).optional() }),
  }, async (a) => out("track_opportunity", await inTx(pool, false, (tx) => trackOpportunity(tx, { employer: a.employer, title: a.title, reqId: a.req_id ?? null, url: a.url ?? null, location: a.location ?? null,
    status: a.status, fitScore: a.fit_score ?? null, notes: a.notes ?? null, contact: a.contact ?? null, source: "julian" }))));

  server.registerTool("record_opportunity_update", {
    description: "Record what happened to ONE specific job — \"I submitted the Altarum application\", \"Altarum scheduled a panel\", \"Amazon 10471926 rejected me\", \"I got an offer\", \"I withdrew\". Status moves forward only (a closed job never reopens); the job's next step and project are updated. If several jobs match, it asks which (give the title or requisition id).",
    inputSchema: z.object({ job: z.string().max(200).optional().describe("employer and/or title words"), employer: z.string().max(200).optional(), title: z.string().max(200).optional(), req_id: z.string().max(60).optional(),
      kind: z.enum(["application", "screen", "interview", "rejection", "offer", "withdrawal", "posting_closed", "note"]), at: z.string().max(40).optional().describe("YYYY-MM-DD; default today"),
      contact: z.string().max(120).optional(), note: z.string().max(500).optional() }),
  }, async (a) => {
    if (!a.job && !a.employer && !a.title && !a.req_id) return fail("record_opportunity_update", "Say which job.");
    return out("record_opportunity_update", await inTx(pool, false, (tx) => recordOpportunityUpdate(tx, { job: a.job ?? null, employer: a.employer ?? null, title: a.title ?? null, reqId: a.req_id ?? null,
      kind: a.kind, at: a.at ?? null, contact: a.contact ?? null, note: a.note ?? null })));
  });

  server.registerTool("sync_career", {
    description: "\"Sync / refresh / update my Career pipeline\": bring the applied Career pipeline up to date from Julian's email and the Career Copilot sheet (same deterministic reading as the bootstrap): new replies, interviews, rejections and applications are recorded on the exact job they concern; status only moves forward; anything ambiguous becomes a decision, never a guess; every change names its source email. preview:true computes the same changes without writing. Also gives every engaged job its next step (waiting on the employer until a date, or Julian's decision). Returns the result (or a job code for diagnostic_result if it takes longer than ~50s).",
    inputSchema: z.object({ preview: z.boolean().default(false) }),
  }, async ({ preview }) => {
    if (!google?.gmailEnumerate) return fail("sync_career", "Google is not connected, so the Career sources can't be read.");
    return out("sync_career", await runCareerSync(pool, google, preview));
  });

  server.registerTool("executive_brief", {
    description: "Julian's executive brief, management by exception: 1) decisions he must make, 2) blocked work, 3) important changes, 4) deadlines and risks, 5) what Finagai completed, 6) everything else compressed. Lead with the headline; do not pad.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => ok("executive_brief", await executiveBriefV2(pool)));
}
