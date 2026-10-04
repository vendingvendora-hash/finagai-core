/**
 * Current-context awareness (WO3 / ADR-068). Deterministic context GATHERING on the Mac (helper), stored as an
 * ephemeral snapshot per heartbeat; deterministic reference RESOLUTION here. Model inference only breaks ties.
 */
import type pg from "pg";
import { resolveRecentArtifact } from "../concierge/interaction.js";

export type MacContext = {
  app?: string | null; window?: string | null; documentPath?: string | null;
  selectedFiles?: string[]; browser?: { app: string; url: string; title: string } | null; display?: string | null; at?: string;
};

const SPREADSHEET_APPS = /excel|numbers|google sheets/i;
const BROWSERS = /chrome|safari|arc|firefox|edge|brave/i;

export async function saveContext(pool: pg.Pool, ctx: MacContext): Promise<void> {
  await pool.query(`UPDATE mac_runtime SET context = $1::jsonb, updated_at = now() WHERE id = 'primary'`, [JSON.stringify({ ...ctx, at: new Date().toISOString() })]);
}

export async function getContext(pool: pg.Pool): Promise<{ ctx: MacContext; ageSeconds: number | null }> {
  const r = await pool.query(`SELECT context, last_heartbeat_at FROM mac_runtime WHERE id = 'primary'`);
  const row = r.rows[0];
  if (!row) return { ctx: {}, ageSeconds: null };
  return { ctx: (row.context ?? {}) as MacContext, ageSeconds: Math.round((Date.now() - new Date(row.last_heartbeat_at).getTime()) / 1000) };
}

export type Referent = { kind: "spreadsheet" | "document" | "page" | "file" | "artifact" | "window"; value: string; source: string; confidence: "high" | "medium" };
export type Resolution = { resolved: Referent | null; candidates: Referent[]; ambiguous: boolean; reason: string };

/**
 * Resolve "this / that / this file / this page / the spreadsheet I have open / the last chart / what I'm looking at"
 * deterministically from the snapshot + recent artifacts. Ambiguous only when two equally-ranked candidates exist.
 */
export function resolveReference(phrase: string, ctx: MacContext, recentArtifact: { kind: string; storageRef: string; summary: string | null } | null): Resolution {
  const p = phrase.toLowerCase();
  const cands: Referent[] = [];
  const front = ctx.app ?? "";
  const isSheetFront = SPREADSHEET_APPS.test(front);
  const isBrowserFront = BROWSERS.test(front);
  const doc = ctx.documentPath || null;
  const sel = (ctx.selectedFiles ?? []).filter(Boolean);
  const tab = ctx.browser && ctx.browser.url ? ctx.browser : null;

  // Explicit kinds first.
  if (/\b(last|that|the) chart\b|\bthat\b.*\bbigger\b|\bthe chart\b/.test(p) && recentArtifact?.kind === "chart")
    cands.push({ kind: "artifact", value: recentArtifact.storageRef, source: `recent chart artifact (${recentArtifact.summary ?? ""})`, confidence: "high" });
  if (/\bspreadsheet|workbook|excel|sheet\b/.test(p)) {
    if (isSheetFront && (doc || ctx.window)) cands.push({ kind: "spreadsheet", value: doc ?? ctx.window!, source: `frontmost ${front} document`, confidence: "high" });
    for (const f of sel) if (/\.(xlsx|xlsm|xls|numbers|csv)$/i.test(f)) cands.push({ kind: "spreadsheet", value: f, source: "selected in Finder", confidence: isSheetFront ? "medium" : "high" });
  }
  if (/\bpage|tab|site|website|url\b/.test(p) && tab) cands.push({ kind: "page", value: tab.url, source: `active ${tab.app} tab “${tab.title}”`, confidence: "high" });
  if (/\bfile\b/.test(p)) {
    for (const f of sel) cands.push({ kind: "file", value: f, source: "selected in Finder", confidence: "high" });
    if (!sel.length && doc) cands.push({ kind: "file", value: doc, source: `frontmost ${front} document`, confidence: "high" });
  }
  // Bare "this / that / what I'm looking at": the focused thing wins — document, else tab, else selection, else artifact.
  if (!cands.length) {
    if (doc) cands.push({ kind: isSheetFront ? "spreadsheet" : "document", value: doc, source: `frontmost ${front} document`, confidence: "high" });
    else if (isBrowserFront && tab) cands.push({ kind: "page", value: tab.url, source: `active ${tab.app} tab “${tab.title}”`, confidence: "high" });
    else if (sel.length === 1) cands.push({ kind: "file", value: sel[0]!, source: "selected in Finder", confidence: "high" });
    else if (sel.length > 1) for (const f of sel) cands.push({ kind: "file", value: f, source: "selected in Finder", confidence: "medium" });
    else if (ctx.window) cands.push({ kind: "window", value: `${front}: ${ctx.window}`, source: "frontmost window", confidence: "medium" });
    if (/\bthat\b/.test(p) && recentArtifact) cands.push({ kind: "artifact", value: recentArtifact.storageRef, source: `recent ${recentArtifact.kind} artifact`, confidence: cands.length ? "medium" : "high" });
  }
  const high = cands.filter((c) => c.confidence === "high");
  if (high.length === 1) return { resolved: high[0]!, candidates: cands, ambiguous: false, reason: `one high-confidence referent: ${high[0]!.source}` };
  if (high.length > 1) return { resolved: null, candidates: high, ambiguous: true, reason: "two equally likely referents; ask which" };
  if (cands.length === 1) return { resolved: cands[0]!, candidates: cands, ambiguous: false, reason: `single candidate: ${cands[0]!.source}` };
  if (cands.length > 1) return { resolved: null, candidates: cands, ambiguous: true, reason: "several candidates; ask which" };
  return { resolved: null, candidates: [], ambiguous: false, reason: "nothing in focus, no selection, no recent artifact" };
}

export async function resolveFromMac(pool: pg.Pool, phrase: string): Promise<Resolution & { context: MacContext; contextAgeSeconds: number | null }> {
  const { ctx, ageSeconds } = await getContext(pool);
  const art = await resolveRecentArtifact(pool, { conversation: "self" }).catch(() => null);
  const res = resolveReference(phrase, ctx, art ? { kind: art.kind, storageRef: art.storageRef, summary: art.summary } : null);
  return { ...res, context: ctx, contextAgeSeconds: ageSeconds };
}
