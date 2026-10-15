/** Live activity = units of work (spec §3.5, §14.2): grouping, titling, hiding, internal exclusion. */
import { describe, expect, it } from "vitest";
import { buildUnits, decisionText, hiddenEvent, historyText, internalLinks, openSubjects, transitionOf } from "../../web/src/model/units";
import { area, corr, ev, need, snapshot, wait } from "./fixtures";
import { currentResolver } from "../../web/src/model/current";
import { deriveCommand } from "../../web/src/model/command";
import { chainModel } from "../../web/src/inspector/model";
import type { Snapshot } from "../../web/src/model/types";

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
    expect(u[0]!.title).toBe("No answer from Beth Young — became your decision");
    expect(u[0]!.yours).toBe(false);                 // ◆ comes only from the snapshot (nothing open was passed)
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
    expect(u.map((x) => x.key)).toEqual([`opportunity:${realOpp}`]);
    expect(u[0]!.title).toBe("Sky Solutions — applied → interviewing");
    const text = JSON.stringify(u.map((x) => [x.title, x.steps.map((e) => [e.summary, e.after])]));
    expect(text).not.toMatch(/CANARY|Canary/);
  });

  it("Everything (diagnostic) still shows all of it", () => {
    const u = buildUnits(evs, internalAreas, { everything: true });
    expect(u.flatMap((x) => x.events.map((e) => e.eventId)).sort()).toEqual(evs.map((e) => e.eventId).sort());
  });
});

/** Production event sequence of Mac task 137 (2026-10-15, events 2671–2717), trimmed to the fields Command reads. */
const TASK = "88ebe32b-385c-444e-b443-9d9e9caa63d9", STEP = "0e32e995-0000-4000-8000-000000000406", ESC = "6c51aaaa-0000-4000-8000-000000000001";
const KEY = `mac:137:step:406@control_task:${TASK}`;
const SUMMARY = "Mac task 137 is waiting for your approval — step 406: Run the read-only command `sw_vers -productVersion` to get the macOS version. Reply \"ok 406\" or \"no 406\" in Messages, or \"stop 137\".";
const task = { type: "control_task", id: TASK }, step = { type: "control_step", id: STEP }, esc = { type: "escalation", id: ESC };
function task137(upTo = 2717) {
  return [
    ev({ eventId: 2671, class: "workflow.invoked", action: "work_invoked", actor: "julian", cause: corr("8e1e"), after: { what: "tool:control_mac" } }),
    ev({ eventId: 2672, class: "task.created", cause: corr("8e1e"), entity: task, nextOwner: "finagai", summary: "task.created", after: { code: 137, request: "Read-only check, change nothing: run `sw_vers -productVersion`" } }),
    ev({ eventId: 2674, class: "workflow.invoked", action: "work_invoked", actor: "j6", cause: corr("3676"), after: { what: "mac:/control/next" } }),
    ev({ eventId: 2676, class: "task.step_proposed", cause: corr("3676"), entity: step, summary: "task.step_proposed: Run the read-only command `sw_vers -productVersion`", after: { code: 406, kind: "run", summary: "Run the read-only command" } }),
    ev({ eventId: 2677, class: "task.state_changed", cause: corr("3676"), entity: task, nextOwner: "julian", summary: "task.state_changed: waiting_approval", before: { status: "active" }, after: { status: "waiting_approval", kind: "approval", reason: "step 406: Run the read-only command `sw_vers -productVersion` to get the macOS version" } }),
    ev({ eventId: 2684, class: "workflow.invoked", action: "work_invoked", cause: corr("6c51"), after: { what: "engine:tick", trigger: "interval" } }),
    ev({ eventId: 2685, class: "escalation.opened", cause: corr("6c51"), entity: esc, nextOwner: "julian", summary: `escalation.opened: ${SUMMARY}`, after: { key: KEY, needs: "authorization", summary: SUMMARY } }),
    ev({ eventId: 2707, class: "workflow.invoked", action: "work_invoked", actor: "j6", cause: corr("def4"), after: { what: "mac:/control/decision" } }),
    ev({ eventId: 2708, class: "task.state_changed", cause: corr("def4"), entity: task, summary: "task.state_changed: active", before: { status: "waiting_approval" }, after: { status: "active", decision: "step approved" } }),
    ev({ eventId: 2709, class: "task.state_changed", cause: corr("def4"), entity: task, summary: "task.state_changed", before: { awaiting_kind: "approval" }, after: { waitEnded: true, awaiting_kind: null } }),
    ev({ eventId: 2710, class: "escalation.resolved", cause: corr("def4"), entity: esc, summary: `escalation.resolved: ${SUMMARY}`, before: { status: "open" }, after: { key: KEY, needs: "authorization", status: "resolved", summary: SUMMARY, resolution: "step approved by Julian" } }),
    ev({ eventId: 2711, class: "other.control_step_approved", action: "control_step_approved", cause: corr("def4"), entity: step, summary: "other.control_step_approved" }),
    ev({ eventId: 2712, class: "workflow.invoked", action: "work_invoked", actor: "j6", cause: corr("d675"), after: { what: "mac:/control/ran" } }),
    ev({ eventId: 2713, class: "other.control_step_ran", action: "control_step_ran", cause: corr("d675"), entity: step, summary: "other.control_step_ran", after: { result: "15.3.1\n" } }),
    ev({ eventId: 2714, class: "workflow.invoked", action: "work_invoked", actor: "j6", cause: corr("86a8"), after: { what: "mac:/mac/heartbeat" } }),
    ev({ eventId: 2715, class: "task.state_changed", cause: corr("86a8"), entity: task, summary: "task.state_changed: failed", before: { status: "active" }, after: { status: "failed", why: "stalled: no progress for 10 min after the lease expired", failure_class: "stalled" } }),
    ev({ eventId: 2716, class: "workflow.invoked", action: "work_invoked", actor: "j6", cause: corr("f87a"), after: { what: "mac:/control/next" } }),
    ev({ eventId: 2717, class: "task.completed", cause: corr("f87a"), entity: task, summary: "task.completed: macOS version is 15.3.1", before: { status: "failed" }, after: { status: "done", summary: "macOS version is 15.3.1, read with `sw_vers -productVersion`. Nothing was changed.", terminal_reason: "verified" } }),
  ].filter((e) => e.eventId <= upTo);
}
const PRESENT_INSTRUCTION = /now your decision|no longer needs you|is waiting for your|Reply "ok|— approve|give a new date|or close it/i;

