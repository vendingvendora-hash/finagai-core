import { resolveRecentArtifact } from "../concierge/interaction.js";
const SPREADSHEET_APPS = /excel|numbers|google sheets/i;
const BROWSERS = /chrome|safari|arc|firefox|edge|brave/i;
export async function saveContext(pool, ctx) {
    await pool.query(`UPDATE mac_runtime SET context = $1::jsonb, updated_at = now() WHERE id = 'primary'`, [JSON.stringify({ ...ctx, at: new Date().toISOString() })]);
}
export async function getContext(pool) {
    const r = await pool.query(`SELECT context, last_heartbeat_at FROM mac_runtime WHERE id = 'primary'`);
    const row = r.rows[0];
    if (!row)
        return { ctx: {}, ageSeconds: null };
    return { ctx: (row.context ?? {}), ageSeconds: Math.round((Date.now() - new Date(row.last_heartbeat_at).getTime()) / 1000) };
}
const norm = (s) => String(s ?? "").toLowerCase().replace(/^google\s+/, "").replace(/\s+browser$/, "").trim();
/** Same browser? Process names differ from app names ("firefox" vs "Firefox", "Google Chrome" vs "Chrome"). */
export function sameBrowser(a, b) {
    const x = norm(a), y = norm(b);
    return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
}
/**
 * Phase 0B: which page is "this page"? Only the FRONTMOST browser's page. A tab from a background browser is
 * never "this page" (live 2026-10-09: Firefox frontmost, Chrome tab returned with high confidence).
 */
export function frontPage(ctx) {
    const front = ctx.app ?? "";
    const tab = ctx.browser && (ctx.browser.url || ctx.browser.title) ? ctx.browser : null;
    const frontIsBrowser = BROWSERS.test(front);
    const tabIsFront = !!tab && (tab.frontmost === true || (tab.frontmost === undefined && sameBrowser(tab.app, front)));
    if (frontIsBrowser) {
        if (tab && tabIsFront && sameBrowser(tab.app, front)) {
            if (tab.url)
                return { page: { kind: "page", value: tab.url, source: `active ${tab.app} tab “${tab.title}”`, confidence: "high" }, uncertain: null, background: null };
            // Firefox: title only — a real, frontmost referent, but without a URL it is not high confidence.
            return { page: { kind: "page", value: tab.title, source: `frontmost ${tab.app} page “${tab.title}” (title only; ${tab.app} does not expose its URL)`, confidence: "medium" },
                uncertain: `${tab.app} is frontmost but only its page title is readable (no URL)`, background: null };
        }
        const title = ctx.window ? ctx.window.replace(/\s+[—–-]\s+Mozilla Firefox.*$/i, "").trim() : "";
        const background = tab ? { kind: "page", value: tab.url ?? tab.title, source: `background ${tab.app} tab “${tab.title}” (not frontmost)`, confidence: "low" } : null;
        return { page: title ? { kind: "page", value: title, source: `frontmost ${front} window “${title}” (page not introspectable)`, confidence: "low" } : null,
            uncertain: `${front} is frontmost and its page cannot be introspected${tab ? `; the ${tab.app} tab is in the background and is NOT this page` : ""}`, background };
    }
    if (tab)
        return { page: null, uncertain: null, background: { kind: "page", value: tab.url ?? tab.title, source: `${tab.app} tab “${tab.title}” (browser not frontmost; ${front || "another app"} is)`, confidence: "medium" } };
    return { page: null, uncertain: null, background: null };
}
/**
 * Resolve "this / that / this file / this page / the spreadsheet I have open / the last chart / what I'm looking at"
 * deterministically from the snapshot + recent artifacts. Ambiguous only when two equally-ranked candidates exist.
 */
