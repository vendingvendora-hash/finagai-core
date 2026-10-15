import type { Conn } from "../live/store";
import { fmtTime } from "../format";

/** The one place the UI admits its own limits: offline/stale, caught up, signed out, or a load failure. */
export function Banner(p: { conn: Conn; disconnectedAt: number | null; caughtUp: { count: number; at: number } | null; now: number; signedOut: boolean; loadError: string | null }) {
  if (p.signedOut) return <div className="banner banner--off" role="alert">Your session ended. <a href="/auth/login">Sign in again</a> to see live state.</div>;
  if (p.loadError) return <div className="banner banner--off" role="alert">Couldn't load Finagai's state ({p.loadError}). Retrying in a few seconds.</div>;
  if (p.conn === "offline") {
    const t = p.disconnectedAt ? fmtTime(p.disconnectedAt) : "—";
    return <div className="banner banner--off" role="alert">Live updates stopped at {t}. What you see is Finagai's state as of {t} and may have changed. Retrying every 10 seconds.</div>;
  }
  if (p.caughtUp && p.conn === "live" && p.now - p.caughtUp.at < 8_000)
    return <div className="banner banner--ok" role="status">Caught up — {p.caughtUp.count} change{p.caughtUp.count === 1 ? "" : "s"} while disconnected.</div>;
  return null;
}
