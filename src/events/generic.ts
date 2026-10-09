/**
 * Phase 5 (ADR-084) — the Area-independent part of proactivity: what is watched for every Area (mail, calendar,
 * deadlines of tracked follow-ups) and the generic reactions (a reply from someone Julian is waiting on; a follow-up
 * reaching or passing its date; lifecycle next steps whose time has come).
 */
import type pg from "pg";
import type { GmailRecord } from "../google/client.js";
import { GMAIL_EXTRACTOR } from "../google/client.js";
import { appendEvent } from "../db/index.js";
import { sweepOverdue } from "../cos/followups.js";
import { inTx, lifecycleTick } from "../cos/opportunities.js";
import type { AreaModule, EngineCtx, RawEvent, StoredEvent, Watcher } from "./types.js";

const DAY = 86_400_000;
export const GMAIL_FIRST_LOOKBACK_MS = DAY;          // first run: the last 24 h (older mail is already in state)

/** Every new message in every connected account (content reused from / stored in the immutable cache). */
export const gmailWatcher: Watcher = {
  name: "gmail", everyMs: 5 * 60_000,
  async poll(ctx, cursors) {
    const g = ctx.google;
    if (!g?.gmailEnumerate) return { events: [], cursors: [], problems: ["gmail not connected"] };
    const known0 = [...cursors.values()].map(Number).filter((n) => Number.isFinite(n) && n > 0);
    // Oldest per-account position (an account with no cursor yet starts 24 h back); never more than 7 days back.
    const since = Math.max(known0.length ? Math.min(...known0) : ctx.now.getTime() - GMAIL_FIRST_LOOKBACK_MS, ctx.now.getTime() - 7 * DAY);
    const q = `after:${Math.floor(since / 1000) - 300}`;      // 5-min overlap; duplicates are absorbed by (source, external_id)
    const known = new Map<string, Map<string, GmailRecord>>();
    for (const r of (await ctx.pool.query(`SELECT account, message_id, record FROM gmail_message_content WHERE extractor_version = $1 AND (record->>'internalDate')::bigint > $2`, [GMAIL_EXTRACTOR, since - 600_000])).rows)
      (known.get(r.account) ?? known.set(r.account, new Map()).get(r.account)!).set(r.message_id, r.record as GmailRecord);
    const fresh: Array<[string, GmailRecord]> = [];
    const res = await g.gmailEnumerate(q, { maxMessages: 200, known, onFetched: (a, r) => fresh.push([a, r]) });
    if (!ctx.dryRun) for (const [account, rec] of fresh)
      await ctx.pool.query(`INSERT INTO gmail_message_content (account, message_id, extractor_version, record) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`, [account, rec.id, GMAIL_EXTRACTOR, JSON.stringify(rec)]);
    const events: RawEvent[] = []; const out: Array<{ scope: string; cursor: string }> = []; const problems: string[] = [];
    for (const a of res) {
      if (!a.ok) { problems.push(`gmail ${a.account}: ${a.error}`); continue; }
      let max = Number(cursors.get(a.account) ?? 0);
      for (const r of a.records) {
        max = Math.max(max, r.internalDate);
        events.push({ source: "gmail", kind: "mail.received", externalId: `${a.account}:${r.id}`, occurredAt: new Date(r.internalDate).toISOString(),
          summary: `${r.from.replace(/<[^>]+>/, "").trim().slice(0, 60)} — ${r.subject.slice(0, 140)}`,
          payload: { account: a.account, id: r.id, threadId: r.threadId, from: r.from, subject: r.subject, snippet: r.snippet.slice(0, 300), templates: r.templates ?? [] } });
      }
      if (a.truncated) problems.push(`gmail ${a.account}: more than 200 new messages — the rest arrive next tick`);
      else out.push({ scope: a.account, cursor: String(Math.max(max, since)) });
    }
    return { events, cursors: out, problems };
  },
};

/** Calendar events in the next 14 days: a new or rescheduled event is an event (id + start). */
export const calendarWatcher: Watcher = {
  name: "calendar", everyMs: 15 * 60_000,
  async poll(ctx) {
    const g = ctx.google;
    if (!g?.calendarEnumerate) return { events: [], cursors: [], problems: ["calendar not connected"] };
    const res = await g.calendarEnumerate("", ctx.now.toISOString(), new Date(ctx.now.getTime() + 14 * DAY).toISOString());
    const events: RawEvent[] = []; const problems: string[] = [];
    for (const a of res) {
      if (!a.ok) { problems.push(`calendar ${a.account}: ${a.error}`); continue; }
      for (const e of a.records) events.push({ source: "calendar", kind: "calendar.upcoming", externalId: `${a.account}:${e.id}:${e.start}`, occurredAt: e.start || ctx.now.toISOString(),
        summary: `${e.start.slice(0, 16).replace("T", " ")} — ${e.summary.slice(0, 140)}`, payload: { account: a.account, id: e.id, start: e.start, title: e.summary } });
    }
    return { events, cursors: [{ scope: "", cursor: ctx.now.toISOString() }], problems };
  },
};