export function resolveReference(phrase, ctx, recentArtifact) {
    const p = phrase.toLowerCase();
    const cands = [];
    const front = ctx.app ?? "";
    const isSheetFront = SPREADSHEET_APPS.test(front);
    const isBrowserFront = BROWSERS.test(front);
    const doc = ctx.documentPath || null;
    const sel = (ctx.selectedFiles ?? []).filter(Boolean);
    const fp = frontPage(ctx);
    // Explicit kinds first.
    if (/\b(last|that|the) chart\b|\bthat\b.*\bbigger\b|\bthe chart\b/.test(p) && recentArtifact?.kind === "chart")
        cands.push({ kind: "artifact", value: recentArtifact.storageRef, source: `recent chart artifact (${recentArtifact.summary ?? ""})`, confidence: "high" });
    if (/\bspreadsheet|workbook|excel|sheet\b/.test(p)) {
        if (isSheetFront && (doc || ctx.window))
            cands.push({ kind: "spreadsheet", value: doc ?? ctx.window, source: `frontmost ${front} document`, confidence: "high" });
        for (const f of sel)
            if (/\.(xlsx|xlsm|xls|numbers|csv)$/i.test(f))
                cands.push({ kind: "spreadsheet", value: f, source: "selected in Finder", confidence: isSheetFront ? "medium" : "high" });
    }
    if (/\bpage|tab|site|website|url\b/.test(p)) {
        if (fp.page)
            cands.push(fp.page);
        else if (fp.background)
            cands.push(fp.background);
    }
    if (/\bfile\b/.test(p)) {
        for (const f of sel)
            cands.push({ kind: "file", value: f, source: "selected in Finder", confidence: "high" });
        if (!sel.length && doc)
            cands.push({ kind: "file", value: doc, source: `frontmost ${front} document`, confidence: "high" });
    }
    // Bare "this / that / what I'm looking at": the focused thing wins — document, else tab, else selection, else artifact.
    if (!cands.length) {
        if (doc)
            cands.push({ kind: isSheetFront ? "spreadsheet" : "document", value: doc, source: `frontmost ${front} document`, confidence: "high" });
        else if (isBrowserFront && fp.page)
            cands.push(fp.page);
        else if (sel.length === 1)
            cands.push({ kind: "file", value: sel[0], source: "selected in Finder", confidence: "high" });
        else if (sel.length > 1)
            for (const f of sel)
                cands.push({ kind: "file", value: f, source: "selected in Finder", confidence: "medium" });
        else if (ctx.window)
            cands.push({ kind: "window", value: `${front}: ${ctx.window}`, source: "frontmost window", confidence: "medium" });
        if (/\bthat\b/.test(p) && recentArtifact)
            cands.push({ kind: "artifact", value: recentArtifact.storageRef, source: `recent ${recentArtifact.kind} artifact`, confidence: cands.length ? "medium" : "high" });
    }
    const high = cands.filter((c) => c.confidence === "high");
    const unc = fp.uncertain && cands.some((c) => c.kind === "page") ? { uncertain: true } : {};
    if (high.length === 1)
        return { resolved: high[0], candidates: cands, ambiguous: false, reason: `one high-confidence referent: ${high[0].source}` };
    if (high.length > 1)
        return { resolved: null, candidates: high, ambiguous: true, reason: "two equally likely referents; ask which" };
    // A low-confidence page (frontmost browser not introspectable) is a candidate, never a silent resolution.
    if (cands.length === 1 && cands[0].confidence === "low")
        return { resolved: null, candidates: cands, ambiguous: false, uncertain: true, reason: fp.uncertain ?? `uncertain: ${cands[0].source}` };
    if (cands.length === 1)
        return { resolved: cands[0], candidates: cands, ambiguous: false, ...unc, reason: fp.uncertain && cands[0].kind === "page" ? fp.uncertain : `single candidate: ${cands[0].source}` };
    if (cands.length > 1)
        return { resolved: null, candidates: cands, ambiguous: true, reason: "several candidates; ask which" };
    return { resolved: null, candidates: [], ambiguous: false, reason: "nothing in focus, no selection, no recent artifact" };
}
export async function resolveFromMac(pool, phrase) {
    const { ctx, ageSeconds } = await getContext(pool);
    const art = await resolveRecentArtifact(pool, { conversation: "self" }).catch(() => null);
    const res = resolveReference(phrase, ctx, art ? { kind: art.kind, storageRef: art.storageRef, summary: art.summary } : null);
    return { ...res, context: ctx, contextAgeSeconds: ageSeconds };
}
//# sourceMappingURL=context.js.map