/**
 * ADR-087 live acceptance — a READ-ONLY self-check of the Live State Stream, run inside the live Core process (operator
 * channel `finagai-job: live-acceptance`). It exercises the real HTTP surface and stream functions against the live
 * database and reports each acceptance property with its evidence. It writes nothing except what reading the stream
 * already does (publishing pending rows into the live_event ordering index).
 */
import type http from "node:http";
import { EventEmitter } from "node:events";
import type pg from "pg";
import { liveHandler } from "./http.js";
import { EVENT_SEMANTICS } from "../db/state-events.js";
import { STATE_ENTITY_TYPES } from "../db/events.js";
import { RETENTION_DAYS, causalChain, publish, readAfter, snapshot, streamBounds, toEnvelopes, type LiveEvent } from "./stream.js";

type Check = { pass: boolean | null; [k: string]: unknown };
const SECRET_VALUE = /Bearer\s+[A-Za-z0-9._~+/-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{4,}|\bsk-[A-Za-z0-9_-]{16,}|\bre_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/;
const SECRET_KEY = /^(password|passwd|secret|client_secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|cookie|session|private[_-]?key|credential)$/i;

/** Mock request/response pair driving the real live handler in-process (no socket, no auth layer). */
function invoke(handler: ReturnType<typeof liveHandler>, method: string, path: string, headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { method, headers, url: path }) as unknown as http.IncomingMessage;
  const chunks: string[] = []; let status = 0; let hdrs: Record<string, unknown> = {};
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(s: number, h?: Record<string, unknown>) { status = s; hdrs = h ?? {}; (this as { headersSent: boolean }).headersSent = true; return this; },
    write(c: string) { chunks.push(String(c)); return true; },
    end(c?: string) { if (c) chunks.push(String(c)); (req as unknown as EventEmitter).emit("close"); },
  }) as unknown as http.ServerResponse;
  return handler(req, res, new URL(path, "http://live.local")).then(() => ({ status, headers: hdrs, body: chunks.join("") }));
}
/** Parse SSE output into messages. */
function sse(body: string) {
  return body.split("\n\n").map((block) => {
    const m: { id?: number; event?: string; data?: LiveEvent & { coalesced?: { count: number; firstSeq: number } } } = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) m.id = Number(line.slice(4));
      else if (line.startsWith("event: ")) m.event = line.slice(7);
      else if (line.startsWith("data: ")) { try { m.data = JSON.parse(line.slice(6)); } catch { /* not JSON */ } }
    }
    return m;
  }).filter((m) => m.id !== undefined || m.event);
}
const covered = (msgs: ReturnType<typeof sse>) => msgs.flatMap((m) => m.data ? (m.data.coalesced ? Array.from({ length: m.data.seq - m.data.coalesced.firstSeq + 1 }, (_, i) => m.data!.coalesced!.firstSeq + i) : [m.data.seq]) : []);

async function fingerprint(pool: pg.Pool) {
  const one = async (sql: string) => String((await pool.query(sql)).rows[0]?.f ?? "");
  return {
    eventMaxId: Number((await pool.query(`SELECT COALESCE(max(id), 0) AS n FROM event`)).rows[0].n),
    escalation: await one(`SELECT md5(COALESCE(string_agg(id::text || status || COALESCE(notified_at::text, ''), ',' ORDER BY id), '')) AS f FROM escalation`),
    exception: await one(`SELECT md5(COALESCE(string_agg(key || status || last_seen_at::text, ',' ORDER BY key), '')) AS f FROM operating_exception`),
    followup: await one(`SELECT md5(COALESCE(string_agg(id::text || state, ',' ORDER BY id), '')) AS f FROM followup`),
    task: await one(`SELECT md5(COALESCE(string_agg(code::text || status, ',' ORDER BY code), '')) AS f FROM control_task`),
    opportunity: await one(`SELECT md5(COALESCE(string_agg(id::text || status, ',' ORDER BY id), '')) AS f FROM opportunity`),
  };
}

