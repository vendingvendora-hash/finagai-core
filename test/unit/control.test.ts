import { describe, expect, it } from "vitest";
import { ALWAYS_CONFIRM, classifyRisk, needsApproval, parseControlCommand, parseStep, type Step } from "../../src/pipelines/j6/control.js";
import { helperAuthorized } from "../../src/concierge/control-routes.js";
import { runControlStep } from "../../helper/finagai-imessage.mjs";

const step = (over: Partial<Step>): Step => ({ kind: "click", params: {}, risk: "write", summary: "do a thing", ...over });

describe("J6 risk classification", () => {
  it("observation is read; everything that changes the world is write", () => {
    for (const k of ["screenshot", "read_text", "list_apps", "list_files", "read_file", "wait"]) expect(classifyRisk(k)).toBe("read");
    for (const k of ["click", "type", "key", "open_app", "open_url", "run", "move_file", "trash_file", "hotkey"]) expect(classifyRisk(k)).toBe("write");
  });
});

describe("J6 approval gate (the core safety property)", () => {
  it("read steps never need approval", () => {
    expect(needsApproval(step({ kind: "screenshot", risk: "read" }), false)).toBe(false);
    expect(needsApproval(step({ kind: "screenshot", risk: "read" }), true)).toBe(false);
  });
  it("navigation (click/type/scroll/open) runs on its own in auto mode", () => {
    for (const kind of ["click", "double_click", "type", "key", "scroll", "open_app", "open_url", "move", "hotkey"])
      expect(needsApproval(step({ kind, summary: "navigate" }), true)).toBe(false);
  });
  it("without auto mode, writes still confirm (used for sensitive tasks)", () => {
    expect(needsApproval(step({ kind: "click" }), false)).toBe(true);
  });
  it("even in auto mode, running commands and file deletion always need an ok", () => {
    for (const kind of ALWAYS_CONFIRM) expect(needsApproval(step({ kind }), true)).toBe(true);
  });
  it("even in auto mode, anything whose summary implies sending/paying/deleting needs an ok", () => {
    expect(needsApproval(step({ kind: "click", summary: 'Click "Send" to email Maria' }), true)).toBe(true);
    expect(needsApproval(step({ kind: "click", summary: "Confirm purchase of the flight" }), true)).toBe(true);
    expect(needsApproval(step({ kind: "click", summary: "Post the tweet" }), true)).toBe(true);
    expect(needsApproval(step({ kind: "click", summary: "Enviar el mensaje a Santiago" }), true)).toBe(true);
    expect(needsApproval(step({ kind: "click", summary: "Borrar el archivo" }), true)).toBe(true);
  });
  it("in auto mode, an ordinary click (open a menu, focus a field) can run without an ok", () => {
    expect(needsApproval(step({ kind: "click", summary: "Open the File menu" }), true)).toBe(false);
    expect(needsApproval(step({ kind: "type", summary: "Type the search query" }), true)).toBe(false);
  });
});

describe("J6 step parsing", () => {
  it("parses a planned action and never downgrades a write to read", () => {
    expect(parseStep('{"kind":"click","params":{"x":10,"y":20},"risk":"read","summary":"click send"}'))
      .toMatchObject({ kind: "click", risk: "write", summary: "click send" }); // kind is write → stays write
    expect(parseStep('{"kind":"screenshot","params":{},"risk":"read","summary":"look"}'))
      .toMatchObject({ kind: "screenshot", risk: "read" });
    expect(parseStep('{"kind":"done","summary":"all set"}')).toMatchObject({ done: true });
    expect(parseStep("not json")).toBeNull();
    expect(parseStep('{"kind":"frobnicate"}')).toBeNull(); // unknown kind refused
  });
  it("captures an ask question", () => {
    expect(parseStep('{"kind":"ask","summary":"which card?","question":"Which card should I use?"}')!.question).toBe("Which card should I use?");
  });
});

