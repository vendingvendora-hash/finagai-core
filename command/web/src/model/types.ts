/** Shapes served by Core's Live State Stream (contract v2), as the Command Center reads them. Never extended here. */
export interface LiveEvent {
  v: 1; seq: number; eventId: number; at: string;
  class: string; domain: string; verb: string; action: string; actor: string;
  area: { id: string; name: string | null } | null;
  entity: { type: string | null; id: string | null };
  summary: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  cause: { correlationId: string | null; eventIds: number[]; requestId: string | null };
  nextOwner: "finagai" | "julian" | null; humanAuthorized: boolean; verified: boolean | null; confidence: number | null;
  lowValue: boolean;
  coalesced?: { count: number; firstSeq: number };
}

export interface SnapshotArea { id: string; name: string; status: string; active_projects: number; internal: boolean;
  health: { color: "green" | "yellow" | "red"; breaches: string[]; warnings: string[] } }
export interface SnapshotWait { id: string; area_id: string | null; summary: string; counterparty: string | null; state: string; due_at: string | null;
  origin: string; rule: string | null; opportunity_id: string | null; project_id: string | null; escalated: boolean; owner: "julian" | "finagai" }
export interface SnapshotNeed { id: string; key: string; area_id: string | null; needs: "judgment" | "authorization" | "principal_reserved"; summary: string;
  due_at: string | null; notified_at: string | null; created_at: string; followup_id: string | null; subject: { type: string; id: string } | null }
export interface SnapshotException { key: string; detector: string; area_id: string | null; owner: "julian" | "finagai"; severity: "info" | "warning" | "critical";
  needs: string | null; summary: string; first_seen_at: string; remediation: string | null; remediation_attempts: number }
export interface SnapshotTask { code: number; status: string; verification_status: string | null; awaiting_kind: string | null; request: string; updated_at: string }
export interface SnapshotRule { code: number; statement: string; kind: string; metric: string | null; armed: boolean; last_fired_at: string | null }

export interface Snapshot {
  v: number; cursor: number; takenAt: string;
  areas: SnapshotArea[]; waits: SnapshotWait[]; needsJulian: SnapshotNeed[]; exceptions: SnapshotException[];
  tasks: SnapshotTask[]; rules: SnapshotRule[]; eventLoopLastTick: string | null;
  opportunitiesByStatus: Record<string, number>;
}

export interface Reliability {
  window: { from: string; to: string; days: number };
  verdict: "healthy" | "degraded";
  why: string[];
  selfCheck: { runs: number; failingRuns: number; last: { at: string; version: string | null } | null };
}
