/** Live activity = units of work (spec §3.5, §14.2): grouping, titling, hiding, internal exclusion. */
import { describe, expect, it } from "vitest";
import { buildUnits, hiddenEvent, internalLinks, transitionOf } from "../../web/src/model/units";
import { corr, ev } from "./fixtures";

const career = { id: "a-career", name: "Career" };
const test = { id: "a-test", name: "Finagai Test" };

describe("hiddenEvent", () => {
  it("hides low-value, tool, source, routine and canary traffic; shows decisions and state changes", () => {
    expect(hiddenEvent(ev({ class: "workflow.completed", lowValue: true }))).toBe(true);
    expect(hiddenEvent(ev({ class: "tool.answered" }))).toBe(true);
    expect(hiddenEvent(ev({ class: "source.polled" }))).toBe(true);
    for (const c of ["workflow.invoked", "system.checked", "evidence.ignored", "capability.measured", "notification.suppressed"]) expect(hiddenEvent(ev({ class: c }))).toBe(true);
    expect(hiddenEvent(ev({ class: "workflow.completed", action: "canary_ran" }))).toBe(true);
    expect(hiddenEvent(ev({ class: "escalation.opened" }))).toBe(false);
    expect(hiddenEvent(ev({ class: "entity.state_changed" }))).toBe(false);
  });
});

describe("buildUnits", () => {
  it("groups by correlation id and titles the unit by its most significant event", () => {
    const u = buildUnits([
      ev({ class: "workflow.started", cause: corr("t1"), area: career }),
      ev({ class: "wait.expired", cause: corr("t1"), area: career, after: { summary: "Waiting on Beth Young" } }),
      ev({ class: "escalation.opened", cause: corr("t1"), area: career, nextOwner: "julian", after: { summary: "No answer from Beth Young — decide" } }),
      ev({ class: "workflow.completed", cause: corr("t1"), area: career }),
    ], new Set());
    expect(u).toHaveLength(1);
    expect(u[0]!.title).toBe("No answer from Beth Young — now your decision");
    expect(u[0]!.yours).toBe(true);
    expect(u[0]!.area?.name).toBe("Career");
    expect(u[0]!.steps.map((e) => e.class)).toEqual(["workflow.started", "wait.expired", "escalation.opened", "workflow.completed"]);
  });

  it("drops units in Finagai's internal test Area and canary units unless Everything is on", () => {
    const evs = [
      ev({ class: "escalation.opened", cause: corr("x"), area: test, after: { summary: "Test decision" } }),
      ev({ class: "workflow.invoked", cause: corr("c"), action: "work_invoked", after: { what: "canary:daily" } }),
      ev({ class: "entity.state_changed", cause: corr("c"), after: { changes: ["Canary opp: applied → offer"] } }),
      ev({ class: "entity.state_changed", cause: corr("r"), area: career, after: { changes: ["Vallum Associates: applied → rejected"] } }),
    ];
    const u = buildUnits(evs, new Set([test.id]));
    expect(u.map((x) => x.key)).toEqual(["r"]);
    expect(u[0]!.title).toBe("Vallum Associates: applied → rejected");
    expect(buildUnits(evs, new Set([test.id]), { everything: true }).map((x) => x.key).sort()).toEqual(["c", "r", "x"]);
  });

  it("hides units whose every event is low-value or routine, and units with nothing above the significance threshold", () => {
    const u = buildUnits([
      ev({ class: "tool.answered", cause: corr("a") }),
      ev({ class: "workflow.completed", cause: corr("b"), lowValue: true }),
      ev({ class: "workflow.started", cause: corr("c") }),
      ev({ class: "workflow.completed", cause: corr("c") }),            // a routine run with no changes
      ev({ class: "evidence.observed", cause: corr("d") }),
    ], new Set());
    expect(u).toEqual([]);
  });

  it("shows a scheduled job's completion and failures, newest unit first", () => {
    const u = buildUnits([
      ev({ class: "workflow.completed", action: "job_finished", cause: corr("j"), after: { job: "daily_maintenance", status: "ok" } }),
      ev({ class: "workflow.failed", cause: corr("f"), after: { workflow: "career_sync" } }),
    ], new Set());
    expect(u.map((x) => x.title)).toEqual(["Career sync failed", "Daily maintenance completed"]);
    expect(u[0]!.outcome).toBe("failed");
  });

  it("events without a correlation id are their own unit", () => {
    const u = buildUnits([ev({ class: "entity.state_changed", before: { status: "applied" }, after: { status: "offer" }, summary: "" }),
      ev({ class: "entity.state_changed", before: { status: "a" }, after: { status: "b" } })], new Set());
    expect(u).toHaveLength(2);
    expect(u[1]!.title).toBe("Changed status: status: applied → offer");
  });
});

