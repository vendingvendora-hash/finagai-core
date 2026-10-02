import { describe, expect, it } from "vitest";
import {
  checkCandidate, checkRelationTarget, extractionResultSchema, quoteInInput, quoteStatesCompletion, resolveProject,
  type Candidate,
} from "../../src/guards/extraction.js";
import { capResponse, filterByTier } from "../../src/guards/output.js";
import { redactSensitive } from "../../src/guards/sensitive.js";

const base: Candidate = {
  temp_id: "c1", item_type: "task", fields: { title: "Send proposal to The Rustic Bar" },
  source_quote: "Tengo que enviar la propuesta a The Rustic Bar antes del viernes 9 de octubre",
  explicitly_stated: true, stated_by: "julian", epistemic_status: "user_provided", classification: "internal",
  source_visibility: "non_public", project_mention: "Vendora outreach", date_expression: "antes del viernes 9 de octubre",
  date_resolved: "2026-10-09T23:59:00-04:00", completion_stated: false,
};
const input = "Hoy hablé con el dueño. Tengo que enviar la propuesta a The Rustic Bar antes del viernes 9 de octubre.";
const c = (over: Partial<Candidate>): Candidate => ({ ...base, ...over });

describe("G02 extraction schema", () => {
  it("accepts a well-formed result and rejects unknown fields or types", () => {
    expect(extractionResultSchema.safeParse({ language: "es", candidates: [base] }).success).toBe(true);
    expect(extractionResultSchema.safeParse({ language: "es", candidates: [{ ...base, item_type: "wish" }] }).success).toBe(false);
    expect(extractionResultSchema.safeParse({ language: "es", candidates: [{ ...base, extra: 1 }] }).success).toBe(false);
    expect(extractionResultSchema.safeParse({ language: "es", candidates: [{ ...base, date_resolved: "next Friday" }] }).success).toBe(false);
  });
});

describe("G01 quotes must come from the input", () => {
  it("accepts verbatim quotes despite whitespace, case, and typographic-quote differences", () => {
    expect(quoteInInput("He said \u201cship it\u201d  today", 'he said "ship it" today')).toBe(true);
    expect(checkCandidate(input, base).outcome).toBe("accepted");
  });
  it("rejects a fabricated quote (unacceptable error: invented fact)", () => {
    const v = checkCandidate(input, c({ source_quote: "Julian said the deadline is Monday" }));
    expect(v).toMatchObject({ outcome: "guard_rejected", reasons: ["G01_quote_not_in_input"] });
  });
});

describe("G03 only explicitly stated work items", () => {
  it("rejects an inferred task (T08: 'I think they're not interested' creates no task)", () => {
    const text = "No reply to two emails; I think they're not interested.";
    const v = checkCandidate(text, c({ source_quote: "I think they're not interested", explicitly_stated: false, fields: { title: "Drop the lead" } }));
    expect(v).toMatchObject({ outcome: "guard_rejected", reasons: ["G03_task_not_explicit"] });
  });
  it("rejects tasks stated by a third party or a document unless Julian states them", () => {
    const v = checkCandidate(input, c({ stated_by: "document" }));
    expect(v.outcome).toBe("guard_rejected");
  });
  it("lets facts through without the explicit-task rule", () => {
    expect(checkCandidate(input, c({ item_type: "fact", explicitly_stated: false })).outcome).toBe("accepted");
  });
});

describe("G04 completion requires a completion statement", () => {
  it("accepts completion stated in English or Spanish", () => {
    expect(quoteStatesCompletion("I sent the proposal this morning")).toBe(true);
    expect(quoteStatesCompletion("Ya envié la propuesta")).toBe(true);
    expect(quoteStatesCompletion("listo, ya lo firmé")).toBe(true);
  });
  it("rejects marking done without one (unacceptable error: incorrectly marking completed)", () => {
    const v = checkCandidate(input, c({ completion_stated: true }));
    expect(v).toMatchObject({ outcome: "guard_rejected", reasons: ["G04_completion_without_statement"] });
  });
});

