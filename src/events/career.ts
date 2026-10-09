/**
 * Phase 5 (ADR-084) — the Career Area's plug-in to the event engine (the golden vertical; nothing here is generic).
 *   watches:  the Career Copilot sheet (edits)
 *   reacts:   job-related mail / interview calendar events / sheet edits → one evidence sync per tick
 * The deterministic ADR-080/081 classifier decides what counts as job evidence, so routing and interpretation agree.
 */
import type pg from "pg";
import { GMAIL_EXTRACTOR, type GmailRecord } from "../google/client.js";
import { CAREER_SHEET, normOrg } from "../cos/bootstrap.js";
import { classifyRecord, type EvidenceRecord } from "../cos/career-evidence.js";
import { syncCareer } from "../cos/career-sync.js";
import type { AreaModule, EngineCtx, StoredEvent } from "./types.js";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function careerApplied(db: Pick<pg.Pool, "query">): Promise<boolean> {
  return !!(await db.query(`SELECT 1 FROM bootstrap_proposal WHERE area = 'Career' AND status = 'applied' LIMIT 1`)).rowCount;
}

/** Is this mail job evidence? The same classifier the bootstrap and sync use, plus known contacts/employers of live jobs. */
export async function careerMailWhy(db: Pick<pg.Pool, "query">, e: StoredEvent): Promise<string | null> {
  const p = e.payload as { account?: string; id?: string; from?: string; subject?: string; snippet?: string; templates?: string[] };
  const cached = (await db.query(`SELECT record FROM gmail_message_content WHERE account = $1 AND message_id = $2 AND extractor_version = $3`, [p.account, p.id, GMAIL_EXTRACTOR])).rows[0]?.record as GmailRecord | undefined;
  const rec: EvidenceRecord = { id: String(p.id), source: "gmail", account: String(p.account), at: e.occurredAt, subject: String(p.subject ?? ""), from: String(p.from ?? ""),
    snippet: String(p.snippet ?? ""), body: cached?.body ?? "", templates: p.templates ?? cached?.templates ?? [], queries: [] };
  const known = new Set((await db.query(`SELECT key FROM employer`)).rows.map((r) => String(r.key)));
  const t = classifyRecord(rec, known);
  if (t.stage === "candidate") return `job evidence (${t.kind}${t.org ? ` — ${t.org}` : ""}; rule ${t.rule})`;
  // A person or employer tied to a live job writes about something the classifier cannot type (a reply, a question).
  const live = (await db.query(`SELECT o.contact, o.status, e.key, e.name FROM opportunity o LEFT JOIN employer e ON e.id = o.employer_id
      WHERE o.archived_at IS NULL AND o.status IN ('preparing','applied','interviewing','offer') AND o.last_evidence_at > now() - interval '60 days'`)).rows;
  const from = rec.from.toLowerCase(); const text = `${rec.subject} ${rec.snippet}`.toLowerCase();
  const hit = live.find((j) => (j.contact && from.includes(String(j.contact).toLowerCase().split(" ")[0]!) && from.includes(String(j.contact).toLowerCase().split(" ").pop()!))
    // Employer match only for jobs past the application stage (an "Amazon" order confirmation must not wake Career).
    || ((j.status === "interviewing" || j.status === "offer") && j.key && String(j.key).length >= 4 && (normOrg(from).includes(String(j.key)) || normOrg(text).includes(String(j.key)))));
  return hit ? `from/about a live job (${hit.contact ?? hit.name})` : null;
}

export const careerModule: AreaModule = {
  watchers: [{
    name: "sheet:career", everyMs: 30 * 60_000,
    async poll(ctx, cursors) {
      if (!ctx.google?.sheetCsv) return { events: [], cursors: [], problems: ["sheets not connected"] };
      const s = await ctx.google.sheetCsv(CAREER_SHEET);
      if (!s) return { events: [], cursors: [], problems: ["Career Copilot sheet not found"] };
      const prev = cursors.get("") ?? null;
      const digest = sha(s.csv);
      const events = prev && prev !== `${s.modified}|${digest}`
        ? [{ source: "sheet", kind: "sheet.changed", externalId: `career:${s.id}:${s.modified}:${digest}`, occurredAt: s.modified || ctx.now.toISOString(),
            summary: `Career Copilot sheet changed (${s.modified})`, payload: { sheetId: s.id, modified: s.modified, digest } }]
        : [];   // first sight only records the position (the bootstrap already read this content)
      return { events, cursors: [{ scope: "", cursor: `${s.modified}|${digest}` }], problems: [] };
    },
  }],
  subscriptions: [{
    id: "career.evidence", area: "Career", workflow: "career.sync",
    async match(e: StoredEvent, ctx: EngineCtx) {
      if (!(await careerApplied(ctx.pool))) return null;
      if (e.kind === "mail.received") return careerMailWhy(ctx.pool, e);
      if (e.kind === "calendar.upcoming") return /\b(interview|phone screen|screening|panel)\b/i.test(String(e.payload.title ?? "")) ? `interview on the calendar: ${e.payload.title}` : null;
      if (e.kind === "sheet.changed") return "the Career Copilot sheet changed";
      return null;
    },
  }],
  workflows: [{
    name: "career.sync",
    async run(ctx) {
      const r = await syncCareer(ctx.pool, ctx.google, { dryRun: ctx.dryRun, now: ctx.now });
      if ("error" in r) throw new Error(r.error);
      if (!r.ok) throw new Error(`incomplete acquisition: ${r.problems.join("; ")}`);   // nothing was written; retried next tick
      return {
        changes: [...r.changes.map((c) => `${c.change}: ${c.job} — ${c.detail} [${c.sources.join(", ")}]`), ...r.lifecycle.map((c) => `${c.change}: ${c.job} — ${c.detail}`)],
        // An identity collision or evidence against a closed job is a judgment call — the only sync outcome that reaches Julian.
        escalations: r.decisions.map((d) => ({ key: `career.sync:${sha(d)}`, needs: "judgment" as const, summary: `Career: ${d}` })),
      };
    },
  }],
};
