import { appendEvent } from "../../db/index.js";
import { parseDateExpression, verifyResolvedDate } from "../j2/dates.js";
import { runCapture } from "../j2/capture.js";
import { zonedWallTimeToUtc } from "../../jobs/time.js";
export const MAX_STAGED_PER_BATCH = 400;
// ------------------------------------------------------------------------------ batches and sources
export async function openBatch(db, scopeNote) {
    const existing = (await db.query(`SELECT id FROM seed_batch WHERE status IN ('open','review') ORDER BY created_at DESC LIMIT 1`)).rows[0];
    if (existing)
        return existing.id;
    return (await db.query(`INSERT INTO seed_batch (scope_note) VALUES ($1) RETURNING id`, [scopeNote ?? null])).rows[0].id;
}
export async function addSource(deps, input) {
    const batchId = input.batchId ?? await openBatch(deps.pool);
    const b = (await deps.pool.query(`SELECT status FROM seed_batch WHERE id = $1`, [batchId])).rows[0];
    if (!b || (b.status !== "open" && b.status !== "review"))
        throw new Error("seeding batch is not open");
    const staged = (await deps.pool.query(`SELECT count(*)::int AS n FROM capture_candidate cc JOIN capture c ON c.id = cc.capture_id WHERE c.seed_batch_id = $1`, [batchId])).rows[0].n;
    if (staged >= MAX_STAGED_PER_BATCH)
        throw new Error(`seeding batch already holds ${staged} items; small trustworthy state over volume`);
    const summary = await runCapture(deps, {
        text: input.title ? `${input.title}\n\n${input.text}` : input.text, sourceType: "document", mode: "seeding",
        client: "claude_ai", idempotencyKey: input.idempotencyKey, seedBatchId: batchId,
    });
    if (b.status === "review")
        await deps.pool.query(`UPDATE seed_batch SET status = 'open', version = version + 1 WHERE id = $1`, [batchId]);
    const stagedCount = (await deps.pool.query(`SELECT count(*)::int AS n FROM capture_candidate WHERE capture_id = $1 AND outcome = 'staged'`, [summary.captureId])).rows[0].n;
    return { ...summary, batchId, stagedCount };
}
async function staged(db, batchId) {
    return (await db.query(`SELECT cc.id, cc.capture_id, c.received_at, cc.payload, cc.proposed_action, cc.target_type, cc.target_id, cc.confirmation, cc.seed_overrides
       FROM capture_candidate cc JOIN capture c ON c.id = cc.capture_id
      WHERE c.seed_batch_id = $1 AND cc.outcome = 'staged' ORDER BY c.received_at, cc.created_at`, [batchId])).rows;
}
const norm = (s) => (s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const keyOf = (c) => `${["task", "deadline", "follow_up"].includes(c.item_type) ? "work" : c.item_type}:${norm(c.fields.title ?? c.fields.claim ?? c.fields.name)}`;
const titleOf = (c) => c.fields.title ?? c.fields.claim ?? c.fields.name ?? c.source_quote.slice(0, 120);
// ------------------------------------------------------------------------------ consolidation
/** Merge exact duplicates inside the batch (provenance kept) and flag same-item date contradictions. */
export async function consolidate(db, batchId) {
    const rows = (await staged(db, batchId)).filter((r) => r.confirmation !== "rejected");
    const firstByKey = new Map();
    let merged = 0, conflicts = 0;
    for (const r of rows) {
        const k = keyOf(r.payload);
        if (k.endsWith(":"))
            continue;
        const first = firstByKey.get(k);
        if (!first) {
            firstByKey.set(k, r);
            continue;
        }
        const a = first.payload.date_resolved, b = r.payload.date_resolved;
        if (a && b && a.slice(0, 10) !== b.slice(0, 10)) {
            await db.query(`UPDATE capture_candidate SET seed_overrides = coalesce(seed_overrides, '{}'::jsonb) || $2 WHERE id = $1`, [r.id, JSON.stringify({ conflicts_with: first.id })]);
            conflicts++;
        }
        else if (!r.seed_overrides?.duplicate_of) {
            await db.query(`UPDATE capture_candidate SET confirmation = 'rejected', seed_overrides = coalesce(seed_overrides, '{}'::jsonb) || $2 WHERE id = $1`, [r.id, JSON.stringify({ duplicate_of: first.id })]);
            merged++;
        }
    }
    return { merged, conflicts };
}
export async function questions(deps, batchId) {
    await consolidate(deps.pool, batchId);
    const rows = (await staged(deps.pool, batchId)).filter((r) => r.confirmation === "pending");
    const projectNames = new Set([
        ...rows.filter((r) => r.payload.item_type === "project").map((r) => norm(r.payload.fields.name ?? r.payload.fields.title)),
        ...(await deps.pool.query(`SELECT name FROM project WHERE archived_at IS NULL AND NOT is_unassigned_holding`)).rows.map((p) => norm(p.name)),
    ]);
    const groups = new Map();
    const group = (p) => { if (!groups.has(p))
        groups.set(p, { questions: [], clear: [] }); return groups.get(p); };
    for (const r of rows) {
        const c = r.payload;
        const ov = r.seed_overrides ?? {};
        const project = ov.project ?? c.project_mention ?? "(no project)";
        const qs = [];
        const ask = (kind, prompt) => qs.push({ candidateId: r.id, kind, prompt, quote: c.source_quote });
        const isWork = ["task", "deadline", "follow_up", "decision", "blocker"].includes(c.item_type);
        if (isWork || c.item_type === "fact") {
            if (!ov.project && (!c.project_mention || !projectNames.has(norm(c.project_mention))))
                ask("missing_project", `Which project does "${titleOf(c)}" belong to?`);
        }
        if (c.item_type === "deadline" && !c.date_resolved && !ov.due)
            ask("missing_due_date", `When is "${titleOf(c)}" due?`);
        if (c.date_expression && !ov.due) {
            const v = verifyResolvedDate(c.date_expression, c.date_resolved, r.received_at, deps.cfg.FINAGAI_TIMEZONE, "mixed");
            if (v && v.kind !== "verified")
                ask("unverified_due_date", `Confirm the due date for "${titleOf(c)}": the source says "${c.date_expression}".`);
        }
        if (ov.conflicts_with)
            ask("conflict_in_batch", `Two sources give different dates for "${titleOf(c)}". Which is right?`);
        if (r.proposed_action === "conflict")
            ask("conflict_with_existing", `"${titleOf(c)}" contradicts something Finagai already has. Keep the existing record or use this one?`);
        if (r.proposed_action === "duplicate")
            ask("duplicate_of_existing", `"${titleOf(c)}" looks like something Finagai already has. Skip it?`);
        if (qs.length)
            group(project).questions.push(...qs);
        else
            group(project).clear.push({ candidateId: r.id, type: c.item_type, title: titleOf(c) });
    }
    // Projects with no staged next action.
    for (const r of rows.filter((x) => x.payload.item_type === "project")) {
        const name = norm(r.payload.fields.name ?? r.payload.fields.title);
        const hasWork = rows.some((x) => ["task", "deadline", "follow_up"].includes(x.payload.item_type)
            && norm(x.seed_overrides?.project ?? x.payload.project_mention) === name);
        if (!hasWork)
            group(r.payload.fields.name ?? "(no project)").questions.push({ candidateId: r.id, kind: "project_without_next_action",
                prompt: `What is the next action for "${r.payload.fields.name ?? titleOf(r.payload)}"?`, quote: r.payload.source_quote });
    }
    await deps.pool.query(`UPDATE seed_batch SET status = 'review', version = version + 1 WHERE id = $1 AND status = 'open'`, [batchId]);
    const ORDER = ["conflict_with_existing", "conflict_in_batch", "unverified_due_date", "missing_due_date", "missing_project", "duplicate_of_existing", "project_without_next_action"];
    return {
        batchId,
        groups: [...groups].map(([project, g]) => ({ project, questions: g.questions.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)), clearForBulkConfirmation: g.clear })),
        pending: rows.length,
    };
}
/** Records Julian's answers in STAGING only. Nothing becomes live until approved promotion. */
export async function answer(deps, batchId, answers, now = new Date()) {
    const results = [];
    for (const a of answers) {
        const row = (await deps.pool.query(`SELECT cc.id FROM capture_candidate cc JOIN capture c ON c.id = cc.capture_id
                                          WHERE cc.id = $1 AND c.seed_batch_id = $2 AND cc.outcome = 'staged'`, [a.candidate_id, batchId])).rows[0];
        if (!row) {
            results.push({ candidate_id: a.candidate_id, ok: false, error: "not a staged item of this batch" });
            continue;
        }
        if (a.action === "confirm" || a.action === "reject") {
            await deps.pool.query(`UPDATE capture_candidate SET confirmation = $2 WHERE id = $1`, [a.candidate_id, a.action === "confirm" ? "confirmed" : "rejected"]);
        }
        else if (a.action === "set_project") {
            await deps.pool.query(`UPDATE capture_candidate SET seed_overrides = coalesce(seed_overrides, '{}'::jsonb) || $2 WHERE id = $1`, [a.candidate_id, JSON.stringify({ project: a.value.trim() })]);
        }
        else if (a.action === "set_due") {
            // Julian's own date words, parsed by code (G11); unparseable answers are refused, never guessed.
            const d = parseDateExpression(a.value, now, deps.cfg.FINAGAI_TIMEZONE, "mixed");
            if (!d || "contradiction" in d) {
                results.push({ candidate_id: a.candidate_id, ok: false, error: "could not read that date; use a form like 'October 20' or '2026-10-20'" });
                continue;
            }
            const due = zonedWallTimeToUtc(d.year, d.month, d.day, 23, 59, deps.cfg.FINAGAI_TIMEZONE);
            await deps.pool.query(`UPDATE capture_candidate SET seed_overrides = coalesce(seed_overrides, '{}'::jsonb) || $2 WHERE id = $1`, [a.candidate_id, JSON.stringify({ due: due.toISOString() })]);
        }
        results.push({ candidate_id: a.candidate_id, ok: true });
    }
    await deps.pool.query(`UPDATE seed_batch SET version = version + 1 WHERE id = $1`, [batchId]);
    return results;
}
// ------------------------------------------------------------------------------ promotion (executor)
/**
 * Called ONLY by the governance executor inside its transaction, after Julian's WebAuthn-verified
 * approval (ADR-019, ADR-030). Promotes confirmed items; unconfirmed items stay staged and excluded.
 */