export async function liveAcceptance(pool: pg.Pool, opts: { version?: string; port?: number; since?: Date } = {}) {
  const out: Record<string, Check> = {};
  // "since the deploy": this process's start (each deploy restarts Core) unless the caller says otherwise
  const since = opts.since ?? new Date(Date.now() - process.uptime() * 1000);
  await publish(pool);

  // 1) the app role cannot DELETE (or TRUNCATE) anything; the stream index and the event log are append-only
  {
    const who = (await pool.query(`SELECT current_user AS u, session_user AS s, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)).rows[0];
    const t = (await pool.query(`SELECT n.nspname || '.' || c.relname AS t, has_table_privilege(current_user, c.oid, 'DELETE') AS d, has_table_privilege(current_user, c.oid, 'TRUNCATE') AS tr,
        has_table_privilege(current_user, c.oid, 'UPDATE') AS up FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`)).rows;
    const del = t.filter((r) => r.d).map((r) => r.t), trunc = t.filter((r) => r.tr).map((r) => r.t);
    const upd = t.filter((r) => r.up && /\.(event|live_event)$/.test(r.t)).map((r) => r.t);
    out.noDeletePrivilege = { pass: !who.su && del.length === 0 && trunc.length === 0 && upd.length === 0, role: who.u, sessionUser: who.s, superuser: who.su, tablesChecked: t.length, deleteOn: del, truncateOn: trunc, updateOnEventLog: upd };
  }

  // 2) Core and scheduler health
  {
    const ticks = (await pool.query(`SELECT started_at, finished_at, trigger, status, error FROM event_tick ORDER BY started_at DESC LIMIT 6`)).rows;
    const lastTickAgeMin = ticks[0] ? Math.round((Date.now() - new Date(ticks[0].started_at).getTime()) / 60_000) : null;
    const jobs = (await pool.query(`SELECT DISTINCT ON (job) job, scheduled_for, started_at, status, error FROM job_run ORDER BY job, started_at DESC`)).rows;
    const failed24h = Number((await pool.query(`SELECT count(*)::int AS n FROM job_run WHERE status = 'failed' AND started_at > now() - interval '24 hours'`)).rows[0].n);
    const lastSchedulerRun = (await pool.query(`SELECT max(started_at) AS at FROM job_run`)).rows[0].at;
    const stalled = (await pool.query(`SELECT status, first_seen_at, resolved_at FROM operating_exception WHERE key = 'loop:stalled'`)).rows[0] ?? null;
    const newCode = (await pool.query(`SELECT min(occurred_at) AS first, count(*)::int AS n FROM event WHERE correlation_id IS NOT NULL`)).rows[0];
    const lag = Number((await pool.query(`SELECT count(*)::int AS n FROM event e WHERE e.occurred_at > now() - interval '1 day' AND e.occurred_at < now() - interval '30 seconds' AND NOT EXISTS (SELECT 1 FROM live_event l WHERE l.event_id = e.id)`)).rows[0].n);
    const tickOk = lastTickAgeMin !== null && lastTickAgeMin <= 15 && ticks.slice(0, 3).every((x) => x.status !== "failed");
    out.health = {
      pass: tickOk && failed24h === 0 && stalled?.status !== "open" && lag === 0 && Number(newCode.n) > 0,
      core: { version: opts.version ?? null, uptimeMin: Math.round(process.uptime() / 60), eventLoopLastTickAgeMin: lastTickAgeMin, recentTicks: ticks.map((x) => ({ at: x.started_at, trigger: x.trigger, status: x.status, error: x.error })),
        livePublisherUnpublished: lag, causalInstrumentationLiveSince: newCode.first, eventsWithCorrelation: Number(newCode.n) },
      scheduler: { lastJobRunAt: lastSchedulerRun, latestPerJob: jobs.map((j) => ({ job: j.job, at: j.started_at, status: j.status, error: j.error })), failedLast24h: failed24h,
        deadManCheck: stalled ? { status: stalled.status, since: stalled.first_seen_at, resolved: stalled.resolved_at } : "never tripped" },
    };
  }

  // 3) ordering: seq strictly increasing, gap-free, one row per event, published in seq order
  {
    const o = (await pool.query(`SELECT count(*)::int AS n, min(seq) AS lo, max(seq) AS hi, count(DISTINCT event_id)::int AS ids,
        (SELECT count(*)::int FROM (SELECT published_at < lag(published_at) OVER (ORDER BY seq) AS inv FROM live_event) x WHERE inv) AS pubInversions,
        (SELECT count(*)::int FROM (SELECT event_id < lag(event_id) OVER (ORDER BY seq) AS inv FROM live_event) y WHERE inv) AS idInversions FROM live_event`)).rows[0];
    const span = Number(o.hi) - Number(o.lo) + 1;
    out.ordering = { pass: Number(o.n) === span && Number(o.ids) === Number(o.n) && Number(o.pubinversions) === 0, rows: Number(o.n), seqRange: [Number(o.lo), Number(o.hi)], gapFree: Number(o.n) === span,
      oneRowPerEvent: Number(o.ids) === Number(o.n), publishOrderInversions: Number(o.pubinversions),
      commitOrderNote: `${Number(o.idinversions)} place(s) where a later-committing event got a later seq than a higher event id — expected: seq follows commit order, not id order` };
  }

  // 4) snapshot ↔ stream position; 9) snapshot and stream agree on what needs Julian (and on open exceptions)
  {
    const snap = await snapshot(pool);
    await publish(pool);
    const after = await streamBounds(pool);
    const rows = (await pool.query(`SELECT e.id, e.action, e.after, e.occurred_at, l.seq FROM event e LEFT JOIN live_event l ON l.event_id = e.id
        WHERE e.action IN ('escalation_opened','escalation_resolved','exception_opened','exception_resolved') ORDER BY COALESCE(l.seq, 0), e.id`)).rows;
    const replay = (upTo: number | null) => {
      const esc = new Map<string, boolean>(), exc = new Map<string, boolean>();
      for (const r of rows) {
        if (upTo !== null && r.seq !== null && Number(r.seq) > upTo) continue;
        const k = String(r.after?.key ?? "");
        if (r.action === "escalation_opened" && r.after?.needs !== "requested") esc.set(k, true);
        if (r.action === "escalation_resolved") esc.set(k, false);
        if (r.action === "exception_opened") exc.set(k, true);
        if (r.action === "exception_resolved") exc.set(k, false);
      }
      const open = (m: Map<string, boolean>) => [...m].filter(([, v]) => v).map(([k]) => k).sort();
      return { needsJulian: open(esc), exceptions: open(exc) };
    };
    const snapNeeds = (snap.needsJulian as Array<{ key: string }>).map((n) => n.key).sort();
    const snapExc = (snap.exceptions as Array<{ key: string }>).map((n) => n.key).sort();
    const atCursor = replay(snap.cursor);
    const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const untracked = (await pool.query(`SELECT s.key FROM escalation s WHERE s.status = 'open' AND s.needs <> 'requested'
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.action = 'escalation_opened' AND e.after->>'key' = s.key)`)).rows.map((r) => r.key);
    out.snapshotCorrespondsToStream = { pass: snap.cursor <= after.newest && snap.cursor >= 1 && eq(atCursor.exceptions, snapExc), snapshotCursor: snap.cursor, streamNewestAfterSnapshot: after.newest,
      openExceptions: { snapshot: snapExc, replayedFromStreamUpToCursor: atCursor.exceptions },
      note: "the snapshot is one repeatable-read transaction that also reads max(seq); replaying the stream up to that cursor reproduces the same state" };
    out.needsMeAgreement = { pass: eq(atCursor.needsJulian, snapNeeds) && untracked.length === 0, snapshotNeedsJulian: snapNeeds, replayedFromStream: atCursor.needsJulian,
      openEscalationsWithoutAStreamEvent: untracked, snapshotWaits: (snap.waits as unknown[]).length, snapshotTasksActive: (snap.tasks as unknown[]).length };
  }

  // 5) causal chains from REAL post-deploy inputs (hotfix 34: judged strictly — explicit cause links, not shared correlation)
  {
    const sinceIso = since.toISOString();
    const STATE_DOMAINS = ["entity", "relationship", "project", "objective", "task", "wait", "inference", "lesson", "exception", "approval", "evidence"];
    const isStateChange = (e: LiveEvent) => STATE_DOMAINS.includes(e.domain) && !["evidence_observed", "evidence_routed"].includes(e.action);
    const CREATION = /(_created|_tracked|_open|_set|^create)$|^opportunity_evidence_added$|^objective_set$/;
    const groupOf = async (corr: string) => toEnvelopes(pool, (await pool.query(`SELECT l.seq, e.id, e.occurred_at, e.actor, e.action, e.entity_type, e.entity_id, e.before, e.after, e.request_id, e.approval_id, e.correlation_id, e.cause_ids, e.area_id
        FROM event e LEFT JOIN live_event l ON l.event_id = e.id WHERE e.correlation_id = $1 ORDER BY e.id`, [corr])).rows);
    const quality = (e: LiveEvent, corr: string, cause: number) => [
      !e.entity.id && "no affected object id", (!e.after || !Object.keys(e.after as object).length) && "no after-state",
      (EVENT_SEMANTICS[e.action] ? EVENT_SEMANTICS[e.action] === "transition" : !CREATION.test(e.action)) && (!e.before || !Object.keys(e.before as object).length) && "no before-state",
      e.cause.correlationId !== corr && "wrong correlation", !e.cause.eventIds.includes(cause) && `does not cite ${cause}`].filter(Boolean) as string[];
    // 5a) incoming email -> routing -> workflow -> state change
    const heads = (await pool.query(`SELECT id, correlation_id FROM event WHERE action = 'evidence_observed' AND after->>'source' = 'gmail' AND occurred_at >= $1 AND correlation_id IS NOT NULL ORDER BY id DESC LIMIT 300`, [sinceIso])).rows;
    const tally = { emails: heads.length, ignoredAtRouting: 0, reachedWorkflow: 0, changedState: 0, linkDefects: [] as string[] };
    let proof: Record<string, unknown> | null = null;
    for (const h of heads) {
      const evs = await groupOf(String(h.correlation_id));
      const obs = evs.find((e) => e.eventId === Number(h.id))!;
      const routed = evs.find((e) => e.action === "evidence_routed" && e.entity.id === obs.entity.id);
      if (!routed || !routed.cause.eventIds.includes(obs.eventId)) { tally.linkDefects.push(`${obs.eventId}: routing missing or not linked`); continue; }
      const started = evs.filter((e) => e.action === "workflow_started" && e.cause.eventIds.includes(routed.eventId));
      if (!started.length) { tally.ignoredAtRouting++; continue; }
      tally.reachedWorkflow++;
      for (const st of started) {
        const children = evs.filter((e) => e.cause.eventIds.includes(st.eventId));
        const changes = children.filter(isStateChange);
        const completed = children.find((e) => e.action === "workflow_completed" || e.action === "workflow_failed");
        if (!completed) tally.linkDefects.push(`${st.eventId}: workflow has no linked completion`);
        if (!changes.length) continue;
        tally.changedState++;
        if (!proof) {
          const defects = changes.flatMap((c) => quality(c, String(h.correlation_id), st.eventId).map((d) => `${c.eventId} ${c.action}: ${d}`));
          const fmt = (e: LiveEvent) => ({ eventId: e.eventId, seq: e.seq, class: e.class, action: e.action, entity: e.entity, cites: e.cause.eventIds, before: e.before, after: e.after, summary: e.summary.slice(0, 120) });
          proof = { correlationId: h.correlation_id, email: fmt(obs), routing: fmt(routed), workflowStarted: fmt(st), stateChanges: changes.map(fmt), workflowCompleted: completed ? fmt(completed) : null, defects };
        }
      }
    }
    out.emailToStateChain = { pass: proof ? !(proof.defects as string[]).length && !tally.linkDefects.length : null, since: sinceIso, tally, proof,
      ...(proof ? {} : { status: "waiting for a real post-deploy email that changes state" }) };
    // 5b) escalation -> notification, from a real email
    const escs = (await pool.query(`SELECT id FROM event WHERE action = 'escalation_opened' AND occurred_at >= $1 ORDER BY id DESC LIMIT 50`, [sinceIso])).rows.map((r) => Number(r.id));
    let best: Record<string, unknown> | null = null; let fromEmail = false;
    for (const id of escs) {
      const chain = await causalChain(pool, id);
      const email = chain.find((e) => e.action === "evidence_observed" && (e.after as { source?: string } | null)?.source === "gmail");
      const notes = await toEnvelopes(pool, (await pool.query(`SELECT l.seq, e.id, e.occurred_at, e.actor, e.action, e.entity_type, e.entity_id, e.before, e.after, e.request_id, e.approval_id, e.correlation_id, e.cause_ids, e.area_id
          FROM event e LEFT JOIN live_event l ON l.event_id = e.id WHERE e.action IN ('notification_delivered','notification_suppressed') AND $1 = ANY(e.cause_ids) ORDER BY e.id`, [id])).rows);
      const note = notes.find((n) => n.action === "notification_delivered" || /quiet hours/.test(String((n.after as { reason?: string } | null)?.reason ?? "")));
      const c = { escalation: id, fromEmail: !!email, chain: chain.map((e) => ({ eventId: e.eventId, seq: e.seq, class: e.class, cites: e.cause.eventIds })), notification: note ? { eventId: note.eventId, seq: note.seq, class: note.class, cites: note.cause.eventIds, after: note.after } : null };
      if (email && note) { best = c; fromEmail = true; break; }
      best ??= c;
    }
    out.escalationNotificationChain = { pass: fromEmail ? true : null, since: sinceIso, escalationsSinceDeploy: escs.length, latest: best,
      ...(fromEmail ? {} : { status: "waiting for a real email whose chain opens an escalation that is then notified (or held for quiet hours)" }) };
    // 5c) every state-change event since deploy: object, before/after, unit of work, cause
    const stateActs = (await pool.query(`SELECT l.seq, e.id, e.occurred_at, e.actor, e.action, e.entity_type, e.entity_id, e.before, e.after, e.request_id, e.approval_id, e.correlation_id, e.cause_ids, e.area_id
        FROM event e LEFT JOIN live_event l ON l.event_id = e.id WHERE e.occurred_at >= $1 ORDER BY e.id DESC LIMIT 2000`, [sinceIso])).rows;
    const stateEvs = (await toEnvelopes(pool, stateActs)).filter(isStateChange);
    // A transition (EVENT_SEMANTICS) about an object that already had events must say what it moved FROM (hotfix 35).
    const beforeless = stateEvs.filter((e) => EVENT_SEMANTICS[e.action] === "transition" && e.entity.id && (!e.before || !Object.keys(e.before as object).length));
    const hadPrior = new Set(beforeless.length ? (await pool.query(`SELECT x.id FROM event x WHERE x.id = ANY($1::bigint[])
        AND EXISTS (SELECT 1 FROM event p WHERE p.entity_type = x.entity_type AND p.entity_id = x.entity_id AND p.id < x.id)`, [beforeless.map((e) => e.eventId)])).rows.map((r) => Number(r.id)) : []);
    const bad = stateEvs.map((e) => ({ e, why: [!e.entity.id && "no object", (!e.after || !Object.keys(e.after as object).length) && "no after", !e.cause.correlationId && "no unit of work",
      !e.cause.eventIds.length && "no cause", hadPrior.has(e.eventId) && "transition without before-state (the object had a prior state)",
      !!e.entity.type && STATE_ENTITY_TYPES.has(e.entity.type) && !(e.action in EVENT_SEMANTICS) && "unclassified state action"].filter(Boolean) })).filter((x) => x.why.length);
    out.stateEventQuality = { pass: bad.length === 0, since: sinceIso, stateChangeEvents: stateEvs.length,
      violations: bad.slice(0, 20).map((x) => `${x.e.eventId} ${x.e.action}: ${x.why.join(", ")}`), note: "detector-originated roots (an exception opened by a condition check) cite the entity's previous event when there is one" };
    // 5d) no silent state change: every row whose state moved since deploy has an event about it at/after that moment
    const silent: string[] = [];
    for (const t of ["followup", "opportunity", "project", "objective", "area", "work_item"]) {
      const rows = (await pool.query(`SELECT r.id, r.updated_at FROM ${t} r WHERE r.updated_at >= $1
          AND NOT EXISTS (SELECT 1 FROM event e WHERE e.entity_id = r.id AND e.occurred_at >= r.updated_at - interval '1 second') LIMIT 20`, [sinceIso])).rows;
      for (const r of rows) silent.push(`${t} ${r.id} changed at ${new Date(r.updated_at).toISOString()} with no event`);
    }
    out.noSilentStateChanges = { pass: silent.length === 0, since: sinceIso, silent };
  }

  // 6) disconnect / reconnect over the real SSE handler: no semantic event missed, none duplicated
  {
    const h = liveHandler(pool, { pollMs: 100, heartbeatMs: 60_000, maxStreamMs: 600 });
    const b = await streamBounds(pool);
    const from = Math.max(0, b.newest - 80), to = b.newest;
    const a = sse((await invoke(h, "GET", `/live/stream?after=${from}`)).body).filter((m) => m.data && m.data.seq <= to);
    const cut = a[Math.floor(a.length / 2)]!;
    const first = a.slice(0, a.indexOf(cut) + 1);
    const second = sse((await invoke(h, "GET", "/live/stream", { "last-event-id": String(cut.id) })).body).filter((m) => m.data && m.data.seq <= to);
    const got = [...covered(first), ...covered(second)];
    const expected = Array.from({ length: to - from }, (_, i) => from + 1 + i);
    const missing = expected.filter((s) => !got.includes(s)), dup = got.filter((s, i) => got.indexOf(s) !== i);
    const sem = (await readAfter(pool, from, {}, 200)) as { events: LiveEvent[] };
    const semantic = sem.events.filter((e) => !e.lowValue && e.seq <= to).map((e) => e.seq);
    const delivered = new Set([...first, ...second].filter((m) => !m.data!.coalesced).map((m) => m.data!.seq));
    const semMissing = semantic.filter((s) => !delivered.has(s));
    const ordered = second.every((m, i) => i === 0 || m.data!.seq > second[i - 1]!.data!.seq) && first.every((m, i) => i === 0 || m.data!.seq > first[i - 1]!.data!.seq);
    out.resume = { pass: missing.length === 0 && dup.length === 0 && semMissing.length === 0 && ordered && (second[0]?.data?.seq ?? Number.POSITIVE_INFINITY) > cut.id!, range: [from + 1, to],
      firstConnection: { messages: first.length, disconnectedAfterSeq: cut.id }, reconnectWithLastEventId: { messages: second.length, firstSeq: second[0]?.data?.seq ?? null },
      positionsCovered: new Set(got).size, missing, duplicated: dup, semanticEventsInRange: semantic.length, semanticEventsMissing: semMissing, strictlyIncreasing: ordered };
  }

  // 7) an expired resume position must take a fresh snapshot
  {
    const b = await streamBounds(pool);
    const future = new Date(Date.now() + (RETENTION_DAYS + 1) * 86_400_000);
    const expired = await readAfter(pool, 1, {}, 5, future);
    const nowRes = await readAfter(pool, 1, {}, 5);
    const h = liveHandler(pool);
    const fresh = await invoke(h, "GET", "/live/events?after=0&limit=1");
    const bodyFresh = JSON.parse(fresh.body);
    const stale = b.oldest !== null && b.oldest > 2 ? await invoke(h, "GET", `/live/events?after=${b.oldest - 2}`) : null;
    out.expiredCursor = { pass: expired.reset === true && nowRes.reset === false && fresh.status === 200 && (!stale || stale.status === 409),
      currentWindow: b, at31DaysFromNow: expired.reset ? { reset: true, reason: expired.reason } : { reset: false },
      cursor1Today: nowRes.reset ? "reset" : "resumable (inside the window)", freshSubscriberStartsAt: bodyFresh.events?.[0]?.seq ?? null,
      httpExpiredCursor: stale ? { status: stale.status, body: JSON.parse(stale.body) } : `not testable over HTTP today — every published position is still inside the ${RETENTION_DAYS}-day window; the function-level check above uses a clock ${RETENTION_DAYS + 1} days ahead` };
  }

  // 8) redaction, authentication and read-only
  {
    // authentication — the real deployed HTTP stack of this process, without and with a bad token
    const port = opts.port ?? Number(process.env.PORT ?? 8787);
    const call = async (method: string, path: string, auth?: string) => {
      try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: auth ? { authorization: auth } : {} }); const t = await r.text(); return { status: r.status, challenge: r.headers.get("www-authenticate"), body: t.slice(0, 120) }; }
      catch (e) { return { status: -1, error: String((e as Error).message).slice(0, 120) }; }
    };
    const auth = {
      snapshotNoToken: await call("GET", "/live/snapshot"), streamNoToken: await call("GET", "/live/stream?after=0"), contractNoToken: await call("GET", "/live/contract"),
      snapshotForgedToken: await call("GET", "/live/snapshot", "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.x"), postNoToken: await call("POST", "/live/snapshot"),
    };
    const authPass = Object.values(auth).every((r) => r.status === 401);
    // read-only — every route of the handler, then compare operational state
    const h = liveHandler(pool, { pollMs: 100, maxStreamMs: 300 });
    const before = await fingerprint(pool);
    const methods: Record<string, number> = {};
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) methods[m] = (await invoke(h, m, "/live/snapshot")).status;
    const reads: Record<string, number> = {};
    for (const p of ["/live/contract", "/live/snapshot", "/live/events?after=0&limit=50", "/live/history?limit=50", `/live/chain/${before.eventMaxId}`, "/live/stream?after=0"]) reads[p] = (await invoke(h, "GET", p)).status;
    const after = await fingerprint(pool);
    const newEvents = (await pool.query(`SELECT id, actor, action FROM event WHERE id > $1 ORDER BY id`, [before.eventMaxId])).rows;
    // the event log may grow meanwhile from Julian's tools or the 5-minute loop (listed below); the handler never appends
    const changed = Object.keys(before).filter((k) => k !== "eventMaxId" && (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]);
    const readOnlyPass = Object.values(methods).every((s) => s === 405) && changed.length === 0;
    // redaction — every envelope in the window
    const b = await streamBounds(pool);
    let cursor = Math.max(0, (b.oldest ?? 1) - 1), scanned = 0; const leaks: Array<{ seq: number; where: string }> = [];
    const principals = (await pool.query(`SELECT DISTINCT principal FROM event WHERE principal IS NOT NULL LIMIT 20`)).rows.map((r) => String(r.principal)).filter((p) => p.length >= 6);
    const scanVal = (v: unknown, path: string, seq: number) => {
      if (v === null || v === undefined) return;
      if (typeof v === "string") { if (SECRET_VALUE.test(v) || principals.some((p) => v.includes(p))) leaks.push({ seq, where: path }); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => scanVal(x, `${path}[${i}]`, seq)); return; }
      if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (SECRET_KEY.test(k) && x !== "[redacted]" && x !== null) leaks.push({ seq, where: `${path}.${k}` }); scanVal(x, `${path}.${k}`, seq); }
    };
    for (;;) {
      const r = await readAfter(pool, cursor, {}, 500);
      if (r.reset) break;
      for (const e of r.events) { scanned++; scanVal(e, "event", e.seq); if ("principal" in e) leaks.push({ seq: e.seq, where: "principal field" }); }
      if (!r.more) break;
      cursor = r.cursor;
    }
    const rawWithSecrets = Number((await pool.query(`SELECT count(*)::int AS n FROM event WHERE occurred_at > now() - make_interval(days => $1) AND (after::text ~* '"(password|secret|api_?key|access_?token|refresh_?token|token|authorization|cookie|private_?key|credential)"' OR after::text ~ 'Bearer [A-Za-z0-9._~+/-]{16,}')`, [RETENTION_DAYS])).rows[0].n);
    out.protections = { pass: authPass && readOnlyPass && leaks.length === 0,
      authentication: { pass: authPass, ...auth },
      readOnly: { pass: readOnlyPass, nonGetMethods: methods, getRoutes: reads, operationalStateChanged: changed, eventsWrittenMeanwhile: newEvents.map((e) => `${e.id}:${e.actor}:${e.action}`) },
      redaction: { pass: leaks.length === 0, envelopesScanned: scanned, storedEventsWithSecretShapedFields: rawWithSecrets, leaks: leaks.slice(0, 20) } };
  }

  const verdict = Object.entries(out).map(([k, v]) => `${k}: ${v.pass === true ? "PASS" : v.pass === false ? "FAIL" : "PENDING"}`);
  // allPass only when nothing is pending: a check that has not been observed live is not a pass.
  return { adr: "0087", ranAt: new Date().toISOString(), since: since.toISOString(), allPass: Object.values(out).every((v) => v.pass === true), verdict, checks: out };
}
