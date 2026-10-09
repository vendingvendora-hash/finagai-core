import { appendEvent } from "../db/index.js";
import { EffectRejected, encodeEffect, validateEffect } from "./guard.js";
import { MIN_FRESHNESS, freshness } from "./apply.js";
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Whether a new inferred effect differs enough from the one already proposed/approved to ask Julian again. */
function materialChange(prev, next) {
    if (!prev || !next)
        return !!next && !prev;
    if (prev.type !== next.type)
        return true;
    if (prev.type === "policy_param" && next.type === "policy_param")
        return prev.param !== next.param || (typeof next.value === "number" && typeof prev.value === "number" ? Math.abs(next.value - prev.value) >= 5 : next.value !== prev.value);
    if (prev.type === "procedure")
        return false; // its key is its step signature: same key = same procedure
    return !same(prev, next);
}
const PROPOSAL_KIND = (e) => (e.type === "procedure" ? "procedure_change" : "preference_change");
const rationaleOf = (c) => `Learned by Finagai (basis: ${c.basis}${c.basis === "inferred" ? " — a generalization from records, applied only if you approve" : ""}). `
    + `Support ${c.support}${c.positives != null ? ` (${c.positives} positive)` : ""}, confidence ${c.confidence.toFixed(2)}, last evidence ${c.lastEvidenceAt.slice(0, 10)}. Evidence: ${JSON.stringify(c.evidence).slice(0, 600)}`;
