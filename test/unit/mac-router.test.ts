/**
 * WO4/WO8 routing benchmark (ADR-070): the right rung is chosen deterministically, health failures are skipped,
 * and no request starts from a mouse click when a higher rung can complete it.
 */
import { describe, it, expect } from "vitest";
import { route, classify } from "../../src/mac/router.js";

const healthy = { filesystem: "PASS", browser: "PASS", accessibility: "PASS", screenCapture: "PASS", browserDom: "PASS" };

describe("capability router", () => {
  it("read/chart an Excel workbook → parser, never clicking", () => {
    expect(route("mac_chart:Altarum_Pricing_Case_Template", healthy).primary).toBe("local_parser");
    expect(route("analyze the spreadsheet Degree of Leverage Analysis.xlsx", healthy).primary).toBe("local_parser");
  });
  it("fill a web form / open a URL → browser DOM first", () => {
    expect(route("open https://example.com and fill the contact form", healthy).primary).toBe("browser_dom");
  });
  it("Phase 1: no Operator extension connected → browser_dom is skipped, accessibility is first", () => {
    const r = route("open https://example.com and fill the contact form", { ...healthy, browserDom: "FAIL" } as never);
    expect(r.unavailable).toContain("browser_dom"); expect(r.primary).toBe("accessibility");
  });
  it("Gmail/Calendar data → connector first, browser as fallback", () => {
    const r = route("find the recruiter's email in my inbox", healthy);
    expect(r.primary).toBe("connector_api"); expect(r.ladder).toContain("browser_dom");
  });
  it("native app task → app scripting, then accessibility; visual mouse is last", () => {
    const r = route("open TextEdit, make a new document and type hello", healthy);
    expect(r.primary).toBe("app_scripting"); expect(r.ladder[r.ladder.length - 1]).toBe("visual_mouse");
  });
  it("unknown application → accessibility first, visual last (the WO4 unknown-app test shape)", () => {
    const r = route("in Zorblax, press the Reconcile button", healthy);
    expect(r.domain).toBe("unknown-app"); expect(r.primary).toBe("accessibility"); expect(r.ladder).toEqual(["accessibility", "screen_perception", "visual_mouse"]);
  });
  it("health-aware: browser extension down → DOM rung skipped, reason says so", () => {
    const r = route("open https://example.com and fill the contact form", { ...healthy, browserDom: "FAIL" });
    expect(r.primary).toBe("accessibility"); expect(r.unavailable).toEqual(["browser_dom"]); expect(r.reason).toMatch(/probe failed/);
  });
  it("health-aware: no Accessibility → AX and mouse rungs unavailable; parser path survives", () => {
    const r = route("mac_chart:Altarum", { ...healthy, accessibility: "FAIL" });
    expect(r.primary).toBe("local_parser"); expect(r.unavailable).toEqual(expect.arrayContaining(["app_scripting", "accessibility", "visual_mouse"]));
  });
  it("benchmark: across 8 representative requests, visual_mouse is primary for none", () => {
    const reqs = ["mac_chart:X", "summarize the spreadsheet budget.xlsx", "open https://a.com and log in", "what's on my calendar tomorrow",
      "move report.pdf from Downloads to Desktop", "in Numbers click the Share button", "in TextEdit File > New", "in Zorblax press OK"];
    const primaries = reqs.map((q) => route(q, healthy).primary);
    expect(primaries.filter((p) => p === "visual_mouse").length).toBe(0);
    expect(classify("in Zorblax press OK").ladder[0]).toBe("accessibility");
  });
});
