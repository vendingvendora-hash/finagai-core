import { EventEmitter } from "node:events";
import { liveHandler } from "./http.js";
import { RETENTION_DAYS, causalChain, publish, readAfter, snapshot, streamBounds, toEnvelopes } from "./stream.js";
const SECRET_VALUE = /Bearer\s+[A-Za-z0-9._~+/-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{4,}|\bsk-[A-Za-z0-9_-]{16,}|\bre_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/;
const SECRET_KEY = /^(password|passwd|secret|client_secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|cookie|session|private[_-]?key|credential)$/i;
/** Mock request/response pair driving the real live handler in-process (no socket, no auth layer). */
function invoke(handler, method, path, headers = {}) {
    const req = Object.assign(new EventEmitter(), { method, headers, url: path });
    const chunks = [];
    let status = 0;
    let hdrs = {};
    const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writeHead(s, h) { status = s; hdrs = h ?? {}; this.headersSent = true; return this; },
        write(c) { chunks.push(String(c)); return true; },
        end(c) { if (c)
            chunks.push(String(c)); req.emit("close"); },
    });
    return handler(req, res, new URL(path, "http://live.local")).then(() => ({ status, headers: hdrs, body: chunks.join("") }));
}
/** Parse SSE output into messages. */
function sse(body) {
    return body.split("\n\n").map((block) => {
        const m = {};
        for (const line of block.split("\n")) {
            if (line.startsWith("id: "))
                m.id = Number(line.slice(4));
            else if (line.startsWith("event: "))
                m.event = line.slice(7);
            else if (line.startsWith("data: ")) {
                try {
                    m.data = JSON.parse(line.slice(6));
                }
                catch { /* not JSON */ }
            }
        }
        return m;
    }).filter((m) => m.id !== undefined || m.event);
}
const covered = (msgs) => msgs.flatMap((m) => m.data ? (m.data.coalesced ? Array.from({ length: m.data.seq - m.data.coalesced.firstSeq + 1 }, (_, i) => m.data.coalesced.firstSeq + i) : [m.data.seq]) : []);
async function fingerprint(pool) {
    const one = async (sql) => String((await pool.query(sql)).rows[0]?.f ?? "");
    return {
        eventMaxId: Number((await pool.query(`SELECT COALESCE(max(id), 0) AS n FROM event`)).rows[0].n),
        escalation: await one(`SELECT md5(COALESCE(string_agg(id::text || status || COALESCE(notified_at::text, ''), ',' ORDER BY id), '')) AS f FROM escalation`),
        exception: await one(`SELECT md5(COALESCE(string_agg(key || status || last_seen_at::text, ',' ORDER BY key), '')) AS f FROM operating_exception`),
        followup: await one(`SELECT md5(COALESCE(string_agg(id::text || state, ',' ORDER BY id), '')) AS f FROM followup`),
        task: await one(`SELECT md5(COALESCE(string_agg(code::text || status, ',' ORDER BY code), '')) AS f FROM control_task`),
        opportunity: await one(`SELECT md5(COALESCE(string_agg(id::text || status, ',' ORDER BY id), '')) AS f FROM opportunity`),
    };
}
export async function liveAcceptance(pool, opts = {}) {
    const out = {};
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
        const replay = (upTo) => {
            const esc = new Map(), exc = new Map();
            for (const r of rows) {
                if (upTo !== null && r.seq !== null && Number(r.seq) > upTo)
                    continue;
                const k = String(r.after?.key ?? "");
                if (r.action === "escalation_opened" && r.after?.needs !== "requested")
                    esc.set(k, true);
                if (r.action === "escalation_resolved")
                    esc.set(k, false);
                if (r.action === "exception_opened")
                    exc.set(k, true);
                if (r.action === "exception_resolved")
                    exc.set(k, false);
            }
            const open = (m) => [...m].filter(([, v]) => v).map(([k]) => k).sort();
            return { needsJulian: open(esc), exceptions: open(exc) };
        };
        const snapNeeds = snap.needsJulian.map((n) => n.key).sort();
        const snapExc = snap.exceptions.map((n) => n.key).sort();
        const atCursor = replay(snap.cursor);
        const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
        const untracked = (await pool.query(`SELECT s.key FROM escalation s WHERE s.status = 'open' AND s.needs <> 'requested'
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.action = 'escalation_opened' AND e.after->>'key' = s.key)`)).rows.map((r) => r.key);
        out.snapshotCorrespondsToStream = { pass: snap.cursor <= after.newest && snap.cursor >= 1 && eq(atCursor.exceptions, snapExc), snapshotCursor: snap.cursor, streamNewestAfterSnapshot: after.newest,
            openExceptions: { snapshot: snapExc, replayedFromStreamUpToCursor: atCursor.exceptions },
            note: "the snapshot is one repeatable-read transaction that also reads max(seq); replaying the stream up to that cursor reproduces the same state" };
        out.needsMeAgreement = { pass: eq(atCursor.needsJulian, snapNeeds) && untracked.length === 0, snapshotNeedsJulian: snapNeeds, replayedFromStream: atCursor.needsJulian,
            openEscalationsWithoutAStreamEvent: untracked, snapshotWaits: snap.waits.length, snapshotTasksActive: snap.tasks.length };
    }
    // 5) a real event-engine cycle: the latest real input and everything it caused
    {
        // the latest real input that reached an Area workflow; otherwise the latest real input at all
        const head = (await pool.query(`SELECT o.id, o.correlation_id FROM event o WHERE o.action = 'evidence_observed' AND o.correlation_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM event w WHERE w.correlation_id = o.correlation_id AND w.action = 'workflow_started') ORDER BY o.id DESC LIMIT 1`)).rows[0]
            ?? (await pool.query(`SELECT id, correlation_id FROM event WHERE action = 'evidence_observed' AND correlation_id IS NOT NULL ORDER BY id DESC LIMIT 1`)).rows[0];
        const inputs = (await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM event w WHERE w.correlation_id = o.correlation_id AND w.action = 'workflow_started'))::int AS routed
        FROM event o WHERE o.action = 'evidence_observed'`)).rows[0];
        const latestTick = (await pool.query(`SELECT correlation_id, count(*)::int AS n, min(occurred_at) AS at, array_agg(action ORDER BY id) AS actions FROM event
        WHERE correlation_id = (SELECT correlation_id FROM event WHERE actor IN ('cos','system') AND correlation_id IS NOT NULL AND action IN ('area_health_changed','workflow_started','evidence_observed','escalation_opened','exception_opened','exception_resolved') ORDER BY id DESC LIMIT 1)
        GROUP BY correlation_id`)).rows[0] ?? null;
        if (!head)
            out.causalChain = { pass: null, status: "waiting for the first real input since the deploy (no evidence_observed yet)", realInputsSinceDeploy: { observed: inputs.n, reachedAWorkflow: inputs.routed }, latestEngineCycle: latestTick };
        else {
            const group = (await pool.query(`SELECT l.seq, e.id, e.occurred_at, e.actor, e.action, e.entity_type, e.entity_id, e.before, e.after, e.request_id, e.approval_id, e.correlation_id, e.cause_ids, e.area_id
          FROM event e LEFT JOIN live_event l ON l.event_id = e.id WHERE e.correlation_id = $1 ORDER BY e.id`, [head.correlation_id])).rows;
            const evs = await toEnvelopes(pool, group);
            const ids = new Set(evs.map((e) => e.eventId));
            const dangling = evs.filter((e) => e.cause.eventIds.some((c) => !ids.has(c))).map((e) => ({ eventId: e.eventId, action: e.action, causes: e.cause.eventIds }));
            const roots = evs.filter((e) => !e.cause.eventIds.length).map((e) => `${e.eventId}:${e.action}`);
            const STATE = ["entity", "relationship", "project", "objective", "task", "wait", "inference", "lesson", "exception", "approval"];
            const stages = { input: evs.some((e) => e.action === "evidence_observed"), routing: evs.some((e) => e.action === "evidence_routed"), workflow: evs.some((e) => e.domain === "workflow"),
                stateChange: evs.some((e) => STATE.includes(e.domain)), escalation: evs.some((e) => e.domain === "escalation"), notification: evs.some((e) => e.domain === "notification") };
            const last = (pred) => [...evs].reverse().find(pred);
            const deepest = last((e) => e.domain === "notification") ?? last((e) => e.domain === "escalation") ?? last((e) => STATE.includes(e.domain)) ?? last((e) => e.domain === "workflow") ?? evs.at(-1);
            const stateChains = await Promise.all(evs.filter((e) => STATE.includes(e.domain)).slice(0, 5).map(async (e) => (await causalChain(pool, e.eventId)).map((x) => `${x.eventId}:${x.class}`)));
            const chain = await causalChain(pool, deepest.eventId);
            const routedWorkflow = evs.find((e) => e.action === "evidence_routed" && e.after?.routes?.length);
            out.causalChain = { pass: stages.input && stages.routing && dangling.length === 0 && (!routedWorkflow || stages.workflow), correlationId: head.correlation_id, stages,
                note: routedWorkflow ? "the input was routed to a workflow" : "the latest input was not routed to any Area workflow (ignored), so the chain legitimately ends at routing",
                events: evs.map((e) => ({ seq: e.seq, eventId: e.eventId, at: e.at, class: e.class, area: e.area?.name ?? null, causes: e.cause.eventIds, summary: e.summary.slice(0, 140) })),
                roots, danglingCauses: dangling, chainBehindDeepest: chain.map((e) => `${e.eventId}:${e.class}`), chainsBehindStateChanges: stateChains,
                realInputsSinceDeploy: { observed: inputs.n, reachedAWorkflow: inputs.routed }, latestEngineCycle: latestTick };
        }
    }
    // 6) disconnect / reconnect over the real SSE handler: no semantic event missed, none duplicated
    {
        const h = liveHandler(pool, { pollMs: 100, heartbeatMs: 60_000, maxStreamMs: 600 });
        const b = await streamBounds(pool);
        const from = Math.max(0, b.newest - 80), to = b.newest;
        const a = sse((await invoke(h, "GET", `/live/stream?after=${from}`)).body).filter((m) => m.data && m.data.seq <= to);
        const cut = a[Math.floor(a.length / 2)];
        const first = a.slice(0, a.indexOf(cut) + 1);
        const second = sse((await invoke(h, "GET", "/live/stream", { "last-event-id": String(cut.id) })).body).filter((m) => m.data && m.data.seq <= to);
        const got = [...covered(first), ...covered(second)];
        const expected = Array.from({ length: to - from }, (_, i) => from + 1 + i);
        const missing = expected.filter((s) => !got.includes(s)), dup = got.filter((s, i) => got.indexOf(s) !== i);
        const sem = (await readAfter(pool, from, {}, 200));
        const semantic = sem.events.filter((e) => !e.lowValue && e.seq <= to).map((e) => e.seq);
        const delivered = new Set([...first, ...second].filter((m) => !m.data.coalesced).map((m) => m.data.seq));
        const semMissing = semantic.filter((s) => !delivered.has(s));
        const ordered = second.every((m, i) => i === 0 || m.data.seq > second[i - 1].data.seq) && first.every((m, i) => i === 0 || m.data.seq > first[i - 1].data.seq);
        out.resume = { pass: missing.length === 0 && dup.length === 0 && semMissing.length === 0 && ordered && (second[0]?.data?.seq ?? Number.POSITIVE_INFINITY) > cut.id, range: [from + 1, to],
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
        const call = async (method, path, auth) => {
            try {
                const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: auth ? { authorization: auth } : {} });
                const t = await r.text();
                return { status: r.status, challenge: r.headers.get("www-authenticate"), body: t.slice(0, 120) };
            }
            catch (e) {
                return { status: -1, error: String(e.message).slice(0, 120) };
            }
        };
        const auth = {
            snapshotNoToken: await call("GET", "/live/snapshot"), streamNoToken: await call("GET", "/live/stream?after=0"), contractNoToken: await call("GET", "/live/contract"),
            snapshotForgedToken: await call("GET", "/live/snapshot", "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.x"), postNoToken: await call("POST", "/live/snapshot"),
        };
        const authPass = Object.values(auth).every((r) => r.status === 401);
        // read-only — every route of the handler, then compare operational state
        const h = liveHandler(pool, { pollMs: 100, maxStreamMs: 300 });
        const before = await fingerprint(pool);
        const methods = {};
        for (const m of ["POST", "PUT", "PATCH", "DELETE"])
            methods[m] = (await invoke(h, m, "/live/snapshot")).status;
        const reads = {};
        for (const p of ["/live/contract", "/live/snapshot", "/live/events?after=0&limit=50", "/live/history?limit=50", `/live/chain/${before.eventMaxId}`, "/live/stream?after=0"])
            reads[p] = (await invoke(h, "GET", p)).status;
        const after = await fingerprint(pool);
        const newEvents = (await pool.query(`SELECT id, actor, action FROM event WHERE id > $1 ORDER BY id`, [before.eventMaxId])).rows;
        // the event log may grow meanwhile from Julian's tools or the 5-minute loop (listed below); the handler never appends
        const changed = Object.keys(before).filter((k) => k !== "eventMaxId" && before[k] !== after[k]);
        const readOnlyPass = Object.values(methods).every((s) => s === 405) && changed.length === 0;
        // redaction — every envelope in the window
        const b = await streamBounds(pool);
        let cursor = Math.max(0, (b.oldest ?? 1) - 1), scanned = 0;
        const leaks = [];
        const principals = (await pool.query(`SELECT DISTINCT principal FROM event WHERE principal IS NOT NULL LIMIT 20`)).rows.map((r) => String(r.principal)).filter((p) => p.length >= 6);
        const scanVal = (v, path, seq) => {
            if (v === null || v === undefined)
                return;
            if (typeof v === "string") {
                if (SECRET_VALUE.test(v) || principals.some((p) => v.includes(p)))
                    leaks.push({ seq, where: path });
                return;
            }
            if (Array.isArray(v)) {
                v.forEach((x, i) => scanVal(x, `${path}[${i}]`, seq));
                return;
            }
            if (typeof v === "object")
                for (const [k, x] of Object.entries(v)) {
                    if (SECRET_KEY.test(k) && x !== "[redacted]" && x !== null)
                        leaks.push({ seq, where: `${path}.${k}` });
                    scanVal(x, `${path}.${k}`, seq);
                }
        };
        for (;;) {
            const r = await readAfter(pool, cursor, {}, 500);
            if (r.reset)
                break;
            for (const e of r.events) {
                scanned++;
                scanVal(e, "event", e.seq);
                if ("principal" in e)
                    leaks.push({ seq: e.seq, where: "principal field" });
            }
            if (!r.more)
                break;
            cursor = r.cursor;
        }
        const rawWithSecrets = Number((await pool.query(`SELECT count(*)::int AS n FROM event WHERE occurred_at > now() - make_interval(days => $1) AND (after::text ~* '"(password|secret|api_?key|access_?token|refresh_?token|token|authorization|cookie|private_?key|credential)"' OR after::text ~ 'Bearer [A-Za-z0-9._~+/-]{16,}')`, [RETENTION_DAYS])).rows[0].n);
        out.protections = { pass: authPass && readOnlyPass && leaks.length === 0,
            authentication: { pass: authPass, ...auth },
            readOnly: { pass: readOnlyPass, nonGetMethods: methods, getRoutes: reads, operationalStateChanged: changed, eventsWrittenMeanwhile: newEvents.map((e) => `${e.id}:${e.actor}:${e.action}`) },
            redaction: { pass: leaks.length === 0, envelopesScanned: scanned, storedEventsWithSecretShapedFields: rawWithSecrets, leaks: leaks.slice(0, 20) } };
    }
    const verdict = Object.entries(out).map(([k, v]) => `${k}: ${v.pass === true ? "PASS" : v.pass === false ? "FAIL" : "PENDING"}`);
    return { adr: "0087", ranAt: new Date().toISOString(), allPass: Object.values(out).every((v) => v.pass === true), verdict, checks: out };
}
//# sourceMappingURL=acceptance.js.map