import { appendEvent } from "../db/index.js";
import { DETECTORS } from "./detectors.js";
import { REMEDIES } from "./remedies.js";
export const MAX_REMEDY_ATTEMPTS = 3;
const REMEDY_GAP_MS = 30 * 60_000;
export async function detectAll(db, now, deps) {
    const detected = [];
    const problems = [];
    for (const [name, d] of Object.entries(DETECTORS)) {
        try {
            detected.push(...await d(db, now, deps));
        }
        catch (e) {
            problems.push(`${name}: ${String(e?.message ?? e).slice(0, 160)}`);
        }
    }
    return { detected, problems };
}
export async function runExceptions(pool, now, dryRun, deps = {}) {
    const { detected, problems } = await detectAll(pool, now, deps);
    const res = { open: 0, opened: [], resolved: [], remedied: [], detectorProblems: problems, needs: [] };
    const want = new Map(detected.map((d) => [d.key, d]));
    const existing = new Map((await pool.query(`SELECT * FROM operating_exception WHERE key = ANY($1::text[]) OR status = 'open'`, [[...want.keys()]])).rows.map((r) => [r.key, r]));
    // resolve what cleared (a detector that FAILED this tick resolves nothing — absence of evidence is not "cleared")
    const failedDetectors = new Set(problems.map((p) => p.split(":")[0] ?? ""));
    for (const r of existing.values()) {
        if (r.status !== "open" || want.has(r.key))
            continue;
        if ([...failedDetectors].some((d) => detectorName(d) === r.detector))
            continue;
        res.resolved.push(r.summary);
        if (!dryRun) {
            await pool.query(`UPDATE operating_exception SET status = 'resolved', resolved_at = $2, resolution = 'condition cleared' WHERE id = $1`, [r.id, now]);
            await appendEvent(pool, { actor: "cos", action: "exception_resolved", entityType: "operating_exception", entityId: r.id, after: { key: r.key, summary: r.summary } });
        }
    }
    // open / update
    for (const d of detected) {
        const r = existing.get(d.key);
        if (!r || r.status === "resolved") {
            res.opened.push(`[${d.owner}] ${d.summary}`);
            if (!dryRun) {
                const row = (await pool.query(`INSERT INTO operating_exception (key, detector, area_id, owner, severity, needs, summary, detail, remediation, first_seen_at, last_seen_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
            ON CONFLICT (key) DO UPDATE SET status = 'open', resolved_at = NULL, resolution = NULL, first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at,
              detector = EXCLUDED.detector, area_id = EXCLUDED.area_id, owner = EXCLUDED.owner, severity = EXCLUDED.severity, needs = EXCLUDED.needs, summary = EXCLUDED.summary,
              detail = EXCLUDED.detail, remediation = EXCLUDED.remediation, remediation_attempts = 0, last_remediation_at = NULL, last_remediation_result = NULL, escalated_at = NULL,
              occurrences = operating_exception.occurrences + 1
            RETURNING *`, [d.key, d.detector, d.areaId ?? null, d.owner, d.severity, d.needs ?? null, d.summary.slice(0, 500), d.detail?.slice(0, 1000) ?? null, d.remediation ?? null, now])).rows[0];
                existing.set(d.key, row);
                await appendEvent(pool, { actor: "cos", action: "exception_opened", entityType: "operating_exception", entityId: row.id, after: { key: d.key, owner: d.owner, severity: d.severity, summary: d.summary } });
            }
            else
                existing.set(d.key, { key: d.key, first_seen_at: now, remediation_attempts: 0, last_remediation_at: null, status: "open" });
        }
        else if (!dryRun) {
            await pool.query(`UPDATE operating_exception SET last_seen_at = $2, summary = $3, detail = $4, severity = $5, owner = $6, needs = $7 WHERE id = $1`, [r.id, now, d.summary.slice(0, 500), d.detail?.slice(0, 1000) ?? null, d.severity, d.owner, d.needs ?? null]);
        }
    }
    // Finagai's own remedies first (bounded)
    for (const d of detected) {
        if (d.owner !== "finagai" || !d.remediation || dryRun)
            continue;
        const r = existing.get(d.key);
        if (r.remediation_attempts >= MAX_REMEDY_ATTEMPTS)
            continue;
        if (r.last_remediation_at && now.getTime() - new Date(r.last_remediation_at).getTime() < REMEDY_GAP_MS)
            continue;
        const remedy = REMEDIES[d.remediation];
        let result;
        try {
            result = remedy ? await remedy(pool, now, d) : `no remedy named ${d.remediation}`;
        }
        catch (e) {
            result = `failed: ${String(e?.message ?? e).slice(0, 200)}`;
        }
        await pool.query(`UPDATE operating_exception SET remediation_attempts = remediation_attempts + 1, last_remediation_at = $2, last_remediation_result = $3 WHERE key = $1`, [d.key, now, result.slice(0, 500)]);
        await appendEvent(pool, { actor: "cos", action: "exception_remedied", entityType: "operating_exception", entityId: r.id, after: { key: d.key, remedy: d.remediation, result } });
        res.remedied.push(`${d.remediation}: ${result}`);
    }
    // what reaches Julian
    for (const d of detected) {
        const r = existing.get(d.key);
        const openFor = (now.getTime() - new Date(r.first_seen_at).getTime()) / 60_000;
        if (d.owner === "julian" && d.needs)
            res.needs.push({ key: `exception:${d.key}:${r.occurrences ?? 1}`, needs: d.needs, summary: d.summary, ...(d.detail ? { detail: d.detail } : {}), areaId: d.areaId ?? null });
        else if (d.owner === "finagai" && d.escalateAfterMin !== undefined && openFor >= d.escalateAfterMin)
            res.needs.push({ key: `exception:${d.key}:${r.occurrences ?? 1}`, needs: "judgment", areaId: d.areaId ?? null,
                summary: `Finagai couldn't clear this itself in ${Math.round(openFor / 60)} h: ${d.summary.replace(/ — Finagai.*$/, "")} — tell it to keep trying, or have it fixed`,
                detail: `${d.detail ?? ""}${r.last_remediation_result ? ` · last remedy: ${r.last_remediation_result}` : ""}`.slice(0, 1000) });
    }
    res.open = dryRun ? [...want.keys()].length : Number((await pool.query(`SELECT count(*)::int AS n FROM operating_exception WHERE status = 'open'`)).rows[0].n);
    return res;
}
const detectorName = (fn) => ({ watcherFailing: "watcher_failing", workflowFailing: "workflow_failing", deadLetters: "dead_letter", budget: "budget", deliveryFailing: "delivery_failing",
    areaBreach: "area_breach", macOffline: "mac_offline", stuckTasks: "stuck_task", reviewBacklog: "review_backlog" }[fn] ?? fn);
