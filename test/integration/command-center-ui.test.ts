/**
 * ADR-089 slices 1–3 — the Command screen and the Why inspector in a real browser (headless Chromium), end to end:
 *   real Core HTTP handler + test database  ←  BFF (session cookie, server-held tokens)  ←  the built SPA (command/dist/web)
 * signed in through a stand-in OIDC provider. Proves the Command Live acceptance points that can be proven off production:
 * calm state, ownership line, Needs you only from open escalations, no internal-Area/canary/low-value leakage, a real
 * engine-raised decision appears within 2 s (with motion only for that real event), a disconnect goes reconnecting →
 * offline/stale → resumes from the cursor with exactly the missed events and a fresh snapshot, mobile layout, zero
 * business writes and zero semantic events from the UI, and no Core token anywhere the browser can reach.
 * Slice 3: activity reads as history (one story per unit of work, past tense, ◆ only while Needs you lists it); the Why
 * inspector's chain on screen equals Core's /live/chain for every event tried, missing causes are shown as missing,
 * technical ids are hidden until asked for, it is deep-linkable (also across sign-in), Esc/back close it, it is
 * full-screen on mobile, and opening and reading it changes nothing in Core.
 *
 * Needs `npm ci && npm run build` in command/ (skipped otherwise). Set CC_E2E_SHOTS=<dir> to save screenshots.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet } from "jose";
import { materialize } from "../../eval/runner/j3cases.js";
import { loadConfig } from "../../src/config/index.js";
import { ensureArea } from "../../src/cos/operating.js";
import { closeFollowup, sweepOverdue } from "../../src/cos/followups.js";
import { enterAwaitingHuman } from "../../src/concierge/human-wait.js";
import { decideStep } from "../../src/pipelines/j6/control.js";
import { appendEvent } from "../../src/db/index.js";
import { runTick } from "../../src/events/index.js";
import type { AreaModule } from "../../src/events/types.js";
import { liveHandler } from "../../src/live/http.js";
import { causalChain } from "../../src/live/stream.js";
import { createHandler } from "../../src/server/app.js";
import { createLogger } from "../../src/server/log.js";
import { createBff } from "../../command/server/index.js";
import { startFakeOidc } from "../support/fake-oidc.js";

const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
const COMMAND = join(process.cwd(), "command"), STATIC = join(COMMAND, "dist/web");
const haveUi = existsSync(join(STATIC, "index.html")) && existsSync(join(COMMAND, "node_modules/playwright-core"));
const SHOTS = process.env.CC_E2E_SHOTS;

let db: Awaited<ReturnType<typeof materialize>>; let pool: pg.Pool;
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const servers: http.Server[] = [];
const coreEnv = { NODE_ENV: "test", DATABASE_URL: "postgres://unused", ANTHROPIC_API_KEY: "unused", PRINCIPAL_SUBJECT: "user_julian", APPROVAL_CLIENT_ID: "c", APPROVAL_CLIENT_SECRET: "s",
  SESSION_SECRET: "x".repeat(40), RESEND_API_KEY: "r", NOTIFY_FROM: "Finagai <review@notify.example.test>", NOTIFY_TO: "julian@example.test", NOTIFY_REPLY_TO: "julian@example.test" };
const empty: AreaModule = { watchers: [], subscriptions: [], workflows: [] };
const tick = () => runTick(pool, { now: new Date(), dryRun: false }, { modules: [empty], exceptions: { budget: async () => ({ monthToDateUsd: 1, targetUsd: 30, ceilingUsd: 36 }) } }, "manual");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Text that would make history read like a current instruction. */
const PRESENT_INSTRUCTION = /now your decision|no longer needs you|is waiting for your|Reply "ok|— approve a follow-up|give a new date, or close it/;

