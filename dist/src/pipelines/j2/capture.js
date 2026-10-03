/**
 * J2 context capture, steps 0-9 (implementation plan section 9), with budget deferral
 * (ADR-025 as clarified). Claude is called for extraction and relation classification only;
 * every model output passes code guards before it can affect state, and every write commits
 * together with its event and candidate record.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendEvent, withTransaction } from "../../db/index.js";
import { checkCandidate, checkRelationTarget, extractionResultSchema, relationResultSchema, resolveProject, } from "../../guards/extraction.js";
import { redactSensitive } from "../../guards/sensitive.js";
import { zonedParts, zonedWallTimeToUtc } from "../../jobs/time.js";
import { BudgetBlockedError } from "../../llm/types.js";
import { J2_CLASSIFY_SYSTEM, J2_CLASSIFY_VERSION, J2_EXTRACT_SYSTEM, J2_EXTRACT_VERSION } from "../../prompts/j2.js";
import { verifyResolvedDate } from "./dates.js";
import { retrieveMatches, tableFor } from "./retrieve.js";
export const PIPELINE_VERSION = "j2-v0";
export const MAX_INPUT_CHARS = 30_000;
export class CaptureInputError extends Error {
}
/** Marker replacing content the second layer classified Highly Sensitive or Prohibited. */
export const SENSITIVE_MARKER = "[REDACTED:SENSITIVE_CONTENT]";
/** Long enough for the slowest model step (4 attempts x 60 s plus backoff) with margin. */
export const CAPTURE_LEASE_MS = 10 * 60_000;
/**
 * G12 payload integrity: every field that changes capture semantics (ADR-038). Computed on the
 * deterministically redacted text, so no derivative of a recognized secret is stored.
 */
export function capturePayloadHash(p) {
    return createHash("sha256").update(JSON.stringify(["v2", p.sourceType, p.mode, p.projectHint ?? null, p.redactedText, p.seedBatchId ?? null])).digest("hex");
}
const emptySummary = (captureId, status) => ({
    captureId, status, applied: [], duplicates: [], proposals: [], conflicts: [], unassigned: [], dateFlags: [],
    rejected: [], notStored: [], openQuestions: [],
});
const COMPLETED = new Set(["processed", "partially_applied", "dry_run", "budget_deferred"]);
// ----------------------------------------------------------------------------- entry point
/**
 * J2 entry. Persistence order (ADR-038):
 *   1. deterministic redaction in memory;
 *   2. an idempotency/processing row WITHOUT the body;
 *   3. extraction and second-layer classification on the in-memory text;
 *   4. only then a sanitized body (minus anything the model labeled Highly Sensitive or Prohibited).
 * A crash or transient failure leaves a reclaimable row; the client retries with the same key.
 */
