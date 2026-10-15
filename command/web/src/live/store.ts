/**
 * The Command Center's single live store (ADR-089 §15.1). It holds what Core served — never a competing truth:
 *   snapshot     the authoritative state at a cursor (replaced whole by every refresh; never patched from events)
 *   events       the semantic events seen (backfill + stream), deduplicated by event id, bounded
 *   lastSeq      the stream cursor (resume point); events with seq ≤ lastSeq are dropped (idempotent application)
 *   conn         connecting → live ⇄ reconnecting → offline, from real stream bytes and a 30 s watchdog
 * State-bearing events schedule a snapshot refresh (debounced); they never mutate business state here.
 */
import { create } from "zustand";
import type { LiveEvent, Reliability, Snapshot } from "../model/types";
import { hiddenEvent } from "../model/units";
import { openSse } from "./sse";

export type Conn = "connecting" | "live" | "reconnecting" | "offline";
export interface Gap { from: number; to: number; missed: number }

export interface LiveState {
  snapshot: Snapshot | null; snapshotAt: number | null;
  reliability: Reliability | null; reliabilityAt: number | null;
  events: LiveEvent[];
  /** event ids that arrived over the live stream after the first load (the only ones allowed to animate) */
  arrivedLive: Record<number, number>;
  lastSeq: number;
  conn: Conn; lastAliveAt: number | null; disconnectedAt: number | null;
  gaps: Gap[]; caughtUp: { count: number; at: number } | null;
  signedOut: boolean; loadError: string | null;
}

export const MAX_EVENTS = 2000;
const STATE_DOMAINS = new Set(["entity", "relationship", "area", "objective", "project", "task", "wait", "exception", "escalation", "approval", "rule", "lesson", "procedure", "authority"]);
const URGENT_DOMAINS = new Set(["escalation", "exception", "approval", "authority"]);
export const WATCHDOG_MS = 30_000, OFFLINE_MS = 60_000, SNAPSHOT_POLL_MS = 60_000;

export const useLive = create<LiveState>(() => ({
  snapshot: null, snapshotAt: null, reliability: null, reliabilityAt: null, events: [], arrivedLive: {}, lastSeq: 0,
  conn: "connecting", lastAliveAt: null, disconnectedAt: null, gaps: [], caughtUp: null, signedOut: false, loadError: null,
}));

/** Merge events into the store, deduplicated by event id and ordered by id. Pure; exported for tests. */
export function mergeEvents(current: LiveEvent[], incoming: LiveEvent[]): LiveEvent[] {
  if (!incoming.length) return current;
  const byId = new Map<number, LiveEvent>();
  for (const e of current) byId.set(e.eventId, e);
  for (const e of incoming) if (!byId.has(e.eventId)) byId.set(e.eventId, e);
  const all = [...byId.values()].sort((a, b) => a.eventId - b.eventId);
  return all.length > MAX_EVENTS ? all.slice(all.length - MAX_EVENTS) : all;
}

export interface ControllerDeps { fetchFn?: typeof fetch; now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; backfillHours?: number }

