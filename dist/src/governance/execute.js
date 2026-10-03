import { appendEvent, withTransaction } from "../db/index.js";
const VERSIONED = new Set(["conflict", "proposal", "seed_batch", "work_item", "knowledge_item", "entity", "external_ref", "project"]);
class Refused extends Error {
}
export async function executeGovernanceDecision(pool, input, promote) {
    try {
        return await withTransaction(pool, async (tx) => {
            const req = (await tx.query(`SELECT * FROM governance_request WHERE id = $1 FOR UPDATE`, [input.requestId])).rows[0];
            if (!req)
                throw new Refused("no such request");
            if (req.status !== "pending")
                throw new Refused(`request is ${req.status}`);
            if (req.expires_at.getTime() <= Date.now())
                throw new Refused("request expired");
            if (!req.challenge_hash || req.challenge_hash !== input.challengeHash)
                throw new Refused("challenge was replaced");
            if (req.challenge_used_at)
                throw new Refused("challenge already used");
            const decision = req.challenge_decision;
            // Consume the challenge first: whatever happens next, it can never be used again.
            await tx.query(`UPDATE governance_request SET challenge_used_at = now() WHERE id = $1`, [req.id]);
            // Counter compare-and-set: a concurrent use of the same assertion cannot both succeed.
            const cred = await tx.query(`UPDATE webauthn_credential SET sign_count = $3, last_used_at = now()
          WHERE id = $1 AND principal_subject = $2 AND revoked_at IS NULL AND sign_count = $4`, [input.credentialUuid, input.principal, input.newSignCount, input.previousSignCount]);
            if (cred.rowCount !== 1)
                throw new Refused("credential state changed or credential not usable");
            // Stale targets: Julian approved a state that no longer exists. Nothing is applied.
            for (const t of req.target_refs) {
                if (!VERSIONED.has(t.type))
                    throw new Refused(`unsupported target type ${t.type}`);
                const cur = (await tx.query(`SELECT version FROM ${t.type} WHERE id = $1 FOR UPDATE`, [t.id])).rows[0];
                if (!cur || cur.version !== t.version) {
                    await tx.query(`UPDATE governance_request SET status = 'superseded' WHERE id = $1`, [req.id]);
                    await appendEvent(tx, { actor: "julian", action: "governance_superseded", entityType: "governance_request", entityId: req.id,
                        reason: `${t.type} ${t.id} changed after the request was staged`, approvalId: req.id, principal: input.principal, client: "approval_page" });
                    return { kind: "superseded", reason: `${t.type} changed since the request was staged; request a new approval` };
                }
            }
            await tx.query(`UPDATE governance_request SET status = $2, decided_at = now(), decided_by_principal = $3, approval_credential_id = $4 WHERE id = $1`, [req.id, decision === "approve" ? "approved" : "rejected", input.principal, input.credentialUuid]);
            if (decision === "reject") {
                const eventId = await appendEvent(tx, { actor: "julian", action: "governance_rejected", entityType: "governance_request",
                    entityId: req.id, reason: req.rationale, approvalId: req.id, principal: input.principal, client: "approval_page" });
                return { kind: "rejected", eventId };
            }
            const ev = (action, entityType, entityId, after, before) => appendEvent(tx, {
                actor: "julian", action, entityType, entityId, after, ...(before !== undefined ? { before } : {}),
                approvalId: req.id, principal: input.principal, client: "approval_page"
            });
            let detail;
            switch (req.action) {
                case "decide_proposal":
                    detail = await decideProposal(tx, req, ev);
                    break;
                case "resolve_conflict":
                    detail = await resolveConflict(tx, req, ev);
                    break;
                case "archive_records":
                    detail = await archiveRecords(tx, req, ev);
                    break;
                case "promote_seed_batch":
                    if (!promote)
                        throw new Refused("seed promotion is not available");
                    detail = await promote(tx, req.target_refs[0].id, { approvalId: req.id, principal: input.principal });
                    break;
                default: throw new Refused(`unsupported action ${req.action}`);
            }
            const eventId = await ev("governance_executed", "governance_request", req.id, { action: req.action, ...detail });
            await tx.query(`UPDATE governance_request SET status = 'executed', executed_event_id = $2 WHERE id = $1`, [req.id, eventId]);
            return { kind: "executed", eventId, detail };
        });
    }
    catch (err) {
        if (err instanceof Refused)
            return { kind: "refused", reason: err.message };
        return { kind: "failed", reason: err instanceof Error ? err.message : "execution failed" };
    }
}
async function decideProposal(tx, req, ev) {
    const p = (await tx.query(`SELECT * FROM proposal WHERE id = $1 AND status = 'pending'`, [req.target_refs[0].id])).rows[0];
    if (!p)
        throw new Refused("proposal is no longer pending");
    const approve = req.proposed_after_state.status === "approved";
    if (!approve) {
        await tx.query(`UPDATE proposal SET status = 'rejected', decided_at = now(), decision_note = $2, version = version + 1 WHERE id = $1`, [p.id, req.rationale]);
        await ev("proposal_decide", "proposal", p.id, { status: "rejected" });
        return { proposal: p.id, status: "rejected" };
    }
    let created;
    if (p.kind === "preference_change" || p.kind === "procedure_change") {
        const table = p.kind === "preference_change" ? "preference" : "procedure";
        const keyCol = table === "preference" ? "key" : "name";
        const textCol = table === "preference" ? "statement" : "body";
        // An existing target is versioned; otherwise a new named entry starts at version 1.
        const existing = p.target_id ? (await tx.query(`SELECT ${keyCol} AS k FROM ${table} WHERE id = $1`, [p.target_id])).rows[0] : undefined;
        const key = existing?.k ?? `${table}-${String(p.id).slice(0, 8)}`;
        const next = (await tx.query(`SELECT coalesce(max(version), 0) + 1 AS v FROM ${table} WHERE ${keyCol} = $1`, [key])).rows[0].v;
        const row = (await tx.query(`INSERT INTO ${table} (${keyCol}, ${textCol}, version, approved_proposal_id, classification) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [key, p.proposed_text, next, p.id, p.classification])).rows[0];
        created = { table, id: row.id };
        await ev("create", table, row.id, { [keyCol]: key, version: next });
    }
    else {
        throw new Refused(`proposal kind ${p.kind} is not executable in v1`);
    }
    await tx.query(`UPDATE proposal SET status = 'approved', decided_at = now(), decision_note = $2, version = version + 1 WHERE id = $1`, [p.id, req.rationale]);
    await ev("proposal_decide", "proposal", p.id, { status: "approved", created });
    return { proposal: p.id, status: "approved", created };
}
async function resolveConflict(tx, req, ev) {
    const c = (await tx.query(`SELECT c.*, cc.capture_id, cc.source_quote AS new_quote FROM conflict c JOIN capture_candidate cc ON cc.id = c.candidate_id
      WHERE c.id = $1 AND c.status = 'open'`, [req.target_refs[0].id])).rows[0];
    if (!c)
        throw new Refused("conflict is no longer open");
    const resolution = String(req.proposed_after_state.resolution);
    const custom = req.proposed_after_state.custom_value;
    const newValue = c.new_value;
    if (resolution === "accept_new" || resolution === "custom") {
        if (c.existing_type === "work_item") {
            if (c.field === "due_at") {
                const raw = resolution === "custom" ? custom : newValue?.date_resolved;
                const due = raw ? new Date(raw) : null;
                if (!due || Number.isNaN(due.getTime()))
                    throw new Refused("the approved due date is not a valid date");
                await tx.query(`UPDATE work_item SET due_at = $2, due_precision = 'day', due_owner = 'finagai', version = version + 1 WHERE id = $1`, [c.existing_id, due]);
                await ev("update", "work_item", c.existing_id, { due_at: due.toISOString() }, c.existing_value);
            }
            else if (c.field === "title") {
                const title = resolution === "custom" ? custom : newValue?.title;
                if (!title)
                    throw new Refused("no title to apply");
                await tx.query(`UPDATE work_item SET title = $2, version = version + 1 WHERE id = $1`, [c.existing_id, title]);
                await ev("update", "work_item", c.existing_id, { title }, c.existing_value);
            }
            else {
                throw new Refused(`field ${c.field} cannot be resolved automatically`);
            }
        }
        else if (c.existing_type === "knowledge_item") {
            const old = (await tx.query(`SELECT * FROM knowledge_item WHERE id = $1`, [c.existing_id])).rows[0];
            const claim = resolution === "custom" ? custom : newValue?.claim;
            if (!old || !claim)
                throw new Refused("no claim to apply");
            const k = (await tx.query(`INSERT INTO knowledge_item (subject_type, subject_id, claim, epistemic_status, source_visibility, purpose, as_of,
                                     retention_review_at, supersedes_id, source_capture_id, source_quote, classification)
         VALUES ($1,$2,$3,'user_provided',$4,$5,now(),$6,$7,$8,$9,$10) RETURNING id`, [old.subject_type, old.subject_id, claim, old.source_visibility, old.purpose, old.retention_review_at, old.id, c.capture_id,
                resolution === "custom" ? claim : c.new_quote, old.classification])).rows[0];
            await tx.query(`UPDATE knowledge_item SET status = 'superseded', version = version + 1 WHERE id = $1`, [old.id]);
            await ev("supersede", "knowledge_item", old.id, { superseded_by: k.id });
            await ev("create", "knowledge_item", k.id, { claim, epistemic_status: "user_provided" });
        }
        else {
            throw new Refused(`conflicts on ${c.existing_type} cannot be resolved automatically`);
        }
    }
    else if (resolution !== "keep_existing" && resolution !== "both_valid") {
        throw new Refused(`unknown resolution ${resolution}`);
    }
    const status = resolution === "custom" ? "custom" : resolution;
    await tx.query(`UPDATE conflict SET status = $2, resolution_note = $3, resolved_at = now(), version = version + 1 WHERE id = $1`, [c.id, status, req.rationale]);
    // Clear the dispute only when no other conflict remains open on the same record.
    if (c.existing_type === "work_item") {
        await tx.query(`UPDATE work_item SET disputed = EXISTS (SELECT 1 FROM conflict WHERE existing_id = $1 AND status = 'open') WHERE id = $1`, [c.existing_id]);
    }
    else if (c.existing_type === "knowledge_item") {
        await tx.query(`UPDATE knowledge_item SET status = 'active' WHERE id = $1 AND status = 'disputed'
                      AND NOT EXISTS (SELECT 1 FROM conflict WHERE existing_id = $1 AND status = 'open')`, [c.existing_id]);
    }
    await ev("conflict_resolve", "conflict", c.id, { resolution });
    return { conflict: c.id, resolution };
}
async function archiveRecords(tx, req, ev) {
    const archived = [];
    for (const t of req.target_refs) {
        const r = await tx.query(`UPDATE ${t.type} SET archived_at = now(), version = version + 1 WHERE id = $1 AND archived_at IS NULL`, [t.id]);
        if (r.rowCount !== 1)
            throw new Refused(`${t.type} ${t.id} is already archived`);
        await ev("archive", t.type, t.id, { archived: true });
        archived.push(t.id);
    }
    return { archived };
}
//# sourceMappingURL=execute.js.map