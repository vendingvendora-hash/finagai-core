/**
 * Phase 5 (ADR-084): event-driven proactivity on a FRESH database built from the real 2026-10-09 evidence (Career
 * bootstrap applied). Mail, calendar and deadline events wake the right Area; Finagai-owned actions happen without
 * Julian; only judgment / authorization / principal-reserved needs are escalated — once, and resolved automatically.
 */
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../eval/runner/j3cases.js";
import { applyBootstrap, proposeCareerBootstrap } from "../../src/cos/bootstrap.js";
import { CAREER_QUERIES } from "../../src/cos/career-evidence.js";
import { addWaiting, ensureArea, executiveBriefV2, resolveWaiting } from "../../src/cos/operating.js";
import { PgDeliveryStore } from "../../src/db/index.js";
import { AREA_MODULES, proactivityStatus, runTick } from "../../src/events/index.js";
import type { EmailMessage, EmailSender } from "../../src/notify/delivery.js";
import { ACCOUNT, REC, SHEET_CSV, fixtureRecord, linkedInRejection, LINKEDIN_SENDER, queryHits } from "../fixtures/career-2026-10-09.js";
import type { GmailRecord } from "../../src/google/client.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
const T = new Date("2026-10-09T17:00:00Z");
const keyOf = (q: string) => Object.entries(CAREER_QUERIES).find(([, b]) => q.endsWith(b))?.[0];
/** Fake Google: Career acquisition queries by key; the mail watcher's "after:<epoch s>" by date. */
const google = (recs: () => GmailRecord[], cal: () => Array<{ id: string; start: string; summary: string }> = () => []) => ({
  sheetCsv: async () => ({ id: "sheet-1", name: "Vendora Career Copilot - Job History", modified: "2026-10-09T16:29:38Z", account: "vending.vendora@gmail.com", csv: SHEET_CSV }),
  gmailEnumerate: async (q: string, o: { known?: Map<string, Map<string, GmailRecord>>; onFetched?: (a: string, r: GmailRecord) => void } = {}) => {
    const after = /^after:(\d+)$/.exec(q)?.[1];
    const h = after ? recs().filter((x) => x.internalDate > Number(after) * 1000) : queryHits(keyOf(q) ?? "", recs());
    const out = h.map((x) => { const k = o.known?.get(ACCOUNT)?.get(x.id); if (k) return k; o.onFetched?.(ACCOUNT, x); return x; });
    return [{ account: ACCOUNT, ok: true, records: out, pages: 1, truncated: false, ids: h.length, vanished: [], fetched: 0, reused: 0 }]; },
  gmailMetadata: async (_a: string, ids: string[]) => ({ records: recs().filter((x) => ids.includes(x.id)), missing: [] }),
  calendarEnumerate: async (q: string) => [{ account: ACCOUNT, ok: true, pages: 1, records: q === "" ? cal() : q === "interview" ? [{ id: "cal-1", start: "2026-09-28T15:00:00-04:00", summary: "Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst" }] : [] }],
});
let mail: GmailRecord[] = Object.values(REC);
let calendar: Array<{ id: string; start: string; summary: string }> = [];
const G = google(() => mail, () => calendar);
const sent: EmailMessage[] = [];
const sender: EmailSender = { async send(m) { sent.push(m); return `msg-${sent.length}`; } };

let db: { appUrl: string; drop: () => Promise<void> } | undefined;
let pool: pg.Pool;
const notify = () => ({ store: new PgDeliveryStore(pool), sender, timezone: "America/New_York" });
const tick = (now: Date, opts: { preview?: boolean; withNotify?: boolean } = {}) =>
  runTick(pool, { google: G as never, now, dryRun: !!opts.preview }, { modules: AREA_MODULES, ...(opts.withNotify === false ? {} : { notify: notify() }) }, opts.preview ? "preview" : "manual");
