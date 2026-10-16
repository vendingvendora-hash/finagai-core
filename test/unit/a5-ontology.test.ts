/**
 * E0 step A5 (ADR-090): one regression per confirmed ontology defect, each written against what the real writer stores
 * (pipelines/j6/control.ts, pipelines/j2/capture.ts, governance/execute.ts, events/engine.ts), not against invented payloads.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOMAINS, KNOWN_ACTIONS, classify, type StoredRow } from "../../src/live/ontology.js";
import { CONTRACT } from "../../src/live/http.js";
import { sanitize } from "../../src/live/stream.js";

const SRC = resolve(__dirname, "../../src");
const row = (action: string, entity_type: string | null, after: Record<string, unknown> | null, before: Record<string, unknown> | null = null): StoredRow => ({ action, entity_type, after, before, approval_id: null });

describe("A5-1 control_step_proposed reads the stored `approval` field", () => {
  // the writer: control.ts stores { code, kind, risk, summary, approval, authority, authorityReason, reflection, expect }
  it("the writer stores `approval`, never `needsApproval`", () => {
    const t = readFileSync(join(SRC, "pipelines/j6/control.ts"), "utf8");
    const call = t.slice(t.indexOf('action: "control_step_proposed"'), t.indexOf('action: "control_step_proposed"') + 400);
    expect(call).toMatch(/\bapproval,/);
    expect(call).not.toMatch(/needsApproval/);
  });
  it("a read-risk `run` step that REQUIRED approval is Julian's boundary (Mac tasks 137/138: sw_vers)", () => {
    const c = classify(row("control_step_proposed", "control_step", { code: 407, kind: "run", risk: "read", summary: "Run sw_vers -productVersion", approval: true, authority: "HIGH_RISK" }));
    expect(c).toEqual(expect.objectContaining({ class: "authority.boundary_encountered", nextOwner: "julian" }));
  });
  it("a write-risk step AUTOMATICALLY PERMITTED inside Julian's envelope is Finagai's step, not a boundary", () => {
    const c = classify(row("control_step_proposed", "control_step", { code: 12, kind: "type", risk: "write", summary: "Type the search query", approval: false, authority: "PREPARATORY", authorityReason: "preparatory, inside Julian's delegation" }));
    expect(c).toEqual(expect.objectContaining({ class: "task.step_proposed", nextOwner: "finagai" }));
  });
  it("a write-risk step that required approval (no envelope, or a commitment) is a boundary; a read step auto-run is Finagai's", () => {
    expect(classify(row("control_step_proposed", "control_step", { code: 13, kind: "click", risk: "write", summary: "Click Submit", approval: true, authority: "EXTERNAL_COMMITMENT" }))).toEqual(expect.objectContaining({ class: "authority.boundary_encountered", nextOwner: "julian" }));
    expect(classify(row("control_step_proposed", "control_step", { code: 14, kind: "screenshot", risk: "read", summary: "Look", approval: false, authority: "OBSERVE" }))).toEqual(expect.objectContaining({ class: "task.step_proposed", nextOwner: "finagai" }));
  });
  it("a row with no `approval` has an unknown approval state: a proposal with no owner, never an invented boundary (risk is not approval)", () => {
    for (const risk of ["write", "read", undefined]) {
      const c = classify(row("control_step_proposed", "control_step", { code: 1, kind: "click", ...(risk ? { risk } : {}), summary: "Click Save" }));
      expect(c, String(risk)).toEqual(expect.objectContaining({ class: "task.step_proposed", nextOwner: null }));
    }
  });
  it("history note: the field exists on every production row — the first J6 writer already stored it", () => {
    // git: cc665da (2026-10-03) wrote `after: { code, kind, risk, summary, approval }`; release #1 was 2026-10-04.
    // This test pins the current writer; the dated evidence is in docs/adr/0090-experience-read-models.md.
    const t = readFileSync(join(SRC, "pipelines/j6/control.ts"), "utf8");
    expect(t).toMatch(/const approval = auth\.decision === "approve";/);
  });
});

describe("A5-2 control_task_done carries and reads verification_status", () => {
  it("the writer now puts verification_status in the completion event's context", () => {
    const t = readFileSync(join(SRC, "pipelines/j6/control.ts"), "utf8");
    const call = t.slice(t.indexOf('action: "control_task_done"'), t.indexOf('action: "control_task_done"') + 300);
    expect(call).toMatch(/verification_status: epistemic/);
  });
  it("verified / unverified / needs_review stay distinguishable: the boolean, plus the status itself on the row", () => {
    const done = (verification_status: string) => row("control_task_done", "control_task", { status: "done", summary: "x", verification_status });
    expect(classify(done("verified")).verified).toBe(true);
    expect(classify(done("unverified")).verified).toBe(false);
    expect(classify(done("needs_review")).verified).toBe(false);
    // the stream envelope keeps `after` (sanitized), so a reader tells unverified from needs_review by the stored status
    expect(sanitize(done("needs_review").after!)).toEqual(expect.objectContaining({ verification_status: "needs_review" }));
    expect(sanitize(done("unverified").after!)).toEqual(expect.objectContaining({ verification_status: "unverified" }));
    expect(classify(row("control_task_done", "control_task", { status: "done", summary: "x" })).verified).toBe(null);
  });
  it("rows written since hotfix 35 (terminal_reason) read as verified without the new field (task 138, event 2771)", () => {
    expect(classify(row("control_task_done", "control_task", { status: "done", terminal_reason: "verified", result_summary: "macOS version is 15.3.1" }, { status: "active", terminal_reason: null })).verified).toBe(true);
  });
  it("the fallback never upgrades an unverified or needs-review completion: those rows carry a different terminal_reason", () => {
    // control.ts: the verifier-unavailable path sets terminal_reason = 'verifier_unavailable' before completing
    expect(classify(row("control_task_done", "control_task", { status: "done", terminal_reason: "verifier_unavailable", result_summary: "NEEDS YOUR REVIEW" })).verified).toBe(null);
    expect(classify(row("control_task_done", "control_task", { status: "done", terminal_reason: "verifier_unavailable", verification_status: "needs_review" })).verified).toBe(false);
  });
});

describe("A5-3 step decisions and work-item completion no longer fall through to other.*", () => {
  it.each([
    ["control_step_approved", { class: "task.step_approved", nextOwner: "finagai" }],
    ["control_step_rejected", { class: "task.step_rejected", nextOwner: "julian" }],
    ["control_step_ran", { class: "task.step_ran" }],
    ["control_step_failed", { class: "task.step_failed", nextOwner: "finagai" }],
  ])("%s", (action, expected) => {
    expect(classify(row(action, "control_step", action.endsWith("ran") || action.endsWith("failed") ? { result: "15.3.1" } : null))).toEqual(expect.objectContaining(expected));
  });
  it("status_change (a work item done from a capture) is a task state change", () => {
    expect(classify(row("status_change", "work_item", { title: "Send the deck", status: "done" }, { status: "open" })).class).toBe("task.state_changed");
  });
});

describe("A5-4 dead rules are gone; legacy actions still classify", () => {
  it("decision and request kinds that were never events have no rule", () => {
    for (const a of ["recover", "terminal", "set_due", "archive_records", "resolve_conflict", "decide_proposal", "promote_seed_batch", "confirm", "route", "ignore"]) expect(KNOWN_ACTIONS, a).not.toContain(a);
  });
  it("history written by retired writers keeps a class", () => {
    expect(classify(row("workflow_ran", null, { workflow: "career.sync" })).class).toBe("workflow.completed");
    expect(classify(row("followup_reply_received", "followup", { from: "x" })).class).toBe("wait.updated");
  });
});

describe("A5-5 knowledge items classify by their stored epistemic status", () => {
  it("what Julian stated or documented is knowledge, an inference is an inference", () => {
    expect(classify(row("create", "knowledge_item", { claim: "Beth Young runs the Altarum panel", epistemic_status: "user_provided" })).class).toBe("knowledge.created");
    expect(classify(row("create", "knowledge_item", { claim: "x", epistemic_status: "documented_claim" })).class).toBe("knowledge.created");
    expect(classify(row("create", "knowledge_item", { claim: "x", epistemic_status: "fact" })).class).toBe("knowledge.created");
    expect(classify(row("create", "knowledge_item", { claim: "they probably prefer mornings", epistemic_status: "inference" })).class).toBe("inference.created");
    expect(classify(row("create", "knowledge_item", { claim: "x", epistemic_status: "hypothesis" })).class).toBe("inference.created");
  });
  it("a creation that stored no status (seeded rows) is unclassified, never a guessed fact", () => {
    expect(classify(row("create", "knowledge_item", { seeded: true })).class).toBe("knowledge.unclassified");
    expect(classify(row("create", "knowledge_item", { claim: "x", epistemic_status: "unknown" })).class).toBe("knowledge.unclassified");
  });
  it("status updates and supersedes do not reclassify the item's nature", () => {
    expect(classify(row("update", "knowledge_item", { status: "active" }, { status: "disputed" })).class).toBe("knowledge.updated");
    expect(classify(row("supersede", "knowledge_item", { status: "superseded", superseded_by: "y" }, { status: "active" })).class).toBe("knowledge.superseded");
  });
  it("other entities keep their domains", () => {
    expect(classify(row("create", "project", { name: "p" })).class).toBe("project.created");
    expect(classify(row("create", "entity", { name: "e" })).class).toBe("entity.created");
  });
});

describe("A5-6 area health on the stream is the snapshot's three-colour verdict", () => {
  it("recordAreaHealth uses areaStatusRead and stores warnings with breaches", () => {
    const t = readFileSync(join(SRC, "events/engine.ts"), "utf8");
    const fn = t.slice(t.indexOf("async function recordAreaHealth"), t.indexOf("async function recordAreaHealth") + 1600);
    expect(fn).toMatch(/areaStatusRead\(pool, a\)/);
    expect(fn).toMatch(/after: \{ color, area: h\.area, breaches: h\.breaches, warnings: h\.warnings \}/);
    expect(fn).not.toMatch(/healthy \? "green" : "red"/);
  });
  it("yellow is a recorded colour; only red hands the Area to Finagai", () => {
    expect(classify(row("area_health_changed", "area", { color: "yellow", area: "Career", breaches: [], warnings: ["no movement for 8 days"] }, { color: "green" }))).toEqual(expect.objectContaining({ class: "area.health_changed", nextOwner: null }));
    expect(classify(row("area_health_changed", "area", { color: "red", area: "Career", breaches: ["1 follow-up(s) overdue (limit 0)"], warnings: [] }, { color: "yellow" })).nextOwner).toBe("finagai");
  });
});

describe("A5-7 the contract declares the domains the ontology emits", () => {
  it("system is declared, and the list is the ontology's own", () => {
    expect(CONTRACT.ontology.domains).toContain("system");
    expect(CONTRACT.ontology.domains).toContain("knowledge");
    expect(CONTRACT.ontology.domains).toEqual([...DOMAINS]);
  });
});