export async function runCapture(deps, req) {
    if (req.text.length === 0 || req.text.length > MAX_INPUT_CHARS) {
        throw new CaptureInputError(`capture text must be 1-${MAX_INPUT_CHARS} characters`);
    }
    const { text: redacted, findings } = redactSensitive(req.text);
    if ((req.mode === "seeding") !== Boolean(req.seedBatchId))
        throw new CaptureInputError("seeding captures require a seed batch, and only seeding captures may have one");
    const payloadSha = capturePayloadHash({ sourceType: req.sourceType, mode: req.mode, projectHint: req.projectHint ?? null, redactedText: redacted, seedBatchId: req.seedBatchId ?? null });
    const token = randomUUID();
    const now = (deps.now ?? (() => new Date()))();
    const ins = await deps.pool.query(`INSERT INTO capture (idempotency_key, client, mode, source_type, source_text, redactions, project_hint,
                          pipeline_version, request_id, received_at, payload_sha256, status, processing_token, processing_until, seed_batch_id)
     VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,'processing',$11, now() + ($12 * interval '1 millisecond'), $13)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, received_at`, [req.idempotencyKey, req.client, req.mode, req.sourceType, findings.length, req.projectHint ?? null,
        PIPELINE_VERSION, req.requestId ?? null, now, payloadSha, token, CAPTURE_LEASE_MS, req.seedBatchId ?? null]);
    let captureId;
    let receivedAt;
    if (ins.rows[0]) {
        captureId = ins.rows[0].id;
        receivedAt = ins.rows[0].received_at;
    }
    else {
        const prior = (await deps.pool.query(`SELECT id, status, payload_sha256, (processing_until > now()) AS live FROM capture WHERE idempotency_key = $1`, [req.idempotencyKey])).rows[0];
        if (prior.payload_sha256 !== payloadSha) {
            return { ...emptySummary(prior.id, "idempotency_conflict"),
                message: "This idempotency key was already used for a different capture request. Nothing was captured; use a new key for a new capture." };
        }
        if (COMPLETED.has(prior.status))
            return { ...emptySummary(prior.id, "already_captured"), existingStatus: prior.status };
        if (prior.status === "processing" && prior.live) {
            return { ...emptySummary(prior.id, "in_progress"), message: "This capture is being processed. Retry later with the same key." };
        }
        // Failed, blocked, or a stale lease: reclaim the SAME capture and retry with the request's text.
        const re = await deps.pool.query(`UPDATE capture SET status = 'processing', processing_token = $2,
              processing_until = now() + ($4 * interval '1 millisecond'), attempts = attempts + 1
        WHERE id = $1 AND payload_sha256 = $3
          AND (status IN ('failed', 'budget_blocked_not_persisted', 'received')
               OR (status = 'processing' AND processing_until < now()))
        RETURNING id, received_at`, [prior.id, token, payloadSha, CAPTURE_LEASE_MS]);
        if (!re.rows[0])
            return { ...emptySummary(prior.id, "in_progress"), message: "This capture is being processed. Retry later with the same key." };
        captureId = re.rows[0].id;
        receivedAt = re.rows[0].received_at; // the original event time is kept across retries
    }
    const summary = await processCapture(deps, {
        id: captureId, text: redacted, mode: req.mode, receivedAt, projectHint: req.projectHint ?? null,
        requestId: req.requestId ?? null, token, deterministicRedactions: findings.length,
    }, false);
    summary.notStored = [...new Set([...findings.map((f) => f.kind), ...summary.notStored])];
    return summary;
}
/** Replays budget-deferred captures (sanitized bodies) in arrival order, under the same ownership rules. */
export async function replayDeferred(deps, limit = 25) {
    let replayed = 0;
    for (let i = 0; i < limit; i++) {
        const token = randomUUID();
        const row = (await deps.pool.query(`UPDATE capture SET status = 'processing', processing_token = $1, processing_until = now() + ($2 * interval '1 millisecond'),
              attempts = attempts + 1
        WHERE id = (SELECT id FROM capture
                     WHERE source_text IS NOT NULL AND (status = 'budget_deferred' OR (status = 'processing' AND processing_until < now()))
                     ORDER BY received_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, source_text, mode, received_at, project_hint, request_id, redactions`, [token, CAPTURE_LEASE_MS])).rows[0];
        if (!row)
            break;
        const s = await processCapture(deps, { id: row.id, text: row.source_text, mode: row.mode, receivedAt: row.received_at,
            projectHint: row.project_hint, requestId: row.request_id, token, deterministicRedactions: row.redactions }, true);
        if (s.status === "budget_deferred")
            break; // still no budget: it was returned to the queue; stop
        replayed++;
    }
    return { replayed, stillDeferred: await deferredCount(deps.pool) };
}
export async function deferredCount(db) {
    const r = await db.query(`SELECT count(*)::int AS n FROM capture WHERE status = 'budget_deferred'`);
    return r.rows[0]?.n ?? 0;
}
class LeaseLost extends Error {
}
/** Every terminal transition requires the current processing token (stale workers are powerless). */
async function finish(db, cap, status, body, extra = {}) {
    const r = await db.query(`UPDATE capture SET status = $3, source_text = $4, sanitized_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
            processing_token = NULL, processing_until = NULL, sensitive_redactions = $5,
            deferred_at = CASE WHEN $6 THEN coalesce(deferred_at, now()) ELSE deferred_at END,
            replayed_at = CASE WHEN $7 THEN now() ELSE replayed_at END
      WHERE id = $1 AND processing_token = $2`, [cap.id, cap.token, status, body, extra.sensitive ?? 0, extra.deferred ?? false, extra.replayed ?? false]);
    if (r.rowCount !== 1)
        throw new LeaseLost();
}
const inProgress = (id) => ({ ...emptySummary(id, "in_progress"),
    message: "Another attempt now owns this capture; this attempt's results were discarded." });
