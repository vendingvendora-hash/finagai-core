/**
 * Phase 0B regression — live 2026-10-09: frontmost app = firefox (LinkedIn job page), Chrome running in the
 * background on julianperezconsulting.webflow.io/job-finder; resolve_reference("this page") returned the
 * Chrome tab with confidence "high". Reference resolution must obey the actual foreground.
 */
import { describe, it, expect } from "vitest";
import { resolveReference, frontPage, type MacContext } from "../../src/mac/context.js";
// @ts-ignore - plain ESM helper module
import { browserActiveTab, firefoxPageTitle, browserFor } from "../../helper/mac-perception.mjs";

const LIVE_2026_10_09: MacContext = {
  app: "firefox", window: null, documentPath: null, selectedFiles: ["/Users/julianperezcardozo/Desktop/sixsigma_cert.png"],
  browser: { app: "Google Chrome", url: "https://julianperezconsulting.webflow.io/job-finder", title: "Job finder" },
};

describe("Phase 0B: 'this page' obeys the frontmost browser (Core)", () => {
  it("B01-core: the exact live snapshot (legacy helper payload) never resolves to the background Chrome tab", () => {
    const r = resolveReference("this page", LIVE_2026_10_09, null);
    expect(r.resolved?.value).not.toBe("https://julianperezconsulting.webflow.io/job-finder");
    expect(r.resolved?.confidence ?? "low").not.toBe("high");
    expect(r.uncertain).toBe(true);
    expect(r.reason).toMatch(/firefox is frontmost/i);
  });
  it("Firefox frontmost with a runtime-13 title-only snapshot → that Firefox page, medium confidence, flagged uncertain", () => {
    const ctx: MacContext = { app: "firefox", window: "Project Finance Associate | LinkedIn — Mozilla Firefox", selectedFiles: [],
      browser: { app: "Firefox", url: null, title: "Project Finance Associate | LinkedIn", frontmost: true, introspection: "title_only" } };
    const r = resolveReference("this page", ctx, null);
    expect(r.resolved?.value).toBe("Project Finance Associate | LinkedIn");
    expect(r.resolved?.confidence).toBe("medium");
    expect(r.uncertain).toBe(true);
  });
  it("B02-core: Chrome frontmost → the Chrome page, high confidence", () => {
    const ctx: MacContext = { app: "Google Chrome", window: "Job finder", selectedFiles: [],
      browser: { app: "Google Chrome", url: "https://julianperezconsulting.webflow.io/job-finder", title: "Job finder", frontmost: true } };
    const r = resolveReference("this page", ctx, null);
    expect(r.resolved).toEqual(expect.objectContaining({ kind: "page", value: "https://julianperezconsulting.webflow.io/job-finder", confidence: "high" }));
    expect(r.uncertain).toBeUndefined();
  });
  it("bare 'this' with Firefox frontmost and a background Chrome tab → never the Chrome tab", () => {
    const r = resolveReference("summarize this", LIVE_2026_10_09, null);
    expect(r.resolved?.value ?? "").not.toContain("webflow.io");
  });
  it("browser not frontmost (Excel) → a background tab is at most medium, labelled not frontmost", () => {
    const fp = frontPage({ app: "Microsoft Excel", window: "A.xlsx", browser: { app: "Google Chrome", url: "https://x.test", title: "X", frontmost: false } });
    expect(fp.page).toBeNull();
    expect(fp.background?.confidence).toBe("medium");
    expect(fp.background?.source).toMatch(/not frontmost/);
  });
});

type Run = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
const fakeRun = (map: Array<[string, string]>): Run => async (cmd, args) => {
  const key = [cmd, ...args].join(" ");
  for (const [match, out] of map) if (key.includes(match)) return { stdout: out };
  return { stdout: "" };
};

describe("Phase 0B: helper browserActiveTab reads the FRONTMOST browser", () => {
  const chromeRunning: Array<[string, string]> = [['contains "Google Chrome"', "true"], ['tell application "Google Chrome"', "https://julianperezconsulting.webflow.io/job-finder\tJob finder"]];
  it("Firefox frontmost + Chrome running → Firefox (title only), never the Chrome tab", async () => {
    const r = await browserActiveTab(fakeRun(chromeRunning), "firefox", "Apply to Vallum Associates | LinkedIn — Mozilla Firefox");
    expect(r.app).toBe("Firefox"); expect(r.url).toBeNull(); expect(r.frontmost).toBe(true);
    expect(r.title).toBe("Apply to Vallum Associates | LinkedIn"); expect(r.introspection).toBe("title_only");
  });
  it("Chrome frontmost → Chrome active tab, frontmost:true", async () => {
    const r = await browserActiveTab(fakeRun(chromeRunning), "Google Chrome", "Job finder");
    expect(r).toEqual(expect.objectContaining({ ok: true, app: "Google Chrome", url: "https://julianperezconsulting.webflow.io/job-finder", frontmost: true }));
  });
  it("Chrome frontmost but not introspectable → uncertainty for Chrome, not another browser", async () => {
    const run: Run = async (_c, args) => { if (args.join(" ").includes('tell application "Google Chrome"')) throw new Error("Not authorized to send Apple events"); return { stdout: "true" }; };
    const r = await browserActiveTab(run, "Google Chrome", "x");
    expect(r.ok).toBe(false); expect(r.app).toBe("Google Chrome"); expect(r.frontmost).toBe(true);
  });
  it("non-browser frontmost → background tab marked frontmost:false", async () => {
    const r = await browserActiveTab(fakeRun(chromeRunning), "Microsoft Excel", "A.xlsx");
    expect(r.frontmost).toBe(false); expect(r.app).toBe("Google Chrome");
  });
  it("Firefox title parsing and browser table", () => {
    expect(firefoxPageTitle("Inbox — Mozilla Firefox")).toBe("Inbox");
    expect(firefoxPageTitle("Inbox - Mozilla Firefox Private Browsing")).toBe("Inbox");
    expect(browserFor("firefox")?.name).toBe("Firefox");
    expect(browserFor("Finder")).toBeNull();
  });
});