describe("Live activity is history: one story per unit of work, phrased by its final outcome (Slice 3 activity semantics)", () => {
  it("task 137's seven units of work are ONE story, titled by how it ended, past tense, every step kept", () => {
    const u = buildUnits(task137(), new Set());
    expect(u).toHaveLength(1);
    expect(u[0]!.title).toBe("Mac task 137: you approved step 406; task completed — macOS version is 15.3.1, read with `sw_vers -productVersion`. Nothing was…");
    expect(u[0]!.outcome).toBeNull();                               // the stall was superseded by completion
    expect(u[0]!.yours).toBe(false);
    expect(u[0]!.parts).toBe(7);
    // history is consolidated, not hidden: every visible step of every unit is in the story
    expect(u[0]!.steps.map((e) => e.eventId)).toEqual([2672, 2676, 2677, 2685, 2708, 2709, 2710, 2711, 2713, 2715, 2717]);
    expect(u[0]!.lastId).toBe(2717);
    // no line of it reads as a current instruction
    for (const t of [u[0]!.title, ...u[0]!.steps.map(historyText)]) expect(t).not.toMatch(PRESENT_INSTRUCTION);
    expect(historyText(u[0]!.steps.find((e) => e.eventId === 2685)!)).toBe("Mac task 137 asked for your approval — step 406: Run the read-only command `sw_vers -productVersion` to get the macOS version");
    expect(historyText(u[0]!.steps.find((e) => e.eventId === 2713)!)).toBe("result: 15.3.1");
  });

  it("while the approval is still open the story says what was asked — and ◆ appears only because the snapshot lists it", () => {
    const evs = task137(2685);
    const closed = buildUnits(evs, new Set());
    expect(closed[0]!.title).toBe("Mac task 137: asked for your approval of step 406");
    expect(closed[0]!.yours).toBe(false);                           // history alone never makes it Julian's
    const open = openSubjects([{ id: ESC, key: KEY, followup_id: null, subject: task }]);
    const u = buildUnits(evs, new Set(), { open });
    expect(u[0]!.title).toBe("Mac task 137: asked for your approval of step 406");
    expect(u[0]!.yours).toBe(true);
    // ... and once Core resolves it, the same story is history: no ◆ even though an event said nextOwner julian
    const after = buildUnits(task137(), new Set(), { open: openSubjects([]) });
    expect(after[0]!.yours).toBe(false);
  });

  it("a stale open-set never lies about the past: the title follows the recorded outcome", () => {
    const open = openSubjects([{ id: ESC, key: KEY, followup_id: null, subject: task }]);
    expect(buildUnits(task137(), new Set(), { open })[0]!.title).toMatch(/^Mac task 137: you approved step 406; task completed/);
  });

  it("decline → direction → cancel reads as what happened, in order", () => {
    const T = "44444444-4444-4444-8444-444444444444", E1 = "e1000000-0000-4000-8000-000000000001", E2 = "e2000000-0000-4000-8000-000000000002";
    const k1 = `mac:140:step:410@control_task:${T}`, k2 = `mac:140:rejected:1760000000000@control_task:${T}`;
    const u = buildUnits([
      ev({ class: "task.created", cause: corr("a"), entity: { type: "control_task", id: T }, after: { code: 140, request: "Send the reply" } }),
      ev({ class: "escalation.opened", cause: corr("b"), entity: { type: "escalation", id: E1 }, after: { key: k1, summary: "Mac task 140 is waiting for your approval — step 410: Click Send. Reply \"ok 410\"" } }),
      ev({ class: "escalation.resolved", cause: corr("c"), entity: { type: "escalation", id: E1 }, after: { key: k1, resolution: "step declined by Julian" } }),
      ev({ class: "escalation.opened", cause: corr("c"), entity: { type: "escalation", id: E2 }, after: { key: k2, summary: "Mac task 140 is waiting for your direction after you declined a step — x. Reply in Messages" } }),
      ev({ class: "escalation.resolved", cause: corr("d"), entity: { type: "escalation", id: E2 }, after: { key: k2, resolution: "task cancelled by Julian" } }),
      ev({ class: "task.state_changed", cause: corr("d"), entity: { type: "control_task", id: T }, after: { status: "cancelled" } }),
    ], new Set());
    expect(u.map((x) => x.title)).toEqual(["Mac task 140: you declined step 410; you cancelled it"]);
  });

  it("a step that needs approval (authority.boundary_encountered on the step) is part of its task's story; cancel/expire end it", () => {
    const T = "88888888-8888-4888-8888-888888888888", S = "99999999-9999-4999-8999-999999999999", E1 = "e8000000-0000-4000-8000-000000000008";
    const key = `mac:150:step:500@control_task:${T}`;
    const base = [
      ev({ class: "task.created", cause: corr("a"), entity: { type: "control_task", id: T }, after: { code: 150, request: "Fill the Acme form" } }),
      ev({ class: "authority.boundary_encountered", action: "control_step_proposed", cause: corr("b"), entity: { type: "control_step", id: S }, nextOwner: "julian", after: { code: 500, risk: "write", needsApproval: true, summary: "Click Submit" } }),
      ev({ class: "task.state_changed", cause: corr("b"), entity: { type: "control_task", id: T }, nextOwner: "julian", after: { status: "waiting_approval", reason: "step 500: Click Submit" } }),
      ev({ class: "escalation.opened", cause: corr("b"), entity: { type: "escalation", id: E1 }, after: { key, summary: "Mac task 150 is waiting for your approval — step 500: Click Submit. Reply \"ok 500\"" } }),
    ];
    expect(buildUnits(base, new Set()).map((x) => [x.key, x.title])).toEqual([[`control_task:${T}`, "Mac task 150: asked for your approval of step 500"]]);
    const cancelled = buildUnits([...base,
      ev({ class: "escalation.resolved", cause: corr("c"), entity: { type: "escalation", id: E1 }, after: { key, resolution: "step declined by Julian" } }),
      ev({ class: "task.cancelled", action: "control_task_cancelled", cause: corr("d"), entity: { type: "control_task", id: T }, after: { status: "cancelled" } }),
    ], new Set());
    expect(cancelled.map((x) => x.title)).toEqual(["Mac task 150: you declined step 500; task was cancelled"]);
    const expired = buildUnits([...base,
      ev({ class: "escalation.resolved", cause: corr("c"), entity: { type: "escalation", id: E1 }, after: { key, resolution: "expired without an answer" } }),
      ev({ class: "task.expired", action: "control_task_expired", cause: corr("c"), entity: { type: "control_task", id: T }, after: { status: "expired" } }),
    ], new Set());
    expect(expired.map((x) => x.title)).toEqual(["Mac task 150: expired without your answer"]);
  });

  it("a decision's story: opened, then resolved, then the outcome — instruction text never repeated", () => {
    const F = "55555555-5555-4555-8555-555555555555", E = "e3000000-0000-4000-8000-000000000003";
    const sum = "No answer from Beth Young by 2026-10-14 — approve a follow-up (Finagai drafts it; it goes out as you), give a new date, or close it";
    const opened = [
      ev({ class: "wait.expired", cause: corr("t1"), area: career, entity: { type: "followup", id: F }, after: { summary: "Waiting on Beth Young — Outcome of the panel" } }),
      ev({ class: "escalation.opened", cause: corr("t1"), area: career, entity: { type: "escalation", id: E }, summary: `escalation.opened: ${sum}`, after: { key: `overdue:${F}:2026-10-14`, summary: sum } }),
    ];
    const open = buildUnits(opened, new Set(), { open: openSubjects([{ id: E, key: `overdue:${F}:2026-10-14`, followup_id: F, subject: null }]) });
    expect(open.map((x) => [x.title, x.yours])).toEqual([["No answer from Beth Young by 2026-10-14 — became your decision", true]]);
    const done = buildUnits([...opened,
      ev({ class: "escalation.resolved", cause: corr("t2"), area: career, entity: { type: "escalation", id: E }, after: { key: `overdue:${F}:2026-10-14`, summary: sum, resolution: "Julian gave a new date" } }),
      ev({ class: "wait.updated", cause: corr("t2"), area: career, entity: { type: "followup", id: F }, before: { due_at: "2026-10-14T00:00:00Z" }, after: { due_at: "2026-10-21T00:00:00Z" } }),
    ], new Set());
    expect(done.map((x) => [x.title, x.yours, x.parts])).toEqual([["No answer from Beth Young by 2026-10-14 — resolved (Julian gave a new date)", false, 2]]);
    for (const e of done[0]!.steps) expect(historyText(e)).not.toMatch(PRESENT_INSTRUCTION);
  });

  it("routine work that only shares the Area never joins a story; the item is dated by the step its title speaks of", () => {
    const F = "77777777-7777-4777-8777-777777777777", E = "e7000000-0000-4000-8000-000000000007", careerId = { type: "area", id: career.id };
    const u = buildUnits([
      ev({ eventId: 2411, at: "2026-10-14T18:02:00Z", class: "wait.expired", cause: corr("t1"), area: career, entity: { type: "followup", id: F }, after: { summary: "Waiting on Beth Young" } }),
      ev({ eventId: 2413, at: "2026-10-14T18:04:00Z", class: "escalation.opened", cause: corr("t1"), area: career, entity: { type: "escalation", id: E }, after: { key: `overdue:${F}:2026-10-14`, summary: "No answer from Beth Young by 2026-10-14 — give a new date, or close it" } }),
      ev({ eventId: 2414, at: "2026-10-14T18:04:01Z", class: "area.health_changed", cause: corr("t1"), area: career, entity: careerId, before: { color: "green" }, after: { color: "red" } }),
      ev({ eventId: 2416, at: "2026-10-14T18:04:02Z", class: "escalation.notified", cause: corr("t1"), area: career, entity: { type: "escalation", id: E }, after: { key: `overdue:${F}:2026-10-14` } }),
      // a later career sync with no changes, on the same Area (production events 2568–2572)
      ev({ eventId: 2568, at: "2026-10-15T09:09:00Z", class: "evidence.observed", cause: corr("s"), entity: { type: "inbound_event", id: "3a25910a-d409-4cd5-b195-d48b253d4db7" }, summary: "evidence.observed: Career Copilot sheet changed" }),
      ev({ eventId: 2571, at: "2026-10-15T09:09:02Z", class: "workflow.completed", action: "career_synced", cause: corr("s"), area: career, entity: careerId, after: { changes: [] } }),
    ], new Set());
    expect(u.map((x) => [x.title, x.steps.map((e) => e.eventId), x.at])).toEqual([
      ["No answer from Beth Young by 2026-10-14 — became your decision", [2411, 2413, 2414, 2416], "2026-10-14T18:04:01Z"],
    ]);
  });

  it("decisionText keeps what a decision was about and drops only the instruction", () => {
    const d = (summary: string, key = "x") => decisionText(ev({ class: "escalation.opened", after: { key, summary } }));
    expect(d("Finagai couldn't clear this itself in 1 h: Gmail watcher failing — tell it to keep trying, or have it fixed")).toBe("Finagai couldn't clear this itself in 1 h: Gmail watcher failing");
    expect(d("Finagai learned something that would change how it works — approve applying it? Follow up after 5 days")).toBe("Finagai learned something that would change how it works: Follow up after 5 days");
    expect(d("Career: Acme — Analyst: evidence says interviewing but the job is withdrawn — interviewing reported after the job was withdrawn"))
      .toBe("Career: Acme — Analyst: evidence says interviewing but the job is withdrawn — interviewing reported after the job was withdrawn");
    expect(d("Your Mac has been unreachable for 2:10 and 1 Mac task(s) are waiting — wake it / open the Finagai helper (only you can)")).toBe("Your Mac has been unreachable for 2:10 and 1 Mac task(s) are waiting");
  });

  it("work about no object stays its own item; a minor fragment never becomes an item by itself", () => {
    const u = buildUnits([
      ev({ class: "workflow.completed", action: "job_finished", cause: corr("j"), after: { job: "daily_maintenance", status: "ok" } }),
      ev({ class: "other.control_step_ran", action: "control_step_ran", cause: corr("m"), entity: { type: "control_step", id: "66666666-6666-4666-8666-666666666666" }, after: { result: "ok" } }),
    ], new Set());
    expect(u.map((x) => x.title)).toEqual(["Daily maintenance completed"]);
  });
});