/** Tracked follow-ups (any Area) reaching their date within 24 h, or passing it. One event per follow-up per due date. */
export const deadlineWatcher: Watcher = {
  name: "deadlines", everyMs: 0,
  async poll(ctx) {
    const rows = (await ctx.pool.query(`SELECT f.id, f.summary, f.counterparty, f.due_at, f.origin, f.rule, f.state, f.opportunity_id, COALESCE(f.area_id, p.area_id) AS area_id, a.name AS area
        FROM followup f LEFT JOIN project p ON p.id = f.project_id LEFT JOIN area a ON a.id = COALESCE(f.area_id, p.area_id)
       WHERE f.state IN ('open','waiting','overdue') AND f.due_at IS NOT NULL AND f.due_at < $1::timestamptz + interval '24 hours'`, [ctx.now])).rows;
    const events: RawEvent[] = rows.map((f) => {
      const overdue = new Date(f.due_at).getTime() <= ctx.now.getTime();
      const due = new Date(f.due_at).toISOString().slice(0, 10);
      return { source: "deadline", kind: overdue ? "followup.overdue" : "followup.due_soon", externalId: `followup:${f.id}:${due}:${overdue ? "overdue" : "soon"}`, occurredAt: overdue ? new Date(f.due_at).toISOString() : ctx.now.toISOString(),
        summary: `${overdue ? "Overdue" : "Due within 24 h"}: ${String(f.summary).slice(0, 160)} (due ${due})`,
        payload: { followupId: f.id, origin: f.origin, rule: f.rule, opportunityId: f.opportunity_id, areaId: f.area_id, area: f.area, counterparty: f.counterparty, due } };
    });
    return { events, cursors: [], problems: [] };
  },
};

const emailOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase().trim();
const nameOf = (from: string) => (/^"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? "").trim().toLowerCase();

/** Open waits Julian created (any Area, job-linked or not) whose counterparty sent this mail. Lifecycle waits are excluded:
 *  the lifecycle recomputes them from the evidence the Area's own workflow records. */
export async function waitedFollowupsFor(db: Pick<pg.Pool, "query">, e: StoredEvent): Promise<Array<{ id: string; summary: string; counterparty: string; area_id: string | null }>> {
  if (e.kind !== "mail.received") return [];
  const from = String(e.payload.from ?? ""); const email = emailOf(from); const name = nameOf(from);
  if (!email && !name) return [];
  const rows = (await db.query(`SELECT f.id, f.summary, f.counterparty, COALESCE(f.area_id, p.area_id) AS area_id FROM followup f LEFT JOIN project p ON p.id = f.project_id
      WHERE f.state IN ('open','waiting','overdue') AND f.origin IN ('julian','bootstrap') AND f.counterparty IS NOT NULL AND length(f.counterparty) >= 3`)).rows;
  return rows.filter((f) => { const c = String(f.counterparty).toLowerCase(); return (!!name && (name === c || name.startsWith(`${c} `) || c.startsWith(`${name} `))) || (!!email && email.includes(c.replace(/\s+/g, "."))); });
}

export const genericModule: AreaModule = {
  watchers: [gmailWatcher, calendarWatcher, deadlineWatcher],
  subscriptions: [
    { id: "followups.replies", area: "*", workflow: "followup.reply",
      async match(e, ctx) { const f = await waitedFollowupsFor(ctx.pool, e); return f.length ? `from ${f.map((x) => x.counterparty).join(", ")}, whom Julian is waiting on (${f.map((x) => x.summary).join("; ").slice(0, 160)})` : null; } },
    { id: "followups.deadlines", area: "*", workflow: "followup.due",
      async match(e) { return e.source === "deadline" && e.payload.origin !== "lifecycle" ? `${e.kind === "followup.overdue" ? "passed" : "reaches"} its due date ${e.payload.due}` : null; } },
    { id: "lifecycle.deadlines", area: "*", workflow: "lifecycle.tick",
      async match(e) { return e.source === "deadline" && e.payload.origin === "lifecycle" ? `a lifecycle next step (${e.payload.rule}) reached its date ${e.payload.due}` : null; } },
  ],
  workflows: [
    { name: "followup.reply",
      async run(ctx, events) {
        // Finagai-owned: the wait is over — the counterparty answered. The follow-up closes with the reply as its outcome
        // (so it can never be escalated as "no answer"); the reply itself is in Julian's inbox and shown as a change.
        const changes: string[] = [];
        await inTx(ctx.pool, ctx.dryRun, async (tx) => {
          for (const e of events) for (const f of await waitedFollowupsFor(tx, e)) {
            const outcome = `${f.counterparty} replied ${e.occurredAt.slice(0, 10)}: “${String(e.payload.subject ?? "").slice(0, 120)}”`;
            await tx.query(`UPDATE followup SET state = 'done', outcome = $2, closed_at = now(), last_action_at = $3, updated_at = now() WHERE id = $1 AND state IN ('open','waiting','overdue')`, [f.id, outcome, e.occurredAt]);
            await appendEvent(tx, { actor: "cos", action: "followup_done", entityType: "followup", entityId: f.id, after: { outcome, by: "event:reply", inboundEvent: e.id } });
            changes.push(`${outcome} — wait closed: ${f.summary}`);
          }
        });
        return { changes, escalations: [] };
      } },
    { name: "followup.due",
      async run(ctx, events) {
        if (!ctx.dryRun) await sweepOverdue(ctx.pool, ctx.now);
        return { changes: events.map((e) => e.summary), escalations: [] };   // escalation (if any) is derived from state by the engine
      } },
    { name: "lifecycle.tick",
      async run(ctx, events) {
        const areas = [...new Set(events.map((e) => String(e.payload.areaId ?? "")).filter(Boolean))];
        const changes: string[] = [];
        for (const areaId of areas.length ? areas : [null]) {
          const r = await inTx(ctx.pool, ctx.dryRun, (tx) => lifecycleTick(tx, ctx.now, { areaId }));
          changes.push(...r.changes.map((c) => `${c.change}: ${c.job} — ${c.detail}`));
        }
        return { changes, escalations: [] };
      } },
  ],
};
