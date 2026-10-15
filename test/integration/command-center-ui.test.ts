/**
 * ADR-089 slices 1–2 — the Command screen in a real browser (headless Chromium), end to end:
 *   real Core HTTP handler + test database  ←  BFF (session cookie, server-held tokens)  ←  the built SPA (command/dist/web)
 * signed in through a stand-in OIDC provider. Proves the Command Live acceptance points that can be proven off production:
 * calm state, ownership line, Needs you only from open escalations, no internal-Area/canary/low-value leakage, a real
 * engine-raised decision appears within 2 s (with motion only for that real event), a disconnect goes reconnecting →
 * offline/stale → resumes from the cursor with exactly the missed events and a fresh snapshot, mobile layout, zero
 * business writes and zero semantic events from the UI, and no Core token anywhere the browser can reach.
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
import { appendEvent } from "../../src/db/index.js";
import { runTick } from "../../src/events/index.js";
import type { AreaModule } from "../../src/events/types.js";
import { liveHandler } from "../../src/live/http.js";
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

describe.skipIf(!admin || !migT || !appT || !haveUi)("Command screen in a browser (ADR-089 slices 1–2)", () => {
  let provider: Awaited<ReturnType<typeof startFakeOidc>>; let bffBase = "";
  let browser: any; let page: any; let career = ""; let bethWait = "";
  const bodies: string[] = []; const urls: string[] = [];
  const shot = async (p: any, name: string) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); } };
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
    await page.locator(".activity .unit", { hasText: "now your decision" }).first().waitFor({ timeout: 2_000 });
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
    expect(await page.locator(".activity .unit", { hasText: "no longer needs you" }).count()).toBe(1);
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

  it("a Mac task waiting on Julian's approval appears in Live activity within 2 s, marked ◆ (production finding 2026-10-15)", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    await appendEvent(pool, { actor: "julian", action: "control_task_created", entityType: "control_task", entityId: id, after: { code: 901, request: "Report the macOS version", requester: "julian" } });
    const t0 = Date.now();
    await appendEvent(pool, { actor: "j6", action: "control_task_state", entityType: "control_task", entityId: id, before: { status: "active" },
      after: { status: "waiting_approval", reason: "step 1: Run the read-only command sw_vers", waitingFor: "julian", awaiting_kind: "approval" } });
    const unit = page.locator(".activity .unit", { hasText: "Mac task is waiting for your approval — Run the read-only command sw_vers" });
    await unit.waitFor({ timeout: 2_000 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await unit.locator(".owner-mark--julian").count()).toBe(1);
    expect(await page.locator(".activity .unit", { hasText: "Mac task 901 started: Report the macOS version" }).count()).toBe(1);
  }, 30_000);

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
