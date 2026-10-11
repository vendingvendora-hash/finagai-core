import { KNOWN_ACTIONS } from "./ontology.js";
import { CONTRACT_VERSION, RETENTION_DAYS, causalChain, coalesce, history, publish, readAfter, snapshot } from "./stream.js";
const HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", ...HEADERS }); res.end(JSON.stringify(body)); };
function filterOf(u) {
    const classes = (u.searchParams.get("class") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
    return { area: u.searchParams.get("area"), ...(classes.length ? { classes } : {}), entityType: u.searchParams.get("entityType"), entityId: u.searchParams.get("entityId") };
}
const intParam = (v, d) => (v && /^\d+$/.test(v) ? Number(v) : d);
export function liveHandler(pool, opts = {}) {
    const pollMs = opts.pollMs ?? 1000, heartbeatMs = opts.heartbeatMs ?? 15_000, maxStreamMs = opts.maxStreamMs ?? 3_600_000;
    return async (req, res, url) => {
        if (req.method !== "GET") {
            res.writeHead(405, { allow: "GET", ...HEADERS });
            res.end();
            return;
        } // observational only
        const path = url.pathname;
        try {
            if (path === "/live/contract")
                return json(res, 200, CONTRACT);
            if (path === "/live/snapshot") {
                await publish(pool);
                return json(res, 200, await snapshot(pool, filterOf(url)));
            }
            if (path === "/live/events") {
                await publish(pool);
                const r = await readAfter(pool, intParam(url.searchParams.get("after"), 0), filterOf(url), Math.min(intParam(url.searchParams.get("limit"), 500), 2000));
                return json(res, r.reset ? 409 : 200, r.reset ? r : { ...r, events: coalesce(r.events) });
            }
            if (path === "/live/history")
                return json(res, 200, { events: await history(pool, { ...filterOf(url), from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined, limit: intParam(url.searchParams.get("limit"), 500) }) });
            const chain = /^\/live\/chain\/(\d+)$/.exec(path);
            if (chain)
                return json(res, 200, { chain: await causalChain(pool, Number(chain[1])) });
            if (path === "/live/stream")
                return stream(req, res, url);
            return json(res, 404, { error: "not_found" });
        }
        catch {
            if (!res.headersSent)
                json(res, 500, { error: "internal_error" });
            else
                res.end();
        }
    };
    async function stream(req, res, url) {
        const f = filterOf(url);
        let cursor = intParam(String(req.headers["last-event-id"] ?? "") || url.searchParams.get("after"), 0);
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no", ...HEADERS });
        let open = true;
        req.on("close", () => { open = false; });
        const write = async (chunk) => { if (!res.write(chunk))
            await new Promise((r) => res.once("drain", () => r())); }; // backpressure
        const started = Date.now();
        let lastBeat = Date.now();
        await write(`retry: 2000\n: finagai live stream v${CONTRACT_VERSION} from ${cursor}\n\n`);
        while (open && Date.now() - started < maxStreamMs) {
            await publish(pool).catch(() => undefined);
            const r = await readAfter(pool, cursor, f, 500);
            if (r.reset) {
                await write(`event: reset\ndata: ${JSON.stringify({ reason: r.reason, oldest: r.oldest })}\n\n`);
                break;
            }
            for (const e of coalesce(r.events))
                await write(`id: ${e.seq}\nevent: ${e.class}\ndata: ${JSON.stringify(e)}\n\n`);
            if (r.cursor > cursor && !r.events.length)
                await write(`id: ${r.cursor}\n: filtered\n\n`); // advance the client's resume point past filtered rows
            cursor = r.cursor;
            if (r.more)
                continue;
            if (Date.now() - lastBeat >= heartbeatMs) {
                await write(`: heartbeat ${new Date().toISOString()}\n\n`);
                lastBeat = Date.now();
            }
            await new Promise((r2) => setTimeout(r2, pollMs));
        }
        res.end();
    }
}
export const CONTRACT = {
    v: CONTRACT_VERSION,
    sourceOfTruth: "the append-only event table; live_event only orders it (seq) for streaming",
    envelope: {
        seq: "stream cursor — monotonic, commit-ordered, gap-free for consumers; resume with ?after=seq or Last-Event-ID",
        eventId: "stable id of the stored event", at: "occurred_at, canonical UTC ISO-8601",
        class: "<domain>.<verb> (see ontology)", action: "the stored action name", actor: "julian | cos | j6 | system | …",
        area: "{id, name} the event affected, when known", entity: "{type, id} it affected",
        summary: "one human line", before: "sanitized prior state, when recorded", after: "sanitized new state / payload",
        cause: "{correlationId: unit of work, eventIds: the events that directly caused it, requestId}",
        nextOwner: "finagai | julian | null — who owns the next action", humanAuthorized: "true when executed under Julian's passkey approval",
        verified: "true/false when the outcome was (not) independently verified, else null", confidence: "0..1 when relevant (lessons)",
        lowValue: "high-frequency, low-value; may be coalesced",
    },
    ontology: { domains: ["entity", "relationship", "area", "objective", "project", "task", "wait", "workflow", "tool", "evidence", "inference", "lesson", "procedure", "capability", "exception", "escalation", "approval", "authority", "notification", "rule", "source", "other"], classifiedActions: KNOWN_ACTIONS.length },
    delivery: { snapshot: "/live/snapshot returns state + cursor from one repeatable-read snapshot", stream: "/live/stream (SSE) or /live/events (pages)", resume: "events after the cursor; a cursor older than retention gets a `reset` (409) — take a new snapshot", retentionDays: RETENTION_DAYS, history: "/live/history covers all stored events", coalescing: "runs of ≥3 low-value events of one class are sent once with a count (seq = last)", ordering: "strictly increasing seq; apply idempotently by seq" },
    safety: "read-only (GET); bearer auth as /mcp; payload keys/values that look like secrets are redacted; the authenticated principal is never exposed",
};
//# sourceMappingURL=http.js.map