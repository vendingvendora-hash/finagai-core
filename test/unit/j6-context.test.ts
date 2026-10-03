/**
 * J6 current-context surfacing (universal-perception mandate). Verifies the planner prompt includes a
 * "Current Mac context" line when the helper supplies frontmost app/window/url, so vague references like
 * "the spreadsheet I have open" have something to resolve against. Tests the pure prompt-line logic.
 */
import { describe, it, expect } from "vitest";

// Mirror of the planner's context-line construction (kept in sync with control.ts).
function ctxLine(ctx?: { app?: string; window?: string; url?: string }): string {
  return ctx && (ctx.app || ctx.window || ctx.url)
    ? `Current Mac context — frontmost app: ${ctx.app ?? "?"}${ctx.window ? `; active window: “${ctx.window}”` : ""}${ctx.url ? `; browser URL: ${ctx.url}` : ""}. Use this to resolve "this"/"the open document"/"the spreadsheet I have open" when Julian is vague.`
    : "";
}

describe("J6 current-context line (ADR-062)", () => {
  it("renders app + window when a document is open", () => {
    const line = ctxLine({ app: "Numbers", window: "Altarum_Pricing_Case_Template" });
    expect(line).toContain("frontmost app: Numbers");
    expect(line).toContain("Altarum_Pricing_Case_Template");
    expect(line).toContain("spreadsheet I have open");
  });
  it("includes the browser URL when the front app is a browser", () => {
    const line = ctxLine({ app: "Google Chrome", window: "Inbox", url: "https://mail.google.com" });
    expect(line).toContain("browser URL: https://mail.google.com");
  });
  it("is empty when no context is available (no hallucinated context)", () => {
    expect(ctxLine(undefined)).toBe("");
    expect(ctxLine({})).toBe("");
  });
});