describe("G09 sensitive content never becomes a candidate", () => {
  it("rejects candidates the model labels Highly Sensitive or Prohibited", () => {
    expect(checkCandidate(input, c({ classification: "highly_sensitive" }))).toMatchObject({ reasons: ["G09_sensitive_label"] });
  });
  it("rejects a quote that includes redacted material (T09)", () => {
    const { text } = redactSensitive("POS login password: Hunter2!x. Renew the POS contract by Friday.");
    expect(checkCandidate(text, c({ item_type: "fact", source_quote: "POS login password: [REDACTED:password]", fields: { claim: "POS password" } })))
      .toMatchObject({ outcome: "guard_rejected", reasons: ["G09_overlaps_sensitive_span"] });
    expect(checkCandidate(text, c({ source_quote: "Renew the POS contract by Friday", fields: { title: "Renew POS contract" } })).outcome)
      .toBe("accepted");
  });
});

describe("temporary information (T06)", () => {
  it("is discarded, never stored", () => {
    expect(checkCandidate("I'm tired today, keep it short", c({ item_type: "temporary", source_quote: "I'm tired today" })).outcome)
      .toBe("temporary_discarded");
  });
});

describe("G05 relation targets come only from retrieval", () => {
  const matchSet = new Set(["7b1f2c40-0000-4000-8000-000000000001"]);
  const j = (over: object) => ({ temp_id: "c1", relation: "update" as const, target_id: "7b1f2c40-0000-4000-8000-000000000001", changed_fields: [], rationale: "r", ...over });
  it("accepts a retrieved target and 'new' without one", () => {
    expect(checkRelationTarget(j({}), matchSet)).toBeNull();
    expect(checkRelationTarget(j({ relation: "new", target_id: null }), matchSet)).toBeNull();
  });
  it("rejects an invented or missing target", () => {
    expect(checkRelationTarget(j({ target_id: "7b1f2c40-0000-4000-8000-000000000099" }), matchSet)).toBe("G05_target_not_in_match_set");
    expect(checkRelationTarget(j({ relation: "conflict", target_id: null }), matchSet)).toBe("G05_target_required");
  });
});

describe("G10 project resolution", () => {
  const projects = [
    { id: "p1", name: "Vendora outreach", aliases: ["outreach"] },
    { id: "p2", name: "Job search" },
    { id: "p3", name: "Búsqueda de empleo" },
    { id: "p4", name: "Outreach" },
  ];
  it("resolves exact names and aliases, ignoring case and accents", () => {
    expect(resolveProject("vendora OUTREACH", projects)).toEqual({ kind: "resolved", projectId: "p1" });
    expect(resolveProject("busqueda de empleo", projects)).toEqual({ kind: "resolved", projectId: "p3" });
  });
  it("sends unknown or ambiguous mentions to Unassigned instead of guessing", () => {
    expect(resolveProject("Vendora", projects)).toMatchObject({ kind: "unassigned", reason: "no_match" });
    expect(resolveProject("outreach", projects)).toMatchObject({ kind: "unassigned", reason: "ambiguous" });
    expect(resolveProject(null, projects)).toMatchObject({ kind: "unassigned", reason: "no_mention" });
  });
  it("honors an explicit project hint that exists", () => {
    expect(resolveProject("anything", projects, "p2")).toEqual({ kind: "resolved", projectId: "p2" });
  });
});

describe("G19 tier filter and G21 size cap", () => {
  it("withholds anything above Confidential in v1", () => {
    const rows = [{ classification: "public" as const }, { classification: "confidential" as const }, { classification: "highly_sensitive" as const }];
    expect(filterByTier(rows)).toEqual({ rows: rows.slice(0, 2), withheld: 1 });
  });
  it("caps response size and reports truncation", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ i, text: "x".repeat(100) }));
    const r = capResponse(items, 2_000);
    expect(r.truncated).toBe(true);
    expect(r.items.length + r.omitted).toBe(100);
    expect(Buffer.byteLength(JSON.stringify(r.items))).toBeLessThanOrEqual(2_000);
  });
});
