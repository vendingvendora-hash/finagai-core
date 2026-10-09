import { appendEvent, withTransaction } from "../db/index.js";
import { ensureArea } from "./operating.js";
export const CAREER_SHEET = "Career Copilot - Job History";
/** RFC-4180 CSV (quotes, embedded commas/newlines). */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                }
                else
                    q = false;
            }
            else
                cell += ch;
            continue;
        }
        if (ch === '"')
            q = true;
        else if (ch === ",") {
            row.push(cell);
            cell = "";
        }
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n")
                i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        }
        else
            cell += ch;
    }
    if (cell || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c.trim()));
}
export const normOrg = (s) => s.toLowerCase().replace(/&/g, " and ").replace(/\b(inc|llc|ltd|corp|corporation|co|company|the|group)\b\.?/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
export const dedupeKey = (org, title, url) => {
    const u = url && /linkedin\.com\/jobs\/view\/(\d+)/.exec(url)?.[1];
    return u ? `linkedin:${u}` : `${normOrg(org)}|${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
};
const STATUS_MAP = { analyzed: "analyzed", shortlisted: "shortlisted", applied: "applied", interviewing: "interviewing", interview: "interviewing",
    offer: "offer", rejected: "rejected", declined: "withdrawn", withdrawn: "withdrawn", closed: "closed", preparing: "preparing", "ready for review": "ready_for_review" };
/** Map the Career Copilot sheet by HEADER NAME (column order may change). Test/diagnostic rows are dropped. */
export function extractSheet(csv) {
    const [header, ...data] = parseCsv(csv);
    if (!header)
        return { rows: [], dropped: 0, duplicates: 0 };
    const col = (re) => header.findIndex((h) => re.test(h.trim()));
    const c = { id: col(/^job id$/i), org: col(/^company$/i), title: col(/^title$/i), url: col(/posting url/i), loc: col(/^location$/i), mode: col(/work mode/i),
        salary: col(/salary/i), elig: col(/eligibility status/i), status: col(/application status/i), score: col(/match score/i), concerns: col(/fit concerns/i),
        resume: col(/latest resume/i), next: col(/^next action$/i), nextAt: col(/next action date/i), folder: col(/job folder/i), updated: col(/date last updated/i) };
    const get = (r, i) => (i >= 0 ? (r[i] ?? "").trim() : "") || null;
    const out = [];
    let dropped = 0;
    const seen = new Set();
    let duplicates = 0;
    for (const r of data) {
        const org = get(r, c.org), title = get(r, c.title);
        const isTest = !!org && !!title && /\b(test|diagnostics?|verify)\b/i.test(org) && /\b(test|qa|verification|readable)\b/i.test(title);
        if (!org || !title || isTest) {
            dropped++;
            continue;
        }
        const key = dedupeKey(org, title, get(r, c.url));
        if (seen.has(key)) {
            duplicates++;
            continue;
        }
        seen.add(key);
        const score = Number(get(r, c.score));
        out.push({ sourceId: get(r, c.id) ?? key, org, title, url: get(r, c.url), location: get(r, c.loc), workMode: get(r, c.mode), salary: get(r, c.salary),
            eligibility: get(r, c.elig), status: STATUS_MAP[(get(r, c.status) ?? "analyzed").toLowerCase()] ?? "analyzed",
            fitScore: Number.isFinite(score) && score > 0 ? Math.round(score) : null, fitNotes: get(r, c.concerns), resume: get(r, c.resume),
            nextAction: get(r, c.next), nextActionAt: get(r, c.nextAt), folder: get(r, c.folder), updatedAt: get(r, c.updated) });
    }
    return { rows: out, dropped, duplicates };
}
const ORG_AFTER = /\b([Pp]hone [Ss]creen|[Ii]nterview|[Aa]pplication)\b[^A-Za-z]{0,3}(?:with|for|at|to)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/;
function engagementFrom(subj, text, when, source) {
    const m = ORG_AFTER.exec(subj);
    if (!m)
        return null;
    const org = m[2].replace(/\s+(Pricing|Senior|Financial|Analyst|Role|Position|Julian)\b.*$/, "").trim();
    if (!org || /^(Julian|Your|The|A|An|Us|Me)$/i.test(org))
        return null;
    const kind = /screen/i.test(m[1]) ? "screen" : /interview/i.test(m[1]) ? "interview" : "application";
    const from = /From:\s*"?([^<"\n]+?)"?\s*</.exec(text)?.[1]?.trim() ?? null;
    return { org, kind, when, subject: subj.slice(0, 160), contact: from && !/julian|otter|no-?reply/i.test(from) ? from : null, source };
}
/** Interview / screen / application evidence from Gmail results (one per thread) and Calendar results (many events per excerpt). */
export function extractEngagement(items, source) {
    const out = [];
    for (const it of items) {
        if (source === "calendar") {
            for (const ev of it.text.split(/(?=\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)) {
                const [when, title] = ev.split("|").map((x) => x.trim());
                if (!when || !title || !/^\d{4}-\d{2}-\d{2}T/.test(when))
                    continue;
                const e = engagementFrom(title, ev, when, "calendar");
                if (e)
                    out.push(e);
            }
            continue;
        }
        const subj = it.name.replace(/^Gmail:\s*/, "").replace(/\s*\[[^\]]+\]$/, "").replace(/^(re|fwd?|canceled|cancelled|updated invitation):\s*/i, "");
        const dateTxt = /Date:\s*([^\n]+?\d{4}[^\n]*?[+-]\d{4})/.exec(it.text)?.[1];
        const when = it.modified ?? (dateTxt && !Number.isNaN(Date.parse(dateTxt)) ? new Date(Date.parse(dateTxt)).toISOString() : null);
        const e = engagementFrom(subj, it.text, when, "gmail");
        if (e)
            out.push(e);
    }
    return out;
}
const ELIGIBLE = (e) => !e || /no restriction/i.test(e);
export async function proposeCareerBootstrap(pool, google, now = new Date()) {
    // DISCOVER
    const sheet = google?.sheetCsv ? await google.sheetCsv(CAREER_SHEET).catch(() => null) : null;
    const gmail = google?.gmail ? await Promise.all([google.gmail(["interview"]), google.gmail(["phone screen"]), google.gmail(["application"])].map((p) => p.catch(() => []))) : [];
    const cal = google?.calendar ? await google.calendar(["interview"]).catch(() => []) : [];
    // EXTRACT
    const ex = sheet ? extractSheet(sheet.csv) : { rows: [], dropped: 0, duplicates: 0 };
    const engaged = [...extractEngagement(gmail.flat(), "gmail"), ...extractEngagement(cal, "calendar")];
    // LINK (by normalized org) + existing projects
    const byOrg = new Map();
    for (const e of engaged) {
        const k = normOrg(e.org);
        if (!k)
            continue;
        byOrg.set(k, [...(byOrg.get(k) ?? []), e]);
    }
    const projects = (await pool.query(`SELECT name FROM project WHERE archived_at IS NULL AND NOT is_unassigned_holding`)).rows.map((r) => String(r.name));
    const conflicts = [];
    const activeProjects = [];
    const day = 86_400_000;
    for (const [k, evs] of byOrg) {
        const latest = evs.map((e) => e.when).filter(Boolean).sort().pop() ?? null;
        const sheetRows = ex.rows.filter((r) => normOrg(r.org) === k);
        const existing = projects.find((p) => normOrg(p) === k) ?? null;
        if (sheetRows.length && sheetRows.every((r) => ["analyzed", "discovered"].includes(r.status)))
            conflicts.push(`${evs[0].org}: the Career Copilot sheet still says "${sheetRows[0].status}" but ${evs.length} interview/screen record(s) exist — pipeline status lags reality (proposed: interviewing)`);
        for (const r of sheetRows)
            if (["analyzed", "discovered"].includes(r.status))
                r.status = "interviewing";
        const stale = latest ? now.getTime() - Date.parse(latest) > 7 * day : false;
        const contact = evs.find((e) => e.contact)?.contact ?? null;
        activeProjects.push({ org: evs[0].org, evidence: Array.from(new Set(evs.map((e) => `${e.kind} (${e.source}${e.when ? ` ${e.when.slice(0, 10)}` : ""})`))).slice(0, 6),
            lastContact: latest, contact, existingProject: existing,
            proposedFollowup: stale ? `Waiting on ${contact ?? evs[0].org} — next step after ${latest.slice(0, 10)} (no contact for ${Math.floor((now.getTime() - Date.parse(latest)) / day)} days)` : null });
    }
    const byStatus = {};
    for (const r of ex.rows)
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const shortlist = ex.rows.filter((r) => r.status === "analyzed" && (r.fitScore ?? 0) >= 88 && ELIGIBLE(r.eligibility)).sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0)).slice(0, 10)
        .map((r) => ({ org: r.org, title: r.title, score: r.fitScore, eligibility: r.eligibility }));
    const ineligible = ex.rows.filter((r) => !ELIGIBLE(r.eligibility)).length;
    if (ineligible)
        conflicts.push(`${ineligible} analyzed posting(s) list citizenship/clearance requirements — kept in the pipeline but excluded from the shortlist`);
    const payload = {
        area: "Career", objective: { proposed: "Secure a strong Financial / Pricing Analyst role", needsConfirmation: true },
        source: { sheet: sheet?.name ?? null, account: sheet?.account ?? null, rows: ex.rows.length, dropped: ex.dropped, duplicates: ex.duplicates },
        pipeline: { total: ex.rows.length, byStatus, shortlist }, activeProjects, conflicts, opportunities: ex.rows,
    };
    const r = await pool.query(`INSERT INTO bootstrap_proposal (area, payload) VALUES ('Career', $1::jsonb) RETURNING code`, [JSON.stringify(payload)]);
    const { opportunities: _omit, ...summary } = payload;
    return { code: Number(r.rows[0].code), summary };
}
/** Apply an approved proposal: area, (confirmed) objective, pipeline records, engaged projects + follow-ups. Idempotent. */
export async function applyBootstrap(pool, code, opts = {}) {
    const p = (await pool.query(`SELECT id, status, payload FROM bootstrap_proposal WHERE code = $1`, [code])).rows[0];
    if (!p)
        return { error: `No bootstrap proposal ${code}.` };
    if (p.status !== "pending")
        return { error: `Bootstrap proposal ${code} is already ${p.status}.` };
    const pl = p.payload;
    const area = await ensureArea(pool, pl.area);
    return withTransaction(pool, async (tx) => {
        let objectiveId = null;
        const objName = opts.objective ?? pl.objective.proposed;
        const ob = await tx.query(`SELECT id FROM objective WHERE area_id = $1 AND lower(name) = lower($2)`, [area.id, objName]);
        objectiveId = ob.rows[0]?.id ?? (await tx.query(`INSERT INTO objective (area_id, name) VALUES ($1, $2) RETURNING id`, [area.id, objName])).rows[0].id;
        let upserted = 0;
        for (const o of pl.opportunities) {
            const r = await tx.query(`INSERT INTO opportunity (kind, area_id, org, title, url, location, work_mode, salary, eligibility, status, fit_score, fit_notes, resume_ref, next_action, next_action_at, source, dedupe_key, details)
         VALUES ('job', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
         ON CONFLICT (kind, dedupe_key) WHERE archived_at IS NULL DO UPDATE SET status = EXCLUDED.status, fit_score = COALESCE(EXCLUDED.fit_score, opportunity.fit_score), updated_at = now()
         RETURNING id`, [area.id, o.org, o.title, o.url, o.location, o.workMode, o.salary, o.eligibility, o.status, o.fitScore, o.fitNotes, o.resume, o.nextAction,
                o.nextActionAt && !Number.isNaN(Date.parse(o.nextActionAt)) ? o.nextActionAt : null, `career_copilot:${o.sourceId}`, dedupeKey(o.org, o.title, o.url), JSON.stringify({ folder: o.folder, sheetUpdatedAt: o.updatedAt })]);
            if (r.rowCount)
                upserted++;
        }
        const created = [];
        for (const a of pl.activeProjects) {
            let pid;
            const ex = await tx.query(`SELECT id FROM project WHERE archived_at IS NULL AND lower(name) = lower($1)`, [a.existingProject ?? a.org]);
            if (ex.rows[0])
                pid = ex.rows[0].id;
            else {
                pid = (await tx.query(`INSERT INTO project (name, description, last_activity_at) VALUES ($1, $2, now()) RETURNING id`, [a.org, `Job opportunity (${a.evidence.join(", ")})`])).rows[0].id;
                created.push(a.org);
            }
            await tx.query(`UPDATE project SET area_id = $2, objective_id = $3, updated_at = now() WHERE id = $1`, [pid, area.id, objectiveId]);
            await tx.query(`UPDATE opportunity SET project_id = $2, contact = COALESCE(contact, $3) WHERE area_id = $4 AND lower(org) = lower($1)`, [a.org, pid, a.contact, area.id]);
            if (a.proposedFollowup && !opts.skipFollowups) {
                const dup = await tx.query(`SELECT 1 FROM followup WHERE project_id = $1 AND state IN ('open','waiting','overdue')`, [pid]);
                if (!dup.rowCount)
                    await tx.query(`INSERT INTO followup (summary, counterparty, state, due_at, last_action_at, area_id, project_id) VALUES ($1, $2, 'waiting', now() + interval '3 days', $3, $4, $5)`, [a.proposedFollowup, a.contact ?? a.org, a.lastContact ?? new Date().toISOString(), area.id, pid]);
            }
        }
        await tx.query(`UPDATE bootstrap_proposal SET status = 'applied', applied_at = now() WHERE id = $1`, [p.id]);
        await appendEvent(tx, { actor: "julian", action: "bootstrap_applied", entityType: "area", entityId: area.id, after: { code, opportunities: upserted, projectsCreated: created } });
        return { area: area.name, objective: objName, opportunities: upserted, activeProjects: pl.activeProjects.map((a) => a.org), projectsCreated: created };
    });
}
//# sourceMappingURL=bootstrap.js.map