async function listen(): Promise<[http.Server, string]> {
  const s = http.createServer(); servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return [s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`];
}
/** Every business table's content as one fingerprint (the semantic event log and the stream index are checked separately). */
async function businessFingerprint() {
  const out: Record<string, string> = {};
  for (const t of ["area", "objective", "project", "opportunity", "opportunity_event", "followup", "escalation", "operating_exception", "lesson", "watch_rule", "control_task", "event_tick", "inbound_event"])
    out[t] = (await q(`SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`))[0].h;
  return out;
}

describe.skipIf(!admin || !migT || !appT || !haveUi)("Command screen in a browser (ADR-089 slices 1–3)", () => {
  let provider: Awaited<ReturnType<typeof startFakeOidc>>; let bffBase = "";
  let browser: any; let page: any; let career = ""; let bethWait = "";
  const bodies: string[] = []; const urls: string[] = [];
  const shot = async (p: any, name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await p.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 2_000 }).catch(() => {});
    await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  };
  const text = async (sel: string) => (await page.locator(sel).allInnerTexts()).join("\n");
  const state = () => page.evaluate(() => { const s = (window as any).__finagaiLive.state(); return { conn: s.conn, lastSeq: s.lastSeq, ids: s.events.map((e: any) => e.eventId), caughtUp: s.caughtUp, gaps: s.gaps }; });

  beforeAll(async () => {
    db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") }, `finagai_ccui_${process.pid}`, []);
    pool = new pg.Pool({ connectionString: db.appUrl, options: "-c search_path=finagai" });
    career = (await ensureArea(pool, "Career")).id;
    const test = (await ensureArea(pool, "Finagai Test")).id;
    // Finagai's work: one wait on another party (Finagai owns the next step)
    await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin, rule) VALUES ($1, 'Waiting on Chimes to respond', 'Chimes', 'waiting', now() + interval '5 days', 'lifecycle', 'applied.awaiting_response')`, [career]);
    // Finagai's internal test Area: a decision and a wait that must never reach Command
    await q(`INSERT INTO escalation (key, area_id, needs, summary) VALUES ('career.sync:leak@opportunity:00000000-0000-0000-0000-0000000000aa', $1, 'judgment', 'LEAKCHECK internal decision')`, [test]);
    await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'LEAKCHECK internal wait', 'Canary', 'waiting', now() + interval '2 days', 'julian')`, [test]);
    // production finding 2026-10-15: decisions about internal test objects created before Core recorded an Area on
    // decisions — no Area on the row or its events; only the subject in the key ties them to the internal Area
    const opp = (await q(`INSERT INTO opportunity (kind, area_id, org, title, status, source, dedupe_key) VALUES ('job', $1, 'LEAKCHECK-CANARY', 'Canary role', 'interviewing', 'test', 'leak|canary') RETURNING id`, [test]))[0].id;
    await appendEvent(pool, { actor: "cos", action: "opportunity_evidence_added", entityType: "opportunity", entityId: opp, areaId: test, after: { opportunity_id: opp, summary: "LEAKCHECK interview evidence" } });
    for (const [k, open] of [["leak-resolved", false], ["leak-open", true]] as const) {
      const key = `career.sync:${k}@opportunity:${opp}`, summary = `LEAKCHECK area-less decision (${k})`;
      const id = (await q(`INSERT INTO escalation (key, area_id, needs, summary) VALUES ($1, NULL, 'judgment', $2) RETURNING id`, [key, summary]))[0].id;
      await appendEvent(pool, { actor: "cos", action: "escalation_opened", entityType: "escalation", entityId: id, after: { key, needs: "judgment", summary } });
      if (!open) {
        await q(`UPDATE escalation SET status = 'resolved', resolved_at = now(), resolution = 'moved on' WHERE id = $1`, [id]);
        await appendEvent(pool, { actor: "cos", action: "escalation_resolved", entityType: "escalation", entityId: id, before: { key, status: "open" }, after: { key, status: "resolved", summary } });
      }
    }
    // low-value traffic that must stay out of Live activity
    for (let i = 0; i < 30; i++) await appendEvent(pool, { actor: "system", action: "tool_called", entityType: "tool", after: { tool: "LEAKCHECK_tool", outcome: "ok" } });
    await tick();
    provider = await startFakeOidc({ clientId: "cc-client", clientSecret: "cc-secret", subject: "user_julian", accessTtlSec: 3600 });
    const [coreSrv, core] = await listen();
    const cfg = loadConfig({ ...coreEnv, FINAGAI_PUBLIC_BASE_URL: core, FINAGAI_MCP_RESOURCE_URL: `${core}/mcp`, OAUTH_ISSUER: provider.issuer, OAUTH_JWKS_URL: `${provider.issuer}/jwks`, ALLOWED_MCP_CLIENT_IDS: "claude-connector,cc-client" });
    coreSrv.on("request", createHandler(cfg, { version: "test", startedAt: new Date() }, createLogger(cfg, () => {}),
      // production polls every 1 s with 15 s heartbeats; streams end after 25 s here to prove a clean end resumes silently
      { keys: createLocalJWKSet({ keys: [provider.jwk] }), live: liveHandler(pool, { pollMs: 250, heartbeatMs: 5_000, maxStreamMs: 25_000 }) }));
    const [bffSrv, bff] = await listen(); bffBase = bff;
    const bcfg = (await import("../../command/server/config.js")).loadConfig({ CC_PUBLIC_URL: bff, OAUTH_ISSUER: provider.issuer, CC_CLIENT_ID: "cc-client", CC_CLIENT_SECRET: "cc-secret",
      CORE_URL: core, CORE_RESOURCE: `${core}/mcp`, PRINCIPAL_SUBJECT: "user_julian", CC_STATE_SECRET: "s".repeat(40), CC_INSECURE_COOKIES: "1", CC_STATIC_DIR: STATIC });
    bffSrv.on("request", createBff(bcfg, { log: () => {} }).handler);
    const { chromium } = createRequire(join(COMMAND, "package.json"))("playwright-core");
    browser = await chromium.launch();
  }, 120_000);
  afterAll(async () => { await browser?.close(); for (const s of servers) s.close(); await provider?.close(); await pool?.end(); await db?.drop(); });

  async function signedInPage(viewport: { width: number; height: number }) {
    const ctx = await browser.newContext({ viewport, reducedMotion: "no-preference" });
    const p = await ctx.newPage();
    p.on("request", (r: any) => urls.push(r.url()));
    p.on("response", async (r: any) => { try { if (r.url().startsWith(bffBase) && !/text\/event-stream|font|image/.test(r.headers()["content-type"] ?? "")) bodies.push(await r.text()); } catch { /* redirects have no body */ } });
    await p.goto(`${bffBase}/`);                                 // → /auth/login → provider → /auth/callback → /
    expect(new URL(p.url()).pathname).toBe("/");
    await p.goto(`${bffBase}/?diag`);
    return p;
  }

  it("signs in and renders the calm state from Core's reads, with nothing internal or low-value — and writes nothing", async () => {
    const before = { fp: await businessFingerprint(), maxEvent: (await q(`SELECT max(id)::int AS m FROM event`))[0].m };
    page = await signedInPage({ width: 1440, height: 900 });
    await page.locator(".calm__statement").waitFor({ timeout: 10_000 });
    expect(await text(".calm__statement")).toBe("Nothing needs you.");
    const lines = await page.locator(".calm__line").allInnerTexts();
    expect(lines.length).toBeGreaterThan(0); expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toBe("Finagai is watching 1 wait on other people.");
    expect(lines.join(" ")).not.toMatch(/\b0\b/);
    expect(await page.locator(".handling, .card, .needs-count").count()).toBe(0);             // no KPI rows, no zero rows
    await page.locator(".conn--live").waitFor({ timeout: 5_000 });
    expect(await text(".topbar")).toMatch(/Live/);
    const all = await page.locator("body").innerText();
    expect(all).not.toMatch(/LEAKCHECK|Finagai Test|Canary/);
    expect(await text(".areas")).toMatch(/^Areas\nCareer/);
    // motion only for real events: a settled page runs no animation
    await sleep(1_500);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await shot(page, "1-desktop-calm");
    // the UI wrote nothing: no business row changed, no semantic event appended (the stream index is not business state)
    await sleep(3_000);
    expect(await businessFingerprint()).toEqual(before.fp);
    expect((await q(`SELECT max(id)::int AS m FROM event`))[0].m).toBe(before.maxEvent);
  }, 60_000);

  it("a decision the engine raises appears above the ownership line within 2 s, with the count, the rail marker and an activity unit", async () => {
    bethWait = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Beth Young about the Altarum panel', 'Beth Young', 'waiting', now() - interval '1 hour', 'julian') RETURNING id`, [career]))[0].id;
    await sweepOverdue(pool);
    const t0 = Date.now();
    await tick();                                                 // the engine opens the escalation (a real escalation.opened)
    const committed = Date.now();
    await page.locator(".needs .card").first().waitFor({ timeout: 5_000 });
    const latency = Date.now() - committed;
    expect(latency).toBeLessThan(2_000);
    expect(await text(".needs .card")).toMatch(/Beth Young/);
    expect(await text(".needs .card .card__kind")).toMatch(/Only you can do this · Career/);
    expect(await text(".needs-count")).toBe("1 needs you");
    expect(await text(".areas__row")).toMatch(/◆\s*Career/);
    // Live activity: the decision as history ("became your decision"), ◆ because Needs you lists it right now
    const bethUnit = page.locator(".activity .unit", { hasText: "No answer from Beth Young" });
    await bethUnit.locator(".unit__title", { hasText: "— became your decision" }).waitFor({ timeout: 2_000 });
    expect(await bethUnit.locator(".owner-mark--julian").count()).toBe(1);
    // ownership: Julian's card above the line, Finagai's wait below it (Beth's wait is not counted twice)
    const cardY = (await page.locator(".needs .card").first().boundingBox()).y, lineY = (await page.locator(".main > .ownership-line").boundingBox()).y;
    expect(cardY).toBeLessThan(lineY);
    expect(await text(".handling")).toMatch(/1 wait on other people/);
    expect(await text(".handling")).toMatch(/0 Mac tasks running/);                             // zero rows are information in the active layout
    expect(await page.locator("body").innerText()).not.toMatch(/LEAKCHECK|Finagai Test/);
    expect(await page.locator(".card--new").count()).toBe(1);                                    // the real event is the only thing that moved
    await shot(page, "2-desktop-needs-julian");
    void t0;
  }, 30_000);

  it("a disconnect reads as reconnecting, then offline and stale; it resumes from the cursor with exactly the missed events, once, and fresh state", async () => {
    const s0 = await state();
    expect(s0.conn).toBe("live");
    await page.evaluate(() => (window as any).__finagaiLive.interrupt(72_000));
    await page.locator(".conn--wait", { hasText: "Reconnecting" }).waitFor({ timeout: 2_000 });
    expect(await page.locator(".banner").count()).toBe(0);                                       // no body change for the first 60 s
    // while disconnected: Beth answers (Julian's decision resolves) and Finagai updates a wait
    await closeFollowup(pool, bethWait, "Beth replied");
    await tick();
    const chimes = (await q(`SELECT id FROM followup WHERE counterparty = 'Chimes'`))[0].id;
    await appendEvent(pool, { actor: "cos", action: "followup_updated", entityType: "followup", entityId: chimes, areaId: career, before: { due_at: "2026-10-20T15:00:00Z" }, after: { due_at: "2026-10-22T15:00:00Z" } });
    await page.locator(".banner--off").waitFor({ timeout: 70_000 });
    expect(await text(".banner--off")).toMatch(/^Live updates stopped at .+\. What you see is Finagai's state as of .+ and may have changed\. Retrying every 10 seconds\.$/);
    expect(await text(".conn")).toMatch(/Offline since/);
    expect(await text(".needs-count")).toMatch(/1 needs you \(as of .+\)/);                       // stale state is labeled, not presented as current
    expect(await text(".needs .card")).toMatch(/Beth Young/);                                     // and nothing changed underneath while offline
    await shot(page, "3-desktop-offline");
    // resume
    await page.locator(".banner--ok", { hasText: "Caught up" }).waitFor({ timeout: 20_000 });
    expect(await text(".conn")).toMatch(/Live/);
    const s1 = await state();
    const missed = (await q(`SELECT e.id::int AS id FROM live_event l JOIN event e ON e.id = l.event_id WHERE l.seq > $1 ORDER BY l.seq`, [s0.lastSeq])).map((r) => r.id as number);
    expect(missed.length).toBeGreaterThan(0);
    for (const id of missed) expect(s1.ids).toContain(id);                                      // nothing lost
    expect(new Set(s1.ids).size).toBe(s1.ids.length);                                            // nothing twice
    expect(s1.gaps).toHaveLength(1);
    expect(await text(".banner--ok")).toBe(`Caught up — ${s1.caughtUp.count} change${s1.caughtUp.count === 1 ? "" : "s"} while disconnected.`);
    expect(s1.caughtUp.count).toBeGreaterThanOrEqual(2);                                         // the resolution and the wait update (routine runs excluded)
    // the snapshot is refreshed once: Beth's decision is gone; Command is calm again
    await page.locator(".calm__statement").waitFor({ timeout: 5_000 });
    expect(await page.locator(".activity .gap").count()).toBe(1);
    expect(await text(".activity .gap")).toMatch(/^Disconnected .+ · \d+ changes? caught up$/);
    // the decision's story is now history in the past tense: one item, resolved, no ◆, no instruction repeated
    const story = page.locator(".activity .unit", { hasText: "No answer from Beth Young" });
    expect(await story.count()).toBe(1);
    expect(await story.locator(".unit__title").innerText()).toMatch(/— resolved \(follow-up done\)$/);
    expect(await story.locator(".owner-mark--julian").count()).toBe(0);
    expect(await page.locator(".activity").innerText()).not.toMatch(PRESENT_INSTRUCTION);
    await shot(page, "4-desktop-resumed");
  }, 120_000);

  it("a stream Core ends cleanly resumes silently: no reconnecting state, no banner, no gap", async () => {
    // streams end after 25 s in this fixture; watch a full cycle
    const g0 = (await state()).gaps.length;
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) { seen.add((await state()).conn); await sleep(1_000); }
    expect([...seen]).toEqual(["live"]);
    expect((await state()).gaps.length).toBe(g0);
  }, 60_000);

  it("a check that writes no event still moves 'last check' (the snapshot is re-read every minute)", async () => {
    const before = (await q(`SELECT max(id)::int AS m FROM event`))[0].m;
    const at = (await q(`INSERT INTO event_tick (started_at, finished_at, trigger, status) VALUES (now() + interval '3 minutes', now() + interval '3 minutes', 'interval', 'done') RETURNING started_at`))[0].started_at as Date;
    expect((await q(`SELECT max(id)::int AS m FROM event`))[0].m).toBe(before);                     // a quiet check: no event at all
    const want = await page.evaluate((iso: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso)), at.toISOString());
    await page.locator(".calm__line", { hasText: `last at ${want}` }).waitFor({ timeout: 75_000 });
    await q(`UPDATE event_tick SET status = 'skipped' WHERE started_at > now() + interval '1 minute'`);
  }, 90_000);

  it("a Mac step waiting for Julian's approval is a Needs-you card within 2 s — Command never says \"Nothing needs you\" meanwhile; approving clears it (hotfix 45)", async () => {
    await page.locator(".calm__statement").waitFor({ timeout: 5_000 });                   // starts calm
    const t = (await q(`INSERT INTO control_task (request) VALUES ('Report the macOS version') RETURNING id, code::int AS code`))[0] as { id: string; code: number };
    const s = (await q(`INSERT INTO control_step (task_id, seq, kind, params, risk, summary, status, authority_class, authority_decision) VALUES ($1, 1, 'run', '{}', 'write', 'Run the read-only command sw_vers -productVersion', 'proposed', 'HIGH_RISK', 'approve') RETURNING code::int AS code`, [t.id]))[0] as { code: number };
    const t0 = Date.now();
    await enterAwaitingHuman(pool, t.id, "approval", `step ${s.code}: Run the read-only command sw_vers -productVersion`);   // the real lifecycle
    const card = page.locator(".needs .card", { hasText: `Mac task ${t.code} is waiting for your approval — step ${s.code}` });
    await card.waitFor({ timeout: 2_000 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await card.locator(".card__kind").innerText()).toMatch(/^◆\s*Your approval/);
    expect(await page.locator(".calm__statement").count()).toBe(0);
    expect(await text(".needs-count")).toBe("1 needs you");
    expect(await page.locator(".main").innerText()).not.toMatch(/Nothing needs you/);
    // the wait is also one Live activity story, past tense, with ◆ because Needs you lists it right now
    const story = page.locator(".activity .unit", { hasText: `Mac task ${t.code}:` });
    await story.locator(".unit__title", { hasText: `Mac task ${t.code}: asked for your approval of step ${s.code}` }).waitFor({ timeout: 2_000 });
    expect(await story.locator(".owner-mark--julian").count()).toBe(1);
    // Julian approves: the escalation resolves with the step, and Command is calm again
    expect((await decideStep(pool, s.code, true)).status).toBe("approved");
    await page.locator(".calm__statement").waitFor({ timeout: 3_000 });
    expect(await page.locator(".needs .card").count()).toBe(0);
    // ... and the same story now says what happened — one item, not "Active" / "Changed" / "no longer needs you" fragments
    await story.locator(".unit__title", { hasText: `Mac task ${t.code}: you approved step ${s.code}` }).waitFor({ timeout: 3_000 });
    expect(await page.locator(".activity .unit", { hasText: `Mac task ${t.code}` }).count()).toBe(1);
    expect(await story.locator(".owner-mark--julian").count()).toBe(0);
    expect(await page.locator(".activity").innerText()).not.toMatch(PRESENT_INSTRUCTION);
    await q(`UPDATE control_task SET status = 'done' WHERE id = $1`, [t.id]);
  }, 30_000);

  it("Why inspector (Slice 3): Review opens it on the decision; the chain on screen is exactly Core's; technical details stay hidden; nothing in Core changes", async () => {
    const w = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Priya about the case study', 'Priya', 'waiting', now() - interval '1 hour', 'julian') RETURNING id`, [career]))[0].id;
    await sweepOverdue(pool); await tick();
    const card = page.locator(".needs .card", { hasText: "Priya" });
    await card.waitFor({ timeout: 5_000 });
    const escId = (await q(`SELECT id FROM escalation WHERE status = 'open' AND key LIKE $1`, [`overdue:${w}:%`]))[0].id as string;
    const latest = (await q(`SELECT max(id)::int AS id FROM event WHERE entity_type = 'escalation' AND entity_id = $1`, [escId]))[0].id as number;
    await sleep(1_000);
    const before = { fp: await businessFingerprint(), maxEvent: (await q(`SELECT max(id)::int AS m FROM event`))[0].m, maxSeq: (await q(`SELECT max(seq)::int AS m FROM live_event`))[0].m };
    const calls: string[] = []; const onReq = (r: any) => { if (r.url().includes("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`); };
    page.on("request", onReq);

    await card.getByRole("link", { name: "Review" }).click();
    const why = page.locator(".why");
    await why.locator(".chain").waitFor({ timeout: 5_000 });
    expect(new URL(page.url()).searchParams.get("why")).toBe(`escalation:${escId}`);              // deep-linkable state
    // the chain on screen == Core's chain for the decision's latest event (and == what the BFF served), root last
    const shown = async () => (await why.locator(".chain .chain__item").evaluateAll((els: Element[]) => els.map((e) => Number(e.getAttribute("data-event-id")))));
    const core = await causalChain(pool, latest);
    expect(await shown()).toEqual(core.map((e) => e.eventId));
    expect(await shown()).toEqual(await page.evaluate(async (id: number) => (await (await fetch(`/api/live/chain/${id}`)).json()).chain.map((e: any) => e.eventId), latest));
    expect(await why.locator(".chain__item--root").getAttribute("data-event-id")).toBe(String(latest));
    // every recorded starting point says so; nothing is shown as missing when nothing is
    for (const e of core.filter((x) => x.cause.eventIds.length === 0)) expect(await why.locator(`.chain__item[data-event-id="${e.eventId}"] .chain__start`).count()).toBe(1);
    expect(await why.locator(".chain__missing").count()).toBe(0);
    // what it says: the decision (no instruction), Julian's now (from the snapshot), what only he can do while it is open
    expect(await why.locator(".why__title").innerText()).toMatch(/^No answer from Priya by \d{4}-\d{2}-\d{2}$/);
    expect(await why.locator(".why__status").innerText()).toMatch(/◆\s*Yours now · Only you can do this · Career/);
    const owner = await why.locator("section[aria-labelledby=why-owner]").innerText();
    expect(owner).toMatch(/You — open in Needs you since/);
    expect(owner).toMatch(/Finagai can\s+draft the follow-up/); expect(owner).toMatch(/Only you can\s+decide whether to nudge/);
    expect(await why.locator(".chain").innerText()).toMatch(/Became your decision/);
    // evidence = exactly the chain's evidence events
    expect(await why.locator(".why__evidence li").evaluateAll((els: Element[]) => els.map((e) => Number(e.getAttribute("data-event-id")))))
      .toEqual(core.filter((e) => e.domain === "evidence").map((e) => e.eventId));
    expect(await why.innerText()).not.toMatch(/What happened next|Consequences/);               // no endpoint → no consequences shown
    // technical details: hidden by default; ids only once asked for
    const corr = core.find((e) => e.eventId === latest)!.cause.correlationId!;
    expect(await why.locator(".why__tech").evaluate((d: HTMLDetailsElement) => d.open)).toBe(false);
    expect(await why.innerText()).not.toContain(corr);
    expect(await why.innerText()).not.toContain(escId);
    await shot(page, "7-desktop-why-review");
    await why.locator(".why__tech summary").click();
    expect(await why.locator(".why__tech").innerText()).toContain(corr);
    // re-root on an ancestor: its own chain, breadcrumb back
    const ancestor = why.locator(".chain__item:has(.chain__row--link)").last();
    const ancId = Number(await ancestor.getAttribute("data-event-id"));
    await ancestor.locator(".chain__row--link").click();
    await page.locator(`.why[data-why="${ancId}"] .chain`).waitFor({ timeout: 5_000 });
    expect(new URL(page.url()).searchParams.get("why")).toBe(String(ancId));
    expect(await shown()).toEqual((await causalChain(pool, ancId)).map((e) => e.eventId));
    expect(await why.locator(".why__trail").innerText()).toMatch(/No answer from Priya/);
    await why.locator(".why__trail button").first().click();
    await page.locator(`.why[data-why="escalation:${escId}"] .chain`).waitFor({ timeout: 5_000 });
    // Esc closes and gives focus back to Review
    await page.keyboard.press("Escape");
    await why.waitFor({ state: "detached", timeout: 3_000 });
    expect(new URL(page.url()).searchParams.has("why")).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Review");
    // Why? from the activity story opens it on the story's most significant event; the browser's back closes it
    const priya = page.locator(".activity .unit", { hasText: "No answer from Priya" });
    await priya.locator(".unit__why").click();
    const rootId = Number(new URL(page.url()).searchParams.get("why"));
    await page.locator(`.why[data-why="${rootId}"] .chain`).waitFor({ timeout: 5_000 });
    expect(await shown()).toEqual((await causalChain(pool, rootId)).map((e) => e.eventId));
    await page.goBack();
    await why.waitFor({ state: "detached", timeout: 3_000 });

    // read-only: only GETs, and Core has not changed — no business row, no semantic event, no stream entry
    page.off("request", onReq);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/^GET \/api\/live\/(snapshot|history|chain\/\d+|summary\/reliability|stream|events)$/);
    await sleep(1_000);
    expect(await businessFingerprint()).toEqual(before.fp);
    expect((await q(`SELECT max(id)::int AS m FROM event`))[0].m).toBe(before.maxEvent);
    expect((await q(`SELECT max(seq)::int AS m FROM live_event`))[0].m).toBe(before.maxSeq);

    // once Priya answers, the same decision is history: past tense, no ◆, and the inspector says nothing is open now
    await closeFollowup(pool, w, "Priya replied"); await tick();
    await priya.locator(".unit__title", { hasText: "— resolved" }).waitFor({ timeout: 5_000 });
    await page.locator(".needs .card", { hasText: "Priya" }).waitFor({ state: "detached", timeout: 3_000 });   // the snapshot caught up
    expect(await priya.locator(".owner-mark--julian").count()).toBe(0);                                   // ◆ follows the snapshot
    await priya.locator(".unit__why").click();
    await why.locator(".chain").waitFor({ timeout: 5_000 });
    const text = await why.innerText();
    expect(text).toMatch(/Nothing about this is open now\./);
    expect(text).not.toMatch(/Yours now|Only you can|◆/);
    expect(text).not.toMatch(PRESENT_INSTRUCTION);
    await shot(page, "8-desktop-why-resolved");
    await why.locator(".why__close").click();
    await why.waitFor({ state: "detached", timeout: 3_000 });
  }, 90_000);

  it("Why inspector: for 20 events, the chain on screen equals /live/chain; a cause Core doesn't have is shown as missing; deep links open it", async () => {
    // a recorded chain longer than Core follows (8 levels), whose first event cites a cause Core no longer has
    const chimes = (await q(`SELECT id FROM followup WHERE counterparty = 'Chimes'`))[0].id;
    let prev = await appendEvent(pool, { actor: "job", action: "work_invoked", causeIds: [987_654_321], after: { what: "job:daily_maintenance" } });
    const ids = [prev];
    for (let i = 0; i < 10; i++) { prev = await appendEvent(pool, { actor: "cos", action: "followup_updated", entityType: "followup", entityId: chimes, areaId: career, causeIds: [prev], before: { n: i }, after: { n: i + 1 } }); ids.push(prev); }
    const open = async (target: string) => {
      await page.evaluate((t: string) => { history.pushState(null, "", `/?diag&why=${t}`); dispatchEvent(new PopStateEvent("popstate")); }, target);
      await page.locator(`.why[data-why="${target}"] .chain, .why[data-why="${target}"] .why__title`).first().waitFor({ timeout: 5_000 });
      await page.locator(`.why[data-why="${target}"] [role=status]`).waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    };
    const shown = () => page.locator(".why .chain .chain__item").evaluateAll((els: Element[]) => els.map((e) => Number(e.getAttribute("data-event-id"))));
    // deepest: Core walks 8 levels; the 9th cause back is recorded but not in the chain → shown as missing, not invented
    await open(String(prev));
    const core = await causalChain(pool, prev);
    expect(core).toHaveLength(8);
    expect(await shown()).toEqual(core.map((e) => e.eventId));
    const missing = page.locator(".why .chain__missing");
    expect(await missing.count()).toBe(1);
    expect(await missing.getAttribute("data-missing-causes")).toBe(String(ids[ids.length - 9]));
    expect(await page.locator(".why .chain__item").first().locator(".chain__missing").count()).toBe(1);
    // the first event cites a cause outside what Core keeps
    await open(String(ids[0]));
    expect(await shown()).toEqual([ids[0]]);
    expect(await page.locator(".why .chain__missing").getAttribute("data-missing-causes")).toBe("987654321");
    expect(await page.locator(".why .chain__start").count()).toBe(0);                              // it had a cause: not a starting point
    await shot(page, "9-desktop-why-missing");
    // 20 events across the store: every line on screen has an event id behind it, and the ids are Core's chain
    const sample = (await q(`SELECT e.id::int AS id FROM event e JOIN live_event l ON l.event_id = e.id ORDER BY random() LIMIT 20`)).map((r) => r.id as number);
    for (const id of sample) {
      await open(String(id));
      const items = page.locator(".why .chain .chain__item");
      expect(await items.count()).toBe((await items.evaluateAll((els: Element[]) => els.filter((e) => e.getAttribute("data-event-id")).length)));
      expect(await shown()).toEqual((await causalChain(pool, id)).map((e) => e.eventId));
    }
    // an object deep link resolves to its latest event; a malformed one says so
    const anyEsc = (await q(`SELECT entity_id::text AS id FROM event WHERE entity_type = 'escalation' AND area_id = $1 ORDER BY id DESC LIMIT 1`, [career]))[0].id as string;
    await page.goto(`${bffBase}/?diag&why=escalation:${anyEsc}`);                                   // a real page load from the link
    await page.locator(`.why[data-why="escalation:${anyEsc}"] .chain`).waitFor({ timeout: 10_000 });
    const latest = (await q(`SELECT max(id)::int AS id FROM event WHERE entity_type = 'escalation' AND entity_id = $1`, [anyEsc]))[0].id as number;
    expect(await page.locator(".why .chain__item--root").getAttribute("data-event-id")).toBe(String(latest));
    await page.evaluate(() => { history.pushState(null, "", "/?diag&why=nonsense!"); dispatchEvent(new PopStateEvent("popstate")); });
    await page.locator('.why[data-why="invalid"]', { hasText: "doesn't point to anything Finagai recorded" }).waitFor({ timeout: 3_000 });
    await page.locator(".why__close").click();
    await page.locator(".why").waitFor({ state: "detached", timeout: 3_000 });
  }, 120_000);

  it("renders the mobile layout at 390×844: Needs you / ownership line / handling / recent changes / Areas, no horizontal scroll", async () => {
    const m = await signedInPage({ width: 390, height: 844 });
    await m.locator(".calm__statement").waitFor({ timeout: 10_000 });
    expect(await m.evaluate(() => getComputedStyle(document.querySelector(".calm__statement")!).fontSize)).toBe("30px");
    for (const sel of [".areas", ".activity", ".strip"]) expect(await m.locator(sel).isVisible()).toBe(false);
    expect(await m.locator(".mobile-recent").isVisible()).toBe(true);
    expect(await m.locator(".mobile-areas").innerText()).toMatch(/Career/);
    expect(await m.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(m, "5-mobile-calm");
    // and with a decision open
    const w = (await q(`INSERT INTO followup (area_id, summary, counterparty, state, due_at, origin) VALUES ($1, 'Waiting on Dana about references', 'Dana', 'waiting', now() - interval '2 hours', 'julian') RETURNING id`, [career]))[0].id;
    await sweepOverdue(pool); await tick();
    await m.locator(".needs .card").first().waitFor({ timeout: 5_000 });
    expect(await m.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const order = await m.evaluate(() => [".needs", ".main > .ownership-line", ".handling", ".mobile-recent", ".mobile-areas"].map((s) => document.querySelector(s)!.getBoundingClientRect().top));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await shot(m, "6-mobile-needs-julian");
    // the inspector is a full-screen sheet on mobile; back (gesture) closes it
    await m.locator(".needs .card").first().getByRole("link", { name: "Review" }).click();
    await m.locator(".why .chain").waitFor({ timeout: 5_000 });
    await m.waitForFunction(() => document.getAnimations().length === 0);                        // the 180 ms open (user action) has finished
    expect(await m.locator(".why").boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    expect(await m.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await m.evaluate(() => { const el = document.querySelector(".why__body")!; return el.scrollWidth <= el.clientWidth; })).toBe(true);
    await shot(m, "10-mobile-why");
    await m.goBack();
    await m.locator(".why").waitFor({ state: "detached", timeout: 3_000 });
    await closeFollowup(pool, w, "answered"); await tick();
    await m.context().close();
  }, 60_000);

  it("no Core access or refresh token is reachable from the browser: storage, cookies, DOM, URLs or any response body", async () => {
    const reach = await page.evaluate(async () => ({
      cookie: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }),
      idb: JSON.stringify(await (indexedDB as any).databases?.() ?? []), dom: document.documentElement.outerHTML,
    }));
    const cookies = await page.context().cookies();
    const session = cookies.find((c: any) => /fcc/.test(c.name));
    expect(session?.httpOnly).toBe(true);
    expect(reach.cookie).not.toMatch(/fcc/);                                                     // HttpOnly: invisible to JS
    expect(provider.issued.length).toBeGreaterThan(0);
    for (const t of provider.issued) {
      for (const v of [reach.cookie, reach.local, reach.session, reach.idb, reach.dom, ...urls, ...bodies, ...cookies.map((c: any) => c.value)]) expect(v.includes(t)).toBe(false);
    }
  }, 30_000);
});
