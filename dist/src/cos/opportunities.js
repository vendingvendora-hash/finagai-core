/**
 * Phase 4 (ADR-082) — the opportunity lifecycle as operational state Finagai owns.
 *
 *   find / pipeline            "Have I applied to Amazon's delivery-finance role?"  "Where am I with all applications?"
 *   track                      a specific posting Julian is considering or preparing (deduplicated against all 400+ jobs)
 *   record                     something that happened to ONE job (applied, interview, rejection, offer, withdrawal)
 *   reconcile (lifecycle)      every engaged job has exactly one next step with an owner and a date; closed jobs leave
 *                              nothing waiting; projects exist for engaged jobs only
 *
 * Identity is ADR-081's: employer → requisition id → normalized title (never one record per employer). Status moves
 * forward only (lifecycle.ts). Every write is in a transaction with its event; nothing is deleted.
 */
import { createHash } from "node:crypto";
import { appendEvent } from "../db/index.js";
import { normOrg, dedupeKey } from "./bootstrap.js";
import { cleanTitle, normTitle } from "./career-evidence.js";
import { CAREER_POLICY, STATUS_RANK, isStatus, isTerminal, jobName, nextStepFor, transitionAllowed } from "./lifecycle.js";
const DAY = 86_400_000;
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const clean = (s) => s.trim().replace(/\s+/g, " ");
/** Run fn in one transaction; dry runs compute everything and roll back (a preview is exactly what would be written). */
export async function inTx(pool, dryRun, fn) {
    const c = await pool.connect();
    try {
        await c.query("BEGIN");
        const r = await fn(c);
        await c.query(dryRun ? "ROLLBACK" : "COMMIT");
        return r;
    }
    catch (e) {
        await c.query("ROLLBACK").catch(() => { });
        throw e;
    }
    finally {
        c.release();
    }
}
const JOB_SELECT = `SELECT o.id, o.org, o.title, o.status, o.requisition_id, o.url, o.location, o.contact, o.applied_at, o.last_evidence_at, o.first_evidence_at, o.created_at,
  o.project_id, o.area_id, o.employer_id, e.name AS employer_name, o.dedupe_key, o.alias_keys, o.fit_score, o.source, o.details
  FROM opportunity o LEFT JOIN employer e ON e.id = o.employer_id`;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const employerOf = (j) => j.employer_name ?? j.org;