export function makePromoter(cfg) {
    return async function promote(tx, batchId, ctx) {
        const batch = (await tx.query(`SELECT status FROM seed_batch WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
        if (!batch || batch.status !== "review")
            throw new Error("batch is not awaiting review");
        const rows = (await staged(tx, batchId)).filter((r) => r.confirmation === "confirmed");
        const ev = (action, entityType, entityId, after) => appendEvent(tx, {
            actor: "seed", action, entityType, entityId, after, approvalId: ctx.approvalId, principal: ctx.principal, client: "approval_page"
        });
        const holding = (await tx.query(`SELECT id FROM project WHERE is_unassigned_holding`)).rows[0].id;
        const projectIds = new Map((await tx.query(`SELECT id, name FROM project WHERE archived_at IS NULL AND NOT is_unassigned_holding`)).rows.map((p) => [norm(p.name), p.id]));
        const counts = { projects: 0, work_items: 0, knowledge: 0, entities: 0, proposals: 0, conflicts: 0, skipped: 0, still_staged: 0 };
        const done = async (id, targetType, targetId, outcome = "applied") => tx.query(`UPDATE capture_candidate SET outcome = $2, target_type = $3, target_id = $4 WHERE id = $1`, [id, outcome, targetType, targetId]);
        // Projects first, so other items can attach to them.
        for (const r of rows.filter((x) => x.payload.item_type === "project")) {
            const name = r.payload.fields.name ?? r.payload.fields.title ?? titleOf(r.payload);
            if (projectIds.has(norm(name)) || r.proposed_action === "duplicate") {
                await done(r.id, "project", projectIds.get(norm(name)) ?? null, "duplicate");
                counts.skipped++;
                continue;
            }
            const p = (await tx.query(`INSERT INTO project (name, description, source_capture_id, classification, last_activity_at) VALUES ($1,$2,$3,$4,now()) RETURNING id`, [name, r.payload.fields.detail ?? null, r.capture_id, r.payload.classification])).rows[0];
            await ev("create", "project", p.id, { name, seeded: true });
            projectIds.set(norm(name), p.id);
            await done(r.id, "project", p.id);
            counts.projects++;
        }
        for (const r of rows.filter((x) => x.payload.item_type !== "project")) {
            const c = r.payload;
            const ov = r.seed_overrides ?? {};
            if (r.proposed_action === "duplicate") {
                await done(r.id, r.target_type, r.target_id, "duplicate");
                counts.skipped++;
                continue;
            }
            const projectName = ov.project ?? c.project_mention;
            const projectId = projectName ? projectIds.get(norm(projectName)) ?? holding : holding;
            if (r.proposed_action === "conflict" && r.target_id && r.target_type) {
                const conflict = (await tx.query(`INSERT INTO conflict (existing_type, existing_id, candidate_id, field, new_value, explanation, classification)
           VALUES ($1,$2,$3,$4,$5,'seeded source contradicts existing record',$6) RETURNING id`, [r.target_type, r.target_id, r.id, r.target_type === "work_item" ? "due_at" : "claim", JSON.stringify({ ...c.fields, date_resolved: c.date_resolved }), c.classification])).rows[0];
                if (r.target_type === "work_item")
                    await tx.query(`UPDATE work_item SET disputed = true WHERE id = $1`, [r.target_id]);
                await ev("conflict_open", "conflict", conflict.id, { existing: r.target_id });
                await done(r.id, "conflict", conflict.id, "conflict");
                counts.conflicts++;
                continue;
            }
            if (["task", "deadline", "follow_up", "decision", "blocker"].includes(c.item_type)) {
                let due = ov.due ? new Date(String(ov.due)) : null;
                if (!due && c.date_expression) {
                    const v = verifyResolvedDate(c.date_expression, c.date_resolved, r.received_at, cfg.FINAGAI_TIMEZONE, "mixed");
                    if (v?.kind === "verified")
                        due = zonedWallTimeToUtc(v.day.year, v.day.month, v.day.day, 23, 59, cfg.FINAGAI_TIMEZONE);
                }
                const done_ = c.completion_stated;
                const w = (await tx.query(`INSERT INTO work_item (project_id, kind, title, detail, status, due_at, due_precision, due_owner, completed_at, rationale, origin, source_capture_id, classification)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [projectId, c.item_type, titleOf(c), c.fields.detail ?? null, done_ ? "done" : "open", due, due ? "day" : null, due ? "finagai" : null,
                    done_ ? r.received_at : null, c.item_type === "decision" ? c.fields.rationale ?? null : null,
                    "explicit_extraction", r.capture_id, c.classification])).rows[0];
                await ev("create", "work_item", w.id, { title: titleOf(c), due_at: due, seeded: true });
                await done(r.id, "work_item", w.id);
                counts.work_items++;
                continue;
            }
            if (c.item_type === "fact" || c.item_type === "correction") {
                const k = (await tx.query(`INSERT INTO knowledge_item (subject_type, subject_id, claim, epistemic_status, source_visibility, as_of, source_capture_id, source_quote, classification)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [projectId === holding ? "julian" : "project", projectId === holding ? null : projectId, c.fields.claim ?? c.source_quote,
                    c.epistemic_status, c.source_visibility, r.received_at, r.capture_id, c.source_quote, c.classification])).rows[0];
                await ev("create", "knowledge_item", k.id, { seeded: true });
                await done(r.id, "knowledge_item", k.id);
                counts.knowledge++;
                continue;
            }
            if (c.item_type === "entity") {
                if (!c.fields.purpose || projectId === holding) {
                    counts.still_staged++;
                    continue;
                } // ADR-022: stays staged, never forced in
                const review = c.classification === "confidential" ? new Date(Date.now() + cfg.RETENTION_CONFIDENTIAL_THIRD_PARTY_DAYS * 86_400_000) : null;
                const e = (await tx.query(`INSERT INTO entity (kind, name, notes, purpose, source_visibility, retention_review_at, source_capture_id, classification)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [c.fields.kind ?? "person", c.fields.name ?? titleOf(c), c.fields.detail ?? null, c.fields.purpose, c.source_visibility, review, r.capture_id, c.classification])).rows[0];
                await tx.query(`INSERT INTO relationship (from_type, from_id, to_type, to_id, kind, source_capture_id) VALUES ('entity',$1,'project',$2,'relates_to',$3)`, [e.id, projectId, r.capture_id]);
                await ev("create", "entity", e.id, { seeded: true });
                await done(r.id, "entity", e.id);
                counts.entities++;
                continue;
            }
            if (c.item_type === "preference" || c.item_type === "procedure_change") {
                // Rules still go through their own proposal and approval; seeding cannot enact them.
                const p = (await tx.query(`INSERT INTO proposal (kind, proposed_text, rationale, source_capture_id, classification) VALUES ($1,$2,'from seeding',$3,$4) RETURNING id`, [c.item_type === "preference" ? "preference_change" : "procedure_change", c.fields.statement ?? c.source_quote, r.capture_id, c.classification])).rows[0];
                await ev("proposal_open", "proposal", p.id, { seeded: true });
                await done(r.id, "proposal", p.id, "proposal");
                counts.proposals++;
                continue;
            }
            counts.still_staged++;
        }
        counts.still_staged += (await staged(tx, batchId)).filter((r) => r.confirmation !== "confirmed").length;
        await tx.query(`UPDATE seed_batch SET status = 'promoted', promoted_at = now(), version = version + 1 WHERE id = $1`, [batchId]);
        return { batch: batchId, ...counts };
    };
}
//# sourceMappingURL=seed.js.map