function parseJson(text, schema) {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let raw;
    try {
        raw = JSON.parse(cleaned);
    }
    catch {
        return { ok: false, error: "response was not valid JSON" };
    }
    const r = schema.safeParse(raw);
    return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.message.slice(0, 800) };
}
async function callStructured(deps, base, user, schema) {
    const messages = [{ role: "user", content: user }];
    const first = await deps.model.complete({ ...base, messages });
    const parsed = parseJson(first.text, schema);
    if (parsed.ok)
        return parsed.data;
    const retry = await deps.model.complete({ ...base, messages: [...messages, { role: "assistant", content: first.text },
            { role: "user", content: `Your response failed validation: ${parsed.error}. Return only corrected JSON.` }] });
    const again = parseJson(retry.text, schema);
    if (again.ok)
        return again.data;
    throw new SchemaFailure(again.error);
}
class SchemaFailure extends Error {
}
/**
 * Remove every verbatim span the second layer classified Highly Sensitive or Prohibited.
 * Matching tolerates whitespace and case differences. If a span cannot be located, the body is
 * withheld entirely (fail safe): provenance text is never kept at the risk of keeping the content.
 */
export function redactSensitiveQuotes(text, quotes) {
    let out = text;
    let count = 0;
    for (const q of quotes) {
        const words = q.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        if (words.length === 0)
            continue;
        const re = new RegExp(words.join("\\s+"), "gi");
        if (!re.test(out))
            return { text: null, count };
        out = out.replace(new RegExp(words.join("\\s+"), "gi"), SENSITIVE_MARKER);
        count++;
    }
    return { text: out, count };
}
/** Replace every occurrence of withheld spans in arbitrary text (no failure semantics). */
export function scrubSpans(text, quotes) {
    let out = text;
    for (const q of quotes) {
        const words = q.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        if (words.length)
            out = out.replace(new RegExp(words.join("\\s+"), "gi"), SENSITIVE_MARKER);
    }
    return out;
}
/** A rejected candidate is persisted only after every withheld span is scrubbed from it. */
function scrubCandidate(c, quotes) {
    if (quotes.length === 0)
        return c;
    const fields = Object.fromEntries(Object.entries(c.fields).map(([k, v]) => [k, v === null ? null : scrubSpans(v, quotes)]));
    return { ...c, fields, source_quote: scrubSpans(c.source_quote, quotes),
        ...(c.date_expression ? { date_expression: scrubSpans(c.date_expression, quotes) } : {}) };
}
async function processCapture(deps, cap, isReplay) {
    try {
        return await processOwned(deps, cap, isReplay);
    }
    catch (err) {
        if (err instanceof LeaseLost)
            return inProgress(cap.id);
        // Unexpected failure: release as 'failed' so the same key can retry; never persist the body.
        try {
            await finish(deps.pool, cap, isReplay ? "budget_deferred" : "failed", isReplay ? cap.text : null, { deferred: isReplay });
        }
        catch (e) {
            if (e instanceof LeaseLost)
                return inProgress(cap.id);
        }
        return { ...emptySummary(cap.id, isReplay ? "budget_deferred" : "failed"), message: "capture failed; retry with the same key" };
    }
}
async function processOwned(deps, cap, isReplay) {
    const summary = emptySummary(cap.id, "processed");
    const tz = deps.cfg.FINAGAI_TIMEZONE;
    // Evaluation runs are budgeted as "eval": paused at the $30 target and reported, never silently reduced (ADR-025).
    const purpose = cap.mode === "seeding" ? "seed" : cap.mode === "eval" ? "eval" : "capture";
    const local = zonedParts(cap.receivedAt, tz);
    const userPayload = JSON.stringify({
        received_at: cap.receivedAt.toISOString(),
        received_at_local: `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`,
        timezone: tz, text: cap.text,
    });
    // Step 2: extract (second-layer classification happens here).
    let extraction;
    try {
        extraction = await callStructured(deps, {
            pipeline: "j2", step: "extract", purpose, model: deps.cfg.MODEL_J2_EXTRACT, promptVersion: J2_EXTRACT_VERSION,
            system: J2_EXTRACT_SYSTEM, maxTokens: 4000, captureId: cap.id, ...(cap.requestId ? { requestId: cap.requestId } : {}),
        }, userPayload, extractionResultSchema);
    }
    catch (err) {
        if (err instanceof BudgetBlockedError && err.level === "ceiling") {
            if (isReplay) {
                await finish(deps.pool, cap, "budget_deferred", cap.text, { deferred: true });
                return { ...emptySummary(cap.id, "budget_deferred") };
            }
            // Security over lossless deferral: an unclassified body is never persisted (ADR-038).
            await finish(deps.pool, cap, "budget_blocked_not_persisted", null);
            return { ...emptySummary(cap.id, "budget_blocked_not_persisted"),
                message: "The model-spend ceiling is reached, so this content could not be classified and was NOT stored. Resubmit it with the same key after budget is available or the ceiling is raised." };
        }
        if (err instanceof SchemaFailure) {
            await finish(deps.pool, cap, "failed", null);
            return { ...emptySummary(cap.id, "failed"), message: "extraction output failed validation twice; retry with the same key" };
        }
        throw err;
    }
    // Second-layer sanitization BEFORE anything derived from the text is persisted.
    const sensitive = extraction.candidates.filter((c) => c.classification === "highly_sensitive" || c.classification === "prohibited");
    const sensitiveQuotes = sensitive.map((c) => c.source_quote);
    const sanitized = redactSensitiveQuotes(cap.text, sensitiveQuotes);
    const body = sanitized.text; // null means "withhold the body" (fail safe)
    const textForGuards = body ?? cap.text.replace(/[\s\S]*/, SENSITIVE_MARKER);
    if (sensitive.length > 0)
        summary.notStored.push("sensitive_content");
    // Step 3: verify (G01, G03, G04, G09), Step 4: resolve projects (G10) and dates (G11).
    const projects = (await deps.pool.query(`SELECT id, name, ARRAY[]::text[] AS aliases, is_unassigned_holding FROM project WHERE archived_at IS NULL`)).rows;
    const holding = projects.find((p) => p.is_unassigned_holding);
    if (!holding)
        throw new Error("Unassigned holding project missing");
    const hintId = cap.projectHint ? projects.find((p) => p.name.toLowerCase() === cap.projectHint.toLowerCase())?.id : undefined;
    const accepted = [];
    const rejectedRows = [];
    for (const c of extraction.candidates) {
        if (sensitive.includes(c)) {
            rejectedRows.push({ c, outcome: "guard_rejected", reasons: ["G09_sensitive_label"], sensitive: true });
            continue;
        }
        // Guards run against the sanitized text: a quote overlapping withheld content cannot pass G01.
        const v = checkCandidate(textForGuards, c);
        if (v.outcome === "temporary_discarded") {
            rejectedRows.push({ c, outcome: "temporary_discarded", reasons: [], sensitive: false });
            continue;
        }
        if (v.outcome === "guard_rejected") {
            rejectedRows.push({ c, outcome: "guard_rejected", reasons: v.reasons, sensitive: false });
            continue;
        }
        if (c.item_type === "open_question") {
            summary.openQuestions.push(scrubSpans(c.fields.title ?? c.source_quote, sensitiveQuotes));
            rejectedRows.push({ c, outcome: "temporary_discarded", reasons: [], sensitive: false });
            continue;
        }
        if (c.item_type === "relationship") {
            rejectedRows.push({ c, outcome: "guard_rejected", reasons: ["unsupported_type_v0"], sensitive: false });
            continue;
        }
        const res = resolveProject(c.project_mention, projects.filter((p) => !p.is_unassigned_holding), hintId);
        const date = verifyResolvedDate(c.date_expression, c.date_resolved, cap.receivedAt, tz, extraction.language);
        accepted.push({ c, projectId: res.kind === "resolved" ? res.projectId : holding.id, unassigned: res.kind !== "resolved", date, matches: [] });
    }
    // Step 5: retrieve matches.
    for (const w of accepted)
        w.matches = await retrieveMatches(deps.pool, w.c, w.unassigned ? null : w.projectId);
    // Step 6: classify relations.
    const judgments = new Map();
    const toClassify = accepted.filter((w) => w.matches.length > 0);
    if (toClassify.length > 0) {
        try {
            const rel = await callStructured(deps, {
                pipeline: "j2", step: "classify", purpose, model: deps.cfg.MODEL_J2_CLASSIFY, promptVersion: J2_CLASSIFY_VERSION,
                system: J2_CLASSIFY_SYSTEM, maxTokens: 2000, captureId: cap.id, ...(cap.requestId ? { requestId: cap.requestId } : {}),
            }, JSON.stringify(toClassify.map((w) => ({
                temp_id: w.c.temp_id, item_type: w.c.item_type, fields: w.c.fields, quote: w.c.source_quote,
                matches: w.matches.map((m) => ({ id: m.id, text: m.text, status: m.status, due_at: m.dueAt })),
            }))), relationResultSchema);
            for (const j of rel.judgments)
                judgments.set(j.temp_id, j);
        }
        catch (err) {
            if (err instanceof BudgetBlockedError && err.level === "ceiling") {
                // Extraction and classification already ran, so the SANITIZED body may be deferred.
                if (body === null) {
                    await finish(deps.pool, cap, "budget_blocked_not_persisted", null);
                    return { ...emptySummary(cap.id, "budget_blocked_not_persisted"), message: "The model-spend ceiling is reached and this content could not be safely stored. Resubmit it with the same key later." };
                }
                return defer(deps, cap, body, sanitized.count, isReplay);
            }
            if (err instanceof SchemaFailure) {
                await finish(deps.pool, cap, isReplay ? "budget_deferred" : "failed", isReplay ? body : null, { deferred: isReplay });
                return { ...emptySummary(cap.id, "failed"), message: "relation classification failed; retry with the same key" };
            }
            throw err;
        }
    }
    // Steps 7-8: apply authority rules and commit atomically, only while this attempt owns the lease.
    const dryRun = cap.mode === "audit";
    const staged = cap.mode === "seeding";
    await withTransaction(deps.pool, async (tx) => {
        const owned = await tx.query(`SELECT 1 FROM capture WHERE id = $1 AND processing_token = $2 FOR UPDATE`, [cap.id, cap.token]);
        if (owned.rowCount !== 1)
            throw new LeaseLost();
        for (const r of rejectedRows) {
            if (r.sensitive) {
                // Audit metadata only: never the sensitive value, not even to prove it was rejected.
                await tx.query(`INSERT INTO capture_candidate (capture_id, item_type, payload, source_quote, outcome, guard_reasons)
           VALUES ($1,$2,$3,$4,'guard_rejected',$5)`, [cap.id, r.c.item_type, JSON.stringify({ temp_id: r.c.temp_id, item_type: r.c.item_type, classification: r.c.classification, withheld: true }),
                    SENSITIVE_MARKER, r.reasons]);
            }
            else {
                // Scrub withheld spans even from candidates rejected for other reasons (their quotes may overlap).
                await insertCandidate(tx, cap.id, scrubCandidate(r.c, sensitiveQuotes), null, r.outcome, null, r.outcome === "guard_rejected" ? r.reasons : []);
            }
            if (r.outcome === "guard_rejected")
                summary.rejected.push({ tempId: r.c.temp_id, reasons: [...r.reasons] });
        }
        for (const w of accepted) {
            const j = judgments.get(w.c.temp_id) ?? { temp_id: w.c.temp_id, relation: "new", target_id: null, changed_fields: [], rationale: "no existing match" };
            const g05 = checkRelationTarget(j, new Set(w.matches.map((m) => m.id)));
            if (g05) {
                await insertCandidate(tx, cap.id, w.c, j.relation, "guard_rejected", null, [g05]);
                summary.rejected.push({ tempId: w.c.temp_id, reasons: [g05] });
                continue;
            }
            if (w.date && w.date.kind !== "verified") {
                summary.dateFlags.push({ title: w.c.fields.title ?? w.c.source_quote, verdict: w.date.kind, ...(w.date.kind === "mismatch" ? { detail: w.date.reason } : {}) });
            }
            if (dryRun || staged) {
                const targetTable = j.target_id ? w.matches.find((m) => m.id === j.target_id)?.table ?? null : null;
                await insertCandidate(tx, cap.id, w.c, j.relation, dryRun ? "dry_run" : "staged", j.target_id, [], targetTable);
                if (staged) {
                    await tx.query(`UPDATE capture_candidate SET confirmation = 'pending' WHERE capture_id = $1 AND outcome = 'staged' AND confirmation IS NULL`, [cap.id]);
                }
                continue;
            }
            await applyCandidate(deps, tx, cap, w, j, summary);
        }
        const status = dryRun ? "dry_run" : summary.rejected.length > 0 ? "partially_applied" : "processed";
        await finish(tx, cap, status, body, { sensitive: sanitized.count, replayed: isReplay });
        summary.status = status;
    });
    return summary;
}
// ----------------------------------------------------------------------------- deferral
export const DEFERRED_QUEUE_LOCK = "finagai.deferred_capture_queue";
/**
 * Only reachable AFTER extraction and second-layer sanitization (ADR-038). Atomic queue bound:
 * count -> decision -> status transition under one advisory transaction lock (ADR-037).
 */