const realTitle = (t) => (/^\(role not named/.test(t) ? null : t);
async function lastInterviewAt(db, id) {
    const r = await db.query(`SELECT max(at) AS at FROM opportunity_event WHERE opportunity_id = $1 AND kind IN ('screen','interview')`, [id]);
    return iso(r.rows[0]?.at);
}
export async function factsOf(db, j) {
    return { employer: employerOf(j), title: realTitle(j.title), reqId: j.requisition_id, status: j.status, contact: j.contact,
        appliedAt: iso(j.applied_at), lastEvidenceAt: iso(j.last_evidence_at), lastInterviewAt: await lastInterviewAt(db, j.id), createdAt: iso(j.created_at) };
}
async function objectiveOf(db, areaId) {
    if (!areaId)
        return null;
    const r = await db.query(`SELECT id FROM objective WHERE area_id = $1 AND status = 'open' ORDER BY created_at`, [areaId]);
    return r.rows.length === 1 ? String(r.rows[0].id) : null;
}
export async function reconcileJob(db, jobId, now, policy = CAREER_POLICY) {
    const j = (await db.query(`${JOB_SELECT} WHERE o.id = $1`, [jobId])).rows[0];
    if (!j)
        return { step: { kind: "none", rule: "missing", reason: "job not found" }, changes: [] };
    const name = jobName({ employer: employerOf(j), title: realTitle(j.title), reqId: j.requisition_id });
    const step = nextStepFor(await factsOf(db, j), now, policy);
    const changes = [];
    const open = (await db.query(`SELECT id, summary, state, due_at, origin, rule FROM followup WHERE state IN ('open','waiting','overdue')
      AND (opportunity_id = $1 OR ($2::uuid IS NOT NULL AND project_id = $2 AND opportunity_id IS NULL)) ORDER BY created_at`, [j.id, j.project_id])).rows;
    // Julian's own "waiting on <person>" for this employer, tracked before the job had a project, belongs to this job when
    // it is the employer's only engaged job (never guessed across several live applications).
    if (j.area_id && !isTerminal(j.status) && STATUS_RANK[j.status] >= STATUS_RANK.preparing) {
        const live = await db.query(`SELECT count(*)::int AS n FROM opportunity WHERE archived_at IS NULL AND employer_id IS NOT DISTINCT FROM $1 AND status IN ('preparing','ready_for_review','applied','interviewing','offer')`, [j.employer_id]);
        if (Number(live.rows[0].n) === 1) {
            const pats = [`%${employerOf(j)}%`, ...(j.contact ? [`%${j.contact}%`] : [])];
            const orphans = (await db.query(`SELECT id, summary, state, due_at, origin, rule FROM followup WHERE state IN ('open','waiting','overdue') AND opportunity_id IS NULL AND project_id IS NULL
          AND area_id = $1 AND (summary ILIKE ANY($2::text[]) OR counterparty ILIKE ANY($2::text[])) ORDER BY created_at`, [j.area_id, pats])).rows;
            for (const f of orphans) {
                await db.query(`UPDATE followup SET opportunity_id = $2, project_id = COALESCE($3, project_id), updated_at = now() WHERE id = $1`, [f.id, j.id, j.project_id]);
                open.push(f);
                changes.push({ job: name, change: "follow-up linked", detail: `${f.summary} now belongs to this job` });
            }
        }
    }
    const mine = open.filter((f) => f.origin !== "julian"); // the engine (and the bootstrap's proposals) may be replaced
    const julians = open.filter((f) => f.origin === "julian"); // Julian's own commitments are never replaced by policy
    const closeF = async (f, state, outcome) => {
        await db.query(`UPDATE followup SET state = $2, outcome = $3, closed_at = now(), updated_at = now() WHERE id = $1`, [f.id, state, outcome.slice(0, 2000)]);
        await appendEvent(db, { actor: "cos", action: state === "done" ? "followup_done" : "followup_cancelled", entityType: "followup", entityId: f.id, after: { outcome: outcome.slice(0, 200), by: "lifecycle" } });
        changes.push({ job: name, change: state === "done" ? "follow-up closed" : "follow-up replaced", detail: `${f.summary} → ${outcome}`.slice(0, 300) });
    };
    if (step.kind === "close") {
        const terminal = isTerminal(j.status);
        for (const f of mine)
            await closeF(f, terminal ? "done" : "cancelled", step.outcome);
        if (terminal)
            for (const f of julians)
                await closeF(f, "done", `resolved by evidence: ${step.outcome}`);
        const stillOpen = terminal ? 0 : julians.length;
        if (j.project_id && !stillOpen) {
            const p = await db.query(`UPDATE project SET status = 'completed', updated_at = now(), version = version + 1 WHERE id = $1 AND status <> 'completed' RETURNING name`, [j.project_id]);
            if (p.rowCount) {
                await appendEvent(db, { actor: "cos", action: "project_completed", entityType: "project", entityId: j.project_id, after: { reason: step.reason, outcome: step.outcome } });
                changes.push({ job: name, change: "project completed", detail: `${p.rows[0].name}: ${step.reason}` });
            }
        }
        return { step, changes };
    }
    if (step.kind === "none")
        return { step, changes };
    // An action: the job needs a live project and exactly one next step.
    let projectId = j.project_id;
    if (projectId) {
        const p = await db.query(`UPDATE project SET status = 'active', last_activity_at = now(), updated_at = now(), version = version + 1 WHERE id = $1 AND status <> 'active' RETURNING name`, [projectId]);
        if (p.rowCount) {
            await appendEvent(db, { actor: "cos", action: "project_reopened", entityType: "project", entityId: projectId, after: { reason: step.reason } });
            changes.push({ job: name, change: "project reopened", detail: step.reason });
        }
    }
    else {
        const ex = await db.query(`SELECT id FROM project WHERE archived_at IS NULL AND lower(name) = lower($1) LIMIT 1`, [name]);
        projectId = ex.rows[0]?.id ?? null;
        if (!projectId) {
            projectId = String((await db.query(`INSERT INTO project (name, description, last_activity_at, area_id, objective_id) VALUES ($1, $2, now(), $3, $4) RETURNING id`, [name.slice(0, 200), `Job opportunity (${j.status}).`, j.area_id, await objectiveOf(db, j.area_id)])).rows[0].id);
            await appendEvent(db, { actor: "cos", action: "create", entityType: "project", entityId: projectId, after: { name, via: "lifecycle", status: j.status } });
            changes.push({ job: name, change: "project created", detail: `${j.status}: ${step.reason}` });
        }
        await db.query(`UPDATE opportunity SET project_id = $2, updated_at = now() WHERE id = $1`, [j.id, projectId]);
    }
    if (julians.length)
        return { step: { ...step, reason: `${step.reason} — you are already tracking: ${julians.map((f) => f.summary).join("; ")}` }, changes };
    const same = mine.find((f) => f.origin === "lifecycle" && f.rule === step.rule);
    for (const f of mine)
        if (f !== same)
            await closeF(f, "cancelled", `superseded: ${step.summary} (${step.reason})`);
    const dueAt = new Date(`${step.due}T16:00:00Z`);
    if (same) {
        if (!same.due_at || new Date(same.due_at).toISOString().slice(0, 10) !== step.due || same.summary !== step.summary) {
            await db.query(`UPDATE followup SET summary = $2, due_at = $3, state = $4, counterparty = $5, updated_at = now() WHERE id = $1`, [same.id, step.summary.slice(0, 2000), dueAt, step.state, step.counterparty]);
            changes.push({ job: name, change: "next step updated", detail: `${step.summary} (due ${step.due})` });
        }
    }
    else {
        const r = await db.query(`INSERT INTO followup (summary, counterparty, channel, state, due_at, last_action_at, area_id, project_id, opportunity_id, origin, rule)
      VALUES ($1, $2, NULL, $3, $4, COALESCE($5, now()), $6, $7, $8, 'lifecycle', $9) RETURNING id`, [step.summary.slice(0, 2000), step.counterparty, step.state, dueAt, j.last_evidence_at ?? j.applied_at, j.area_id, projectId, j.id, step.rule]);
        await appendEvent(db, { actor: "cos", action: "followup_created", entityType: "followup", entityId: r.rows[0].id, after: { summary: step.summary, due: step.due, rule: step.rule, by: "lifecycle" } });
        changes.push({ job: name, change: step.owner === "julian" ? "needs Julian" : "Finagai watching", detail: `${step.summary} (due ${step.due}; ${step.reason}${step.needsJulian ? `; needs you because ${step.needsJulian.because}` : ""})` });
    }
    return { step, changes };
}
/** Jobs the lifecycle is responsible for: engaged statuses, or anything holding a live project / open follow-up. */
export async function lifecycleTick(db, now, opts = {}) {
    const ids = (await db.query(`SELECT o.id FROM opportunity o LEFT JOIN project p ON p.id = o.project_id
     WHERE o.archived_at IS NULL AND ($1::uuid IS NULL OR o.area_id = $1)
       AND (o.status IN ('preparing','ready_for_review','applied','interviewing','offer') AND (o.project_id IS NOT NULL OR o.last_evidence_at > $2::timestamptz - interval '30 days' OR o.source IN ('julian','j6'))
            OR (p.id IS NOT NULL AND p.status = 'active')
            OR EXISTS (SELECT 1 FROM followup f WHERE f.opportunity_id = o.id AND f.state IN ('open','waiting','overdue')))
     ORDER BY o.id`, [opts.areaId ?? null, now])).rows.map((r) => String(r.id));
    const changes = [];
    for (const id of ids)
        changes.push(...(await reconcileJob(db, id, now, opts.policy)).changes);
    return { jobsChecked: ids.length, changes };
}
async function view(db, j, now, withHistory = true) {
    const facts = await factsOf(db, j);
    const step = nextStepFor(facts, now);
    const fu = (await db.query(`SELECT summary, due_at, origin FROM followup WHERE opportunity_id = $1 AND state IN ('open','waiting','overdue') ORDER BY due_at NULLS LAST LIMIT 1`, [j.id])).rows[0];
    const proj = j.project_id ? (await db.query(`SELECT name, status FROM project WHERE id = $1`, [j.project_id])).rows[0] : null;
    const hist = withHistory ? (await db.query(`SELECT at, kind, transition, summary, source FROM opportunity_event WHERE opportunity_id = $1 ORDER BY at, source_id LIMIT 30`, [j.id])).rows
        .map((e) => `${iso(e.at).slice(0, 10)} ${e.kind}${e.transition ? ` (${e.transition})` : ""}${e.summary ? `: ${String(e.summary).slice(0, 100)}` : ""}${e.source !== "gmail" ? ` [${e.source}]` : ""}`) : [];
    return { job: jobName(facts), employer: facts.employer, title: facts.title, reqId: j.requisition_id, location: j.location, status: j.status, appliedAt: iso(j.applied_at)?.slice(0, 10) ?? null,
        lastContact: iso(j.last_evidence_at)?.slice(0, 10) ?? null, contact: j.contact, fitScore: j.fit_score, url: j.url, project: proj ? `${proj.name}${proj.status !== "active" ? ` (${proj.status})` : ""}` : null,
        nextStep: fu ? `${fu.summary} (due ${iso(fu.due_at).slice(0, 10)}${fu.origin === "julian" ? ", yours" : ""})` : step.kind === "action" ? `${step.summary} (due ${step.due}) — not yet recorded` : step.kind === "close" ? `none (${step.reason})` : null,
        history: hist };
}
const words = (q) => q.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !["the", "at", "for", "job", "role", "position", "of", "my", "and", "a", "an", "to", "in"].includes(w));
/** Jobs matching a free-text reference and/or structured fields. Most engaged first. */
export async function findJobs(db, q, limit = 25) {
    const cond = [q.includeArchived ? "TRUE" : "o.archived_at IS NULL"];
    const args = [];
    const add = (sql, v) => { args.push(v); cond.push(sql.replace(/\$\?/g, `$${args.length}`)); };
    if (q.reqId)
        add(`lower(o.requisition_id) = lower($?)`, q.reqId.trim());
    if (q.url) {
        const li = /linkedin\.com\/jobs\/view\/(\d+)/.exec(q.url)?.[1];
        if (li)
            add(`($? = ANY(o.alias_keys) OR o.dedupe_key = $?)`, `linkedin:${li}`);
        else
            add(`o.url = $?`, q.url.trim());
    }
    if (q.employer) {
        const k = normOrg(q.employer);
        add(`(e.key = $? OR $? = ANY(e.aliases) OR e.key LIKE $? || ' %' OR lower(o.org) LIKE '%' || $? || '%')`, k);
    }
    if (q.title) {
        const ws = words(q.title);
        if (ws.length)
            add(`lower(o.title) LIKE ALL ($?::text[])`, ws.map((w) => `%${w}%`));
    }
    if (q.status)
        add(`o.status = $?`, q.status);
    if (q.query) {
        const ws = words(q.query);
        if (ws.length)
            add(`lower(coalesce(e.name, o.org) || ' ' || o.org || ' ' || o.title || ' ' || coalesce(o.requisition_id, '') || ' ' || coalesce(o.location, '')) LIKE ALL ($?::text[])`, ws.map((w) => `%${w}%`));
    }
    args.push(limit);
    const r = await db.query(`${JOB_SELECT} WHERE ${cond.join(" AND ")}
    ORDER BY CASE WHEN o.status IN ('offer','interviewing','preparing','ready_for_review','applied') THEN 0 WHEN o.status IN ('rejected','withdrawn','closed') THEN 1 ELSE 2 END,
             o.last_evidence_at DESC NULLS LAST, o.fit_score DESC NULLS LAST, o.id LIMIT $${args.length}`, args);
    return r.rows;
}
export async function findOpportunity(pool, q, now = new Date()) {
    const rows = await findJobs(pool, q, 25);
    if (!rows.length)
        return { found: 0, answer: "No job in Finagai's pipeline matches that.", jobs: [] };
    const jobs = [];
    for (const r of rows)
        jobs.push(await view(pool, r, now, rows.length <= 5));
    const engaged = jobs.filter((j) => STATUS_RANK[j.status] >= 2);
    const answer = rows.length === 1 ? `${jobs[0].job}: ${jobs[0].status}${jobs[0].appliedAt ? `, applied ${jobs[0].appliedAt}` : ""}.`
        : `${rows.length}${rows.length === 25 ? "+" : ""} separate jobs match (each is its own application)${engaged.length ? `; ${engaged.length} applied or further` : "; none applied"}.`;
    return { found: rows.length, answer, jobs };
}
export async function pipelineSummary(pool, areaName = "Career", now = new Date()) {
    const a = (await pool.query(`SELECT id, name FROM area WHERE archived_at IS NULL AND lower(name) = lower($1)`, [areaName])).rows[0];
    if (!a)
        return { error: `There is no "${areaName}" area yet.` };
    const by = Object.fromEntries((await pool.query(`SELECT status, count(*)::int AS n FROM opportunity WHERE archived_at IS NULL AND area_id = $1 GROUP BY status ORDER BY status`, [a.id])).rows.map((r) => [r.status, r.n]));
    const engagedRows = (await pool.query(`${JOB_SELECT} WHERE o.archived_at IS NULL AND o.area_id = $1 AND o.status IN ('offer','interviewing','preparing','ready_for_review')
    ORDER BY o.last_evidence_at DESC NULLS LAST, o.id`, [a.id])).rows;
    const appliedRows = (await pool.query(`${JOB_SELECT} WHERE o.archived_at IS NULL AND o.area_id = $1 AND o.status = 'applied' ORDER BY o.last_evidence_at DESC NULLS LAST, o.id`, [a.id])).rows;
    const live = (t) => !!t && now.getTime() - new Date(t).getTime() < CAREER_POLICY.responseDays * DAY;
    const fmt = async (r) => { const v = await view(pool, r, now, false); return `${v.job} — ${v.status}, last contact ${v.lastContact ?? "?"}${v.nextStep ? `; next: ${v.nextStep}` : ""}`; };
    const recent = (await pool.query(`SELECT ev.at, ev.kind, ev.transition, o.org, o.title, o.requisition_id, e.name AS emp FROM opportunity_event ev JOIN opportunity o ON o.id = ev.opportunity_id LEFT JOIN employer e ON e.id = o.employer_id
     WHERE o.area_id = $1 AND ev.at > $2::timestamptz - interval '7 days' ORDER BY ev.at DESC LIMIT 15`, [a.id, now])).rows
        .map((e) => `${iso(e.at).slice(0, 10)} ${e.kind}: ${jobName({ employer: e.emp ?? e.org, title: realTitle(e.title), reqId: e.requisition_id })}${e.transition ? ` (${e.transition})` : ""}`);
    const shortlist = (await pool.query(`SELECT org, title, fit_score, eligibility FROM opportunity WHERE archived_at IS NULL AND area_id = $1 AND status IN ('analyzed','shortlisted') AND fit_score >= 88
     AND (eligibility IS NULL OR eligibility ILIKE '%no restriction%') ORDER BY fit_score DESC, org, title LIMIT 8`, [a.id])).rows.map((r) => `${r.org} — ${r.title} (fit ${r.fit_score})`);
    const awaiting = appliedRows.filter((r) => live(r.last_evidence_at));
    const silent = appliedRows.filter((r) => !live(r.last_evidence_at));
    return {
        area: a.name, source: "Finagai job pipeline (one record per job/application; structured state, not an inbox search)",
        totals: { jobs: Object.values(by).reduce((s, n) => s + Number(n), 0), byStatus: by },
        headline: `${engagedRows.filter((r) => r.status === "offer").length} offer(s), ${engagedRows.filter((r) => r.status === "interviewing").length} interviewing, ${engagedRows.filter((r) => r.status !== "offer" && r.status !== "interviewing").length} being prepared, ${awaiting.length} applications awaiting a response (< ${CAREER_POLICY.responseDays} days), ${silent.length} older applications with no response.`,
        engaged: await Promise.all(engagedRows.map(fmt)),
        awaitingResponse: await Promise.all(awaiting.map(fmt)),
        noResponse: { count: silent.length, oldest: silent.length ? iso(silent[silent.length - 1].last_evidence_at ?? silent[silent.length - 1].applied_at)?.slice(0, 10) ?? null : null,
            note: "applications with no response for 14+ days stay in the pipeline as applied; any new email brings them back" },
        lastSevenDays: recent,
        shortlistNotApplied: shortlist,
    };
}
// ---------------------------------------------------------------------------------------------------------------
// Track a posting / record what happened (writes).
export const TEST_AREA = "Finagai Test";
/** Finagai's own never-submitting fixtures are test postings: they live in a separate area, never in Career. */
export const isFixtureUrl = (u) => !!u && /^https:\/\/finagai-core\.onrender\.com\/fixtures\//i.test(u.trim()) || !!u && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/fixtures\//i.test(u.trim());
async function areaFor(db, name, create) {
    const r = await db.query(`SELECT id, name FROM area WHERE archived_at IS NULL AND lower(name) = lower($1)`, [name]);
    if (r.rows[0])
        return { id: String(r.rows[0].id), name: String(r.rows[0].name) };
    if (!create)
        return null;
    const ins = await db.query(`INSERT INTO area (name, description) VALUES ($1, $2) RETURNING id, name`, [name, "Finagai's own acceptance tests (fixtures); never real applications"]);
    await appendEvent(db, { actor: "cos", action: "area_created", entityType: "area", entityId: ins.rows[0].id, after: { name } });
    return { id: String(ins.rows[0].id), name };
}
/** The employer row for a name: same normalized key, a stored alias, or a token-prefix match ("altarum" ⊂ "altarum institute"). */
async function employerFor(db, name) {
    const k = normOrg(name);
    if (!k)
        return null;
    const exact = await db.query(`SELECT id, key, name FROM employer WHERE key = $1 OR $1 = ANY(aliases) ORDER BY (key = $1) DESC LIMIT 1`, [k]);
    if (exact.rows[0])
        return exact.rows[0];
    const t = k.split(" ");
    const pref = (await db.query(`SELECT id, key, name FROM employer WHERE key LIKE $1 || ' %' OR $2 LIKE key || ' %'`, [k, k])).rows
        .filter((e) => String(e.key).split(" ")[0].length >= 3 && t[0].length >= 3);
    return pref.length === 1 ? pref[0] : null;
}
/** Identity candidates for a posting: exact key / alias, requisition, LinkedIn id, then same employer + same title. */
async function matchJob(db, emp, empKey, title, reqId, keys) {
    const byKey = (await db.query(`${JOB_SELECT} WHERE o.archived_at IS NULL AND o.kind = 'job' AND (o.dedupe_key = ANY($1::text[]) OR o.alias_keys && $1::text[])`, [keys])).rows;
    const nt = normTitle(title);
    const sameEmp = (await db.query(`${JOB_SELECT} WHERE o.archived_at IS NULL AND o.kind = 'job' AND (o.employer_id = $1 OR e.key = $2 OR lower(o.org) = lower($3))`, [emp?.id ?? null, empKey, empKey])).rows
        .filter((j) => j.employer_id === emp?.id || normOrg(j.org) === empKey || normOrg(j.employer_name ?? "") === empKey);
    if (reqId) {
        const req = sameEmp.filter((j) => (j.requisition_id ?? "").toLowerCase() === reqId.toLowerCase());
        if (req.length)
            return req;
        // The same posting without a requisition (e.g. its Career Copilot row) is this job; a job under ANOTHER requisition never is.
        const k = byKey.filter((j) => !j.requisition_id);
        return k.length ? k : sameEmp.filter((j) => !j.requisition_id && normTitle(j.title) === nt);
    }
    const titleHits = sameEmp.filter((j) => normTitle(j.title) === nt);
    const all = [...new Map([...byKey, ...titleHits].map((j) => [j.id, j])).values()];
    // No requisition given, and the title exists under several requisitions: only Julian can say which job he means.
    if (new Set(all.filter((j) => j.requisition_id).map((j) => j.requisition_id)).size > 1)
        return all;
    return byKey.length ? byKey : titleHits;
}
export async function trackOpportunity(db, input, now = new Date()) {
    const employerName = clean(input.employer);
    const rawTitle = clean(input.title);
    if (employerName.length < 2 || rawTitle.length < 2)
        return { error: "Both the employer and the job title are needed to track a specific job." };
    const title = cleanTitle(rawTitle, employerName) ?? rawTitle;
    const reqId = input.reqId ? clean(input.reqId).toUpperCase() : null;
    const url = input.url ? input.url.trim() : null;
    const fixture = isFixtureUrl(url);
    const area = await areaFor(db, fixture ? TEST_AREA : input.area ?? "Career", fixture);
    if (!area)
        return { error: `There is no "${input.area ?? "Career"}" area yet.` };
    const emp = await employerFor(db, employerName);
    const empKey = emp?.key ?? normOrg(employerName);
    const key = reqId ? `job:${empKey}|req:${reqId.toLowerCase()}` : `job:${empKey}|title:${normTitle(title)}`;
    const li = url ? /linkedin\.com\/jobs\/view\/(\d+)/.exec(url)?.[1] : undefined;
    const keys = [...new Set([key, dedupeKey(employerName, title, url), ...(li ? [`linkedin:${li}`] : []), ...(reqId ? [] : [`job:${empKey}|title:${normTitle(title)}`])])].sort();
    const hits = await matchJob(db, emp, empKey, title, reqId, keys);
    if (hits.length > 1)
        return { outcome: "ambiguous", candidates: hits.slice(0, 10).map((h) => `${jobName({ employer: employerOf(h), title: realTitle(h.title), reqId: h.requisition_id })} — ${h.status}`),
            question: `Several jobs match "${employerName} — ${title}". Which one (the requisition id tells them apart)?` };
    const wanted = input.status ?? "shortlisted";
    const at = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at) : now;
    let jobId;
    let previous = null;
    let outcome;
    if (hits[0]) {
        const h = hits[0];
        jobId = h.id;
        previous = h.status;
        outcome = "existing";
        await db.query(`UPDATE opportunity SET url = COALESCE(url, $2), location = COALESCE(location, $3), requisition_id = COALESCE(requisition_id, $4), fit_score = COALESCE($5, fit_score),
      contact = COALESCE(contact, $6), alias_keys = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(alias_keys || $7::text[]) x), updated_at = now() WHERE id = $1`, [jobId, url, input.location ?? null, reqId, input.fitScore ?? null, input.contact ?? null, keys.filter((k) => k !== h.dedupe_key)]);
    }
    else {
        outcome = "created";
        let employerId = emp?.id ?? null;
        if (!employerId)
            employerId = String((await db.query(`INSERT INTO employer (key, name, aliases) VALUES ($1, $2, ARRAY[$1]) ON CONFLICT (key) DO UPDATE SET updated_at = now() RETURNING id`, [empKey, employerName])).rows[0].id);
        jobId = String((await db.query(`INSERT INTO opportunity (kind, area_id, org, title, url, location, status, fit_score, fit_notes, contact, source, dedupe_key, alias_keys, employer_id, requisition_id, identity_basis, source_ids, details)
       VALUES ('job', $1, $2, $3, $4, $5, 'discovered', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb) RETURNING id`, [area.id, employerName, title, url, input.location ?? null, input.fitScore ?? null, input.notes ?? null, input.contact ?? null, input.source, key, keys, employerId, reqId, reqId ? "requisition" : "title",
            [`${input.source}:${input.sourceRef ?? sha(key)}`], JSON.stringify({ trackedVia: input.source, ...(fixture ? { fixture: true } : {}) })])).rows[0].id);
        await appendEvent(db, { actor: input.source === "j6" ? "j6" : "julian", action: "opportunity_tracked", entityType: "opportunity", entityId: jobId, after: { job: `${employerName} — ${title}`, reqId, url, area: area.name } });
    }
    const kind = wanted === "applied" ? "application" : wanted === "interviewing" ? "interview" : "tracked";
    const ev = await recordOnJob(db, jobId, { kind, at, source: input.source, sourceId: input.sourceRef ?? `${kind}:${wanted}:${at.toISOString().slice(0, 10)}`, summary: input.notes ?? `${wanted} (${input.source === "j6" ? "Finagai, from the posting" : "Julian"})`, status: wanted }, now);
    const after = (await db.query(`SELECT status, applied_at FROM opportunity WHERE id = $1`, [jobId])).rows[0];
    const alreadyApplied = previous !== null && STATUS_RANK[previous] >= STATUS_RANK.applied;
    const fresh = (await db.query(`${JOB_SELECT} WHERE o.id = $1`, [jobId])).rows[0];
    const v = await view(db, fresh, now, false);
    return { outcome, jobId, job: v.job, status: String(after.status), previousStatus: previous, alreadyApplied, appliedAt: iso(after.applied_at)?.slice(0, 10) ?? null, area: area.name, changes: ev.changes, nextStep: v.nextStep };
}
const KIND_STATUS = { tracked: null, application: "applied", screen: "interviewing", interview: "interviewing", rejection: "rejected", offer: "offer", withdrawal: "withdrawn", posting_closed: "closed", note: null };
/** Append one event to one job, move its status forward if the event implies it, then reconcile its next step. */
export async function recordOnJob(db, jobId, e, now) {
    const j = (await db.query(`SELECT status, applied_at FROM opportunity WHERE id = $1 FOR UPDATE`, [jobId])).rows[0];
    const target = e.status && e.kind === "tracked" ? e.status : KIND_STATUS[e.kind];
    const t = target ? transitionAllowed(String(j.status), target) : { ok: false };
    const transition = t.ok ? `${j.status}→${target}` : null;
    const ins = await db.query(`INSERT INTO opportunity_event (opportunity_id, at, kind, source, source_id, summary, transition) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`, [jobId, e.at, e.kind, e.source, e.sourceId.slice(0, 200), e.summary.slice(0, 300), transition ?? (t.anomaly ? `anomaly: ${t.anomaly}` : null)]);
    const inserted = !!ins.rowCount;
    if (inserted) {
        const contactEvent = e.kind !== "tracked" && e.kind !== "note";
        await db.query(`UPDATE opportunity SET status = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE status END,
        applied_at = CASE WHEN $3 AND applied_at IS NULL THEN $4 ELSE applied_at END,
        last_evidence_at = CASE WHEN $5 THEN GREATEST(coalesce(last_evidence_at, $4), $4) ELSE last_evidence_at END,
        first_evidence_at = CASE WHEN $5 THEN LEAST(coalesce(first_evidence_at, $4), $4) ELSE first_evidence_at END,
        contact = COALESCE($6, contact), updated_at = now() WHERE id = $1`, [jobId, transition ? target : null, target === "applied" || e.kind === "application", e.at, contactEvent, e.contact ?? null]);
        if (transition)
            await appendEvent(db, { actor: e.source === "julian" ? "julian" : e.source === "j6" ? "j6" : "cos", action: "opportunity_status", entityType: "opportunity", entityId: jobId, before: { status: j.status }, after: { status: target, via: e.kind, source: e.source } });
    }
    const rec = await reconcileJob(db, jobId, now);
    return { inserted, transition, anomaly: t.anomaly ?? null, changes: rec.changes, step: rec.step };
}
export async function recordOpportunityUpdate(db, input, now = new Date()) {
    const rows = await findJobs(db, { query: input.job ?? null, employer: input.employer ?? null, title: input.title ?? null, reqId: input.reqId ?? null }, 12);
    if (!rows.length)
        return { error: `No job matches${input.job ? ` "${input.job}"` : ""}. Track it first (employer + title).` };
    if (rows.length > 1) {
        return { outcome: "ambiguous", question: "Which job? Each application is its own record (give the title or requisition id).",
            candidates: rows.map((h) => `${jobName({ employer: employerOf(h), title: realTitle(h.title), reqId: h.requisition_id })} — ${h.status}`) };
    }
    const j = rows[0];
    const at = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at) : now;
    const source = input.source ?? "julian";
    const r = await recordOnJob(db, j.id, { kind: input.kind, at, source, sourceId: input.sourceRef ?? `${input.kind}:${at.toISOString().slice(0, 10)}:${sha(`${input.note ?? ""}|${input.contact ?? ""}`)}`,
        summary: input.note ?? `${input.kind} (told by Julian)`, contact: input.contact ?? null }, now);
    const after = (await db.query(`${JOB_SELECT} WHERE o.id = $1`, [j.id])).rows[0];
    const v = await view(db, after, now, false);
    return { job: v.job, recorded: r.inserted ? input.kind : `${input.kind} (already recorded)`, status: after.status, transition: r.transition, anomaly: r.anomaly, nextStep: v.nextStep, changes: r.changes };
}
export async function archiveTestJob(db, jobId) {
    const j = (await db.query(`SELECT o.id, a.name AS area FROM opportunity o LEFT JOIN area a ON a.id = o.area_id WHERE o.id = $1`, [jobId])).rows[0];
    if (!j || j.area !== TEST_AREA)
        return { error: "Only Finagai's own test (fixture) jobs can be removed." };
    await db.query(`UPDATE followup SET state = 'cancelled', outcome = 'test job removed', closed_at = now(), updated_at = now() WHERE opportunity_id = $1 AND state IN ('open','waiting','overdue')`, [jobId]);
    await db.query(`UPDATE project SET status = 'completed', archived_at = now(), updated_at = now() WHERE id = (SELECT project_id FROM opportunity WHERE id = $1)`, [jobId]);
    await db.query(`UPDATE opportunity SET archived_at = now(), updated_at = now() WHERE id = $1`, [jobId]);
    await appendEvent(db, { actor: "cos", action: "opportunity_archived", entityType: "opportunity", entityId: jobId, after: { reason: "test fixture job" } });
    return { archived: jobId };
}
export { isStatus };
//# sourceMappingURL=opportunities.js.map