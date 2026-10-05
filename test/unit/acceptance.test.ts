import { isReadOnlyCommand } from "../../src/pipelines/j6/control.js";
/**
 * Phase 1A/1C — acceptance contracts + independent verification. Adversarial cases: tools "succeed" but the
 * objective is not achieved; the verifier must reject (false_completion), never trust the planner's claim.
 */
import { describe, it, expect } from "vitest";
import { deriveContract, verifyCompletion, lastObservation, recoveryDecision, REJECTION_MARKER, RECOVERY_BUDGET } from "../../src/mac/acceptance.js";

const noModel = { model: { complete: async () => { throw new Error("grader must not be needed"); } }, graderModel: "x" } as never;
const obs = (o: object) => `observed: ${JSON.stringify({ ok: true, ...o })}`;

describe("contract derivation (deterministic)", () => {
  it("quoted text into a named app → ui_state with app + text expectations", () => {
    const c = deriveContract('In TextEdit, type the exact line "Finagai WO4 AX test OK" and do not save');
    expect(c.verificationStrategy).toBe("ui_state"); expect(c.expect.app).toBe("TextEdit"); expect(c.expect.textContains).toEqual(["Finagai WO4 AX test OK"]); expect(c.expect.noSave).toBe(true);
  });
  it("chart requests → artifact strategy; open-ended requests → model_graded", () => {
    expect(deriveContract("mac_chart:Altarum").verificationStrategy).toBe("artifact");
    expect(deriveContract("organize my downloads sensibly").verificationStrategy).toBe("model_graded");
  });
});

describe("adversarial false completions are rejected", () => {
  const c = deriveContract('In TextEdit, type "hello world"');
  it("typing 'succeeded' but nothing re-observed → FAIL", async () => {
    const v = await verifyCompletion(noModel, c, [{ kind: "type", summary: "type hello world", result: "typed" }], "Done: typed the text", null);
    expect(v.pass).toBe(false); expect(v.reason).toMatch(/no observe/);
  });
  it("observed window is a different app → FAIL", async () => {
    const v = await verifyCompletion(noModel, c, [{ kind: "observe", summary: "observe", result: obs({ app: "firefox", window: "", focusedValue: "" }) }], "Done", null);
    expect(v.pass).toBe(false); expect(v.reason).toMatch(/expected TextEdit frontmost, observed firefox/);
  });
  it("right app, wrong text → FAIL", async () => {
    const v = await verifyCompletion(noModel, c, [{ kind: "observe", summary: "observe", result: obs({ app: "TextEdit", window: "Untitled", focusedValue: "hello wrld" }) }], "Done", null);
    expect(v.pass).toBe(false); expect(v.reason).toMatch(/"hello world" not found/);
  });
  it("last AX write was UNVERIFIED and nothing observed after → FAIL regardless of strategy", async () => {
    const v = await verifyCompletion(noModel, c, [{ kind: "ax_set_value", summary: "set text", result: "unverified: set (read-back mismatch)" }], "Done", null);
    expect(v.pass).toBe(false); expect(v.reason).toMatch(/unverified/);
  });
  it("artifact strategy with no image → FAIL", async () => {
    const v = await verifyCompletion(noModel, deriveContract("mac_chart:Altarum"), [], "Built chart", null);
    expect(v.pass).toBe(false);
  });
});

describe("genuine completions pass", () => {
  it("right app and text observed → PASS", async () => {
    const c = deriveContract('In TextEdit, type "hello world"');
    const v = await verifyCompletion(noModel, c, [{ kind: "ax_set_value", summary: "set", result: "verified: set AXTextArea" }, { kind: "observe", summary: "observe", result: obs({ app: "TextEdit", window: "Untitled", focusedValue: "hello world" }) }], "Done", null);
    expect(v.pass).toBe(true);
  });
  it("model_graded uses an independent grader and parses PASS/FAIL", async () => {
    const grader = { model: { complete: async () => ({ text: "FAIL: the screen shows the wrong tab" }) }, graderModel: "grader" } as never;
    const v = await verifyCompletion(grader, deriveContract("do something open-ended"), [], "Done", null);
    expect(v.pass).toBe(false); expect(v.graded).toBe(true); expect(v.reason).toMatch(/wrong tab/);
  });
  it("lastObservation parses the latest observe JSON only", () => {
    expect(lastObservation([{ kind: "observe", summary: "", result: obs({ app: "A" }) }, { kind: "observe", summary: "", result: obs({ app: "B" }) }])!.app).toBe("B");
  });
});

