/**
 * Phase 7 (ADR-086): management by exception on a FRESH database. Silence when normal; Finagai remedies what it owns;
 * Julian hears only what only he can clear, what outlived Finagai's remedies, and what he asked to be told — once each,
 * resolved automatically when the condition clears. A dead-man check covers the event loop itself.
 */
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materialize } from "../../eval/runner/j3cases.js";
import { ensureArea, executiveBriefV2 } from "../../src/cos/operating.js";
import { appendEvent, PgDeliveryStore } from "../../src/db/index.js";
import { proactivityStatus, runTick } from "../../src/events/index.js";
import type { AreaModule } from "../../src/events/types.js";
import { exceptionsStatus } from "../../src/exceptions/index.js";
import { addRule, listRules, removeRule } from "../../src/exceptions/rules.js";
import { eventLoopWatchdog } from "../../src/exceptions/watchdog.js";
import type { EmailMessage, EmailSender } from "../../src/notify/delivery.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
const NOW = new Date("2026-10-12T15:00:00Z");                  // 11:00 ET — outside quiet hours
const H = 3_600_000;
let db: { appUrl: string; drop: () => Promise<void> } | undefined;
let pool: pg.Pool;
let careerId: string;
const sent: EmailMessage[] = [];
const sender: EmailSender = { async send(m) { sent.push(m); return `m${sent.length}`; } };
let spend = 5;
const budget = async () => ({ monthToDateUsd: spend, targetUsd: 30, ceilingUsd: 36 });
const NONE: AreaModule[] = [];
const tick = (now: Date, opts: { preview?: boolean; modules?: AreaModule[] } = {}) =>
  runTick(pool, { now, dryRun: !!opts.preview }, { modules: opts.modules ?? NONE, exceptions: { budget }, notify: { store: new PgDeliveryStore(pool), sender, timezone: "America/New_York" } }, opts.preview ? "preview" : "manual");
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
/** The next instant at or after d that is 11:00–20:59 in New York (outside the digest's quiet hours). */
const daytime = (d: Date) => { const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(d));
  return h >= 11 && h < 21 ? d : new Date(d.getTime() + (((11 - h) + 24) % 24) * 3_600_000); };
const exc = async (key: string) => (await q(`SELECT * FROM operating_exception WHERE key = $1`, [key]))[0];
let seq = 0;
/** A past event-engine tick as the live loop records it (watchers / workflows in stats). */
const pastTick = (stats: object) => q(`INSERT INTO event_tick (trigger, status, started_at, finished_at, stats) VALUES ('interval', 'done', now() - interval '1 hour' + ($1 || ' seconds')::interval, now(), $2::jsonb)`, [String(seq++), JSON.stringify(stats)]);

