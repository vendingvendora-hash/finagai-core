/**
 * Phase 1 of two-phase governance (ADR-019): Claude may REQUEST; Core STAGES. Nothing authoritative
 * changes here. Execution happens only after Julian's authenticated approval with a fresh WebAuthn
 * assertion (ADR-030), implemented in M5.
 *
 * The raw nonce travels only in the approval link; Core stores its hash. The nonce is not a secret
 * from Claude (Claude relays the link); it binds the WebAuthn challenge to this exact request and is
 * single-use. Authority comes from the WebAuthn signature, which Claude cannot produce.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendEvent, withTransaction } from "../db/index.js";
/** Deterministic JSON (sorted keys) so the content hash is stable for identical content. */
export function stableStringify(v) {
    if (v === null || typeof v !== "object")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return `[${v.map(stableStringify).join(",")}]`;
    if (v instanceof Date)
        return JSON.stringify(v.toISOString());
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
export function governanceContentHash(action, targets, before, after) {
    return createHash("sha256").update(stableStringify({ action, targets, before, after })).digest("hex");
}
export async function stageGovernanceRequest(pool, cfg, input) {
    const nonce = randomBytes(32).toString("base64url");
    const contentHash = governanceContentHash(input.action, input.targets, input.before, input.after);
    return withTransaction(pool, async (tx) => {
        const r = await tx.query(`INSERT INTO governance_request (action, target_refs, before_state, proposed_after_state, rationale, source_ref,
                                       requesting_client, expires_at, nonce_hash, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 * interval '1 hour'), $9, $10) RETURNING id, expires_at`, [input.action, JSON.stringify(input.targets), JSON.stringify(input.before), JSON.stringify(input.after), input.rationale,
            input.sourceRef === undefined ? null : JSON.stringify(input.sourceRef), input.client, cfg.GOVERNANCE_REQUEST_TTL_HOURS,
            createHash("sha256").update(nonce).digest("hex"), contentHash]);
        const row = r.rows[0];
        await appendEvent(tx, { actor: "system", action: "governance_request_staged", entityType: "governance_request", entityId: row.id,
            after: { action: input.action, targets: input.targets }, client: input.client, ...(input.requestId ? { requestId: input.requestId } : {}) });
        const url = new URL(`/approve/${row.id}`, cfg.FINAGAI_PUBLIC_BASE_URL);
        url.searchParams.set("n", nonce);
        return { approvalId: row.id, approvalUrl: url.toString(), expiresAt: row.expires_at, contentHash };
    });
}
//# sourceMappingURL=stage.js.map