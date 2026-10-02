/**
 * J2 deterministic guards applied to model output (implementation plan sections 9 and 11).
 * Each guard is a pure function with a stable reason code recorded in capture_candidate.guard_reasons.
 */
import { z } from "zod";

// ---------------------------------------------------------------- G02: schema
export const ITEM_TYPES = [
  "project", "task", "deadline", "follow_up", "decision", "blocker", "fact", "correction", "preference",
  "procedure_change", "entity", "relationship", "external_ref", "open_question", "temporary",
] as const;
const WORK_ITEM_TYPES = new Set(["task", "deadline", "follow_up"]);

export const candidateSchema = z.object({
  temp_id: z.string().min(1).max(64),
  item_type: z.enum(ITEM_TYPES),
  fields: z.record(z.string(), z.string().nullable()),
  source_quote: z.string().min(1).max(2000),
  explicitly_stated: z.boolean(),
  stated_by: z.enum(["julian", "third_party", "document"]),
  epistemic_status: z.enum(["fact", "user_provided", "documented_claim", "inference", "hypothesis", "unknown"]),
  classification: z.enum(["public", "internal", "confidential", "highly_sensitive", "prohibited"]),
  source_visibility: z.enum(["public", "non_public"]),
  project_mention: z.string().nullable(),
  date_expression: z.string().nullable(),
  date_resolved: z.string().datetime({ offset: true }).nullable(),
  completion_stated: z.boolean(),
}).strict();

export const extractionResultSchema = z.object({
  language: z.enum(["es", "en", "mixed"]),
  candidates: z.array(candidateSchema).max(50),
}).strict();

export type Candidate = z.infer<typeof candidateSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export const relationResultSchema = z.object({
  judgments: z.array(z.object({
    temp_id: z.string(),
    relation: z.enum(["new", "duplicate", "update", "conflict", "supersedes"]),
    target_id: z.string().uuid().nullable(),
    changed_fields: z.array(z.string()),
    rationale: z.string().max(500),
  }).strict()),
}).strict();
export type RelationResult = z.infer<typeof relationResultSchema>;

// ---------------------------------------------------------------- reason codes
export type GuardReason =
  | "G01_quote_not_in_input" | "G03_task_not_explicit" | "G04_completion_without_statement"
  | "G05_target_not_in_match_set" | "G05_target_required" | "G09_sensitive_label" | "G09_overlaps_sensitive_span"
  | "temporary";

// ---------------------------------------------------------------- G01: quotes must exist in the input
export function normalizeForQuote(s: string): string {
  return s.normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

export function quoteInInput(input: string, quote: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length > 0 && normalizeForQuote(input).includes(q);
}

// ---------------------------------------------------------------- G04: completion needs a completion statement
const COMPLETION_CUES = [
  // English
  /\b(?:done|finished|completed?|sent|submitted|delivered|closed|resolved|signed|paid|wrapped up|took care of)\b/i,
  // Spanish
  /\b(?:listo|lista|hecho|hecha|terminad[oa]|termin[eé]|complet[eé]|completad[oa]|envi[eé]|enviad[oa]|entregu[eé]|entregad[oa]|cerrad[oa]|resuelt[oa]|firm[eé]|pagu[eé]|ya (?:lo|la) )/i,
];
export function quoteStatesCompletion(quote: string): boolean {
  return COMPLETION_CUES.some((re) => re.test(quote));
}

// ---------------------------------------------------------------- candidate-level verdict
export type CandidateVerdict =
  | { outcome: "accepted"; candidate: Candidate }
  | { outcome: "temporary_discarded"; candidate: Candidate }
  | { outcome: "guard_rejected"; candidate: Candidate; reasons: GuardReason[] };

/**
 * G01, G03, G04, G09 on one candidate. `redactedInput` is the capture text AFTER the G09 detector
 * ran (J2 step 1), which is also the only text the model ever sees. A quote must appear in it, so a
 * quote can never carry a secret; a quote that includes a redaction marker is rejected outright.
 */
export function checkCandidate(redactedInput: string, c: Candidate): CandidateVerdict {
  if (c.item_type === "temporary") return { outcome: "temporary_discarded", candidate: c };
  const reasons: GuardReason[] = [];
  if (!quoteInInput(redactedInput, c.source_quote)) reasons.push("G01_quote_not_in_input");
  if (WORK_ITEM_TYPES.has(c.item_type) && !(c.explicitly_stated && c.stated_by === "julian")) reasons.push("G03_task_not_explicit");
  if ((c.completion_stated || c.fields.status === "done") && !quoteStatesCompletion(c.source_quote)) {
    reasons.push("G04_completion_without_statement");
  }
  if (c.classification === "highly_sensitive" || c.classification === "prohibited") reasons.push("G09_sensitive_label");
  if (/\[REDACTED:[A-Za-z_]+\]/.test(c.source_quote) || Object.values(c.fields).some((v) => v !== null && /\[REDACTED:[A-Za-z_]+\]/.test(v))) {
    reasons.push("G09_overlaps_sensitive_span");
  }
  return reasons.length > 0 ? { outcome: "guard_rejected", candidate: c, reasons } : { outcome: "accepted", candidate: c };
}

// ---------------------------------------------------------------- G05: relation targets come from retrieval
export function checkRelationTarget(
  judgment: RelationResult["judgments"][number], matchSet: ReadonlySet<string>,
): GuardReason | null {
  if (judgment.relation === "new") return null;
  if (!judgment.target_id) return "G05_target_required";
  return matchSet.has(judgment.target_id) ? null : "G05_target_not_in_match_set";
}

// ---------------------------------------------------------------- G10: project resolution
export interface ProjectRef { id: string; name: string; aliases?: string[] }

export type ProjectResolution =
  | { kind: "resolved"; projectId: string }
  | { kind: "unassigned"; reason: "no_mention" | "no_match" | "ambiguous"; candidates: string[] };

/** Exact (case- and accent-insensitive) name or alias match only; anything else goes to Unassigned. */
export function resolveProject(mention: string | null, projects: readonly ProjectRef[], hintId?: string): ProjectResolution {
  if (hintId && projects.some((p) => p.id === hintId)) return { kind: "resolved", projectId: hintId };
  if (!mention) return { kind: "unassigned", reason: "no_mention", candidates: [] };
  const key = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  const m = key(mention);
  const hits = projects.filter((p) => [p.name, ...(p.aliases ?? [])].some((n) => key(n) === m));
  if (hits.length === 1) return { kind: "resolved", projectId: hits[0]!.id };
  return { kind: "unassigned", reason: hits.length === 0 ? "no_match" : "ambiguous", candidates: hits.map((h) => h.id) };
}
