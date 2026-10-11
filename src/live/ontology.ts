/**
 * ADR-087 — the Live State event ontology. Every stored event (the authoritative `event` row) is classified at read
 * time into `<domain>.<verb>` plus the few cross-cutting facts a visualization needs (who owns the next action, was it
 * human-authorized, verified, with what confidence). Classification is a pure function of the stored row, so the
 * ontology can evolve without rewriting history, and replay always agrees with the live stream.
 */
export type Domain =
  | "entity" | "relationship" | "area" | "objective" | "project" | "task" | "wait" | "workflow" | "tool" | "evidence"
  | "inference" | "lesson" | "procedure" | "capability" | "exception" | "escalation" | "approval" | "authority"
  | "notification" | "rule" | "source" | "system" | "other";

export interface Classified { class: string; domain: Domain; verb: string; nextOwner: "finagai" | "julian" | null; verified: boolean | null; confidence: number | null; lowValue: boolean }
export interface StoredRow { action: string; entity_type: string | null; after: Record<string, unknown> | null; before: Record<string, unknown> | null; approval_id: string | null }

const F = (domain: Domain, verb: string, extra: Partial<Classified> = {}) => ({ domain, verb, ...extra });
type Rule = (r: StoredRow) => ReturnType<typeof F>;
const ENTITY_BY_TYPE: Record<string, Domain> = { project: "project", work_item: "task", knowledge_item: "inference", entity: "entity", area: "area", objective: "objective", proposal: "approval", conflict: "evidence" };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** action → classification. Unknown actions still stream, as other.<action>. */
const RULES: Record<string, Rule> = {
  // world model
  create: (r) => F(ENTITY_BY_TYPE[r.entity_type ?? ""] ?? "entity", "created"),
  update: (r) => F(ENTITY_BY_TYPE[r.entity_type ?? ""] ?? "entity", "updated"),
  supersede: (r) => F(r.entity_type === "knowledge_item" ? "inference" : "entity", r.entity_type === "knowledge_item" ? "updated" : "superseded"),
  archive_records: () => F("entity", "archived"),
  archive: () => F("entity", "archived"),
  set_project: () => F("relationship", "changed"),
  set_due: () => F("task", "updated"),
  opportunity_tracked: () => F("entity", "created"),
  opportunity_status: () => F("entity", "state_changed"),
  opportunity_archived: () => F("entity", "archived"),
  artifact_registered: () => F("entity", "created"),
  // Areas / objectives / projects
  area_created: () => F("area", "created"),
  area_health_changed: (r) => F("area", "health_changed", { nextOwner: r.after?.color === "red" ? "finagai" : null }),
  objective_set: () => F("objective", "created"),
  project_placed: () => F("relationship", "created"),
  project_completed: () => F("project", "state_changed"),
  project_reopened: () => F("project", "state_changed"),
  bootstrap_applied: () => F("workflow", "completed", { verified: true }),
  // waits / follow-ups
  followup_created: (r) => F("wait", "started", { nextOwner: r.after?.owner === "julian" ? "julian" : "finagai" }),
  followup_waiting: () => F("wait", "started", { nextOwner: "finagai" }),
  followup_done: () => F("wait", "resolved"),
  followup_overdue: () => F("wait", "expired"),
  // Mac tasks (J6) and their authority boundary
  control_task_created: () => F("task", "created", { nextOwner: "finagai" }),
  control_step_proposed: (r) => F(r.after?.needsApproval || r.after?.risk === "write" ? "authority" : "task", r.after?.needsApproval || r.after?.risk === "write" ? "boundary_encountered" : "step_proposed",
    { nextOwner: r.after?.needsApproval || r.after?.risk === "write" ? "julian" : "finagai" }),
  control_task_done: (r) => F("task", "completed", { verified: r.after?.verification === "verified" ? true : r.after?.verification ? false : null }),
  control_task_cancelled: () => F("task", "cancelled"),
  false_completion: () => F("task", "failed", { verified: false }),
  recover: () => F("task", "recovered"),
  terminal: () => F("task", "state_changed"),
  authority_refused: () => F("authority", "boundary_encountered", { nextOwner: "julian" }),
  // workflows (event engine, learning, sync)
  workflow_started: () => F("workflow", "started", { nextOwner: "finagai" }),
  workflow_completed: () => F("workflow", "completed"),
  workflow_failed: () => F("workflow", "failed", { nextOwner: "finagai" }),
  workflow_ran: () => F("workflow", "completed"),
  career_synced: () => F("workflow", "completed"),
  learning_ran: () => F("workflow", "completed"),
  review_generated: () => F("workflow", "completed"),
  promote_seed_batch: () => F("workflow", "completed"),
  // tools / sources
  tool_called: (r) => F("tool", r.after?.outcome === "ok" ? "succeeded" : "failed", { verified: null, lowValue: r.after?.outcome === "ok" }),
  mcp_initialize: () => F("source", "connected", { lowValue: true }),
  mcp_tools_listed: () => F("source", "observed", { lowValue: true }),
  mcp_client_observed: () => F("source", "connected"),
  mcp_unknown_tool: () => F("tool", "failed"),
  // evidence
  evidence_observed: () => F("evidence", "observed"),
  evidence_routed: (r) => F("evidence", (r.after?.routes as unknown[] | undefined)?.length ? "classified" : "ignored", { lowValue: !(r.after?.routes as unknown[] | undefined)?.length }),
  conflict_open: () => F("evidence", "conflict_opened", { nextOwner: "julian" }),
  resolve_conflict: () => F("evidence", "conflict_resolved"),
  conflict_resolve: () => F("evidence", "conflict_resolved"),
  // learning
  lesson_learned: (r) => F(String(r.after?.key ?? "").startsWith("perf:") ? "capability" : "lesson", String(r.after?.key ?? "").startsWith("perf:") ? "measured" : "learned", { confidence: num(r.after?.confidence) }),
  lesson_stated: () => F("lesson", "stated", { confidence: 1 }),
  lesson_proposed: (r) => F(r.after?.effect && (r.after.effect as { type?: string }).type === "procedure" ? "procedure" : "lesson", r.after?.effect && (r.after.effect as { type?: string }).type === "procedure" ? "discovered" : "proposed", { nextOwner: "julian" }),
  lesson_approved: () => F("lesson", "approved"),
  lesson_rejected: () => F("lesson", "rejected"),
  lesson_active: () => F("lesson", "updated"),
  lesson_retired: () => F("lesson", "retired"),
  lesson_forgotten: () => F("lesson", "forgotten"),
  lesson_applied: () => F("procedure", "used"),
  // exceptions / escalations / notifications / rules
  exception_opened: (r) => F("exception", "opened", { nextOwner: r.after?.owner === "julian" ? "julian" : "finagai" }),
  exception_remedied: () => F("exception", "remediated", { nextOwner: "finagai" }),
  exception_resolved: () => F("exception", "cleared"),
  escalation_opened: (r) => F("escalation", "opened", { nextOwner: r.after?.needs === "requested" ? null : "julian" }),
  escalation_resolved: () => F("escalation", "resolved"),
  notification_delivered: () => F("notification", "delivered"),
  notification_suppressed: () => F("notification", "suppressed"),
  watch_rule_added: () => F("rule", "created"),
  watch_rule_removed: () => F("rule", "removed"),
  // approvals / governance
  proposal_open: () => F("approval", "requested", { nextOwner: "julian" }),
  proposal_decide: () => F("approval", "resolved"),
  decide_proposal: () => F("approval", "resolved"),
  governance_request_staged: () => F("approval", "requested", { nextOwner: "julian" }),
  governance_executed: () => F("approval", "resolved"),
  governance_rejected: () => F("approval", "resolved"),
  governance_expired: () => F("approval", "expired"),
  governance_superseded: () => F("approval", "superseded"),
  governance_approval_refused: () => F("authority", "boundary_encountered"),
  passkey_enrolled: () => F("authority", "credential_enrolled"),
  confirm: () => F("approval", "resolved"),
  route: () => F("evidence", "classified"),
  ignore: () => F("evidence", "ignored", { lowValue: true }),
};

export function classify(r: StoredRow): Classified {
  const rule = RULES[r.action] ?? (r.action.startsWith("concierge_") ? () => F("task", r.action.slice("concierge_".length)) : undefined);
  const base = rule ? rule(r) : F("other", r.action);
  return { class: `${base.domain}.${base.verb}`, domain: base.domain, verb: base.verb, nextOwner: base.nextOwner ?? null, verified: base.verified ?? null,
    confidence: base.confidence ?? null, lowValue: base.lowValue ?? false };
}
export const KNOWN_ACTIONS = Object.keys(RULES);
