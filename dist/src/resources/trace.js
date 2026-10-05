/** Router rungs → registry capability ids. */
export const RUNG_CAPABILITY = {
    connector_api: "google.gmail", local_parser: "mac.local_parser", app_scripting: "mac.app_scripting", browser_dom: "mac.browser",
    accessibility: "mac.accessibility", screen_perception: "mac.screen", visual_mouse: "mac.keyboard_mouse",
};
export async function writeTrace(pool, ctx, rows) {
    for (const r of rows)
        await pool.query(`INSERT INTO resource_trace (interaction_id, task_id, request, capability_id, decision, reason, relevance) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.interactionId ?? null, ctx.taskId ?? null, ctx.request.slice(0, 500), r.capabilityId, r.decision, r.reason.slice(0, 300), r.relevance ?? null]);
}
/** Trace rows for an execution route: primary rung used, remaining ladder considered, unhealthy rungs unavailable. */
export function routeTraceRows(route) {
    const rows = [{ capabilityId: RUNG_CAPABILITY[route.primary], decision: "used", reason: `primary path for ${route.domain}: ${route.reason}` }];
    for (const p of route.ladder.slice(1))
        rows.push({ capabilityId: RUNG_CAPABILITY[p], decision: "considered", reason: "fallback rung if the primary path fails" });
    for (const p of route.unavailable)
        rows.push({ capabilityId: RUNG_CAPABILITY[p], decision: "unavailable", reason: "capability probe failed" });
    return rows;
}
export async function traceFor(pool, by) {
    const r = await pool.query(`SELECT capability_id, decision, reason FROM resource_trace WHERE ($1::uuid IS NULL OR interaction_id = $1) AND ($2::uuid IS NULL OR task_id = $2) ORDER BY id`, [by.interactionId ?? null, by.taskId ?? null]);
    return r.rows;
}
//# sourceMappingURL=trace.js.map