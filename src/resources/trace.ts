/**
 * Phase 2F — resource traces: for every planned execution, which capabilities were considered, used, skipped
 * or unavailable, and why. Feeds debugging now and empirical routing (Phase 6F) later.
 */
import type pg from "pg";
import type { Path } from "../mac/router.js";

/** Router rungs → registry capability ids. */
export const RUNG_CAPABILITY: Record<Path, string> = {
  connector_api: "google.gmail", local_parser: "mac.local_parser", app_scripting: "mac.app_scripting", browser_dom: "mac.browser",
  accessibility: "mac.accessibility", screen_perception: "mac.screen", visual_mouse: "mac.keyboard_mouse",
};

export interface TraceRow { capabilityId: string; decision: "used" | "considered" | "skipped" | "unavailable"; reason: string; relevance?: number }

export async function writeTrace(pool: pg.Pool, ctx: { interactionId?: string | null; taskId?: string | null; request: string }, rows: TraceRow[]): Promise<void> {
  for (const r of rows)
    await pool.query(`INSERT INTO resource_trace (interaction_id, task_id, request, capability_id, decision, reason, relevance) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.interactionId ?? null, ctx.taskId ?? null, ctx.request.slice(0, 500), r.capabilityId, r.decision, r.reason.slice(0, 300), r.relevance ?? null]);
}

/** Trace rows for an execution route: primary rung used, remaining ladder considered, unhealthy rungs unavailable. */
export function routeTraceRows(route: { primary: Path; ladder: Path[]; unavailable: Path[]; reason: string; domain: string }): TraceRow[] {
  const rows: TraceRow[] = [{ capabilityId: RUNG_CAPABILITY[route.primary], decision: "used", reason: `primary path for ${route.domain}: ${route.reason}` }];
  for (const p of route.ladder.slice(1)) rows.push({ capabilityId: RUNG_CAPABILITY[p], decision: "considered", reason: "fallback rung if the primary path fails" });
  for (const p of route.unavailable) rows.push({ capabilityId: RUNG_CAPABILITY[p], decision: "unavailable", reason: "capability probe failed" });
  return rows;
}

export async function traceFor(pool: pg.Pool, by: { interactionId?: string; taskId?: string }): Promise<Array<{ capability_id: string; decision: string; reason: string }>> {
  const r = await pool.query(`SELECT capability_id, decision, reason FROM resource_trace WHERE ($1::uuid IS NULL OR interaction_id = $1) AND ($2::uuid IS NULL OR task_id = $2) ORDER BY id`,
    [by.interactionId ?? null, by.taskId ?? null]);
  return r.rows;
}