/** Orchestrates the network; framework-free so it can be tested directly. One instance per page. */
export class LiveController {
  private stop: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private relTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private relPoll: ReturnType<typeof setInterval> | null = null;
  private refreshing = false; private refreshAgain = false; private refreshDue = 0;
  private attempt = 0; private openedAt = 0;
  private blockedUntil = 0;
  private reopenedAt: number | null = null; private gapFrom: number | null = null; private caught = 0;
  private readonly f: typeof fetch; private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps = {}) {
    this.f = deps.fetchFn ?? ((...a) => fetch(...a));
    this.now = deps.now ?? (() => Date.now());
  }

  async start() {
    try {
      await this.loadSnapshot(true);
      await this.backfill();
    } catch (e) {
      if (!useLive.getState().signedOut) useLive.setState({ loadError: String((e as Error)?.message ?? e) });
      return;
    }
    void this.loadReliability();
    this.connect();
    this.watchdog = setInterval(() => this.tick(), 5_000);
    // Some authoritative fields change with no semantic event (a quiet check writes no event; it only moves the event
    // loop's last-check time). Re-read the snapshot and the report every minute while visible, and at once on return.
    // While disconnected the snapshot is deliberately left as it was (the screen says "as of" the disconnect); the
    // catch-up after reconnecting refreshes it once.
    const poll = () => { if (document.visibilityState === "visible" && useLive.getState().conn === "live") { this.scheduleRefresh(0); void this.loadReliability(); } };
    this.relPoll = setInterval(poll, SNAPSHOT_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("online", () => this.reconnectNow());
    window.addEventListener("offline", () => this.markDown());
  }

  dispose() {
    this.stop?.(); for (const t of [this.refreshTimer, this.relTimer, this.reconnectTimer]) if (t) clearTimeout(t);
    if (this.watchdog) clearInterval(this.watchdog); if (this.relPoll) clearInterval(this.relPoll);
  }

  /** Diagnostic: cut the stream and keep it down for `ms` (used to prove disconnect/resume on production). */
  interrupt(ms: number) { this.blockedUntil = this.now() + ms; this.stop?.(); this.stop = null; this.markDown(); this.scheduleReconnect(ms); }

  private async getJson<T>(path: string): Promise<T> {
    const r = await this.f(path, { credentials: "same-origin", cache: "no-store" });
    if (r.status === 401) { useLive.setState({ signedOut: true }); throw new Error("signed out"); }
    if (!r.ok) throw new Error(`${path} answered ${r.status}`);
    return (await r.json()) as T;
  }

  private async loadSnapshot(first = false) {
    const s = await this.getJson<Snapshot>("/api/live/snapshot");
    const cur = useLive.getState();
    // a snapshot is only ever replaced by one at the same or a later cursor
    if (cur.snapshot && s.cursor < cur.snapshot.cursor) return;
    useLive.setState({ snapshot: s, snapshotAt: this.now(), ...(first ? { lastSeq: Math.max(cur.lastSeq, s.cursor) } : {}) });
  }

  private async backfill() {
    // 24 h of context so that what the rail shows (12 h) can be linked to what caused it (e.g. internal test objects)
    const from = new Date(this.now() - (this.deps.backfillHours ?? 24) * 3_600_000).toISOString();
    const r = await this.getJson<{ events: LiveEvent[] }>(`/api/live/history?order=desc&limit=1000&from=${encodeURIComponent(from)}`);
    useLive.setState((s) => ({ events: mergeEvents(s.events, r.events) }));
  }

  async loadReliability() {
    try { const r = await this.getJson<Reliability>("/api/live/summary/reliability?days=1"); useLive.setState({ reliability: r, reliabilityAt: this.now() }); }
    catch { /* the last value stays, shown "as of" */ }
  }

  private connect() {
    if (this.now() < this.blockedUntil) { this.scheduleReconnect(this.blockedUntil - this.now()); return; }
    const after = useLive.getState().lastSeq;
    this.stop?.();
    this.stop = openSse(`/api/live/stream?after=${after}`, after ? String(after) : null, {
      onOpen: () => {
        this.attempt = 0; this.openedAt = this.now();
        const s = useLive.getState();
        if (s.disconnectedAt !== null) { this.reopenedAt = this.now(); this.gapFrom = s.disconnectedAt; this.caught = 0; }
        useLive.setState({ conn: "live", lastAliveAt: this.now() });
        if (this.reopenedAt !== null) {
          // the missed events arrive first; then restore fresh authoritative state once and say what was caught up
          setTimeout(() => this.finishCatchUp(), 3_000);
        }
      },
      onAlive: () => {
        const s = useLive.getState();
        useLive.setState({ lastAliveAt: this.now(), ...(s.conn !== "live" && this.now() >= this.blockedUntil ? { conn: "live" as Conn } : {}) });
      },
      onCursor: (id) => { const n = Number(id); if (Number.isFinite(n)) useLive.setState((s) => ({ lastSeq: Math.max(s.lastSeq, n) })); },
      onMessage: (m) => this.onEvent(m.data),
      onReset: () => { void this.resetAll(); },
      onClose: (reason) => {
        if (reason === "aborted") return;
        if (reason === "unauthorized") { useLive.setState({ signedOut: true }); return; }
        // Core ends a stream cleanly after its maximum duration: resume from the cursor at once, without telling Julian
        // the connection dropped. Only a failure (or a second clean end in a row) counts as a disconnection.
        if (reason === "ended" && this.now() - this.openedAt > 10_000 && useLive.getState().conn === "live") { this.scheduleReconnect(0); return; }
        this.markDown();
        this.scheduleReconnect(Math.min(10_000, 2_000 * 2 ** this.attempt++));
      },
    });
  }

  private onEvent(data: string) {
    let e: LiveEvent;
    try { e = JSON.parse(data) as LiveEvent; } catch { return; }
    const s = useLive.getState();
    if (e.seq <= s.lastSeq) return;                                   // idempotent: never apply twice
    const t = this.now();
    // during the catch-up window Core replays what was missed; count the meaningful ones (what Live activity would show)
    if (this.reopenedAt !== null && !hiddenEvent(e)) this.caught++;
    useLive.setState({ lastSeq: e.seq, lastAliveAt: t, events: mergeEvents(s.events, [e]), arrivedLive: { ...pruneArrived(s.arrivedLive, t), [e.eventId]: t } });
    // what Julian must see within 2 s (spec §18): his decisions and problems; other state changes coalesce for 1 s
    if (STATE_DOMAINS.has(e.domain)) this.scheduleRefresh(URGENT_DOMAINS.has(e.domain) ? 150 : 1_000);
    if (e.domain === "system" || e.domain === "exception" || e.class === "workflow.failed") this.scheduleReliability();
  }

  private finishCatchUp() {
    if (this.gapFrom === null || this.reopenedAt === null) return;
    const gap: Gap = { from: this.gapFrom, to: this.reopenedAt, missed: this.caught };
    useLive.setState((s) => ({ gaps: [...s.gaps, gap].slice(-20), caughtUp: { count: this.caught, at: this.now() }, disconnectedAt: null }));
    this.gapFrom = null; this.reopenedAt = null;
    this.scheduleRefresh(0);
    void this.loadReliability();
  }

  private markDown() {
    const s = useLive.getState();
    if (s.conn === "live" || s.conn === "connecting") useLive.setState({ conn: "reconnecting", disconnectedAt: s.disconnectedAt ?? s.lastAliveAt ?? this.now() });
  }

  private tick() {
    const s = useLive.getState(); const t = this.now();
    if (s.conn === "live" && s.lastAliveAt !== null && t - s.lastAliveAt > WATCHDOG_MS) { this.stop?.(); this.stop = null; this.markDown(); this.scheduleReconnect(0); }
    const down = useLive.getState();
    if ((down.conn === "reconnecting" || down.conn === "connecting") && down.disconnectedAt !== null && t - down.disconnectedAt > OFFLINE_MS) useLive.setState({ conn: "offline" });
    if (!navigator.onLine && down.conn === "live") this.markDown();
  }

  private scheduleReconnect(ms: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, Math.max(0, ms));
  }
  private reconnectNow() { this.attempt = 0; this.scheduleReconnect(0); }

  /** Refresh the snapshot after `ms`; bursts coalesce into one read, and an earlier deadline wins (decisions are urgent). */
  scheduleRefresh(ms = 1_000) {
    const due = this.now() + ms;
    if (this.refreshTimer) { if (due >= this.refreshDue) return; clearTimeout(this.refreshTimer); }
    this.refreshDue = due;
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      if (this.refreshing) { this.refreshAgain = true; return; }
      this.refreshing = true;
      try { await this.loadSnapshot(); } catch { /* stays as of the last refresh */ }
      finally { this.refreshing = false; if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(0); } }
    }, ms);
  }
  private scheduleReliability() {
    if (this.relTimer) return;
    this.relTimer = setTimeout(() => { this.relTimer = null; void this.loadReliability(); }, 5_000);
  }

  private async resetAll() {
    this.stop?.(); this.stop = null;
    useLive.setState({ events: [], arrivedLive: {}, lastSeq: 0, snapshot: null });
    await this.loadSnapshot(true); await this.backfill(); this.connect();
  }
}

function pruneArrived(m: Record<number, number>, now: number) {
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(m)) if (now - v < 60_000) out[Number(k)] = v;
  return out;
}