async function propose(db, lessonId, c, effect) {
    const r = await db.query(`INSERT INTO proposal (kind, target_type, target_id, proposed_text, rationale, classification) VALUES ($1, 'lesson', $2, $3, $4, 'internal') RETURNING id`, [PROPOSAL_KIND(effect), lessonId, `${c.statement}\n\n${encodeEffect(effect)}`, rationaleOf(c)]);
    const id = String(r.rows[0].id);
    await appendEvent(db, { actor: "cos", action: "lesson_proposed", entityType: "lesson", entityId: lessonId, after: { key: c.key, proposal: id, statement: c.statement, effect } });
    return id;
}
/** Apply one learning pass's candidates. `now` drives freshness; the caller owns the transaction. */
export async function storeLessons(db, candidates, now) {
    const res = { learned: [], updated: 0, proposed: [], retired: [], decided: [], effectRejected: [], unchanged: 0 };
    // 0) proposals Julian decided since the last pass → lesson status follows (approved / rejected)
    for (const l of (await db.query(`SELECT l.id, l.key, l.statement, p.status AS pstatus,
        EXISTS (SELECT 1 FROM proposal q WHERE q.target_type = 'lesson' AND q.target_id = l.id AND q.status = 'approved') AS ever_approved
      FROM lesson l JOIN proposal p ON p.id = l.proposal_id WHERE l.status = 'proposed' AND p.status <> 'pending'`)).rows) {
        const status = l.pstatus === "approved" || l.ever_approved ? "approved" : l.pstatus === "rejected" ? "rejected" : "active";
        await db.query(`UPDATE lesson SET status = $2, updated_at = $3 WHERE id = $1`, [l.id, status, now]);
        await appendEvent(db, { actor: "cos", action: `lesson_${status}`, entityType: "lesson", entityId: l.id, after: { key: l.key, proposal: l.pstatus } });
        res.decided.push(`${status}: ${l.statement}`);
    }
    const produced = new Set();
    for (const c0 of candidates) {
        if (produced.has(c0.key))
            continue;
        produced.add(c0.key);
        // Every effect passes the whitelist; a rejected effect leaves an informational lesson (the fact is still true).
        let effect = null;
        let rejectedWhy = null;
        if (c0.effect) {
            try {
                effect = validateEffect(c0.effect, c0.basis);
            }
            catch (e) {
                if (!(e instanceof EffectRejected))
                    throw e;
                rejectedWhy = e.message;
                res.effectRejected.push(`${c0.key}: ${e.message}`);
            }
        }
        const c = { ...c0, effect, evidence: rejectedWhy ? { ...c0.evidence, effectRejected: rejectedWhy } : c0.evidence };
        const fresh = freshness(c.lastEvidenceAt, now);
        const prev = (await db.query(`SELECT id, status, effect, proposal_id, retired_reason, support, confidence FROM lesson WHERE key = $1`, [c.key])).rows[0];
        if (!prev) {
            if (fresh < MIN_FRESHNESS)
                continue; // never start from stale evidence
            const status = c.basis === "inferred" && effect ? "proposed" : "active";
            const ins = await db.query(`INSERT INTO lesson (key, kind, basis, area_id, scope, statement, effect, support, positives, confidence, evidence, first_seen_at, last_evidence_at, status, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14,$12,$12) RETURNING id`, [c.key, c.kind, c.basis, c.areaId ?? null, c.scope, c.statement, effect ? JSON.stringify(effect) : null, c.support, c.positives ?? null, c.confidence.toFixed(3), JSON.stringify(c.evidence), now, c.lastEvidenceAt, status]);
            const id = String(ins.rows[0].id);
            if (status === "proposed") {
                const pid = await propose(db, id, c, effect);
                await db.query(`UPDATE lesson SET proposal_id = $2 WHERE id = $1`, [id, pid]);
                res.proposed.push(c.statement);
            }
            else
                await appendEvent(db, { actor: "cos", action: "lesson_learned", entityType: "lesson", entityId: id, after: { key: c.key, basis: c.basis, statement: c.statement, confidence: Number(c.confidence.toFixed(3)), effect } });
            res.learned.push(`[${c.basis}] ${c.statement}`);
            continue;
        }
        const id = String(prev.id);
        // Julian's decisions stand: forgotten stays forgotten, rejected stays rejected (numbers keep updating for the record).
        const forgotten = prev.status === "retired" && /^forgotten/.test(String(prev.retired_reason ?? ""));
        let status = prev.status;
        let proposalId = prev.proposal_id;
        if (!forgotten && c.basis === "inferred" && effect && (prev.status === "proposed" || prev.status === "approved" || prev.status === "retired" || prev.status === "active")
            && (prev.status === "retired" || prev.status === "active" || materialChange(prev.effect, effect))) {
            if (fresh >= MIN_FRESHNESS) {
                if (prev.status === "proposed" && proposalId)
                    await db.query(`UPDATE proposal SET status = 'superseded', updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'pending'`, [proposalId]);
                proposalId = await propose(db, id, c, effect);
                status = "proposed";
                res.proposed.push(c.statement);
            }
        }
        else if (!forgotten && c.basis === "observed" && prev.status === "retired" && fresh >= MIN_FRESHNESS) {
            status = "active";
            res.learned.push(`[observed, again] ${c.statement}`);
        }
        // A pending/approved/rejected inferred lesson keeps the effect it was decided on unless a new proposal replaced it.
        const keepEffect = c.basis === "inferred" && status !== "proposed" ? prev.effect : effect;
        if (status === prev.status && proposalId === prev.proposal_id && Number(prev.support) === c.support && Number(prev.confidence).toFixed(3) === c.confidence.toFixed(3) && same(prev.effect, keepEffect)) {
            res.unchanged++;
            continue;
        }
        await db.query(`UPDATE lesson SET statement = $2, effect = $3::jsonb, support = $4, positives = $5, confidence = $6, evidence = $7::jsonb, last_evidence_at = $8, status = $9, proposal_id = $10,
        retired_reason = CASE WHEN $9 = 'retired' THEN retired_reason ELSE NULL END, updated_at = $11 WHERE id = $1`, [id, c.statement, keepEffect ? JSON.stringify(keepEffect) : null, c.support, c.positives ?? null, c.confidence.toFixed(3), JSON.stringify(c.evidence), c.lastEvidenceAt, status, proposalId, now]);
        res.updated++;
    }
    // Observed lessons the records no longer support, or whose evidence went stale, retire (history is kept). A pending
    // inferred proposal that is no longer supported is withdrawn. Stated and approved lessons are never auto-retired.
    for (const l of (await db.query(`SELECT id, key, basis, status, statement, proposal_id, last_evidence_at FROM lesson WHERE basis <> 'stated' AND status IN ('active','proposed')`)).rows) {
        const stale = freshness(l.last_evidence_at, now) < MIN_FRESHNESS;
        if (produced.has(l.key) && !stale)
            continue;
        const reason = stale ? `stale: last evidence ${new Date(l.last_evidence_at).toISOString().slice(0, 10)}` : "no longer supported by the records";
        if (l.status === "proposed" && l.proposal_id)
            await db.query(`UPDATE proposal SET status = 'superseded', updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'pending'`, [l.proposal_id]);
        await db.query(`UPDATE lesson SET status = 'retired', retired_reason = $2, updated_at = $3 WHERE id = $1`, [l.id, reason, now]);
        await appendEvent(db, { actor: "cos", action: "lesson_retired", entityType: "lesson", entityId: l.id, after: { key: l.key, reason } });
        res.retired.push(`${l.statement} (${reason})`);
    }
    return res;
}
//# sourceMappingURL=store.js.map