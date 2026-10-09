/**
 * Phase 3 (ADR-079): the employee layer as MCP tools Julian reaches in plain language — names, never UUIDs.
 */
import { z } from "zod";
import { applyBootstrap, proposeCareerBootstrap } from "../cos/bootstrap.js";
import { addWaiting, areaStatus, ensureArea, executiveBriefV2, placeUnderArea, resolveWaiting, setObjective, waitingOn } from "../cos/operating.js";
export function registerCosTools(server, { ok, fail }, pool, google) {
    const out = (tool, r) => ("error" in r && typeof r.error === "string" ? fail(tool, r.error) : ok(tool, r));
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
        description: "Stage a bootstrap of real operational state for an Area from Julian's authorized sources (Career: the Career Copilot job-history sheet in Drive, interview/recruiter evidence in Gmail and Calendar, existing projects). Read-only: returns a concise PROPOSAL with a short code (pipeline counts, shortlist, active opportunities with evidence, proposed follow-ups, conflicts). Show it to Julian; nothing is written until he approves with apply_bootstrap.",
        inputSchema: z.object({ area: z.enum(["Career"]).default("Career") }),
        annotations: { readOnlyHint: true },
    }, async () => {
        if (!google?.sheetCsv)
            return fail("bootstrap_area", "Google is not connected, so the Career sources can't be read.");
        const r = await proposeCareerBootstrap(pool, google);
        return ok("bootstrap_area", { proposalCode: r.code, ...r.summary, instruction: `Show Julian this proposal concisely (objective to confirm, active opportunities, conflicts). Apply only after he approves: apply_bootstrap {code:${r.code}}.` });
    });
    server.registerTool("apply_bootstrap", {
        description: "Apply a bootstrap proposal Julian approved (by its short code): creates/links the Area, his confirmed objective, pipeline records, active-opportunity projects and their waiting follow-ups. Idempotent; links existing records instead of duplicating.",
        inputSchema: z.object({ code: z.number().int().positive(), objective: z.string().max(300).optional().describe("Julian's own wording of the objective, if he changed it"), skip_followups: z.boolean().optional() }),
    }, async ({ code, objective, skip_followups }) => out("apply_bootstrap", await applyBootstrap(pool, code, { objective: objective ?? null, skipFollowups: skip_followups === true })));
    server.registerTool("executive_brief", {
        description: "Julian's executive brief, management by exception: 1) decisions he must make, 2) blocked work, 3) important changes, 4) deadlines and risks, 5) what Finagai completed, 6) everything else compressed. Lead with the headline; do not pad.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    }, async () => ok("executive_brief", await executiveBriefV2(pool)));
}
//# sourceMappingURL=cosTools.js.map