describe("transitionOf", () => {
  it("lists changed scalar fields only, dates shortened", () => {
    expect(transitionOf(ev({ class: "wait.updated", before: { due_at: "2026-10-14T00:00:00Z", summary: "x", meta: {} }, after: { due_at: "2026-10-19T00:00:00Z", summary: "x", meta: { a: 1 } } })))
      .toBe("due at: 2026-10-14 → 2026-10-19");
    expect(transitionOf(ev({ class: "wait.updated", before: { a: 1 }, after: { a: 1 } }))).toBeNull();
  });
});

describe("internal test work never reaches Live activity (production finding 2026-10-15)", () => {
  const opp = "39a63fc3-9421-4708-8af9-e96a53adc536", esc = "a3d7db5b-71b6-4972-91bf-bef5edcfc36f", realOpp = "11111111-1111-1111-1111-111111111111";
  const internalAreas = new Set([test.id]);
  const evs = [
    // one career sync run that handled a real job AND the canary
    ev({ class: "evidence.observed", cause: corr("run"), entity: { type: "inbound_event", id: "22222222-2222-2222-2222-222222222222" }, summary: "Your application to Acceptance Canary 4B" }),
    ev({ class: "entity.state_changed", cause: corr("run"), area: career, entity: { type: "opportunity", id: realOpp }, after: { changes: ["Sky Solutions — applied → interviewing"] } }),
    ev({ class: "evidence.attached", cause: corr("run"), area: test, entity: { type: "opportunity", id: opp }, after: { opportunity_id: opp, summary: "Interview: Acceptance Canary 4B" } }),
    ev({ class: "workflow.completed", cause: corr("run"), area: career, after: { changes: ["status: ADR088-CANARY — Acceptance Canary 4B — applied → interviewing", "Sky Solutions — applied → interviewing"] } }),
    // a decision about the canary opportunity, created before Core recorded an Area on decisions (no Area on the row)
    ev({ class: "escalation.opened", cause: corr("run"), entity: { type: "escalation", id: esc }, after: { key: `career.sync:abc@opportunity:${opp}`, summary: "Career: ADR088-CANARY — Acceptance Canary 4B: evidence says interviewing" } }),
    // ... and its later resolution, alone in its own run
    ev({ class: "escalation.resolved", cause: corr("later"), entity: { type: "escalation", id: esc }, before: { key: `career.sync:abc@opportunity:${opp}` }, after: { key: `career.sync:abc@opportunity:${opp}`, summary: "Career: ADR088-CANARY — no longer needs you" } }),
  ];

  it("links the area-less decision and its resolution to the internal opportunity", () => {
    const links = internalLinks(evs, internalAreas);
    expect(links.has(opp)).toBe(true);
    expect(links.has(esc)).toBe(true);
    expect(links.has(realOpp)).toBe(false);
  });

  it("a mixed run shows only the real job's outcome; the canary's decision and resolution do not appear at all", () => {
    const u = buildUnits(evs, internalAreas);
    expect(u.map((x) => x.key)).toEqual(["run"]);
    expect(u[0]!.title).toBe("Sky Solutions — applied → interviewing");
    const text = JSON.stringify(u.map((x) => [x.title, x.steps.map((e) => [e.summary, e.after])]));
    expect(text).not.toMatch(/CANARY|Canary/);
  });

  it("Everything (diagnostic) still shows all of it", () => {
    expect(buildUnits(evs, internalAreas, { everything: true }).map((x) => x.key).sort()).toEqual(["later", "run"]);
  });
});
