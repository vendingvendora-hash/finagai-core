/**
 * Phase 5 (ADR-084) — the event engine. One tick:
 *   1. poll every DUE watcher (mail, calendar, deadlines, Area-specific sources); record each real-world event ONCE
 *   2. route every new event to the Areas that subscribe to it (with the reason) — or record why it was ignored
 *   3. run each workflow ONCE with all its events (ten emails = one sync); Finagai-owned actions happen here
 *   4. derive what genuinely needs Julian from STATE (judgment / authorization / principal-reserved), escalate each
 *      need once, resolve escalations whose source item closed
 *   5. notify Julian of new escalations in one digest (outside quiet hours)
 * Single runner (advisory lock); a preview computes the same tick and writes nothing (no cursors, no events, no sends).
 */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { appendEvent, withCause } from "../db/index.js";
import { areaHealth } from "../cos/areas.js";
import { deliverOnce, type DeliveryStore, type EmailSender } from "../notify/delivery.js";
import { RULE_NEEDS } from "../cos/lifecycle.js";
import { routingOverride } from "../learning/apply.js";
import { runExceptions } from "../exceptions/index.js";
import { evaluateRules } from "../exceptions/rules.js";
import type { DetectorDeps } from "../exceptions/detectors.js";
import type { AreaModule, EngineCtx, EscalationNeed, RawEvent, StoredEvent, Subscription, Workflow } from "./types.js";

const LOCK_KEY = 84_005;   // pg advisory lock id for the event engine
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export interface EngineDeps {
  modules: AreaModule[];
  /** Phase 7 (ADR-086): what the exception detectors may read beyond the database (budget meter) */
  exceptions?: DetectorDeps;
  notify?: { store: DeliveryStore; sender: EmailSender; timezone: string; quietHours?: [number, number] } | undefined;
}
export interface TickResult {
  tickId: string | null; trigger: string; preview: boolean; skipped?: string;
  watchers: Array<{ name: string; polled: boolean; events: number; newEvents: number; problems: string[] }>;
  events: Array<{ summary: string; kind: string; status: string; routes: Array<{ subscription: string; area: string; workflow: string; why: string }>; reason?: string | null }>;
  workflows: Array<{ name: string; events: number; ok: boolean; changes: string[]; error?: string }>;
  escalations: { opened: string[]; resolved: string[]; open: number; notified: string[]; held?: string };
  exceptions?: { open: number; opened: string[]; resolved: string[]; remedied: string[]; rulesFired: string[]; problems: string[] };
}

function localHour(now: Date, tz: string): number { return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now)); }

export async function runTick(pool: pg.Pool, ctxIn: Omit<EngineCtx, "pool">, deps: EngineDeps, trigger: "interval" | "manual" | "preview"): Promise<TickResult> {
  const ctx: EngineCtx = { ...ctxIn, pool };
  const lock = await pool.connect();
  const result: TickResult = { tickId: null, trigger, preview: ctx.dryRun, watchers: [], events: [], workflows: [], escalations: { opened: [], resolved: [], open: 0, notified: [] } };
  try {
    const got = (await lock.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY])).rows[0]?.ok;
    if (!got) return { ...result, skipped: "another tick is running" };
    try {
      if (!ctx.dryRun) result.tickId = String((await pool.query(`INSERT INTO event_tick (trigger) VALUES ($1) RETURNING id`, [trigger])).rows[0].id);
      try {
        // ADR-087: one tick = one unit of work; every event it causes carries this correlation id.
        await withCause({ correlationId: result.tickId ?? randomUUID(), causeIds: [] }, () => tick(ctx, deps, result));
        if (result.tickId) await pool.query(`UPDATE event_tick SET status = 'done', finished_at = now(), stats = $2::jsonb WHERE id = $1`, [result.tickId, JSON.stringify(statsOf(result))]);
      } catch (e) {
        if (result.tickId) await pool.query(`UPDATE event_tick SET status = 'failed', finished_at = now(), error = $2, stats = $3::jsonb WHERE id = $1`, [result.tickId, String((e as Error)?.stack ?? e).slice(0, 2000), JSON.stringify(statsOf(result))]);
        throw e;
      }
    } finally { await lock.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]); }
  } finally { lock.release(); }
  return result;
}