describe("J6 commands from Julian's thread", () => {
  it("ok/no approve or skip a step; stop cancels a task", () => {
    expect(parseControlCommand("ok 7")).toEqual({ kind: "ok_step", code: 7 });
    expect(parseControlCommand("no 7")).toEqual({ kind: "no_step", code: 7 });
    expect(parseControlCommand("stop 3")).toEqual({ kind: "cancel_task", code: 3 });
    expect(parseControlCommand("cancel 3")).toEqual({ kind: "cancel_task", code: 3 });
    expect(parseControlCommand("hello")).toBeNull();
  });
});

describe("J6 helper auth", () => {
  it("requires the exact helper token", () => {
    const t = "z".repeat(48);
    expect(helperAuthorized(`Bearer ${t}`, t)).toBe(true);
    expect(helperAuthorized(`Bearer ${t}`, "other")).toBe(false);
  });
});

describe("J6 executor guards (no Mac here; just the refusals)", () => {
  it("refuses file actions outside home and in excluded spots", async () => {
    expect(await runControlStep({ kind: "read_file", params: { path: "/etc/passwd" } })).toMatch(/refused/);
    expect(await runControlStep({ kind: "trash_file", params: { path: "~/Library/Keychains/login.keychain-db" } })).toMatch(/refused/);
    expect(await runControlStep({ kind: "open_url", params: { url: "file:///etc/passwd" } })).toMatch(/refused/);
  });
});

import { parsePlan } from "../../src/pipelines/j5/concierge.js";

describe("J6 contact bridge (ADR-051)", () => {
  it("triage flags a do-on-Mac request separately from a plain question", () => {
    expect(parsePlan('{"relevant":true,"file_queries":[],"do_on_mac":true}')).toMatchObject({ doOnMac: true });
    expect(parsePlan('{"relevant":true,"file_queries":["flight"],"do_on_mac":false}')).toMatchObject({ doOnMac: false });
    expect(parsePlan('{"relevant":true,"file_queries":[]}')).toMatchObject({ doOnMac: false }); // absent = false
  });
});

import { skillsFor } from "../../src/pipelines/j6/skills.js";
import { systemPrompt } from "../../src/pipelines/j6/control.js";

describe("J6 state-of-the-art thinking (ADR-055)", () => {
  it("includes the right playbook for the request", () => {
    expect(skillsFor("mándame la licencia de compliance de la carpeta de Drive")).toMatch(/FIND A FILE IN GOOGLE DRIVE/);
    expect(skillsFor("read the confirmation email from Delta")).toMatch(/READ GMAIL/);
    expect(skillsFor("fill out the Workday application")).toMatch(/FILL A FORM/);
    expect(skillsFor("read my utilization excel and chart it")).toMatch(/READ A SPREADSHEET/);
    expect(skillsFor("what's on my calendar tomorrow")).toMatch(/CHECK THE CALENDAR/);
    expect(skillsFor("find Vendora's compliance license")).toMatch(/VENDORA CONTEXT/);
    expect(skillsFor("just say hi")).toBe("");
  });
  it("the planner prompt drives plan-act-reflect, multi-account Drive, and verification", () => {
    const p = systemPrompt("EST", "today", "find the compliance license in Drive");
    expect(p).toMatch(/reflect/i);
    expect(p).toMatch(/\/u\/0\/, \/u\/1\/, \/u\/2\//);
    expect(p).toMatch(/TRY THE OTHER ACCOUNTS/);
    expect(p).toMatch(/Verify, don't assume/);
    expect(p).toMatch(/FIND A FILE IN GOOGLE DRIVE/); // skill injected
    expect(p).toMatch(/never type passwords/i);
  });
  it("parseStep captures reflection and expect", () => {
    const s = parseStep('{"reflection":"last click did nothing","plan":"use search url","kind":"open_url","params":{"url":"https://drive.google.com/drive/u/1/search?q=x"},"risk":"write","summary":"Open Drive account 2 search","expect":"results list shows"}');
    expect(s!.reflection).toMatch(/did nothing/);
    expect(s!.expect).toMatch(/results list/);
    expect(s!.kind).toBe("open_url");
  });
});