/** Read-only: what is wrong right now, who owns it, what Finagai is doing about it. */
export async function exceptionsStatus(db, now = new Date()) {
    const open = (await db.query(`SELECT e.key, e.detector, e.owner, e.severity, e.needs, e.summary, e.detail, e.first_seen_at, e.last_seen_at, e.remediation, e.remediation_attempts,
      e.last_remediation_result, a.name AS area FROM operating_exception e LEFT JOIN area a ON a.id = e.area_id WHERE e.status = 'open'
      ORDER BY CASE e.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, e.first_seen_at`)).rows;
    const recent = (await db.query(`SELECT summary, resolved_at, resolution FROM operating_exception WHERE status = 'resolved' AND resolved_at > $1::timestamptz - interval '3 days' ORDER BY resolved_at DESC LIMIT 10`, [now])).rows;
    const yours = open.filter((e) => e.owner === "julian");
    return {
        headline: !open.length ? "All normal — nothing is wrong." : yours.length ? `${yours.length} thing(s) only you can clear; Finagai is handling ${open.length - yours.length} other exception(s).` : `Nothing needs you — Finagai is handling ${open.length} exception(s).`,
        needsYou: yours.map((e) => ({ area: e.area, summary: e.summary, needs: e.needs, since: e.first_seen_at, detail: e.detail })),
        finagaiHandling: open.filter((e) => e.owner === "finagai").map((e) => ({ area: e.area, severity: e.severity, summary: e.summary, since: e.first_seen_at,
            remedy: e.remediation ? `${e.remediation} (${e.remediation_attempts}/${MAX_REMEDY_ATTEMPTS} tries${e.last_remediation_result ? `; last: ${e.last_remediation_result}` : ""})` : "watching / retrying" })),
        recentlyCleared: recent.map((r) => `${r.summary} (cleared ${new Date(r.resolved_at).toISOString().slice(0, 16).replace("T", " ")} UTC)`),
    };
}
//# sourceMappingURL=index.js.map