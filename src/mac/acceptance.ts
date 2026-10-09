/**
 * Phase 1A/1C (ADR-072) — acceptance contracts and independent completion verification.
 * The planner that performs a task is NOT the authority on its success: `verifyCompletion` must pass before
 * a J6 task is marked done. Verification strategies: deterministic (string/state checks on observations),
 * artifact (image present), ui_state (last observation matches), model_graded (separate grader model reads
 * the objective + trace + final screenshot) — used only where determinism is impossible.
 */
import type { MeteredModelClient } from "../llm/metered.js";

export type Strategy = "deterministic" | "ui_state" | "artifact" | "model_graded";
export interface AcceptanceContract {
  objective: string;
  expectedOutcome: string;
  requiredEvidence: string[];
  verificationStrategy: Strategy;
  artifactRequirements: string[];
  allowedSideEffects: string[];
  terminalConditions: string[];
  /** Deterministic expectations extracted from the request. */
  expect: { app?: string; textContains?: string[]; screenshot?: boolean; noSave?: boolean; fileOp?: "move_file" | "trash_file" };
}

const quoted = (s: string) => [...s.matchAll(/["“”']([^"“”']{2,120})["“”']/g)].map((m) => m[1]!.trim());

/** Derive a contract from the request deterministically (no model). */
export function deriveContract(request: string): AcceptanceContract {
  const r = request.toLowerCase();
  const texts = quoted(request);
  const appMatch = request.match(/\b(?:in|into|open|activate|using|with)\s+(TextEdit|Notes|Pages|Numbers|Keynote|Excel|Word|PowerPoint|Messages|Mail|Finder|Calendar|Reminders|Preview|Terminal|Chrome|Safari|Firefox|Calculator)\b/i);
  const app = appMatch?.[1];
  const wantsScreenshot = /\b(screenshot|capture|show me|take a picture)\b/.test(r);
  const noSave = /\bdo not save|don't save|without saving\b/.test(r);
  const base = { objective: request.slice(0, 300), allowedSideEffects: noSave ? ["no document saved"] : ["as requested"], terminalConditions: ["verifier passes", "max 2 verifier rejections", "80 steps"] };
  if (/^mac_chart:/.test(request))
    return { ...base, expectedOutcome: "a chart image of a meaningful series from the named workbook", requiredEvidence: ["artifact image", "series metadata"], verificationStrategy: "artifact", artifactRequirements: ["png, aspect = svg aspect"], expect: { screenshot: true } };
  // File operations verify deterministically from the helper's own state check (fs-ops: hash/size/source gone),
  // never through a model (live #113: a model grader falsely rejected a hash-verified move).
  if (/\bmove_file\b|\btrash_file\b|\b(move|rename|trash|delete)\b[^.]{0,80}\b(file|folder|~\/|\.(txt|pdf|csv|xlsx|docx|png|jpg))/i.test(request)) {
    const op = /trash|delete/i.test(request) && !/move/i.test(request) ? "trash_file" : "move_file";
    return { ...base, expectedOutcome: `the ${op === "move_file" ? "move" : "trash"} is verified on disk`, requiredEvidence: [`${op} result "verified:"`], verificationStrategy: "deterministic", artifactRequirements: [], expect: { fileOp: op } };
  }
  if (texts.length && app)
    return { ...base, expectedOutcome: `${app} shows the text ${texts.map((t) => JSON.stringify(t)).join(", ")}`, requiredEvidence: ["observe() after the last write", "frontmost app"], verificationStrategy: "ui_state", artifactRequirements: [], expect: { app, textContains: texts, noSave } };
  if (app && /\b(open|activate|launch|bring)\b/.test(r) && !/\b(type|enter|fill|write|send|click|create)\b/.test(r))
    return { ...base, expectedOutcome: `${app} is frontmost`, requiredEvidence: ["frontmost app"], verificationStrategy: "ui_state", artifactRequirements: [], expect: { app } };
  if (wantsScreenshot)
    return { ...base, expectedOutcome: "a screenshot of the requested view exists", requiredEvidence: ["final screenshot"], verificationStrategy: "artifact", artifactRequirements: ["png"], expect: { screenshot: true } };
  return { ...base, expectedOutcome: "the request is satisfied as a careful human would judge from the final screen and the step trace", requiredEvidence: ["step trace", "final screenshot"], verificationStrategy: "model_graded", artifactRequirements: [], expect: {} };
}

