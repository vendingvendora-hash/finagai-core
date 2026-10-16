/**
 * ADR-087 — read-only HTTP surface of the Live State Stream (for a future Command Center). Bearer-authenticated
 * exactly like /mcp (Julian's identity, same audience); GET only — viewing can never change operational state.
 *   GET /live/contract                  the contract (version, envelope fields, ontology, retention)
 *   GET /live/snapshot[?area=]          current authoritative state + the cursor it is consistent with
 *   GET /live/events?after=N[&area&class&limit]   one ordered page (polling clients)
 *   GET /live/stream?after=N[&area&class]         Server-Sent Events: id = seq, resumable with Last-Event-ID
 *   GET /live/history?from&to[&area&class&limit]  semantic replay over all stored events
 *   GET /live/chain/<eventId>           the causal chain behind one event
 *   GET /live/summary/reliability?days|since   the Phase 8 reliability report (ADR-089 slice 0: pure read)
 * History (ADR-089 slice 0): filters apply before the limit; `order=desc` pages newest-first with `before=<eventId>`.
 */
import type http from "node:http";
import type pg from "pg";
import { DOMAINS, KNOWN_ACTIONS } from "./ontology.js";
import { CONTRACT_VERSION, RETENTION_DAYS, causalChain, coalesce, history, publish, readAfter, snapshot, type Filter } from "./stream.js";
import { reliabilityReport } from "./reliability.js";

const HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", ...HEADERS }); res.end(JSON.stringify(body)); };

export interface LiveHttpOpts { pollMs?: number; heartbeatMs?: number; maxStreamMs?: number }

function filterOf(u: URL): Filter {
  const classes = (u.searchParams.get("class") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  return { area: u.searchParams.get("area"), ...(classes.length ? { classes } : {}), entityType: u.searchParams.get("entityType"), entityId: u.searchParams.get("entityId") };
}
const intParam = (v: string | null | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export function liveHandler(pool: pg.Pool, opts: LiveHttpOpts = {}) {
  const pollMs = opts.pollMs ?? 1000, heartbeatMs = opts.heartbeatMs ?? 15_000, maxStreamMs = opts.maxStreamMs ?? 3_600_000;
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET", ...HEADERS }); res.end(); return; }   // observational only
    const path = url.pathname;
    try {
      if (path === "/live/contract") return json(res, 200, CONTRACT);
      if (path === "/live/snapshot") { await publish(pool); return json(res, 200, await snapshot(pool, filterOf(url))); }
      if (path === "/live/events") {
        await publish(pool);
        const r = await readAfter(pool, intParam(url.searchParams.get("after"), 0), filterOf(url), Math.min(intParam(url.searchParams.get("limit"), 500), 2000));
        return json(res, r.reset ? 409 : 200, r.reset ? r : { ...r, events: coalesce(r.events) });
      }
      if (path === "/live/history") {
        const p = url.searchParams;
        return json(res, 200, { events: await history(pool, { ...filterOf(url), from: p.get("from") ?? undefined, to: p.get("to") ?? undefined, limit: intParam(p.get("limit"), 500),
          order: p.get("order") === "desc" ? "desc" : "asc", ...(p.get("before") ? { before: intParam(p.get("before"), 0) } : {}), ...(p.get("after") ? { after: intParam(p.get("after"), 0) } : {}) } as never) });
      }
      if (path === "/live/summary/reliability") {
        // The same report as `finagai-job: reliability` — computed from the stream, read-only (SELECTs only).
        const since = url.searchParams.get("since");
        const days = intParam(url.searchParams.get("days"), 1);
        const d = since ? new Date(since) : null;
        return json(res, 200, await reliabilityReport(pool, d && !Number.isNaN(d.getTime()) ? { since: d } : { days }));
      }
      const chain = /^\/live\/chain\/(\d+)$/.exec(path);
      if (chain) return json(res, 200, { chain: await causalChain(pool, Number(chain[1])) });
      if (path === "/live/stream") return stream(req, res, url);
      return json(res, 404, { error: "not_found" });
    } catch { if (!res.headersSent) json(res, 500, { error: "internal_error" }); else res.end(); }
  };

  async function stream(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const f = filterOf(url);
    let cursor = intParam(String(req.headers["last-event-id"] ?? "") || url.searchParams.get("after"), 0);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no", ...HEADERS });
    let open = true; req.on("close", () => { open = false; });
    const write = async (chunk: string) => { if (!res.write(chunk)) await new Promise<void>((r) => res.once("drain", () => r())); };   // backpressure
    const started = Date.now(); let lastBeat = Date.now();
    await write(`retry: 2000\n: finagai live stream v${CONTRACT_VERSION} from ${cursor}\n\n`);
    while (open && Date.now() - started < maxStreamMs) {
      await publish(pool).catch(() => undefined);
      const r = await readAfter(pool, cursor, f, 500);
      if (r.reset) { await write(`event: reset\ndata: ${JSON.stringify({ reason: r.reason, oldest: r.oldest })}\n\n`); break; }
      for (const e of coalesce(r.events)) await write(`id: ${e.seq}\nevent: ${e.class}\ndata: ${JSON.stringify(e)}\n\n`);
      if (r.cursor > cursor && !r.events.length) await write(`id: ${r.cursor}\n: filtered\n\n`);   // advance the client's resume point past filtered rows
      cursor = r.cursor;
      if (r.more) continue;
      if (Date.now() - lastBeat >= heartbeatMs) { await write(`: heartbeat ${new Date().toISOString()}\n\n`); lastBeat = Date.now(); }
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
  ontology: { domains: [...DOMAINS], classifiedActions: KNOWN_ACTIONS.length },
  delivery: { snapshot: "/live/snapshot returns state + cursor from one repeatable-read snapshot", stream: "/live/stream (SSE) or /live/events (pages)", resume: "events after the cursor; a cursor older than retention gets a `reset` (409) — take a new snapshot", retentionDays: RETENTION_DAYS, history: "/live/history covers all stored events; filters (area, class, entityType, entityId) apply before the limit; order=desc with before=<eventId> pages newest-first",
    summaries: { reliability: "/live/summary/reliability?days=N | ?since=<ISO> — the Phase 8 report (read-only)" }, coalescing: "runs of ≥3 low-value events of one class are sent once with a count (seq = last)", ordering: "strictly increasing seq; apply idempotently by seq" },
  safety: "read-only (GET); bearer auth as /mcp; payload keys/values that look like secrets are redacted; the authenticated principal is never exposed",
} as const;