const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM inbound_event)::int AS ev, (SELECT count(*) FROM escalation)::int AS esc, (SELECT count(*) FROM event_cursor)::int AS cur,
  (SELECT count(*) FROM opportunity_event)::int AS oe, (SELECT string_agg(status, ',' ORDER BY id) FROM opportunity) AS st, (SELECT count(*) FROM outbound_delivery)::int AS od`)).rows[0];

describe.skipIf(!admin || !migT || !appT)("event-driven proactivity (Phase 5, ADR-084)", () => {
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_p5_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    await ensureArea(pool, "Career");
    await addWaiting(pool, { counterparty: "Beth Young", about: "Altarum Pricing Analyst outcome after the 9/28 panel", area: "Career", due: "2026-10-14", now: new Date("2026-10-09T13:00:00Z") });
    const p = await proposeCareerBootstrap(pool, G as never, T);
    await applyBootstrap(pool, p.code);
  }, 60_000);
  afterAll(async () => { await pool?.end(); await db?.drop(); });

  it("a preview tick computes everything and writes/sends nothing", async () => {
    const before = await counts();
    const r = await tick(new Date("2026-10-09T18:00:00Z"), { preview: true });
    expect(r.preview).toBe(true);
    expect(r.events.length).toBeGreaterThan(0);
    expect(await counts()).toEqual(before);
    expect(sent).toHaveLength(0);
  });

  it("new mail wakes Career only when it is job evidence; unrelated mail is ignored with the reason; one sync for many emails", async () => {
    const r = await tick(new Date("2026-10-09T18:00:00Z"));
    const ri = r.events.find((e) => /Resource Innovations/.test(e.summary))!;
    expect(ri.status).toBe("routed");
    expect(ri.routes[0]).toEqual(expect.objectContaining({ area: "Career", workflow: "career.sync", why: expect.stringMatching(/job evidence/) }));
    const news = r.events.find((e) => /Jobs Update/.test(e.summary))!;
    expect(news).toEqual(expect.objectContaining({ status: "ignored", reason: "no Area subscribes to this event" }));
    expect(r.workflows.filter((w) => w.name === "career.sync")).toEqual([expect.objectContaining({ ok: true })]);   // batched: ONE sync
    expect(r.escalations.opened).toEqual([]);                                                       // nothing here needs Julian
    // The same mail is never an event twice; a quiet tick does nothing.
    const again = await tick(new Date("2026-10-09T18:04:30Z"));                                     // a tick slightly early still polls
    expect(again.events).toEqual([]);
    expect(again.watchers.find((w) => w.name === "gmail")).toEqual(expect.objectContaining({ polled: true, newEvents: 0 }));
  });

  it("a rejection email arrives → Career updates itself (status, project closed) with no escalation", async () => {
    mail = [...mail, fixtureRecord("1a12fff000000001", String(Date.parse("2026-10-10T14:00:00Z")), "Your application to Project Finance Analyst - SMR at Vallum Associates", LINKEDIN_SENDER,
      "Your application to Project Finance Analyst - SMR at Vallum Associates ͏ ͏ ͏", ...linkedInRejection("Vallum Associates"))];
    const r = await tick(new Date("2026-10-10T15:00:00Z"));
    expect(r.events.map((e) => [e.status, e.routes.map((x) => x.workflow)])).toContainEqual(["routed", ["career.sync"]]);
    const sync = r.workflows.find((w) => w.name === "career.sync")!;
    expect(sync.ok).toBe(true);
    expect(sync.changes.join(" ")).toMatch(/status: Vallum Associates — Project Finance Analyst - SMR — applied → rejected \[gmail:1a12fff000000001\]/);
    expect(sync.changes.join(" ")).toMatch(/project completed/);
    expect((await pool.query(`SELECT status FROM opportunity WHERE org = 'Vallum Associates' AND title = 'Project Finance Analyst - SMR'`)).rows[0].status).toBe("rejected");
    expect(r.escalations.opened).toEqual([]);
    expect((await pool.query(`SELECT status FROM inbound_event WHERE external_id = $1`, [`${ACCOUNT}:1a12fff000000001`])).rows[0].status).toBe("handled");
  });

  it("an interview on the calendar wakes Career; an unrelated calendar event does not", async () => {
    calendar = [{ id: "c-int", start: "2026-10-13T14:00:00-04:00", summary: "Interview with Chimes — Contract Cost & Pricing Specialist" }, { id: "c-den", start: "2026-10-12T09:00:00-04:00", summary: "Dentist" }];
    const r = await tick(new Date("2026-10-10T16:00:00Z"));
    expect(r.events.find((e) => /Dentist/.test(e.summary))!.status).toBe("ignored");
    expect(r.events.find((e) => /Interview with Chimes/.test(e.summary))!.routes.map((x) => x.workflow)).toEqual(["career.sync"]);
  });

  it("Julian's own wait passes its date → escalated ONCE (principal-reserved), one digest; resolved automatically when he closes it", async () => {
    const r = await tick(new Date("2026-10-15T15:00:00Z"));
    expect(r.events.find((e) => e.kind === "followup.overdue" && /Beth Young/.test(e.summary))!.routes.map((x) => x.workflow)).toContain("followup.due");
    expect(r.escalations.opened).toEqual([expect.stringMatching(/^\[principal_reserved\] No answer from Beth Young by 2026-10-14 — approve a follow-up/)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/^Finagai needs you: No answer from Beth Young/);
    expect(sent[0]!.text).toMatch(/Only the items below need you; everything else Finagai is handling/);
    const b = await executiveBriefV2(pool, new Date("2026-10-15T15:00:00Z"));
    expect(b.decisions.join(" ")).toMatch(/\[Career\] No answer from Beth Young/);
    const again = await tick(new Date("2026-10-15T15:06:00Z"));
    expect(again.escalations.opened).toEqual([]); expect(sent).toHaveLength(1);                   // never twice
    await resolveWaiting(pool, "Beth Young", "Beth replied: decision next week");
    const after = await tick(new Date("2026-10-15T15:12:00Z"));
    expect(after.escalations.resolved).toEqual([expect.stringMatching(/No answer from Beth Young/)]);
    expect((await proactivityStatus(pool)).needsJulian).toEqual([]);
  });

  it("quiet hours hold the digest; a reply from someone Julian waits on is recorded (no escalation)", async () => {
    await ensureArea(pool, "Health Admin");
    await addWaiting(pool, { counterparty: "Dana Smith", about: "insurance renewal quote", area: "Health Admin", due: "2026-10-17", now: new Date("2026-10-15T12:00:00Z") });
    mail = [...mail, fixtureRecord("1a12fff000000002", String(Date.parse("2026-10-15T20:00:00Z")), "Re: renewal quote", "Dana Smith <dana@broker.example>", "Here is the quote you asked for.")];
    const r = await tick(new Date("2026-10-16T03:00:00Z"));                                        // 23:00 ET
    const ev = r.events.find((e) => /renewal quote/.test(e.summary))!;
    expect(ev.routes.map((x) => x.workflow)).toEqual(["followup.reply"]);
    expect(r.workflows.find((w) => w.name === "followup.reply")!.changes.join(" ")).toMatch(/Dana Smith replied/);
    expect(r.escalations.opened).toEqual([]);
    // Its date passes unanswered by Julian's decision → escalated, but held overnight.
    const late = await tick(new Date("2026-10-17T03:00:00Z"));
    expect(late.escalations.opened).toEqual([expect.stringMatching(/No answer from Dana Smith/)]);
    expect(late.escalations.held).toMatch(/quiet hours/);
    expect(sent).toHaveLength(1);
    const morning = await tick(new Date("2026-10-17T12:00:00Z"));                                  // 08:00 ET
    expect(morning.escalations.notified).toEqual([expect.stringMatching(/No answer from Dana Smith/)]);
    expect(sent).toHaveLength(2);
  });

  it("a failing workflow does not lose the event (retried next tick) and a concurrent tick is skipped", async () => {
    const broken = { ...G, gmailEnumerate: async (q: string, o: object) => /^after:\d+$/.test(q) ? G.gmailEnumerate(q, o as never)
      : [{ account: ACCOUNT, ok: false, error: "HTTP 429", records: [], pages: 0, truncated: false, ids: 0, vanished: [] }] };
    mail = [...mail, fixtureRecord("1a12fff000000003", String(Date.parse("2026-10-17T13:00:00Z")), "Thanks for applying to Chimes", "Chimes <no-reply@hire.lever.co>", "Thank you for applying to the Contract Cost & Pricing Specialist role at Chimes.")];
    const r = await runTick(pool, { google: broken as never, now: new Date("2026-10-17T14:00:00Z"), dryRun: false }, { modules: AREA_MODULES }, "manual");
    expect(r.workflows.find((w) => w.name === "career.sync")).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/incomplete acquisition/) }));
    expect((await pool.query(`SELECT status FROM inbound_event WHERE external_id = $1`, [`${ACCOUNT}:1a12fff000000003`])).rows[0].status).toBe("failed");
    const retry = await tick(new Date("2026-10-17T14:06:00Z"), { withNotify: false });
    expect(retry.workflows.find((w) => w.name === "career.sync")).toEqual(expect.objectContaining({ ok: true }));
    expect((await pool.query(`SELECT status FROM inbound_event WHERE external_id = $1`, [`${ACCOUNT}:1a12fff000000003`])).rows[0].status).toBe("handled");
    const holder = await pool.connect();
    await holder.query(`SELECT pg_advisory_lock(84005)`);
    expect((await tick(new Date("2026-10-17T14:12:00Z"))).skipped).toMatch(/another tick/);
    await holder.query(`SELECT pg_advisory_unlock(84005)`); holder.release();
  });
});
