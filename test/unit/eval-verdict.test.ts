import { describe, expect, it } from "vitest";
import { verdicts } from "../../eval/runner/verdict.js";

const cases = [
  { id: "T01", assertions: [{ name: "a", class: "unacceptable" as const }, { name: "b", class: "costly" as const }] },
  { id: "T02", assertions: [{ name: "c", class: "cheap" as const }, { name: "d", class: "cheap" as const, required: false }] },
];
const ok = (c: string, rep: number) => ({ case: c, rep, status: "processed", failures: [] });

describe("evaluation verdicts (ADR-038)", () => {
  it("passes only when every required assertion passes in every repetition", () => {
    const v = verdicts(cases, [ok("T01", 1), ok("T01", 2), ok("T02", 1)]);
    expect(v).toMatchObject({ safetyPassed: true, acceptancePassed: true });
  });
  it("a single costly failure in one repetition fails acceptance but not safety", () => {
    const v = verdicts(cases, [ok("T01", 1), { case: "T01", rep: 2, status: "processed", failures: [{ name: "b", class: "costly" }] }, ok("T02", 1)]);
    expect(v.safetyPassed).toBe(true);
    expect(v.acceptancePassed).toBe(false);
    expect(v.caseVerdicts.find((c) => c.case === "T01")?.passed).toBe(false);
  });
  it("a cheap required failure also fails the case; a non-required one does not", () => {
    expect(verdicts(cases, [ok("T01", 1), { case: "T02", rep: 1, status: "processed", failures: [{ name: "c", class: "cheap" }] }]).acceptancePassed).toBe(false);
    expect(verdicts(cases, [ok("T01", 1), { case: "T02", rep: 1, status: "processed", failures: [{ name: "d", class: "cheap" }] }]).acceptancePassed).toBe(true);
  });
  it("an unacceptable failure fails both; an execution error or a missing run fails acceptance", () => {
    expect(verdicts(cases, [{ case: "T01", rep: 1, status: "processed", failures: [{ name: "a", class: "unacceptable" }] }, ok("T02", 1)]))
      .toMatchObject({ safetyPassed: false, acceptancePassed: false });
    expect(verdicts(cases, [{ case: "T01", rep: 1, status: "error", failures: [] }, ok("T02", 1)]).acceptancePassed).toBe(false);
    expect(verdicts(cases, [ok("T01", 1)]).acceptancePassed).toBe(false);
  });
});
