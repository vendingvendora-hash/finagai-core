/**
 * Mac perception substrate (product mandate: universal Mac perception). Tests the deterministic parsers
 * and mac-doctor report shaping with an injected fake `run` (real AppleScript needs a Mac; these lock the
 * parsing/report logic so it can't silently regress).
 */
import { describe, it, expect } from "vitest";
// @ts-ignore - plain ESM helper module
import { getFrontmost, listWindows, listApps, browserActiveTab, accessibilityTree, macDoctor } from "../../helper/mac-perception.mjs";

type Run = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
const fakeRun = (map: Array<[string, string]>): Run => async (cmd, args) => {
  const key = [cmd, ...args].join(" ");
  for (const [match, out] of map) if (key.includes(match)) return { stdout: out };
  return { stdout: "" };
};

describe("Mac perception substrate (ADR-062)", () => {
  it("getFrontmost parses app + window", async () => {
    const r = await getFrontmost(fakeRun([["frontmost is true", "Numbers\tAltarum_Pricing_Case_Template"]]));
    expect(r.ok).toBe(true); expect(r.app).toBe("Numbers"); expect(r.window).toContain("Altarum");
  });
  it("listWindows parses structured JSON", async () => {
    const r = await listWindows(fakeRun([["System Events", JSON.stringify([{ app: "Chrome", title: "Gmail", x: 0, y: 0, w: 800, h: 600 }])]]));
    expect(r.ok).toBe(true); expect(r.windows[0].app).toBe("Chrome");
  });
  it("listApps splits the process list", async () => {
    const r = await listApps(fakeRun([["background only is false", "Finder, Numbers, Google Chrome"]]));
    expect(r.apps).toContain("Google Chrome"); expect(r.apps.length).toBe(3);
  });
  it("browserActiveTab reads the Chrome tab url/title", async () => {
    const r = await browserActiveTab(fakeRun([['contains "Google Chrome"', "true"], ["active tab of front window", "https://mail.google.com\tInbox"]]));
    expect(r.ok).toBe(true); expect(r.url).toContain("mail.google.com"); expect(r.title).toBe("Inbox");
  });
  it("accessibilityTree parses the element list", async () => {
    const r = await accessibilityTree(fakeRun([["frontmost:true", JSON.stringify([{ role: "AXButton", title: "Send", value: "", depth: 1 }])]]));
    expect(r.ok).toBe(true); expect(r.tree[0].role).toBe("AXButton");
  });
  it("macDoctor reports per-capability pass/fail with remediation hints", async () => {
    const run = fakeRun([
      ["background only is false", "Finder"], ["frontmost is true", "Finder\t"],
      ["mdfind", ""], ['contains "Google Chrome"', "false"], ["pbpaste", "hi"],
    ]);
    const doc = await macDoctor(run, "/tmp/x.png");
    expect(doc.checks.length).toBeGreaterThanOrEqual(6);
    const browser = doc.checks.find((c: { name: string }) => c.name.includes("Browser"));
    expect(browser.ok).toBe(false);
    expect(browser.settingsHint).toBeTruthy();   // tells Julian exactly what to enable
  });
});
