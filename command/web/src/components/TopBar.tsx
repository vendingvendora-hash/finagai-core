import type { Conn } from "../live/store";
import type { Health } from "../model/command";
import { fmtTime } from "../format";

const HEALTH: Record<Health, { glyph: string; label: string }> = {
  healthy: { glyph: "●", label: "Healthy" }, degraded: { glyph: "◑", label: "Degraded" }, attention: { glyph: "◆", label: "Attention" }, unknown: { glyph: "○", label: "Checking health" },
};

export function TopBar(p: { conn: Conn; disconnectedAt: number | null; health: Health; healthWhy: string[]; needs: number; asOf: number | null; quietHeld: number }) {
  const live = p.conn === "live";
  const conn = p.conn === "live" ? { cls: "conn--live", text: "Live" }
    : p.conn === "connecting" ? { cls: "conn--wait", text: "Connecting…" }
    : p.conn === "reconnecting" ? { cls: "conn--wait", text: "Reconnecting…" }
    : { cls: "conn--off", text: `Offline since ${p.disconnectedAt ? fmtTime(p.disconnectedAt) : "—"}` };
  const h = HEALTH[p.health];
  return (
    <header className="topbar" role="banner">
      <div className="topbar__brand">Finagai</div>
      <div className="topbar__status">
        {p.quietHeld > 0 && <span className="topbar__quiet">{p.quietHeld} notice{p.quietHeld === 1 ? "" : "s"} held until 7:00</span>}
        <span className={`conn ${conn.cls}`} role="status" aria-live="polite"><span aria-hidden="true">{p.conn === "live" ? "●" : p.conn === "offline" ? "○" : "◌"}</span> {conn.text}</span>
        <span className={`health health--${p.health}`} title={p.healthWhy.join("\n") || undefined}>
          <span aria-hidden="true">{h.glyph}</span> {h.label}{p.health === "degraded" && <span className="health__more"> — Finagai is handling it</span>}
        </span>
        {p.needs > 0 && <span className="needs-count">{p.needs} need{p.needs === 1 ? "s" : ""} you{!live && p.asOf ? ` (as of ${fmtTime(p.asOf)})` : ""}</span>}
      </div>
    </header>
  );
}
