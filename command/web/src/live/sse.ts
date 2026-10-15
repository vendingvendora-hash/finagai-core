/**
 * A Server-Sent Events reader over fetch (same-origin; the BFF session cookie authenticates it).
 * Chosen over EventSource because the Command Center must see Core's heartbeat comments (": heartbeat …") to know
 * the stream is alive, and must control reconnect timing and the resume cursor itself. Frames are parsed per the SSE
 * spec: `id:`, `event:`, `data:` lines; a blank line ends a message; lines starting with ":" are comments.
 */
export interface SseHandlers {
  onOpen(): void;
  onMessage(m: { id: string | null; event: string; data: string }): void;
  /** any byte from the server (messages, heartbeats, filtered-cursor advances) — proof the stream is alive */
  onAlive(): void;
  onCursor(id: string): void;
  onReset(data: string): void;
  onClose(reason: "ended" | "error" | "unauthorized" | "aborted"): void;
}

export function openSse(url: string, lastEventId: string | null, h: SseHandlers): () => void {
  const ac = new AbortController();
  void (async () => {
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "text/event-stream", ...(lastEventId ? { "last-event-id": lastEventId } : {}) }, signal: ac.signal, cache: "no-store", credentials: "same-origin" });
    } catch { return h.onClose(ac.signal.aborted ? "aborted" : "error"); }
    if (res.status === 401) return h.onClose("unauthorized");
    if (!res.ok || !res.body) return h.onClose("error");
    h.onOpen();
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = ""; let id: string | null = null; let event = "message"; let data: string[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        h.onAlive();
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
          if (line === "") {
            if (data.length) { if (event === "reset") h.onReset(data.join("\n")); else h.onMessage({ id, event, data: data.join("\n") }); }
            else if (id) h.onCursor(id);                  // "id: N" + comment: Core advanced the cursor past filtered rows
            id = null; event = "message"; data = []; continue;
          }
          if (line.startsWith(":")) continue;
          const c = line.indexOf(":"); const field = c < 0 ? line : line.slice(0, c); let val = c < 0 ? "" : line.slice(c + 1); if (val.startsWith(" ")) val = val.slice(1);
          if (field === "id") id = val; else if (field === "event") event = val; else if (field === "data") data.push(val);
        }
      }
      h.onClose("ended");
    } catch { h.onClose(ac.signal.aborted ? "aborted" : "error"); }
  })();
  return () => ac.abort();
}
