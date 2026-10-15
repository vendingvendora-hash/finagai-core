import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "./components/Banner";
import { CommandScreen } from "./components/Command";
import { TopBar } from "./components/TopBar";
import { LiveController, useLive } from "./live/store";
import { deriveCommand } from "./model/command";
import { internalEvent, internalLinks } from "./model/units";
import { parseWhy, sameTarget, whyValue, withWhy, type WhyTarget } from "./inspector/model";
import { WhyInspector, type Crumb } from "./inspector/WhyInspector";
import type { LiveEvent } from "./model/types";

const DIAG = new URLSearchParams(location.search).has("diag");
const SEEN_KEY = "fcc.lastSeenEventId";
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY) ?? "0") || 0; } catch { return 0; } };
const writeSeen = (n: number) => { try { localStorage.setItem(SEEN_KEY, String(n)); } catch { /* per-browser convenience only */ } };

/**
 * The inspector lives in the URL (`?why=`), so it is deep-linkable and the browser's back button / back gesture closes it.
 * history.state carries how it was reached: `depth` = entries pushed since it opened over the page (0 = opened by a
 * deep link), `trail` = the breadcrumb of earlier roots, `focus` = Review (the item) or Why? (how it got here).
 */
interface WhyNav { depth: number; base: "page" | "link"; trail: Crumb[]; focus: "review" | "chain" }
interface WhyOpen { target: WhyTarget | "invalid"; nav: WhyNav }
function readWhy(): WhyOpen | null {
  const t = parseWhy(location.search);
  if (!t) return null;
  const nav = (history.state as { why?: WhyNav } | null)?.why ?? { depth: 0, base: "link", trail: [], focus: "review" };
  return { target: t, nav };
}

export function App() {
  const s = useLive();
  const ctl = useRef<LiveController | null>(null);
  const [now, setNow] = useState(Date.now());
  const [everything, setEverything] = useState(false);
  const [lastSeen] = useState(readSeen);
  const [why, setWhy] = useState<WhyOpen | null>(readWhy);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onPop = () => { const w = readWhy(); setWhy(w); if (!w) restoreFocus(); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const restoreFocus = () => { const el = opener.current; opener.current = null; if (el && document.contains(el)) el.focus(); };
  const openWhy = useCallback((t: WhyTarget, focus: "review" | "chain") => {
    opener.current = document.activeElement as HTMLElement | null;
    history.pushState({ why: { depth: 1, base: "page", trail: [], focus } satisfies WhyNav }, "", `${withWhy(location.search, t)}${location.hash}`);
    setWhy(readWhy());
  }, []);
  const reroot = useCallback((t: WhyTarget, fromHeading: string) => {
    const cur = readWhy();
    if (!cur || cur.target === "invalid" || sameTarget(cur.target, t)) return;
    const nav: WhyNav = { depth: cur.nav.depth + 1, base: cur.nav.base, trail: [...cur.nav.trail, { value: whyValue(cur.target), heading: fromHeading }], focus: "chain" };
    history.pushState({ why: nav }, "", `${withWhy(location.search, t)}${location.hash}`);
    setWhy(readWhy());
  }, []);
  const back = useCallback((i: number) => { const cur = readWhy(); if (cur) history.go(-(cur.nav.trail.length - i)); }, []);
  const closeWhy = useCallback(() => {
    const cur = readWhy();
    if (cur && cur.nav.base === "page" && cur.nav.depth > 0) { history.go(-cur.nav.depth); return; }   // popstate closes it
    history.pushState(null, "", `${withWhy(location.search, null)}${location.hash}`);
    setWhy(null); restoreFocus();
  }, []);

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

  const internalAreas = useMemo(() => new Set((s.snapshot?.areas ?? []).filter((a) => a.internal).map((a) => a.id)), [s.snapshot]);
  const links = useMemo(() => internalLinks(s.events, internalAreas), [s.events, internalAreas]);
  const view = useMemo(() => (s.snapshot ? deriveCommand(s.snapshot, s.reliability, now, s.snapshotAt, links) : null), [s.snapshot, s.reliability, now, s.snapshotAt, links]);
  const isInternal = useCallback((e: LiveEvent) => !everything && internalEvent(e, internalAreas, links), [everything, internalAreas, links]);
  const quietHeld = useMemo(() => heldForQuietHours(s.events, s.snapshot?.needsJulian.map((n) => n.key) ?? [], now), [s.events, s.snapshot, now]);

  return (
    <div className={`app conn-${s.conn} ${why ? "app--why" : ""}`}>
      <TopBar conn={s.conn} disconnectedAt={s.disconnectedAt} health={view?.health ?? "unknown"} healthWhy={view?.healthWhy ?? []} needs={view?.needs.length ?? 0}
        asOf={s.snapshotAt} quietHeld={quietHeld} />
      <Banner conn={s.conn} disconnectedAt={s.disconnectedAt} caughtUp={s.caughtUp} now={now} signedOut={s.signedOut} loadError={s.loadError} />
      {view && s.snapshot ? <CommandScreen view={view} snapshot={s.snapshot} events={s.events} arrivedLive={s.arrivedLive} conn={s.conn} now={now} gaps={s.gaps}
        everything={everything} {...(DIAG ? { setEverything } : {})} lastSeen={lastSeen} links={links} reliabilityWhy={s.reliability?.why ?? []} reliabilityVerdict={s.reliability?.verdict ?? null}
        onWhy={openWhy} />
        : !s.signedOut && !s.loadError && <p className="loading">Loading Finagai's state…</p>}
      {why && view && s.snapshot && <WhyInspector target={why.target} focus={why.nav.focus} trail={why.nav.trail} view={view} snapshot={s.snapshot} events={s.events}
        isInternal={isInternal} live={s.conn === "live"} onClose={closeWhy} onReroot={reroot} onBack={back} />}
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