const statsOf = (r: TickResult) => ({ watchers: r.watchers, events: r.events.length, routed: r.events.filter((e) => e.routes.length).length,
  workflows: r.workflows.map((w) => ({ name: w.name, events: w.events, ok: w.ok, changes: w.changes.length, error: w.error ?? null })), escalations: r.escalations, exceptions: r.exceptions ?? null });

async function tick(ctx: EngineCtx, deps: EngineDeps, result: TickResult) {
  const { pool } = ctx;
  const watchers = deps.modules.flatMap((m) => m.watchers);
  const subs = deps.modules.flatMap((m) => m.subscriptions);
  const flows = new Map(deps.modules.flatMap((m) => m.workflows).map((w) => [w.name, w] as const));

  const observedEvent = new Map<string, number>();     // inbound_event id → its evidence_observed event id (ADR-087)
  const routedEvent = new Map<string, number>();       // inbound_event id → its evidence_routed event id
  // 1) watchers → recorded events (idempotent)
  const cursorRows = (await pool.query(`SELECT watcher, scope, cursor, updated_at FROM event_cursor`)).rows;
  const inMemory: StoredEvent[] = [];      // preview: events are routed without being stored
  for (const w of watchers) {
    const mine = cursorRows.filter((c) => c.watcher === w.name);
    const last = mine.length ? Math.max(...mine.map((c) => new Date(c.updated_at).getTime())) : 0;
    // Live (first ticks 2026-10-09): ticks are 5 min apart but not aligned with the watcher's own clock, so a strict
    // "≥ everyMs" made the 5-min mail watcher poll every 10 min. A watcher is due within one minute of its interval.
    if (w.everyMs > 0 && last && ctx.now.getTime() - last < w.everyMs - 60_000 && !ctx.dryRun) { result.watchers.push({ name: w.name, polled: false, events: 0, newEvents: 0, problems: [] }); continue; }
    let polled: { events: RawEvent[]; cursors: Array<{ scope: string; cursor: string }>; problems: string[] };
    try { polled = await w.poll(ctx, new Map(mine.map((c) => [String(c.scope), String(c.cursor)]))); }
    catch (e) { result.watchers.push({ name: w.name, polled: true, events: 0, newEvents: 0, problems: [String((e as Error)?.message ?? e).slice(0, 200)] }); continue; }
    let fresh = 0;
    for (const ev of polled.events) {
      if (ctx.dryRun) {
        const seen = await pool.query(`SELECT 1 FROM inbound_event WHERE source = $1 AND external_id = $2`, [ev.source, ev.externalId]);
        if (!seen.rowCount) { fresh++; inMemory.push({ ...ev, id: `preview:${sha(ev.source + ev.externalId)}`, status: "new" }); }
        continue;
      }
      const ins = await pool.query(`INSERT INTO inbound_event (occurred_at, source, kind, external_id, summary, payload, tick_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (source, external_id) DO NOTHING RETURNING id`, [ev.occurredAt, ev.source, ev.kind, ev.externalId, ev.summary.slice(0, 300), JSON.stringify(ev.payload), result.tickId]);
      fresh += ins.rowCount ?? 0;
      // ADR-087: the real-world input enters the live record (the head of every causal chain it starts).
      if (ins.rowCount) observedEvent.set(String(ins.rows[0].id), await appendEvent(pool, { actor: "system", action: "evidence_observed", entityType: "inbound_event", entityId: String(ins.rows[0].id),
        after: { source: ev.source, kind: ev.kind, summary: ev.summary.slice(0, 200), occurredAt: ev.occurredAt } }));
    }
    if (!ctx.dryRun) for (const c of polled.cursors)
      await pool.query(`INSERT INTO event_cursor (watcher, scope, cursor, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (watcher, scope) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`, [w.name, c.scope, c.cursor, ctx.now]);
    result.watchers.push({ name: w.name, polled: true, events: polled.events.length, newEvents: fresh, problems: polled.problems });
  }

  // 2) route new events (and retry failed ones from the last 6 h)
  const pending: StoredEvent[] = ctx.dryRun ? inMemory : (await pool.query(`SELECT id, source, kind, external_id AS "externalId", occurred_at AS "occurredAt", summary, payload, status FROM inbound_event
     WHERE status = 'new' OR (status = 'failed' AND attempts < 5) ORDER BY occurred_at, id LIMIT 500`)).rows
    .map((r) => ({ ...r, occurredAt: new Date(r.occurredAt).toISOString() }));
  const byFlow = new Map<string, StoredEvent[]>();
  const routesOf = new Map<string, Array<{ subscription: string; area: string; workflow: string; why: string }>>();
  for (const e of pending) {
    const routes: Array<{ subscription: string; area: string; workflow: string; why: string }> = [];
    // Phase 6 (ADR-085): Julian's stated routing correction for this sender comes first. "ignore" silences the Areas'
    // subscriptions only — waits and deadlines (area "*") still see the mail, so a reply still closes a wait.
    const override = e.kind === "mail.received" ? await routingOverride(pool, e.payload).catch(() => null) : null;
    if (override?.action === "route" && override.workflow && flows.has(override.workflow) && subs.some((s) => s.area !== "*" && s.workflow === override.workflow)) {
      const area = subs.find((s) => s.workflow === override.workflow)!.area;
      routes.push({ subscription: `lesson:${override.key}`, area, workflow: override.workflow, why: `Julian said mail from ${override.sender} belongs to ${override.workflow}` });
      byFlow.set(override.workflow, [...(byFlow.get(override.workflow) ?? []), e]);
    }
    for (const s of subs) {
      if (override && s.area !== "*") continue;
      let why: string | null = null;
      try { why = await s.match(e, ctx); } catch (err) { why = null; ctx.log?.("subscription match failed", { sub: s.id, error: String((err as Error)?.message ?? err).slice(0, 160) }); }
      if (why) { routes.push({ subscription: s.id, area: s.area, workflow: s.workflow, why }); byFlow.set(s.workflow, [...(byFlow.get(s.workflow) ?? []), e]); }
    }
    routesOf.set(e.id, routes);
    const reason = routes.length ? null : override?.action === "ignore" ? `Julian said mail from ${override.sender} is not for any Area` : "no Area subscribes to this event";
    if (!ctx.dryRun) {
      await pool.query(`UPDATE inbound_event SET status = $2, routes = $3::jsonb, reason = $4, handled_at = CASE WHEN $2 = 'ignored' THEN now() ELSE handled_at END WHERE id = $1`,
        [e.id, routes.length ? "routed" : "ignored", JSON.stringify(routes), reason]);
      const observed = observedEvent.get(e.id) ?? Number((await pool.query(`SELECT id FROM event WHERE action = 'evidence_observed' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [e.id])).rows[0]?.id ?? 0);
      const areaName = routes.find((r) => r.area !== "*")?.area;
      const areaId = areaName ? ((await pool.query(`SELECT id FROM area WHERE lower(name) = lower($1)`, [areaName])).rows[0]?.id as string | undefined) ?? null : null;
      routedEvent.set(e.id, await appendEvent(pool, { actor: "system", action: "evidence_routed", entityType: "inbound_event", entityId: e.id, areaId,
        ...(observed ? { causeIds: [observed] } : {}), after: { summary: e.summary.slice(0, 200), routes: routes.map((r) => ({ area: r.area, workflow: r.workflow, why: r.why.slice(0, 160) })), reason } }));
    }
    result.events.push({ summary: e.summary, kind: e.kind, status: routes.length ? "routed" : "ignored", routes, reason });
  }

  // 3) workflows, once each, with all their events
  const needs: EscalationNeed[] = [];
  for (const [name, evs] of byFlow) {
    const wf = flows.get(name) as Workflow | undefined;
    if (!wf) { result.workflows.push({ name, events: evs.length, ok: false, changes: [], error: "no such workflow" }); continue; }
    const causes = evs.map((e) => routedEvent.get(e.id)).filter((x): x is number => !!x);
    const startedId = ctx.dryRun ? 0 : await appendEvent(pool, { actor: "cos", action: "workflow_started", entityType: "event_tick", ...(result.tickId ? { entityId: result.tickId } : {}),
      causeIds: causes, after: { workflow: name, events: evs.length, inbound: evs.slice(0, 20).map((e) => e.id) } });
    try {
      const r = await withCause({ causeIds: startedId ? [startedId] : [] }, () => wf.run(ctx, evs));
      needs.push(...r.escalations.map((x) => ({ ...x, detail: x.detail ?? `from ${evs.length} event(s): ${evs.slice(0, 3).map((e) => e.summary).join(" | ")}` })));
      result.workflows.push({ name, events: evs.length, ok: true, changes: r.changes });
      if (!ctx.dryRun) {
        await pool.query(`UPDATE inbound_event SET status = 'handled', handled_at = now(), attempts = attempts + 1, reason = NULL WHERE id = ANY($1::uuid[]) AND status IN ('routed','failed')`, [evs.map((e) => e.id)]);
        await appendEvent(pool, { actor: "cos", action: "workflow_completed", entityType: "event_tick", ...(result.tickId ? { entityId: result.tickId } : {}), causeIds: [startedId],
          after: { workflow: name, events: evs.length, changes: r.changes.slice(0, 30), escalations: r.escalations.length } });
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      result.workflows.push({ name, events: evs.length, ok: false, changes: [], error: msg });
      if (!ctx.dryRun) {
        await pool.query(`UPDATE inbound_event SET status = 'failed', attempts = attempts + 1, reason = $2 WHERE id = ANY($1::uuid[])`, [evs.map((x) => x.id), `${name} failed: ${msg}`.slice(0, 500)]);
        await appendEvent(pool, { actor: "cos", action: "workflow_failed", entityType: "event_tick", ...(result.tickId ? { entityId: result.tickId } : {}), causeIds: [startedId], after: { workflow: name, events: evs.length, error: msg } });
      }
    }
  }

  // 4) Phase 7 (ADR-086): management by exception — detect what is wrong, remedy what Finagai owns, and add only what
  //    needs Julian (or outlived Finagai's remedies); then Julian's own "tell me when" rules.
  try {
    const ex = await runExceptions(pool, ctx.now, ctx.dryRun, deps.exceptions ?? {});
    const rules = await evaluateRules(pool, ctx.now, ctx.dryRun, deps.exceptions ?? {});
    needs.push(...ex.needs, ...rules.needs);
    result.exceptions = { open: ex.open, opened: ex.opened, resolved: ex.resolved, remedied: ex.remedied, rulesFired: rules.fired, problems: [...ex.detectorProblems, ...rules.problems] };
  } catch (e) { result.exceptions = { open: -1, opened: [], resolved: [], remedied: [], rulesFired: [], problems: [String((e as Error)?.message ?? e).slice(0, 200)] }; }

  // 5) escalations: derived from state (the single source of truth) + workflow judgments
  needs.push(...await stateNeeds(pool, ctx.now));
  await reconcileEscalations(ctx, needs, result);

  // ADR-087: Area health is state — a change of colour is an event.
  if (!ctx.dryRun) await recordAreaHealth(pool);

  // 6) one digest for new escalations
  if (deps.notify) await notifyDigest(ctx, deps.notify, result);
}

/** What only Julian can do right now, read from state — independent of which event (if any) revealed it. */
export async function stateNeeds(db: Pick<pg.Pool, "query">, now: Date): Promise<EscalationNeed[]> {
  const out: EscalationNeed[] = [];
  // a) lifecycle steps the policy put on Julian's plate (each declares why)
  for (const f of (await db.query(`SELECT f.id, f.summary, f.rule, f.due_at, COALESCE(f.area_id, p.area_id) AS area_id FROM followup f LEFT JOIN project p ON p.id = f.project_id
      WHERE f.origin = 'lifecycle' AND f.state IN ('open','overdue') AND f.rule = ANY($1::text[])`, [Object.keys(RULE_NEEDS)])).rows)
    out.push({ key: `followup:${f.id}`, needs: RULE_NEEDS[f.rule]!, summary: f.summary, areaId: f.area_id, followupId: f.id, dueAt: f.due_at ? new Date(f.due_at).toISOString() : null });
  // b) something Julian himself is waiting on went past its date with no answer: following up goes out as him
  for (const f of (await db.query(`SELECT f.id, f.summary, f.counterparty, f.due_at, COALESCE(f.area_id, p.area_id) AS area_id FROM followup f LEFT JOIN project p ON p.id = f.project_id
      WHERE f.origin IN ('julian','bootstrap') AND f.state IN ('open','waiting','overdue') AND f.due_at IS NOT NULL AND f.due_at <= $1`, [now])).rows)
    out.push({ key: `overdue:${f.id}:${new Date(f.due_at).toISOString().slice(0, 10)}`, needs: "principal_reserved", areaId: f.area_id, followupId: f.id, dueAt: new Date(f.due_at).toISOString(),
      summary: `No answer from ${f.counterparty ?? "them"} by ${new Date(f.due_at).toISOString().slice(0, 10)} — approve a follow-up (Finagai drafts it; it goes out as you), give a new date, or close it`, detail: f.summary });
  // c) Phase 6 (ADR-085): a behaviour change Finagai inferred applies only with Julian's authorization (passkey approval
  //    of the proposal); until then it is only proposed. Resolved automatically once he decides (or it is withdrawn).
  for (const l of (await db.query(`SELECT l.key, l.statement, l.area_id, p.id AS pid FROM lesson l JOIN proposal p ON p.id = l.proposal_id AND p.status = 'pending' WHERE l.status = 'proposed'`)).rows)
    out.push({ key: `lesson:${l.key}:${l.pid}`, needs: "authorization", areaId: l.area_id,
      summary: `Finagai learned something that would change how it works — approve applying it? ${String(l.statement).slice(0, 300)}`,
      detail: `Learned-change proposal ${l.pid}: ask Finagai to show pending proposals; approving or rejecting uses request_proposal_decision (your passkey). Nothing changes until you approve.` });
  return out;
}

async function reconcileEscalations(ctx: EngineCtx, needs: EscalationNeed[], result: TickResult) {
  const { pool } = ctx;
  const want = new Map(needs.map((n) => [n.key, n]));
  const open = (await pool.query(`SELECT e.id, e.key, e.summary, e.needs, e.notified_at, e.followup_id, f.state AS fstate FROM escalation e LEFT JOIN followup f ON f.id = e.followup_id WHERE e.status = 'open'`)).rows;
  // Resolve what no longer needs Julian (its follow-up closed / moved on, or a state-derived need disappeared).
  for (const o of open) {
    // A notification Julian asked for is done once it has been delivered.
    if (o.needs === "requested") {
      if (o.notified_at) { result.escalations.resolved.push(o.summary); if (!ctx.dryRun) { await pool.query(`UPDATE escalation SET status = 'resolved', resolved_at = now(), resolution = 'told' WHERE id = $1`, [o.id]);
        await appendEvent(pool, { actor: "cos", action: "escalation_resolved", entityType: "escalation", entityId: o.id, after: { key: o.key, needs: o.needs, resolution: "told" } }); } }
      continue;
    }
    const stateDerived = /^(followup|overdue|lesson|exception):/.test(o.key);
    if ((o.followup_id && (o.fstate === "done" || o.fstate === "cancelled")) || (stateDerived && !want.has(o.key))) {
      result.escalations.resolved.push(o.summary);
      if (!ctx.dryRun) {
        const resolution = o.fstate === "done" || o.fstate === "cancelled" ? `follow-up ${o.fstate}` : "no longer needed";
        await pool.query(`UPDATE escalation SET status = 'resolved', resolved_at = now(), resolution = $2 WHERE id = $1`, [o.id, resolution]);
        await appendEvent(pool, { actor: "cos", action: "escalation_resolved", entityType: "escalation", entityId: o.id, after: { key: o.key, needs: o.needs, resolution, summary: o.summary } });
      }
    }
  }
  const openKeys = new Set(open.map((o) => o.key));
  for (const n of want.values()) {
    if (openKeys.has(n.key)) continue;
    const seen = await pool.query(`SELECT status FROM escalation WHERE key = $1`, [n.key]);
    if (seen.rowCount) continue;                    // resolved before: never re-escalated for the same key
    result.escalations.opened.push(`[${n.needs}] ${n.summary}`);
    if (!ctx.dryRun) {
      const ins = await pool.query(`INSERT INTO escalation (key, area_id, needs, summary, detail, due_at, followup_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (key) DO NOTHING RETURNING id`,
        [n.key, n.areaId ?? null, n.needs, n.summary.slice(0, 500), n.detail?.slice(0, 1000) ?? null, n.dueAt ?? null, n.followupId ?? null]);
      if (ins.rowCount) await appendEvent(pool, { actor: "cos", action: "escalation_opened", entityType: "escalation", entityId: String(ins.rows[0].id), areaId: n.areaId ?? null,
        after: { key: n.key, needs: n.needs, summary: n.summary.slice(0, 300), dueAt: n.dueAt ?? null } });
    }
  }
  result.escalations.open = ctx.dryRun ? open.length - result.escalations.resolved.length + result.escalations.opened.length
    : Number((await pool.query(`SELECT count(*)::int AS n FROM escalation WHERE status = 'open'`)).rows[0].n);
}

const NEEDS_LABEL = { judgment: "your decision", authorization: "your authorization", principal_reserved: "only you can do this", requested: "you asked to be told" } as const;

async function notifyDigest(ctx: EngineCtx, n: NonNullable<EngineDeps["notify"]>, result: TickResult) {
  const rows = (await ctx.pool.query(`SELECT e.id, e.key, e.needs, e.summary, e.due_at, a.name AS area FROM escalation e LEFT JOIN area a ON a.id = e.area_id
     WHERE e.status = 'open' AND e.notified_at IS NULL ORDER BY e.created_at`)).rows;
  const pendingPreview = ctx.dryRun ? result.escalations.opened : [];
  if (!rows.length && !pendingPreview.length) return;
  const [qs, qe] = n.quietHours ?? [22, 7];
  const h = localHour(ctx.now, n.timezone);
  if (h >= qs || h < qe) {
    result.escalations.held = `quiet hours (${qs}:00–${qe}:00 ${n.timezone}); sent at ${qe}:00`;
    // ADR-087: a held digest is recorded once per set of items (not every 5 minutes through the night).
    if (!ctx.dryRun && rows.length) {
      const k = sha(rows.map((r) => r.key).sort().join("|"));
      const seen = await ctx.pool.query(`SELECT 1 FROM event WHERE action = 'notification_suppressed' AND after->>'digest' = $1 LIMIT 1`, [k]);
      if (!seen.rowCount) await appendEvent(ctx.pool, { actor: "cos", action: "notification_suppressed", after: { digest: k, reason: "quiet hours", items: rows.length, keys: rows.map((r) => r.key).slice(0, 20) } });
    }
    return;
  }
  if (ctx.dryRun) { result.escalations.notified = pendingPreview; return; }
  const lines = rows.map((r) => `• ${r.area ? `[${r.area}] ` : ""}${r.summary}${r.due_at ? ` (by ${new Date(r.due_at).toISOString().slice(0, 10)})` : ""} — ${NEEDS_LABEL[r.needs as keyof typeof NEEDS_LABEL]}`);
  const key = `escalations:${sha(rows.map((r) => r.key).sort().join("|"))}`;
  const told = rows.filter((r) => r.needs === "requested"), act = rows.filter((r) => r.needs !== "requested");
  const r = await deliverOnce(n.store, n.sender, key, "escalation_digest", {
    subject: !act.length ? `Finagai: ${told.length === 1 ? String(told[0].summary).replace(/^You asked to be told: /, "").slice(0, 90) : `${told.length} things you asked to be told about`}`
      : act.length === 1 ? `Finagai needs you: ${String(act[0].summary).slice(0, 80)}` : `Finagai needs you on ${act.length} things`,
    text: [act.length ? `Only the items below need you; everything else Finagai is handling.\n\n${lines.filter((_, i) => rows[i].needs !== "requested").join("\n")}` : "",
      told.length ? `${act.length ? "\n\n" : ""}You asked to be told (nothing to do):\n${lines.filter((_, i) => rows[i].needs === "requested").join("\n")}` : "",
      act.length ? `\n\nAsk Finagai in Claude (e.g. "what needs me?") to act on any of them.` : ""].join(""),
  });
  if (r === "sent" || r === "already_sent") {
    await ctx.pool.query(`UPDATE escalation SET notified_at = now() WHERE id = ANY($1::uuid[])`, [rows.map((x) => x.id)]);
    result.escalations.notified = rows.map((x) => x.summary);
    await appendEvent(ctx.pool, { actor: "cos", action: "notification_delivered", after: { channel: "email", purpose: "escalation_digest", items: rows.length, keys: rows.map((x) => x.key).slice(0, 20), result: r } });
  } else {
    result.escalations.held = `digest not sent: ${r}`;
    await appendEvent(ctx.pool, { actor: "cos", action: "notification_suppressed", after: { reason: `delivery ${r}`, items: rows.length, keys: rows.map((x) => x.key).slice(0, 20) } });
  }
}

/** Read-only status for tools: the engine's heartbeat, cursors, recent events and open escalations. */
export async function proactivityStatus(pool: pg.Pool, limit = 25) {
  const ticks = (await pool.query(`SELECT started_at, finished_at, trigger, status, stats, error FROM event_tick ORDER BY started_at DESC LIMIT 5`)).rows;
  const cursors = (await pool.query(`SELECT watcher, scope, cursor, updated_at FROM event_cursor ORDER BY watcher, scope`)).rows;
  const events = (await pool.query(`SELECT received_at, kind, summary, status, routes, reason FROM inbound_event ORDER BY received_at DESC LIMIT $1`, [limit])).rows
    .map((e) => ({ at: e.received_at, kind: e.kind, summary: e.summary, status: e.status, routedTo: (e.routes as Array<{ area: string; workflow: string; why: string }>).map((r) => `${r.area}/${r.workflow}: ${r.why}`), reason: e.reason }));
  const counts = (await pool.query(`SELECT status, count(*)::int AS n FROM inbound_event WHERE received_at > now() - interval '24 hours' GROUP BY status`)).rows;
  const escalations = (await pool.query(`SELECT e.created_at, e.needs, e.summary, e.due_at, e.status, e.notified_at, a.name AS area FROM escalation e LEFT JOIN area a ON a.id = e.area_id
     WHERE e.status = 'open' OR e.resolved_at > now() - interval '3 days' ORDER BY e.status, e.created_at DESC LIMIT 20`)).rows;
  const last = ticks.find((t) => t.status !== "skipped");
  return {
    heartbeat: last ? { lastTick: last.started_at, status: last.status, ageMinutes: Math.round((Date.now() - new Date(last.started_at).getTime()) / 60_000), error: last.error } : null,
    last24h: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    needsJulian: escalations.filter((e) => e.status === "open" && e.needs !== "requested").map((e) => ({ area: e.area, needs: NEEDS_LABEL[e.needs as keyof typeof NEEDS_LABEL], summary: e.summary, due: e.due_at, notified: !!e.notified_at })),
    recentlyResolved: escalations.filter((e) => e.status === "resolved").map((e) => e.summary),
    recentEvents: events, watchers: cursors, ticks,
  };
}

/** Append area_health_changed when an Area's health differs from the last recorded one (first time: a baseline). */
async function recordAreaHealth(pool: pg.Pool) {
  for (const a of (await pool.query(`SELECT id FROM area WHERE archived_at IS NULL AND status = 'active'`)).rows) {
    const h = await areaHealth(pool, a.id);
    if (!h) continue;
    const color = h.healthy ? "green" : "red";
    const last = (await pool.query(`SELECT after->>'color' AS color FROM event WHERE action = 'area_health_changed' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [a.id])).rows[0]?.color;
    if (last === color) continue;
    await appendEvent(pool, { actor: "cos", action: "area_health_changed", entityType: "area", entityId: a.id, areaId: a.id,
      before: last ? { color: last } : null, after: { color, area: h.name, breaches: h.breaches } });
  }
}
