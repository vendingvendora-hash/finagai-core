/** The browser's SSE reader (fetch-based) and the event merge: frames split anywhere, heartbeats prove liveness,
 *  filtered-cursor advances, reset, 401; events deduplicated by id, ordered, bounded. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSse } from "../../web/src/live/sse";
import { MAX_EVENTS, mergeEvents } from "../../web/src/live/store";
import { ev } from "./fixtures";

function streamOf(chunks: string[], status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } });
  return vi.fn(async () => new Response(status === 200 ? body : null, { status, headers: { "content-type": "text/event-stream" } }));
}
function collect() {
  const out = { open: 0, alive: 0, messages: [] as Array<{ id: string | null; event: string; data: string }>, cursors: [] as string[], resets: [] as string[], closed: "" };
  return { out, h: { onOpen: () => { out.open++; }, onAlive: () => { out.alive++; }, onMessage: (m: { id: string | null; event: string; data: string }) => { out.messages.push(m); },
    onCursor: (id: string) => { out.cursors.push(id); }, onReset: (d: string) => { out.resets.push(d); }, onClose: (r: string) => { out.closed = r; } } };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); };

afterEach(() => vi.unstubAllGlobals());

describe("openSse", () => {
  it("parses messages split across chunks, ignores comments, reports cursor advances and resets, and sends Last-Event-ID", async () => {
    const f = streamOf([": heartbeat 1\n\n", "id: 41\nevent: entity.state_changed\nda", "ta: {\"seq\":41}\n\n", "id: 45\n: filtered\n\n", "event: reset\r\ndata: {\"reason\":\"retention\"}\r\n\r\n"]);
    vi.stubGlobal("fetch", f);
    const { out, h } = collect();
    openSse("/api/live/stream?after=40", "40", h);
    await until(() => out.closed !== "");
    expect(out.open).toBe(1);
    expect(out.alive).toBe(5);
    expect(out.messages).toEqual([{ id: "41", event: "entity.state_changed", data: "{\"seq\":41}" }]);
    expect(out.cursors).toEqual(["45"]);
    expect(out.resets).toEqual(["{\"reason\":\"retention\"}"]);
    expect(out.closed).toBe("ended");
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["last-event-id"]).toBe("40");
    expect(init.credentials).toBe("same-origin");
  });
  it("reports unauthorized on 401 (session ended) without opening", async () => {
    vi.stubGlobal("fetch", streamOf([], 401));
    const { out, h } = collect();
    openSse("/api/live/stream", null, h);
    await until(() => out.closed !== "");
    expect(out).toEqual(expect.objectContaining({ open: 0, closed: "unauthorized" }));
  });
});

describe("mergeEvents", () => {
  it("deduplicates by event id, keeps order, and is bounded", () => {
    const a = ev({ class: "wait.started", eventId: 5 }), b = ev({ class: "wait.started", eventId: 3 }), c = ev({ class: "wait.started", eventId: 9 });
    expect(mergeEvents([a, c], [b, a, c]).map((e) => e.eventId)).toEqual([3, 5, 9]);
    const many = Array.from({ length: MAX_EVENTS + 10 }, (_, i) => ev({ class: "wait.started", eventId: i + 1 }));
    const m = mergeEvents([], many);
    expect(m).toHaveLength(MAX_EVENTS);
    expect(m[0]!.eventId).toBe(11);
  });
});
