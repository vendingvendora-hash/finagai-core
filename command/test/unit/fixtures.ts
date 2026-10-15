import type { LiveEvent, Snapshot, SnapshotArea, SnapshotNeed, SnapshotWait } from "../../web/src/model/types";

let n = 0;
export function ev(p: Partial<LiveEvent> & { class: string }): LiveEvent {
  n++;
  const [domain, verb] = p.class.split(".") as [string, string];
  return {
    v: 1, seq: p.seq ?? n, eventId: p.eventId ?? p.seq ?? n, at: p.at ?? new Date(Date.UTC(2026, 9, 15, 12, 0, n)).toISOString(),
    domain, verb, action: p.action ?? verb, actor: "cos", area: null, entity: { type: null, id: null }, summary: `${p.class}: thing ${n}`,
    before: null, after: null, cause: { correlationId: null, eventIds: [], requestId: null }, nextOwner: null, humanAuthorized: false,
    verified: null, confidence: null, lowValue: false, ...p,
  };
}
export const corr = (id: string) => ({ correlationId: id, eventIds: [], requestId: null });

export const area = (id: string, name: string, extra: Partial<SnapshotArea> = {}): SnapshotArea =>
  ({ id, name, status: "active", active_projects: 0, internal: false, health: { color: "green", breaches: [], warnings: [] }, ...extra });
export const need = (id: string, areaId: string | null, extra: Partial<SnapshotNeed> = {}): SnapshotNeed =>
  ({ id, key: `overdue:${id}:x`, area_id: areaId, needs: "principal_reserved", summary: `Decision ${id}`, due_at: null, notified_at: null,
     created_at: "2026-10-14T10:00:00Z", followup_id: null, subject: null, ...extra });
export const wait = (id: string, areaId: string | null, extra: Partial<SnapshotWait> = {}): SnapshotWait =>
  ({ id, area_id: areaId, summary: `Waiting ${id}`, counterparty: `Party ${id}`, state: "waiting", due_at: "2026-10-19T15:00:00Z", origin: "lifecycle",
     rule: "applied.awaiting_response", opportunity_id: null, project_id: null, escalated: false, owner: "finagai", ...extra });
export const snapshot = (p: Partial<Snapshot> = {}): Snapshot => ({
  v: 2, cursor: 100, takenAt: "2026-10-15T12:00:00Z", areas: [], waits: [], needsJulian: [], exceptions: [], tasks: [], rules: [],
  eventLoopLastTick: "2026-10-15T11:58:00Z", opportunitiesByStatus: {}, ...p,
});