/** Slice 3 acceptance invariant 2: unfinished work reads in its CURRENT state, which only the snapshot decides. */
describe("unfinished work is shown in its current state (from the snapshot), never as finished history", () => {
  /** a snapshot that already reflects every event in the fixture (its cursor is past them all) */
  const snapAt = (p: Partial<Snapshot> = {}) => snapshot({ cursor: 1e9, ...p });
  const units = (evs: ReturnType<typeof task137>, snap: Snapshot) => {
    const v = deriveCommand(snap, null, Date.parse("2026-10-15T17:00:00Z"));
    return buildUnits(evs, v.internalAreaIds, { open: openSubjects(v.needs), current: currentResolver(snap, v) });
  };
  // Core serves the code as a string (a pg bigint) — the lookup must not depend on that
  const task = (status: string, awaiting_kind: string | null = null) => ({ code: "137" as unknown as number, status, verification_status: null, awaiting_kind, request: "Read-only check: report the macOS version", updated_at: "" });

  it("a task waiting for Julian's approval: present tense, ◆, the request — not 'asked for your approval'", () => {
    const snap = snapAt({ needsJulian: [need(ESC, null, { key: KEY, needs: "authorization", subject: { type: "control_task", id: TASK } })], tasks: [task("waiting_approval", "approval")] });
    const u = units(task137(2685), snap);
    expect(u.map((x) => [x.title, x.yours, x.current?.owner])).toEqual([["Mac task 137 — waiting for your approval of step 406: Read-only check: report the macOS version", true, "julian"]]);
  });

  it("a running task after Julian approved: 'running', with what already happened kept as history", () => {
    const u = units(task137(2711), snapAt({ tasks: [task("active")] }));
    expect(u.map((x) => [x.title, x.yours, x.outcome])).toEqual([["Mac task 137 — running: Read-only check: report the macOS version (earlier: you approved step 406)", false, null]]);
  });

  it("recovering after a stall: Core lists it active again → running (the earlier failure is not its final word)", () => {
    const u = units(task137(2715), snapAt({ tasks: [task("active")] }));
    expect(u[0]!.title).toMatch(/^Mac task 137 — running/);
    expect(u[0]!.outcome).toBeNull();
  });

  it("blocked on the model budget: paused, Finagai's — not Julian's", () => {
    const u = units(task137(2672), snapAt({ tasks: [task("paused", "budget")] }));
    expect(u.map((x) => [x.title, x.yours])).toEqual([["Mac task 137 — paused until the model budget allows: Read-only check: report the macOS version", false]]);
  });

  it("one time base: while the snapshot predates the approval, the title is the snapshot's state without the newer history (production, task 138)", () => {
    // the stream already carries "ok 406" (events 2707–2711, seq > cursor) but the snapshot (cursor before them) still lists the wait
    const evs = task137(2711).map((e) => ({ ...e, seq: e.eventId }));
    const snap = snapAt({ cursor: 2700, needsJulian: [need(ESC, null, { key: KEY, needs: "authorization", subject: { type: "control_task", id: TASK } })], tasks: [task("waiting_approval", "approval")] });
    const u = units(evs, snap);
    expect(u[0]!.title).toBe("Mac task 137 — waiting for your approval of step 406: Read-only check: report the macOS version");
    expect(u[0]!.title).not.toMatch(/you approved/);
    // the refreshed snapshot (cursor past them) moves it on, with the approval as history
    expect(units(evs, snapAt({ cursor: 2711, tasks: [task("active")] }))[0]!.title).toBe("Mac task 137 — running: Read-only check: report the macOS version (earlier: you approved step 406)");
  });

  it("production replay, Mac task 138 (events 2755–2773, seq 2724–2742): waiting → (lag) → running → completed, each title on one time base", () => {
    const T = "bad1b009-89bd-4ada-8eb5-bc4914a99f6c", E = "c45fd3d4-a60f-46e9-a2d6-057cfc4b0e4a", K = `mac:138:step:407@control_task:${T}`;
    const S = "Mac task 138 is waiting for your approval — step 407: Run the read-only command `sw_vers -productVersion` to get the macOS version. Reply \"ok 407\" or \"no 407\" in Messages, or \"stop 138\".";
    const req = "Controlled read-only acceptance check (Julian authorized exactly one): run the single read-only command `sw_vers -productVersion` as one `run` step and report the macOS version number.";
    const at = (id: number, seq: number, p: Parameters<typeof ev>[0]) => ev({ eventId: id, seq, ...p });
    const all = [
      at(2755, 2724, { class: "workflow.invoked", action: "work_invoked", actor: "julian", cause: corr("547d"), after: { what: "tool:control_mac" } }),
      at(2756, 2725, { class: "task.created", actor: "julian", cause: { correlationId: "547d", eventIds: [2755], requestId: null }, entity: { type: "control_task", id: T }, summary: "task.created", after: { code: 138, request: req } }),
      at(2758, 2727, { class: "workflow.invoked", action: "work_invoked", actor: "j6", cause: corr("8eab"), after: { what: "mac:/control/next" } }),
      at(2760, 2729, { class: "task.step_proposed", actor: "j6", cause: { correlationId: "8eab", eventIds: [2758], requestId: null }, entity: { type: "control_step", id: "57e9aaaa-0000-4000-8000-000000000407" }, summary: "task.step_proposed: Run the read-only command", after: { code: 407, kind: "run", risk: "read" } }),
      at(2761, 2730, { class: "task.state_changed", actor: "j6", cause: { correlationId: "8eab", eventIds: [2758], requestId: null }, entity: { type: "control_task", id: T }, nextOwner: "julian", summary: "task.state_changed: waiting_approval", before: { status: "active" }, after: { status: "waiting_approval", awaiting_kind: "approval" } }),
      at(2762, 2731, { class: "escalation.opened", cause: { correlationId: "8eab", eventIds: [2761], requestId: null }, entity: { type: "escalation", id: E }, nextOwner: "julian", summary: `escalation.opened: ${S}`, after: { key: K, needs: "authorization", summary: S } }),
      at(2763, 2732, { class: "workflow.invoked", action: "work_invoked", actor: "j6", cause: corr("bc4b"), after: { what: "mac:/control/decision" } }),
      at(2764, 2733, { class: "task.state_changed", actor: "julian", cause: { correlationId: "bc4b", eventIds: [2763], requestId: null }, entity: { type: "control_task", id: T }, summary: "task.state_changed: active", before: { status: "waiting_approval" }, after: { status: "active", decision: "step approved" } }),
      at(2765, 2734, { class: "task.state_changed", actor: "j6", cause: { correlationId: "bc4b", eventIds: [2763], requestId: null }, entity: { type: "control_task", id: T }, summary: "task.state_changed", before: { awaiting_kind: "approval" }, after: { awaiting_kind: null } }),
      at(2766, 2735, { class: "escalation.resolved", cause: { correlationId: "bc4b", eventIds: [2765], requestId: null }, entity: { type: "escalation", id: E }, summary: `escalation.resolved: ${S}`, before: { status: "open" }, after: { key: K, status: "resolved", summary: S, resolution: "step approved by Julian" } }),
      at(2769, 2738, { class: "other.control_step_ran", action: "control_step_ran", actor: "j6", cause: corr("2968"), entity: { type: "control_step", id: "57e9aaaa-0000-4000-8000-000000000407" }, summary: "other.control_step_ran", after: { result: "15.3.1\n" } }),
      at(2771, 2740, { class: "task.completed", actor: "j6", cause: corr("f762"), entity: { type: "control_task", id: T }, summary: "task.completed: macOS version is 15.3.1", before: { status: "active" }, after: { status: "done", summary: "macOS version is 15.3.1 (from the single read-only `sw_vers -productVersion` command; nothing changed).", terminal_reason: "verified" } }),
    ];
    const t138 = (status: string, awaiting_kind: string | null = null) => ({ code: "138" as unknown as number, status, verification_status: null, awaiting_kind, request: req.slice(0, 200), updated_at: "" });
    const open = [need(E, null, { key: K, needs: "authorization", subject: { type: "control_task", id: T } })];
    const titleAt = (upTo: number, snap: Snapshot) => { const u = units(all.filter((e) => e.eventId <= upTo), snap); expect(u).toHaveLength(1); return [u[0]!.title, u[0]!.yours, u[0]!.current ? "open" : "done"]; };
    // 1) waiting (snapshot read after the escalation opened)
    expect(titleAt(2762, snapshot({ cursor: 2731, needsJulian: open, tasks: [t138("waiting_approval", "approval")] })))
      .toEqual([expect.stringMatching(/^Mac task 138 — waiting for your approval of step 407: Controlled read-only/), true, "open"]);
    // 2) the lag window observed live on hotfix 47: approval events streamed, snapshot not yet re-read → still the snapshot's state, no "you approved"
    const lag = titleAt(2766, snapshot({ cursor: 2731, needsJulian: open, tasks: [t138("waiting_approval", "approval")] }));
    expect(lag[0]).toMatch(/^Mac task 138 — waiting for your approval of step 407: /); expect(lag[0]).not.toMatch(/you approved/);
    // 3) running (snapshot re-read): the approval is history
    expect(titleAt(2769, snapshot({ cursor: 2738, tasks: [t138("active")] }))).toEqual([expect.stringMatching(/^Mac task 138 — running: .*\(earlier: you approved step 407\)$/), false, "open"]);
    // 4) completed: past tense with the verified outcome
    expect(titleAt(2771, snapshot({ cursor: 2740 }))).toEqual(["Mac task 138: you approved step 407; task completed — macOS version is 15.3.1 (from the single read-only `sw_vers -productVersion`…", false, "done"]);
  });

  it("finished (Core no longer lists it): the past-tense story", () => {
    expect(units(task137(), snapAt())[0]!.title).toMatch(/^Mac task 137: you approved step 406; task completed — /);
  });

  it("an open decision, an open wait and a problem being fixed each read as still open", () => {
    const career = area("a-career", "Career");
    const F = "55555555-5555-4555-8555-555555555555", W = "66666666-6666-4666-8666-666666666666", E = "e3000000-0000-4000-8000-000000000003";
    const sum = "No answer from Beth Young by 2026-10-14 — approve a follow-up (Finagai drafts it; it goes out as you), give a new date, or close it";
    const evs = [
      ev({ class: "escalation.opened", cause: corr("d"), area: { id: career.id, name: "Career" }, entity: { type: "escalation", id: E }, after: { key: `overdue:${F}:2026-10-14`, summary: sum } }),
      ev({ class: "wait.started", cause: corr("w"), area: { id: career.id, name: "Career" }, entity: { type: "followup", id: W }, summary: "wait.started: Waiting on Chimes to respond to the Controller application", after: { summary: "Waiting on Chimes to respond to the Controller application" } }),
      ev({ class: "exception.opened", cause: corr("x"), entity: { type: "operating_exception", id: "77777777-7777-4777-8777-777777777777" }, after: { key: "watcher:gmail", summary: "Gmail watcher failing (3 polls in a row)" } }),
    ];
    const snap = snapAt({ areas: [career], needsJulian: [need(E, career.id, { key: `overdue:${F}:2026-10-14`, followup_id: F, summary: sum })], waits: [wait(W, career.id, { counterparty: "Chimes", summary: "Waiting on Chimes to respond to the Controller application" })],
      exceptions: [{ key: "watcher:gmail", detector: "watcher", area_id: null, owner: "finagai", severity: "warning", needs: null, summary: "Gmail watcher failing (3 polls in a row)", first_seen_at: "", remediation: null, remediation_attempts: 1 }] });
    expect(units(evs, snap).map((x) => [x.title, x.yours]).sort()).toEqual([
      ["Gmail watcher failing (3 polls in a row) — Finagai is fixing it", false],
      ["No answer from Beth Young by 2026-10-14 — waiting for you (only you can do this)", true],
      ["Waiting on Chimes to respond to the Controller application — still waiting", false],
    ]);
    // ... and once the snapshot no longer lists them, they read as history (the instruction is never repeated)
    expect(units(evs, snapAt({ areas: [career] })).map((x) => x.title).sort()).toEqual([
      "Finagai found a problem: Gmail watcher failing (3 polls in a row)",
      "No answer from Beth Young by 2026-10-14 — became your decision",
      "Started waiting: Waiting on Chimes to respond to the Controller application",
    ]);
  });
});

/** Slice 3 acceptance invariant 1: readability is presentation only — Core's records are never altered. */
describe("presentation never alters Core's records", () => {
  const freeze = <T>(o: T): T => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  it("stories, current state and the Why model run on deeply frozen events and snapshot, and the records are byte-identical afterwards", () => {
    const evs = task137(); const snap = snapshot({ needsJulian: [need(ESC, null, { key: KEY, needs: "authorization", subject: { type: "control_task", id: TASK } })] });
    const before = JSON.stringify([evs, snap]);
    freeze(evs); freeze(snap);
    const v = deriveCommand(snap, null, 0);
    expect(() => buildUnits(evs, new Set(), { open: openSubjects(v.needs), current: currentResolver(snap, v) })).not.toThrow();
    expect(() => chainModel(evs, 2717)).not.toThrow();
    for (const e of evs) { historyText(e); decisionText(e); }
    expect(JSON.stringify([evs, snap])).toBe(before);
  });
});