export interface Verdict { pass: boolean; reason: string; strategy: Strategy; graded?: boolean; unavailable?: boolean }

export interface StepTrace { kind: string; summary: string; result: string | null }

/** Parse the last `observe:` JSON from the step trace, if any. */
export function lastObservation(trace: StepTrace[]): Record<string, string> | null {
  for (let i = trace.length - 1; i >= 0; i--) {
    const m = trace[i]!.result?.match(/observed:\s*(\{.*\})\s*$/s);
    if (m) { try { return JSON.parse(m[1]!); } catch { /* keep looking */ } }
  }
  return null;
}

const READ_RESULT = /^(browser_read|browser_find|browser_list_tabs|read_file|read_text|list_files|list_apps|observe|screenshot)$/;

export async function verifyCompletion(
  deps: { model: Pick<MeteredModelClient, "complete">; graderModel: string; taskId?: string },
  contract: AcceptanceContract, trace: StepTrace[], claimedSummary: string, finalScreenshotB64: string | null,
): Promise<Verdict> {
  const s = contract.verificationStrategy;
  // Any write action in the last few steps that reported unverified/error blocks completion regardless of strategy.
  const recentBad = trace.slice(-4).find((t) => /^(unverified|error):/i.test(t.result ?? "") && /^(ax_click|ax_set_value|menu_item|activate_app)$/.test(t.kind));
  const laterObserve = recentBad ? trace.slice(trace.indexOf(recentBad) + 1).some((t) => t.kind === "observe" || t.kind === "screenshot") : true;
  if (recentBad && !laterObserve) return { pass: false, strategy: s, reason: `last write step was ${recentBad.result!.split(":")[0]} (${recentBad.summary}) and nothing re-observed the UI afterwards` };

  if (s === "deterministic" && contract.expect.fileOp) {
    const last = [...trace].reverse().find((t) => t.kind === contract.expect.fileOp);
    if (!last) return { pass: false, strategy: s, reason: `no ${contract.expect.fileOp} step ran` };
    return /^verified:/i.test(last.result ?? "") ? { pass: true, strategy: s, reason: (last.result ?? "").slice(0, 200) }
      : { pass: false, strategy: s, reason: `${contract.expect.fileOp} did not verify: ${(last.result ?? "no result").slice(0, 160)}` };
  }
  if (s === "artifact") return finalScreenshotB64 ? { pass: true, strategy: s, reason: "final image present" } : { pass: false, strategy: s, reason: "no final image/artifact was produced" };

  if (s === "ui_state") {
    const obs = lastObservation(trace);
    if (!obs) return { pass: false, strategy: s, reason: "no observe() after the last action; call observe and check the expected state" };
    if (contract.expect.app && !String(obs.app ?? "").toLowerCase().startsWith(contract.expect.app.toLowerCase().split(" ")[0]!))
      return { pass: false, strategy: s, reason: `expected ${contract.expect.app} frontmost, observed ${obs.app || "unknown"}` };
    for (const t of contract.expect.textContains ?? []) {
      const hay = `${obs.focusedValue ?? ""} ${obs.window ?? ""} ${obs.focusedTitle ?? ""}`;
      if (!hay.includes(t)) return { pass: false, strategy: s, reason: `expected text ${JSON.stringify(t)} not found in the observed focused element/window` };
    }
    return { pass: true, strategy: s, reason: `observed ${obs.app}/${obs.window ?? ""} with expected content` };
  }

  // model_graded: an independent grader, never the planner, with the objective + trace + final screen.
  const content: Array<{ type: "text"; text: string } | { type: "image"; mediaType: "image/png"; dataBase64: string }> = [{ type: "text", text:
`You are an independent verifier. Decide whether the OBJECTIVE was actually achieved, judging only from the evidence. Do not trust the claimed summary.
OBJECTIVE: ${contract.objective}
EXPECTED OUTCOME: ${contract.expectedOutcome}
CLAIMED SUMMARY (untrusted): ${claimedSummary}
NOTE: every step result below is attached verbatim to the final report Julian receives — information found by a read step counts as reported even if the summary only references it. Judge whether the evidence achieves the objective.
STEP TRACE (most recent last):
${trace.slice(-12).map((t) => `- [${t.kind}] ${t.summary}: ${(t.result ?? "").slice(0, READ_RESULT.test(t.kind) ? 2500 : 300)}`).join("\n")}
Reply with exactly one line: PASS: <why the evidence shows it> or FAIL: <what is missing or contradicted>.` }];
  if (finalScreenshotB64) content.push({ type: "image", mediaType: "image/png", dataBase64: finalScreenshotB64 });
  const ask = async () => {
    const r = await deps.model.complete({ pipeline: "j6", step: "verify", purpose: "concierge", promptVersion: "verify-2", model: deps.graderModel, maxTokens: 800, ...(deps.taskId ? { requestId: deps.taskId } : {}),
      system: "Independent task verifier. Be strict; the planner's claims are untrusted. Answer with one line starting PASS: or FAIL:.", messages: [{ role: "user", content }] } as never);
    return String((r as { text?: string }).text ?? "").trim();
  };
  const parse = (text: string): Verdict | null => {
    const m = text.match(/\b(PASS|FAIL)\b\W*([\s\S]*)/i);
    if (!m) return null;
    const pass = m[1]!.toUpperCase() === "PASS";
    return { pass, strategy: s, graded: true, reason: (m[2] ?? "").trim().slice(0, 300) || (pass ? "grader passed" : "grader rejected") };
  };
  try {
    const first = parse(await ask());
    if (first) return first;
    const second = parse(await ask());              // one retry: an empty/unparseable reply is not a verdict
    if (second) return second;
    return { pass: false, unavailable: true, strategy: s, graded: true, reason: "verifier returned no readable verdict twice" };
  } catch (e) {
    return { pass: false, unavailable: true, strategy: s, graded: true, reason: `verifier unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
}


/**
 * Bounded recovery (ADR-072.2). A verifier rejection means "not yet proven complete", not "impossible".
 * The task continues — re-observe, diagnose, revise strategy — until acceptance passes, a genuine blocker or
 * human need appears, or the deterministic budget is exhausted. An identical completion claim with NO new
 * evidence since the last rejection trips the loop guard; a materially different strategy is allowed.
 */
export const RECOVERY_BUDGET = { maxRejections: 4, maxRecoverySteps: 24, maxWallMs: 15 * 60_000 } as const;
export const REJECTION_MARKER = "VERIFIER REJECTED";

export interface TraceStep { kind: string; summary: string }
export type RecoveryDecision =
  | { action: "recover"; strategyChanged: boolean }
  | { action: "terminal"; terminalReason: "repeated_claim_without_new_evidence" | "recovery_budget_exhausted" | "recovery_time_exhausted" | "recovery_steps_exhausted"; strategyChanged: boolean };

const sig = (t: TraceStep) => `${t.kind}|${t.summary}`.toLowerCase().replace(/\s+/g, " ").trim();

export function recoveryDecision(input: {
  rejectionsIncludingThis: number; trace: TraceStep[]; claimSummary: string; lastClaimSummary: string | null; taskStartedAtMs: number; nowMs: number;
}): RecoveryDecision {
  const markers = input.trace.map((t, i) => (t.summary.startsWith(REJECTION_MARKER) ? i : -1)).filter((i) => i >= 0);
  const lastM = markers.length ? markers[markers.length - 1]! : -1;
  const prevM = markers.length > 1 ? markers[markers.length - 2]! : -1;
  const after = lastM >= 0 ? input.trace.slice(lastM + 1) : [];
  const before = lastM >= 0 ? input.trace.slice(prevM + 1, lastM) : input.trace;
  const beforeSigs = new Set(before.map(sig));
  const strategyChanged = after.some((t) => !beforeSigs.has(sig(t)));
  const stepsSinceFirst = markers.length ? input.trace.length - markers[0]! : 0;

  if (lastM >= 0 && after.length === 0 && input.lastClaimSummary != null && input.claimSummary.trim().toLowerCase() === input.lastClaimSummary.trim().toLowerCase())
    return { action: "terminal", terminalReason: "repeated_claim_without_new_evidence", strategyChanged };
  if (input.rejectionsIncludingThis > RECOVERY_BUDGET.maxRejections) return { action: "terminal", terminalReason: "recovery_budget_exhausted", strategyChanged };
  if (input.nowMs - input.taskStartedAtMs > RECOVERY_BUDGET.maxWallMs && markers.length) return { action: "terminal", terminalReason: "recovery_time_exhausted", strategyChanged };
  if (stepsSinceFirst > RECOVERY_BUDGET.maxRecoverySteps) return { action: "terminal", terminalReason: "recovery_steps_exhausted", strategyChanged };
  return { action: "recover", strategyChanged };
}