describe("bounded recovery policy (replaces 'two rejections → fail')", () => {
  const t0 = Date.now();
  it("first rejection → recover", () => {
    expect(recoveryDecision({ rejectionsIncludingThis: 1, trace: [{ kind: "type", summary: "type" }], claimSummary: "done", lastClaimSummary: null, taskStartedAtMs: t0, nowMs: t0 }).action).toBe("recover");
  });
  it("identical claim with no new evidence since the last rejection → loop guard", () => {
    const trace = [{ kind: "type", summary: "type" }, { kind: "observe", summary: `${REJECTION_MARKER} x` }];
    const d = recoveryDecision({ rejectionsIncludingThis: 2, trace, claimSummary: "Typed it", lastClaimSummary: "typed it", taskStartedAtMs: t0, nowMs: t0 });
    expect(d).toMatchObject({ action: "terminal", terminalReason: "repeated_claim_without_new_evidence" });
  });
  it("a materially different strategy after rejection → recover, strategyChanged=true", () => {
    const trace = [{ kind: "type", summary: "type text" }, { kind: "observe", summary: `${REJECTION_MARKER} x` }, { kind: "ax_set_value", summary: "set value directly" }];
    const d = recoveryDecision({ rejectionsIncludingThis: 2, trace, claimSummary: "Typed it", lastClaimSummary: "Typed it", taskStartedAtMs: t0, nowMs: t0 });
    expect(d).toEqual({ action: "recover", strategyChanged: true });
  });
  it("budget: more than maxRejections → terminal recovery_budget_exhausted", () => {
    const d = recoveryDecision({ rejectionsIncludingThis: RECOVERY_BUDGET.maxRejections + 1, trace: [{ kind: "x", summary: "new" }], claimSummary: "a", lastClaimSummary: "b", taskStartedAtMs: t0, nowMs: t0 });
    expect(d).toMatchObject({ action: "terminal", terminalReason: "recovery_budget_exhausted" });
  });
});

describe("read-only shell commands (live task #104)", () => {
  it("plain reads are reads", () => {
    for (const c of ["cat ~/Documents/report.csv", "ls -la ~/Downloads", "head -50 notes.txt", "mdfind -name Altarum", "grep -n PASS ~/Desktop/notes.txt"])
      expect(isReadOnlyCommand(c)).toBe(true);
  });
  it("protected paths stay behind Julian's ok even for reads (helper token lives in ~/.finagai)", () => {
    for (const c of ["cat ~/.finagai/imessage-helper.json", "cat ~/.finagai/phase1-live.out", "cat ~/.ssh/id_ed25519", "cat /etc/passwd",
      "ls ~/Library/Keychains", "cat ~/Downloads/../.finagai/imessage-helper.json", "head ~/Documents/passwords.txt", "cat ~/Downloads/finagai-core/.env",
      "cat ~/Library/Messages/chat.db", "grep token ~/.config/gh/hosts.yml"])
      expect(isReadOnlyCommand(c), c).toBe(false);
  });
  it("anything that could write or chain stays a write", () => {
    for (const c of ["cat a > b", "ls; rm -rf ~", "cat x | sh", "echo $(rm x)", "rm file", "find . -delete", "sed -i s/a/b/ f", "tail -f log && curl x", "cat `whoami`", "ls\nrm x", "touch x"])
      expect(isReadOnlyCommand(c)).toBe(false);
  });
});

describe("live #113 regressions", () => {
  it("file moves verify deterministically from the helper's verified result — no model grader", async () => {
    const c = deriveContract("Move ~/Desktop/finagai-move-test.txt to ~/Documents with move_file");
    expect(c.verificationStrategy).toBe("deterministic"); expect(c.expect.fileOp).toBe("move_file");
    const ok = await verifyCompletion(noModel, c, [{ kind: "move_file", summary: "move", result: "verified: moved 22 bytes, sha256 ab12… -> ~/Documents/x" }], "Moved", null);
    expect(ok.pass).toBe(true);
    const bad = await verifyCompletion(noModel, c, [{ kind: "move_file", summary: "move", result: "error: collision: exists" }], "Moved", null);
    expect(bad.pass).toBe(false);
  });
  it("grader: markdown/lowercase verdicts parse; empty replies retry once and become 'unavailable', never a FAIL", async () => {
    let n = 0;
    const md = { model: { complete: async () => ({ text: "**Pass** — the trace shows it" }) }, graderModel: "g" } as never;
    expect((await verifyCompletion(md, deriveContract("do something open-ended"), [], "Done", null)).pass).toBe(true);
    const empty = { model: { complete: async () => { n++; return { text: "" }; } }, graderModel: "g" } as never;
    const v = await verifyCompletion(empty, deriveContract("do something open-ended"), [], "Done", null);
    expect(v.unavailable).toBe(true); expect(v.pass).toBe(false); expect(n).toBe(2);
  });
});