async function defer(deps, cap, sanitizedBody, sensitiveCount, isReplay) {
    const summary = emptySummary(cap.id, "budget_deferred");
    const max = deps.cfg.MAX_DEFERRED_CAPTURES;
    const outcome = await withTransaction(deps.pool, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [DEFERRED_QUEUE_LOCK]);
        const count = await deferredCount(tx);
        if (!isReplay && count >= max) {
            await finish(tx, cap, "budget_blocked_not_persisted", null);
            return { accepted: false, count };
        }
        await finish(tx, cap, "budget_deferred", sanitizedBody, { sensitive: sensitiveCount, deferred: true });
        return { accepted: true, count: isReplay ? count + 1 : count + 1 };
    });
    if (!outcome.accepted) {
        await deps.alerts?.deferredQueue(100, outcome.count, max);
        return { ...summary, status: "rejected_queue_full", deferredCount: outcome.count,
            message: `The model-spend ceiling is reached and the deferred-capture queue is full (${max}). This capture was NOT queued or stored; resubmit it with the same key after the budget is raised.` };
    }
    if (isReplay)
        return { ...summary, deferredCount: outcome.count };
    if (outcome.count >= max)
        await deps.alerts?.deferredQueue(100, outcome.count, max);
    else if (outcome.count >= Math.ceil(max * 0.8))
        await deps.alerts?.deferredQueue(80, outcome.count, max);
    return { ...summary, deferredCount: outcome.count,
        message: "The model-spend ceiling is reached. This capture was classified, sanitized, and stored; it will be finished when budget is available." };
}
// ----------------------------------------------------------------------------- authority rules (section 6)
async function insertCandidate(tx, captureId, c, relation, outcome, targetId, reasons, targetType = null) {
    await tx.query(`INSERT INTO capture_candidate (capture_id, item_type, payload, source_quote, proposed_action, outcome, target_type, target_id, guard_reasons)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [captureId, c.item_type, JSON.stringify(c), c.source_quote, relation, outcome, targetType, targetId, reasons]);
}
const WORK_KIND = {
    task: "task", deadline: "deadline", follow_up: "follow_up", decision: "decision", blocker: "blocker",
};
function dueFields(w, tz) {
    if (!w.date || w.date.kind !== "verified")
        return { due_at: null, due_precision: null, due_owner: null };
    const d = w.date.day;
    // Day precision: stored as 23:59 local time on the stated day in Julian's timezone.
    return { due_at: zonedWallTimeToUtc(d.year, d.month, d.day, 23, 59, tz), due_precision: "day", due_owner: "finagai" };
}
async function applyCandidate(deps, tx, cap, w, j, summary) {
    const { c } = w;
    const ev = (action, entityType, entityId, after, before) => appendEvent(tx, { actor: "j2", action, entityType, entityId, after, ...(before !== undefined ? { before } : {}),
        captureId: cap.id, ...(cap.requestId ? { requestId: cap.requestId } : {}), client: "j2" });
    const title = c.fields.title ?? c.fields.claim ?? c.fields.name ?? c.source_quote.slice(0, 120);
    const target = j.target_id ? w.matches.find((m) => m.id === j.target_id) : undefined;
    const ref = (table, id) => ({ table, id, title });
    // Duplicates never write domain state.
    if (j.relation === "duplicate" && target) {
        await insertCandidate(tx, cap.id, c, "duplicate", "duplicate", target.id, [], target.table);
        summary.duplicates.push(ref(target.table, target.id));
        return;
    }
    // G07: supersession only for explicit corrections; anything else contradicting becomes a conflict.
    let relation = j.relation === "supersedes" && c.item_type !== "correction" ? "conflict" : j.relation;
    // G06: an "update" may only fill gaps or change status. Replacing an existing, different due date is a
    // contradiction, so it becomes a conflict whatever the model called it (never a silent overwrite).
    const newDue = dueFields(w, deps.cfg.FINAGAI_TIMEZONE).due_at;
    if (relation === "update" && target?.table === "work_item" && target.dueAt && newDue && target.dueAt.getTime() !== newDue.getTime()) {
        relation = "conflict";
    }
    // Knowledge claims are never "updated" in place: a different claim is a conflict unless explicitly corrected.
    if (relation === "update" && target?.table === "knowledge_item")
        relation = "conflict";
    if (relation === "conflict" && target) {
        const field = j.changed_fields[0] ?? (target.table === "work_item" ? "due_at" : "claim");
        const cand = await tx.query(`INSERT INTO capture_candidate (capture_id, item_type, payload, source_quote, proposed_action, outcome, target_type, target_id)
       VALUES ($1,$2,$3,$4,'conflict','conflict',$5,$6) RETURNING id`, [cap.id, c.item_type, JSON.stringify(c), c.source_quote, target.table, target.id]);
        const conflict = await tx.query(`INSERT INTO conflict (existing_type, existing_id, candidate_id, field, existing_value, new_value, explanation, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [target.table, target.id, cand.rows[0].id, field,
            JSON.stringify(target.table === "work_item" ? { due_at: target.dueAt, title: target.text } : { claim: target.text }),
            JSON.stringify({ ...c.fields, date_resolved: c.date_resolved }), j.rationale, c.classification]);
        if (target.table === "work_item")
            await tx.query(`UPDATE work_item SET disputed = true WHERE id = $1`, [target.id]);
        if (target.table === "knowledge_item")
            await tx.query(`UPDATE knowledge_item SET status = 'disputed' WHERE id = $1`, [target.id]);
        await ev("conflict_open", "conflict", conflict.rows[0].id, { existing: target.id, field });
        summary.conflicts.push(ref("conflict", conflict.rows[0].id));
        return;
    }
    // Preferences and procedure changes become proposals (G08); never direct writes.
    if (c.item_type === "preference" || c.item_type === "procedure_change") {
        const p = await tx.query(`INSERT INTO proposal (kind, proposed_text, rationale, source_capture_id, classification)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [c.item_type === "preference" ? "preference_change" : "procedure_change", c.fields.statement ?? c.source_quote,
            `Captured from Julian: "${c.source_quote}"`, cap.id, c.classification]);
        await ev("proposal_open", "proposal", p.rows[0].id, { kind: c.item_type });
        await insertCandidate(tx, cap.id, c, relation, "proposal", p.rows[0].id, [], "proposal");
        summary.proposals.push(ref("proposal", p.rows[0].id));
        return;
    }
    // Work items.
    const kind = WORK_KIND[c.item_type];
    if (kind) {
        const due = dueFields(w, deps.cfg.FINAGAI_TIMEZONE);
        const done = c.completion_stated; // G04 already verified the quote states completion
        if (relation === "update" && target && target.table === "work_item") {
            const before = await tx.query(`SELECT title, status, due_at, version FROM work_item WHERE id = $1 FOR UPDATE`, [target.id]);
            const row = before.rows[0];
            if (!row || row.version !== target.version)
                throw new Error("work item changed concurrently; capture will be retried");
            const upd = await tx.query(`UPDATE work_item SET status = CASE WHEN $2 THEN 'done' ELSE status END,
                completed_at = CASE WHEN $2 THEN now() ELSE completed_at END,
                due_at = coalesce($3, due_at), due_precision = coalesce($4, due_precision), due_owner = coalesce($5, due_owner),
                detail = coalesce($6, detail), version = version + 1
          WHERE id = $1 RETURNING title, status, due_at`, [target.id, done, due.due_at, due.due_precision, due.due_owner, c.fields.detail ?? null]);
            const eid = await ev(done ? "status_change" : "update", "work_item", target.id, upd.rows[0], row);
            await tx.query(`UPDATE work_item SET last_event_id = $2 WHERE id = $1`, [target.id, eid]);
            await insertCandidate(tx, cap.id, c, relation, "applied", target.id, [], "work_item");
            summary.applied.push(ref("work_item", target.id));
            return;
        }
        const wi = await tx.query(`INSERT INTO work_item (project_id, kind, title, detail, status, due_at, due_precision, due_owner, completed_at, rationale,
                              origin, source_capture_id, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'explicit_extraction',$11,$12) RETURNING id`, [w.projectId, kind, title, c.fields.detail ?? null, done ? "done" : "open", due.due_at, due.due_precision, due.due_owner,
            done ? cap.receivedAt : null, kind === "decision" ? c.fields.rationale ?? null : null, cap.id, c.classification]);
        const eid = await ev("create", "work_item", wi.rows[0].id, { title, kind, due_at: due.due_at, project_id: w.projectId });
        await tx.query(`UPDATE work_item SET last_event_id = $2 WHERE id = $1`, [wi.rows[0].id, eid]);
        await tx.query(`UPDATE project SET last_activity_at = $2 WHERE id = $1`, [w.projectId, cap.receivedAt]);
        await insertCandidate(tx, cap.id, c, relation, "applied", wi.rows[0].id, [], "work_item");
        summary.applied.push(ref("work_item", wi.rows[0].id));
        if (w.unassigned)
            summary.unassigned.push(ref("work_item", wi.rows[0].id));
        return;
    }
    // Knowledge: facts and corrections (provenance, status, and as-of are mandatory).
    if (c.item_type === "fact" || c.item_type === "correction") {
        const supersedes = relation === "supersedes" && target?.table === "knowledge_item" ? target.id : null;
        const subjectType = w.unassigned ? "julian" : "project";
        const k = await tx.query(`INSERT INTO knowledge_item (subject_type, subject_id, claim, epistemic_status, source_visibility, as_of,
                                   supersedes_id, source_capture_id, source_quote, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [subjectType, subjectType === "project" ? w.projectId : null, c.fields.claim ?? c.source_quote, c.epistemic_status,
            c.source_visibility, cap.receivedAt, supersedes, cap.id, c.source_quote, c.classification]);
        if (supersedes) {
            await tx.query(`UPDATE knowledge_item SET status = 'superseded', version = version + 1 WHERE id = $1`, [supersedes]);
            await ev("supersede", "knowledge_item", supersedes, { superseded_by: k.rows[0].id });
        }
        const eid = await ev("create", "knowledge_item", k.rows[0].id, { claim: c.fields.claim ?? c.source_quote, epistemic_status: c.epistemic_status });
        await tx.query(`UPDATE knowledge_item SET last_event_id = $2 WHERE id = $1`, [k.rows[0].id, eid]);
        await insertCandidate(tx, cap.id, c, relation, "applied", k.rows[0].id, [], "knowledge_item");
        summary.applied.push(ref("knowledge_item", k.rows[0].id));
        return;
    }
    // Projects.
    if (c.item_type === "project") {
        const p = await tx.query(`INSERT INTO project (name, description, source_capture_id, classification, last_activity_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [c.fields.name ?? title, c.fields.detail ?? null, cap.id, c.classification, cap.receivedAt]);
        const eid = await ev("create", "project", p.rows[0].id, { name: c.fields.name ?? title });
        await tx.query(`UPDATE project SET last_event_id = $2 WHERE id = $1`, [p.rows[0].id, eid]);
        await insertCandidate(tx, cap.id, c, relation, "applied", p.rows[0].id, [], "project");
        summary.applied.push(ref("project", p.rows[0].id));
        return;
    }
    // Entities: ADR-022 minimal third-party policy.
    if (c.item_type === "entity") {
        const reasons = [];
        if (!c.fields.purpose)
            reasons.push("ADR022_missing_purpose");
        if (w.unassigned)
            reasons.push("ADR022_missing_project");
        if (reasons.length) {
            await insertCandidate(tx, cap.id, c, relation, "guard_rejected", null, reasons);
            summary.rejected.push({ tempId: c.temp_id, reasons });
            return;
        }
        const review = c.classification === "confidential"
            ? new Date(cap.receivedAt.getTime() + deps.cfg.RETENTION_CONFIDENTIAL_THIRD_PARTY_DAYS * 86_400_000) : null;
        const e = await tx.query(`INSERT INTO entity (kind, name, notes, purpose, source_visibility, retention_review_at, source_capture_id, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [c.fields.kind ?? "person", c.fields.name ?? title, c.fields.detail ?? null, c.fields.purpose, c.source_visibility, review, cap.id, c.classification]);
        await tx.query(`INSERT INTO relationship (from_type, from_id, to_type, to_id, kind, source_capture_id) VALUES ('entity',$1,'project',$2,'relates_to',$3)`, [e.rows[0].id, w.projectId, cap.id]);
        const eid = await ev("create", "entity", e.rows[0].id, { name: c.fields.name ?? title });
        await tx.query(`UPDATE entity SET last_event_id = $2 WHERE id = $1`, [e.rows[0].id, eid]);
        await insertCandidate(tx, cap.id, c, relation, "applied", e.rows[0].id, [], "entity");
        summary.applied.push(ref("entity", e.rows[0].id));
        return;
    }
    // External references (authority class 1): pointers only, unverified until integrations exist.
    if (c.item_type === "external_ref") {
        const x = await tx.query(`INSERT INTO external_ref (provider, title_hint, url_hint, as_of, source_capture_id, classification)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [c.fields.provider ?? "other", c.fields.title_hint ?? title, c.fields.url_hint ?? null, cap.receivedAt, cap.id, c.classification]);
        await tx.query(`INSERT INTO relationship (from_type, from_id, to_type, to_id, kind, source_capture_id) VALUES ('external_ref',$1,'project',$2,'relates_to',$3)`, [x.rows[0].id, w.projectId, cap.id]);
        await ev("create", "external_ref", x.rows[0].id, { title_hint: c.fields.title_hint ?? title });
        await insertCandidate(tx, cap.id, c, relation, "applied", x.rows[0].id, [], "external_ref");
        summary.applied.push(ref("external_ref", x.rows[0].id));
        return;
    }
    await insertCandidate(tx, cap.id, c, relation, "guard_rejected", null, ["unsupported_type_v0"]);
    summary.rejected.push({ tempId: c.temp_id, reasons: ["unsupported_type_v0"] });
}
export { tableFor };
//# sourceMappingURL=capture.js.map