describe.skipIf(!admin || !migT || !appT)("management by exception (Phase 7, ADR-086)", () => {
  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_p7_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    careerId = (await ensureArea(pool, "Career")).id;
  }, 60_000);
  afterAll(async () => { await pool?.end(); await db?.drop(); });

  it("silence when normal: no exceptions, nothing sent, the brief says all normal", async () => {
    const r = await tick(NOW);
    expect(r.exceptions).toEqual(expect.objectContaining({ open: 0, opened: [], problems: [] }));
    expect(sent).toHaveLength(0);
    expect((await exceptionsStatus(pool, NOW)).headline).toBe("All normal — nothing is wrong.");
    expect((await executiveBriefV2(pool, NOW)).headline).toBe("Nothing needs you right now — all normal.");
  });

  it("a preview detects but writes nothing", async () => {
    for (let i = 0; i < 3; i++) await pastTick({ watchers: [{ name: "gmail", polled: true, problems: ["gmail a@x: invalid_grant"] }] });
    const before = (await q(`SELECT count(*)::int AS n FROM operating_exception`))[0].n;
    const r = await tick(NOW, { preview: true });
    expect(r.exceptions!.opened).toEqual([expect.stringMatching(/^\[julian\] Finagai can't read gmail/)]);
    expect((await q(`SELECT count(*)::int AS n FROM operating_exception`))[0].n).toBe(before);
    expect(sent).toHaveLength(0);
  });

  it("only Julian can re-authorize an account: escalated once (principal-reserved), one email; resolves itself when polls succeed", async () => {
    const r = await tick(new Date(NOW.getTime() + 60_000));
    expect(r.escalations.opened).toEqual([expect.stringMatching(/^\[principal_reserved\] Finagai can't read gmail — the account needs to be re-authorized/)]);
    expect(await exc("watcher:gmail:auth")).toEqual(expect.objectContaining({ owner: "julian", severity: "critical", needs: "principal_reserved", status: "open" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/^Finagai needs you: Finagai can't read gmail/);
    const again = await tick(new Date(NOW.getTime() + 6 * 60_000));
    expect(again.escalations.opened).toEqual([]); expect(sent).toHaveLength(1);                  // never twice
    await q(`INSERT INTO event_tick (trigger, status, started_at, finished_at, stats) VALUES ('interval', 'done', now(), now(), $1::jsonb)`, [JSON.stringify({ watchers: [{ name: "gmail", polled: true, problems: [] }] })]);
    const ok = await tick(new Date(NOW.getTime() + 12 * 60_000));
    expect(ok.exceptions!.resolved).toEqual([expect.stringMatching(/can't read gmail/)]);
    expect(ok.escalations.resolved).toEqual([expect.stringMatching(/can't read gmail/)]);
    expect((await proactivityStatus(pool)).needsJulian).toEqual([]);
  });

  it("a problem Finagai owns stays off Julian's plate until it outlives Finagai's remedies — then it is a judgment call", async () => {
    for (let i = 0; i < 3; i++) await pastTick({ watchers: [{ name: "calendar", polled: true, problems: ["calendar a@x: socket hang up"] }] });
    const t0 = new Date(NOW.getTime() + H);
    const r = await tick(t0);
    expect(r.exceptions!.opened).toEqual([expect.stringMatching(/^\[finagai\] calendar watcher failing/)]);
    expect(r.escalations.opened).toEqual([]);
    expect((await executiveBriefV2(pool, t0)).headline).toMatch(/^Nothing needs you right now — Finagai is handling 1 exception/);
    const later = await tick(new Date(t0.getTime() + 25 * H));
    expect(later.escalations.opened).toEqual([expect.stringMatching(/^\[judgment\] Finagai couldn't clear this itself in 25 h: calendar watcher failing .* tell it to keep trying, or have it fixed/)]);
    await q(`INSERT INTO event_tick (trigger, status, started_at, finished_at, stats) VALUES ('interval', 'done', now() + interval '1 second', now(), $1::jsonb)`, [JSON.stringify({ watchers: [{ name: "calendar", polled: true, problems: [] }] })]);
    const cleared = await tick(new Date(t0.getTime() + 26 * H));
    expect(cleared.escalations.resolved).toEqual([expect.stringMatching(/calendar watcher failing/)]);
    expect(await exc("watcher:calendar")).toEqual(expect.objectContaining({ status: "resolved", resolution: "condition cleared" }));
  });

  it("Finagai remedies what it owns: dead-lettered events are requeued once their workflow works again", async () => {
    const e = (await q(`INSERT INTO inbound_event (occurred_at, source, kind, external_id, summary, payload, status, attempts, routes, reason, received_at)
        VALUES (now() - interval '3 hours', 'test', 'mail.received', 'dl-1', 'stuck mail', '{}'::jsonb, 'failed', 5, $1::jsonb, 'w.sync failed: boom', now() - interval '3 hours') RETURNING id`, [JSON.stringify([{ workflow: "w.sync" }])]))[0];
    await pastTick({ workflows: [{ name: "w.sync", ok: true, events: 1, changes: 0, error: null }] });
    const r = await tick(new Date(NOW.getTime() + 30 * H));
    expect(r.exceptions!.opened).toEqual([expect.stringMatching(/1 event\(s\) gave up after 5 attempts/)]);
    expect(r.exceptions!.remedied).toEqual(["requeue_dead_events: requeued 1 of 1"]);
    expect((await q(`SELECT status, attempts, reason FROM inbound_event WHERE id = $1`, [e.id]))[0]).toEqual(expect.objectContaining({ attempts: 0, reason: "requeued: its workflow works again" }));
    const next = await tick(new Date(NOW.getTime() + 30.2 * H));
    expect(next.exceptions!.resolved).toEqual([expect.stringMatching(/gave up after 5 attempts/)]);
  });

  it("the budget ceiling is Julian's alone; nearing it is only watched", async () => {
    spend = 30;                                                                   // 83% of $36
    const r1 = await tick(new Date(NOW.getTime() + 31 * H));
    expect(await exc("budget:near")).toEqual(expect.objectContaining({ owner: "finagai", severity: "info", status: "open" }));
    expect(r1.escalations.opened).toEqual([]);
    spend = 34.5;                                                                 // 96%
    const r2 = await tick(new Date(NOW.getTime() + 31.1 * H));
    expect(r2.escalations.opened).toEqual([expect.stringMatching(/^\[principal_reserved\] Model spend is \$34\.50 of the \$36\.00 monthly ceiling — at the ceiling Finagai stops calling models; only you can raise it/)]);
    spend = 5;
    const r3 = await tick(new Date(NOW.getTime() + 31.2 * H));
    expect(r3.escalations.resolved).toEqual([expect.stringMatching(/Model spend/)]);
    // A process without the budget meter reports it unavailable — and never "clears" an open budget exception.
    spend = 34.5;
    await tick(new Date(NOW.getTime() + 31.3 * H));
    const blind = await runTick(pool, { now: new Date(NOW.getTime() + 31.4 * H), dryRun: false }, { modules: NONE }, "manual");
    expect(blind.exceptions!.problems).toEqual([expect.stringMatching(/^budget: budget meter unavailable/)]);
    expect((await exc("budget:ceiling")).status).toBe("open");
    spend = 5; await tick(new Date(NOW.getTime() + 31.5 * H));
  });

  it("the Mac: offline with work waiting is Julian's (only he can wake it); asleep with nothing waiting is normal", async () => {
    await q(`INSERT INTO mac_runtime (id, last_heartbeat_at) VALUES ('primary', now() - interval '2 hours') ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at`);
    const t = new Date(Date.now());
    await tick(t);
    // Phase 8 (ADR-088, live 2026-10-13): an idle, sleeping Mac is not an exception (it only produced open/close noise)
    expect(await exc("mac:offline")).toBeUndefined();
    const st = await exceptionsStatus(pool, t);
    expect(st.headline).toBe("All normal — nothing is wrong.");
    expect(st.noted).toEqual([]);
    await q(`INSERT INTO control_task (request, status, created_at) VALUES ('make the September chart', 'active', now() - interval '40 minutes')`);
    const r = await tick(new Date(t.getTime() + 60_000));
    expect(r.escalations.opened).toEqual([expect.stringMatching(/^\[principal_reserved\] Your Mac has been unreachable for 2 h and 1 Mac task\(s\) are waiting/)]);
    await q(`UPDATE control_task SET status = 'cancelled' WHERE status = 'active'`);
    await q(`UPDATE mac_runtime SET last_heartbeat_at = now()`);
    const back = await tick(new Date(t.getTime() + 120_000));
    expect(back.exceptions!.resolved.length).toBeGreaterThanOrEqual(1);            // Julian's exception clears the moment the Mac is back
    expect((await q(`SELECT count(*)::int AS n FROM operating_exception WHERE status = 'open' AND detector = 'mac_offline'`))[0].n).toBe(0);
  });

  it("an unverifiable READ-ONLY answer is neither Julian's review nor an exception; an unverified CHANGE is his to accept", async () => {
    const mk = async (request: string, kinds: string[]) => {
      const t = (await q(`INSERT INTO control_task (request, status, verification_status, result_summary, created_at, updated_at) VALUES ($1, 'done', 'needs_review', 'NEEDS YOUR REVIEW', now() - interval '2 days', now() - interval '2 days') RETURNING id, code`, [request]))[0];
      let i = 0; for (const k of kinds) await q(`INSERT INTO control_step (task_id, seq, kind, risk, summary, status, result, ran_at) VALUES ($1, $2, $3, 'read', $4, 'done', 'verified: ok', now() - interval '2 days')`, [t.id, ++i, k, `${k} step`]);
      return Number(t.code);
    };
    const ro = await mk("Have I received an update from Beth?", ["browser_open_tab", "browser_read", "browser_click", "browser_navigate"]);   // live: task 129
    const rw = await mk("Fill the Chimes application form", ["browser_open_tab", "browser_fill_form", "browser_upload"]);
    const r = await tick(new Date(Date.now() + 10 * 60_000));
    expect(await exc(`task:${ro}:review`)).toBeUndefined();                       // not an exception at all: nothing pending, nothing to remedy
    expect(await exc(`task:${rw}:review`)).toEqual(expect.objectContaining({ owner: "julian", needs: "judgment" }));
    expect(r.escalations.opened).toEqual([expect.stringMatching(new RegExp(`^\\[judgment\\] Task ${rw} changed something Finagai could not verify`))]);
    // The brief applies the same rule (live 2026-10-11: it still listed read-only task 129 as "needs your review").
    const b = await executiveBriefV2(pool);
    expect(b.blocked.join(" ")).toMatch(new RegExp(`Task ${rw} needs your review`));
    expect(b.blocked.join(" ")).not.toMatch(new RegExp(`Task ${ro} needs your review`));
    await q(`UPDATE control_task SET verification_status = 'verified' WHERE code = ANY($1::bigint[])`, [[ro, rw]]);
    await tick(new Date(Date.now() + 11 * 60_000));
  });

  it("'tell me when …' rules: validated, notify once on the edge, never act, and are removable", async () => {
    expect(await addRule(pool, { statement: "tell me when x", metric: "nope", op: ">", value: 1 })).toEqual({ error: expect.stringMatching(/Unknown metric "nope"/) });
    expect(await addRule(pool, { statement: "tell me when x", metric: "jobs_in_status", op: ">=", value: 1, area: "Career" })).toEqual({ error: expect.stringMatching(/needs a status/) });
    expect(await addRule(pool, { statement: "tell me when x", event: "opportunity_status", status: "hired" })).toEqual({ error: expect.stringMatching(/Unknown status "hired"/) });
    expect(await addRule(pool, { statement: "tell me when x", metric: "jobs_in_status", op: ">=", value: 1, area: "Nowhere", status: "offer" })).toEqual({ error: 'There is no "Nowhere" area.' });
    const ev = await addRule(pool, { statement: "Tell me when a Career job reaches interviewing", event: "opportunity_status", area: "Career", status: "interviewing" }) as { rule: number };
    expect(ev.rule).toBeGreaterThan(0);
    const ex = await addRule(pool, { statement: "Tell me if anything goes wrong", metric: "open_exceptions", op: ">=", value: 1 }, { budget }) as { rule: number; currentValue: number; note: string };
    expect(ex.currentValue).toBe(0); expect(ex.note).toMatch(/once when it becomes true/);
    const lazy = await addRule(pool, { statement: "Tell me if I apply to fewer than 3 jobs a week", metric: "applications_last_7d", area: "Career", op: "<", value: 3 }) as { note: string };
    expect(lazy.note).toMatch(/already true right now/);                         // 0 applications: true now → does not fire until it clears first
    sent.length = 0;
    // an interview arrives
    const o = (await q(`INSERT INTO opportunity (kind, area_id, org, title, status, source, dedupe_key) VALUES ('job', $1, 'Altarum', 'Pricing Analyst', 'interviewing', 'test', 'altarum|pa') RETURNING id`, [careerId]))[0];
    await appendEvent(pool, { actor: "cos", action: "opportunity_status", entityType: "opportunity", entityId: o.id, before: { status: "applied" }, after: { status: "interviewing" } });
    // the notice goes out only outside quiet hours (22:00–07:00 ET): pin the tick to daytime so the test does not
    // depend on when it runs (it failed when the suite ran at 03:20 ET)
    const t = daytime(new Date(Date.now() + 60_000));
    const r = await tick(t);
    expect(r.exceptions!.rulesFired).toEqual(["Tell me when a Career job reaches interviewing"]);
    expect(r.escalations.opened).toEqual([expect.stringMatching(/^\[requested\] You asked to be told: “Tell me when a Career job reaches interviewing” — Altarum — Pricing Analyst is now interviewing/)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/^Finagai: “Tell me when a Career job reaches interviewing”/);
    expect(sent[0]!.text).toMatch(/You asked to be told \(nothing to do\)/);
    // not a decision: the brief and "what needs me" never list it; it resolves once told and never repeats
    expect((await executiveBriefV2(pool, t)).decisions.join(" ")).not.toMatch(/asked to be told/);
    expect((await proactivityStatus(pool)).needsJulian).toEqual([]);
    const r2 = await tick(new Date(t.getTime() + 60_000));
    expect(r2.escalations.resolved).toEqual([expect.stringMatching(/You asked to be told/)]);
    expect(r2.exceptions!.rulesFired).toEqual([]);
    // a rule only observes: it changed nothing in the pipeline
    expect((await q(`SELECT status FROM opportunity WHERE id = $1`, [o.id]))[0].status).toBe("interviewing");
    expect((await listRules(pool)).map((x) => x.rule)).toEqual(expect.arrayContaining([ev.rule, ex.rule]));
    expect(await removeRule(pool, "apply to fewer")).toEqual(expect.objectContaining({ statement: "Tell me if I apply to fewer than 3 jobs a week" }));
    expect(await removeRule(pool, "apply to fewer")).toEqual({ error: expect.stringMatching(/No active rule/) });
  });

  it("an edge-triggered metric rule fires once when it becomes true and re-arms only after it clears", async () => {
    sent.length = 0;
    await q(`INSERT INTO mac_runtime (id, last_heartbeat_at) VALUES ('primary', now() - interval '2 hours') ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = EXCLUDED.last_heartbeat_at`);
    await q(`INSERT INTO control_task (request, status, created_at) VALUES ('rename the Q3 deck', 'active', now() - interval '40 minutes')`);
    const t = new Date(Date.now() + 5 * 60_000);
    const r = await tick(t);                                                        // the Mac is offline WITH work waiting → "anything goes wrong" fires
    expect(r.exceptions!.rulesFired).toEqual(["Tell me if anything goes wrong"]);
    const r2 = await tick(new Date(t.getTime() + 60_000));
    expect(r2.exceptions!.rulesFired).toEqual([]);                                  // still true: no repeat
    await q(`UPDATE control_task SET status = 'cancelled' WHERE status = 'active'`);
    await q(`UPDATE mac_runtime SET last_heartbeat_at = now()`);
    await tick(new Date(t.getTime() + 120_000));                                    // clears → re-arms
    expect((await q(`SELECT armed, fired_count FROM watch_rule WHERE statement = 'Tell me if anything goes wrong'`))[0]).toEqual({ armed: true, fired_count: 1 });
  });

  it("dead-man check: a stalled loop opens a critical exception and sends ONE alert per outage; the next tick clears it", async () => {
    sent.length = 0;
    await q(`DELETE FROM event_tick`).catch(() => undefined);                      // app role may not delete: fall back to a far-future clock
    const last = (await q(`SELECT max(started_at) AS at FROM event_tick`))[0].at as Date;
    const late = new Date(Math.max(Date.now(), new Date(last).getTime()) + 45 * 60_000);
    const day = new Date(late); day.setUTCHours(15, 0, 0, 0); if (day < late) day.setUTCDate(day.getUTCDate() + 1);   // 11:00 ET, after the stall
    const notify = { store: new PgDeliveryStore(pool), sender, timezone: "America/New_York" };
    const w1 = await eventLoopWatchdog(pool, day, notify);
    expect(w1).toEqual(expect.objectContaining({ stalled: true, notified: "sent" }));
    expect(await exc("loop:stalled")).toEqual(expect.objectContaining({ owner: "julian", severity: "critical", status: "open" }));
    expect(sent).toHaveLength(1); expect(sent[0]!.subject).toBe("Finagai has stopped noticing new mail and deadlines");
    const w2 = await eventLoopWatchdog(pool, new Date(day.getTime() + 15 * 60_000), notify);
    expect(w2.notified).toBe("already_sent"); expect(sent).toHaveLength(1);
    const night = new Date(day); night.setUTCHours(6, 0, 0, 0);                    // 02:00 ET
    if (night > new Date(last)) expect((await eventLoopWatchdog(pool, night, notify)).notified).toBe("held for quiet hours");
    await tick(new Date(day.getTime() + 20 * 60_000));
    expect((await exc("loop:stalled")).status).toBe("resolved");
  });
});
