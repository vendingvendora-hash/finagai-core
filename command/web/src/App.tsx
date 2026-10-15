import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "./components/Banner";
import { CommandScreen } from "./components/Command";
import { TopBar } from "./components/TopBar";
import { LiveController, useLive } from "./live/store";
import { deriveCommand } from "./model/command";
import type { LiveEvent } from "./model/types";

const DIAG = new URLSearchParams(location.search).has("diag");
const SEEN_KEY = "fcc.lastSeenEventId";
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY) ?? "0") || 0; } catch { return 0; } };
const writeSeen = (n: number) => { try { localStorage.setItem(SEEN_KEY, String(n)); } catch { /* per-browser convenience only */ } };

export function App() {
  const s = useLive();
  const ctl = useRef<LiveController | null>(null);
  const [now, setNow] = useState(Date.now());
  const [everything, setEverything] = useState(false);
  const [lastSeen] = useState(readSeen);

  useEffect(() => {
    const c = new LiveController(); ctl.current = c; void c.start();
    if (DIAG) (window as unknown as { __finagaiLive: unknown }).__finagaiLive = { interrupt: (ms: number) => c.interrupt(ms), state: () => useLive.getState() };
    // "since you last looked": remember the newest event seen when Julian leaves the page
    const save = () => { const ev = useLive.getState().events; if (ev.length) writeSeen(ev[ev.length - 1]!.eventId); };
    const onVis = () => { if (document.visibilityState === "hidden") save(); };
    document.addEventListener("visibilitychange", onVis); window.addEventListener("pagehide", save);
    return () => { c.dispose(); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pagehide", save); };
  }, []);

  // a clock for relative times and transient notes; it changes text, never moves anything
  const transient = (s.caughtUp && now - s.caughtUp.at < 9_000) || Object.values(s.arrivedLive).some((t) => now - t < 7_000);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), transient ? 1_000 : 15_000); return () => clearInterval(t); }, [transient]);

  // retry a failed first load
  useEffect(() => {
    if (!s.loadError) return;
    const t = setTimeout(() => { useLive.setState({ loadError: null }); void ctl.current?.start(); }, 10_000);
    return () => clearTimeout(t);
  }, [s.loadError]);

  const view = useMemo(() => (s.snapshot ? deriveCommand(s.snapshot, s.reliability, now) : null), [s.snapshot, s.reliability, now]);
  const quietHeld = useMemo(() => heldForQuietHours(s.events, s.snapshot?.needsJulian.map((n) => n.key) ?? [], now), [s.events, s.snapshot, now]);

  return (
    <div className={`app conn-${s.conn}`}>
      <TopBar conn={s.conn} disconnectedAt={s.disconnectedAt} health={view?.health ?? "unknown"} healthWhy={view?.healthWhy ?? []} needs={view?.needs.length ?? 0}
        asOf={s.snapshotAt} quietHeld={quietHeld} />
      <Banner conn={s.conn} disconnectedAt={s.disconnectedAt} caughtUp={s.caughtUp} now={now} signedOut={s.signedOut} loadError={s.loadError} />
      {view ? <CommandScreen view={view} events={s.events} arrivedLive={s.arrivedLive} conn={s.conn} now={now} gaps={s.gaps}
        everything={everything} {...(DIAG ? { setEverything } : {})} lastSeen={lastSeen} reliabilityWhy={s.reliability?.why ?? []} reliabilityVerdict={s.reliability?.verdict ?? null} />
        : !s.signedOut && !s.loadError && <p className="loading">Loading Finagai's state…</p>}
    </div>
  );
}

/** Notices held for quiet hours that still concern an open decision (only shown during quiet hours, 22:00–07:00). */
function heldForQuietHours(events: LiveEvent[], openKeys: string[], now: number): number {
  const h = new Date(now).getHours();
  if (!(h >= 22 || h < 7)) return 0;
  const open = new Set(openKeys); const held = new Set<string>();
  for (const e of events) {
    if (e.action !== "notification_suppressed" || now - Date.parse(e.at) > 10 * 3_600_000) continue;
    const a = (e.after ?? {}) as { reason?: string; keys?: string[] };
    if (!/quiet hours/.test(a.reason ?? "")) continue;
    for (const k of a.keys ?? []) if (open.has(k)) held.add(k);
  }
  return held.size;
}
