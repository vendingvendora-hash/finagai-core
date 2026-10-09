import { CAREER_POLICY } from "../cos/lifecycle.js";
import { decodeEffect, validateEffect, EffectRejected } from "./guard.js";
const DAY = 86_400_000;
export const HALF_LIFE_DAYS = 30;
export const MIN_FRESHNESS = 0.25;
/** How current the evidence behind a lesson is: 1 = today, halves every 30 days. Stated lessons do not decay. */
export const freshness = (lastEvidenceAt, now) => Math.pow(0.5, Math.max(0, now.getTime() - new Date(lastEvidenceAt).getTime()) / DAY / HALF_LIFE_DAYS);
const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9_ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
/** Effects Julian approved: read from the GOVERNED rows (procedure / preference created by the approval), never from
 *  the lesson row — what applies is exactly the text he approved. A forgotten (retired) lesson stops applying. */
async function approvedEffects(db, type) {
    const rows = (await db.query(`SELECT DISTINCT ON (l.id) l.key, COALESCE(pr.statement, pc.body) AS text, COALESCE(pr.created_at, pc.created_at) AS at
      FROM lesson l JOIN proposal p ON p.target_type = 'lesson' AND p.target_id = l.id AND p.status = 'approved'
      LEFT JOIN preference pr ON pr.approved_proposal_id = p.id AND pr.archived_at IS NULL
      LEFT JOIN procedure pc ON pc.approved_proposal_id = p.id AND pc.archived_at IS NULL
     WHERE l.status <> 'retired' AND (pr.id IS NOT NULL OR pc.id IS NOT NULL)
     ORDER BY l.id, COALESCE(pr.created_at, pc.created_at) DESC`)).rows;
    const out = [];
    for (const r of rows) {
        const e = decodeEffect(String(r.text ?? ""));
        if (!e || e.type !== type)
            continue;
        try {
            out.push({ key: r.key, effect: validateEffect(e, "inferred"), approvedAt: new Date(r.at).toISOString() });
        }
        catch (err) {
            if (!(err instanceof EffectRejected))
                throw err;
        } // re-validated at use: an out-of-bounds row never applies
    }
    return out;
}
/** Advisory guidance for one Mac task. Empty when nothing learned is relevant. */
export async function guidanceFor(db, request, now = new Date()) {
    const req = words(request);
    const hints = (await db.query(`SELECT key, basis, statement, effect, support, positives, confidence, last_evidence_at FROM lesson
      WHERE status = 'active' AND effect->>'type' = 'planner_hint' ORDER BY confidence DESC, support DESC LIMIT 40`)).rows
        .filter((l) => l.basis === "stated" || freshness(l.last_evidence_at, now) >= MIN_FRESHNESS)
        .map((l) => { try {
        return { ...l, effect: validateEffect(l.effect, l.basis) };
    }
    catch {
        return null;
    } })
        .filter((l) => !!l)
        // Julian's stated hints apply when their words match the request (or they named none); observed hints are about
        // step kinds and apply to any task.
        .filter((l) => l.basis !== "stated" || !l.effect.match.length || l.effect.match.some((m) => req.has(m.toLowerCase())))
        .slice(0, 5);
    const procs = (await approvedEffects(db, "procedure"))
        .map((p) => ({ ...p, effect: p.effect }))
        .filter((p) => { const w = p.effect.when.map((x) => x.toLowerCase()); return w.length > 0 && w.filter((x) => req.has(x)).length >= Math.ceil(w.length / 2); })
        .slice(0, 2);
    if (!hints.length && !procs.length)
        return { block: "", keys: [] };
    const lines = [
        ...hints.map((h) => `- ${h.effect.text} [${h.basis === "stated" ? "Julian said so" : `observed, ${h.positives ?? h.support}/${h.support}, confidence ${Number(h.confidence).toFixed(2)}`}]`),
        ...procs.map((p) => `- Procedure Julian approved (${p.approvedAt.slice(0, 10)}) for "${p.effect.name}":\n${p.effect.steps.map((s, i) => `    ${i + 1}. ${s}`).join("\n")}`),
    ];
    return {
        block: `Learned guidance (advisory, from Finagai's own records and Julian's approvals — your authority, approval, verification and secrets rules are unchanged and always take precedence; ignore a line that does not fit this screen):\n${lines.join("\n")}`,
        keys: [...hints.map((h) => String(h.key)), ...procs.map((p) => p.key)],
    };
}
const emailOf = (from) => (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase().trim();
/** Julian's stated routing correction for this mail, if any (exact address first, then its domain). */
export async function routingOverride(db, payload) {
    const email = emailOf(String(payload.from ?? ""));
    if (!email.includes("@"))
        return null;
    const domain = email.split("@")[1];
    const rows = (await db.query(`SELECT key, effect FROM lesson WHERE status = 'active' AND basis = 'stated' AND effect->>'type' = 'routing_override' AND effect->>'sender' = ANY($1::text[])`, [[email, domain]])).rows;
    const pick = rows.find((r) => r.effect.sender === email) ?? rows.find((r) => r.effect.sender === domain);
    if (!pick)
        return null;
    try {
        const e = validateEffect(pick.effect, "stated");
        return { key: pick.key, sender: e.sender, action: e.action, ...(e.workflow ? { workflow: e.workflow } : {}) };
    }
    catch {
        return null;
    }
}
/** The lifecycle policy for an Area: code defaults, overridden only by parameters Julian approved for that Area. */
export async function policyFor(db, areaId) {
    const base = { ...CAREER_POLICY };
    if (!areaId)
        return base;
    const area = (await db.query(`SELECT name FROM area WHERE id = $1`, [areaId])).rows[0]?.name;
    if (!area)
        return base;
    const approved = (await approvedEffects(db, "policy_param")).map((a) => ({ ...a, effect: a.effect }))
        .filter((a) => a.effect.area.toLowerCase() === area.toLowerCase())
        .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt)); // the latest approval of a parameter wins
    for (const a of approved)
        base[a.effect.param] = a.effect.value;
    return base;
}
//# sourceMappingURL=apply.js.map