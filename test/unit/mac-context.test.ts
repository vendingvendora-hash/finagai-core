/**
 * WO3 reference resolution (ADR-068). U1–U6 as deterministic resolver cases; the same cases run on the real
 * Mac through mac_get_context + resolve_reference once the runtime is deployed.
 */
import { describe, it, expect } from "vitest";
import { resolveReference, type MacContext } from "../../src/mac/context.js";

const chart = { kind: "chart", storageRef: "/Users/j/.finagai/out/m01-1/chart.png", summary: "Unit Price by Month" };

describe("WO3 referent resolution", () => {
  it("U1: Excel open → 'analyze this spreadsheet' resolves to the open workbook, no question", () => {
    const ctx: MacContext = { app: "Microsoft Excel", window: "Altarum_Pricing_Case_Template.xlsx", documentPath: "/Users/j/Downloads/Altarum_Pricing_Case_Template.xlsx", selectedFiles: [], browser: null };
    const r = resolveReference("analyze this spreadsheet", ctx, null);
    expect(r.ambiguous).toBe(false); expect(r.resolved?.kind).toBe("spreadsheet"); expect(r.resolved?.value).toContain("Altarum_Pricing_Case_Template.xlsx");
  });
  it("U2: Chrome tab open → 'summarize this' resolves to the active tab URL", () => {
    const ctx: MacContext = { app: "Google Chrome", window: "Altarum – Pricing", documentPath: null, selectedFiles: [], browser: { app: "Google Chrome", url: "https://altarum.org/pricing", title: "Altarum – Pricing" } };
    const r = resolveReference("summarize this", ctx, null);
    expect(r.resolved?.kind).toBe("page"); expect(r.resolved?.value).toBe("https://altarum.org/pricing"); expect(r.ambiguous).toBe(false);
  });
  it("U3: one Finder file selected → 'send this to Santiago' resolves to that file", () => {
    const ctx: MacContext = { app: "Finder", window: "Downloads", documentPath: null, selectedFiles: ["/Users/j/Downloads/Sales_Tax_License.pdf"], browser: null };
    const r = resolveReference("send this to Santiago", ctx, null);
    expect(r.resolved?.kind).toBe("file"); expect(r.resolved?.value).toContain("Sales_Tax_License.pdf");
  });
  it("U4: chart just generated → 'make that bigger' resolves to the last chart artifact", () => {
    const ctx: MacContext = { app: "Messages", window: "Julian", documentPath: null, selectedFiles: [], browser: null };
    const r = resolveReference("make that bigger", ctx, chart);
    expect(r.resolved?.kind).toBe("artifact"); expect(r.resolved?.value).toBe(chart.storageRef);
  });
  it("U5: focus moved from Excel to Chrome → the SAME phrase now resolves to the tab (re-observation, not stale)", () => {
    const excel: MacContext = { app: "Microsoft Excel", window: "A.xlsx", documentPath: "/x/A.xlsx", selectedFiles: [], browser: null };
    const chrome: MacContext = { app: "Google Chrome", window: "Docs", documentPath: null, selectedFiles: [], browser: { app: "Google Chrome", url: "https://docs.google.com/d/1", title: "Docs" } };
    expect(resolveReference("look at this", excel, null).resolved?.kind).toBe("spreadsheet");
    expect(resolveReference("look at this", chrome, null).resolved?.kind).toBe("page");
  });
  it("U6: genuinely ambiguous (two files selected, nothing in focus) → ambiguous with both candidates; otherwise never asks", () => {
    const two: MacContext = { app: "Finder", window: "Downloads", documentPath: null, selectedFiles: ["/a.pdf", "/b.pdf"], browser: null };
    const r = resolveReference("send this to Santiago", two, null);
    expect(r.ambiguous).toBe(true); expect(r.candidates.length).toBe(2);
    const none: MacContext = { app: "Finder", window: null, documentPath: null, selectedFiles: [], browser: null };
    const n = resolveReference("fix this", none, null);
    expect(n.resolved).toBeNull(); expect(n.ambiguous).toBe(false);   // nothing to resolve: honest "nothing in focus", not a fake guess
  });
});
