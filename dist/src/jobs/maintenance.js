import { appendEvent } from "../db/index.js";
import { replayDeferred } from "../pipelines/j2/capture.js";
export async function expireGovernanceRequests(pool) {
    const expired = await pool.query(`UPDATE governance_request SET status = 'expired' WHERE status = 'pending' AND expires_at < now() RETURNING id`);
    for (const r of expired.rows) {
        await appendEvent(pool, { actor: "job", action: "governance_expired", entityType: "governance_request", entityId: r.id, client: "scheduler" });
    }
    return expired.rowCount ?? 0;
}
export function dailyMaintenanceHandler(pool, j2) {
    return async (ctx) => {
        const expired = await expireGovernanceRequests(pool);
        if (ctx.signal.aborted)
            return { status: "failed", detail: "lease lost" };
        const replay = await replayDeferred(j2(), 50);
        return { status: "succeeded", detail: `expired ${expired} requests; replayed ${replay.replayed}; ${replay.stillDeferred} still deferred` };
    };
}
//# sourceMappingURL=maintenance.js.map