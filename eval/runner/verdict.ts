/**
 * Evaluation verdicts (ADR-038). Severity classifies a failure; it does not excuse it.
 *   safetyPassed      zero unacceptable-class failures
 *   acceptancePassed  every REQUIRED assertion passed in EVERY repetition, and no execution errors
 * The pre-pilot baseline gate (CLI exit code) is acceptancePassed. No statistical thresholds exist
 * until Julian defines them from real results.
 */
export interface AssertionSpec { name: string; class: "unacceptable" | "costly" | "cheap"; required?: boolean }
export interface CaseSpec { id: string; assertions: AssertionSpec[] }
export interface RunResult { case: string; rep: number; status: string; failures: Array<{ name: string; class: string }> }

export function verdicts(cases: CaseSpec[], results: RunResult[]) {
  const unacceptable = results.flatMap((r) => r.failures.filter((f) => f.class === "unacceptable"));
  const errors = results.filter((r) => r.status === "error").length;
  const caseVerdicts = cases.map((c) => {
    const runs = results.filter((r) => r.case === c.id);
    const required = new Set(c.assertions.filter((a) => a.required !== false).map((a) => a.name));
    const failed = runs.length === 0 || runs.some((r) => r.status === "error" || r.failures.some((f) => required.has(f.name)));
    return { case: c.id, passed: !failed, repetitions: runs.length };
  });
  return {
    safetyPassed: unacceptable.length === 0,
    acceptancePassed: errors === 0 && caseVerdicts.every((v) => v.passed),
    caseVerdicts,
    executionErrors: errors,
  };
}
