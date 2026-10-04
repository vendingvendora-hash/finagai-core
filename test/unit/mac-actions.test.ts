/** WO4: observe->act->verify contract of mac-actions.mjs, with an injected osa (no macOS needed). */
import { describe, it, expect } from "vitest";
import { activateApp, axClick, axSetValue, menuItem, changed } from "../../helper/mac-actions.mjs";

function fakeOsa(script: { frontmost: string[]; press?: string; set?: string }) {
  let i = 0;
  return async (lines: string[]) => {
    const src = lines.join("\n");
    if (src.includes("AXFocusedUIElement")) { const app = script.frontmost[Math.min(i++, script.frontmost.length - 1)]; return `${app}\nUntitled\nAXTextArea\n\n`; }
    if (src.includes('perform action "AXPress"')) return script.press ?? "pressed:AXButton";
    if (src.includes("set value of target")) return script.set ?? "set:hello";
    return "";
  };
}

describe("observe → act → verify", () => {
  it("activate_app verifies by the frontmost app actually changing", async () => {
    const r = await activateApp(fakeOsa({ frontmost: ["Finder", "TextEdit"] }) as never, "TextEdit");
    expect(r.ok).toBe(true); expect(r.verified).toBe(true); expect(r.after!.app).toBe("TextEdit");
  });
  it("activate_app reports failure when the app did not come to front", async () => {
    const r = await activateApp(fakeOsa({ frontmost: ["Finder", "Finder"] }) as never, "TextEdit");
    expect(r.ok).toBe(false); expect(r.result).toMatch(/frontmost is Finder/);
  });
  it("ax_click: a press with no observable change is reported UNVERIFIED, not success", async () => {
    const r = await axClick(fakeOsa({ frontmost: ["TextEdit", "TextEdit"] }) as never, "TextEdit", { title: "OK" });
    expect(r.ok).toBe(true); expect(r.verified).toBe(false); expect(r.result).toMatch(/no visible UI change/);
  });
  it("ax_click: missing control is an error naming the title", async () => {
    const r = await axClick(fakeOsa({ frontmost: ["TextEdit"], press: "notfound" }) as never, "TextEdit", { title: "Reconcile" });
    expect(r.ok).toBe(false); expect(r.result).toMatch(/no control titled "Reconcile"/);
  });
  it("ax_set_value verifies by read-back", async () => {
    const ok = await axSetValue(fakeOsa({ frontmost: ["TextEdit"], set: "set:hello" }) as never, "TextEdit", { title: undefined, value: "hello" });
    expect(ok.verified).toBe(true);
    const bad = await axSetValue(fakeOsa({ frontmost: ["TextEdit"], set: "set:hell" }) as never, "TextEdit", { title: undefined, value: "hello" });
    expect(bad.ok).toBe(false); expect(bad.result).toMatch(/read-back mismatch/);
  });
  it("menu_item refuses a path shorter than [menu, item]", async () => {
    const r = await menuItem(fakeOsa({ frontmost: ["TextEdit"] }) as never, "TextEdit", ["File"]);
    expect(r.ok).toBe(false);
  });
  it("changed() detects window/focus deltas only", () => {
    const a = { ok: true, app: "A", window: "W", focusedRole: "r", focusedTitle: "t", focusedValue: "v" };
    expect(changed(a, { ...a })).toBe(false); expect(changed(a, { ...a, window: "W2" })).toBe(true);
  });
});

describe("intended-outcome verification (live task #77 finding)", () => {
  it("a menu click whose observed delta is focus moving to ANOTHER app is NOT verified", async () => {
    // before: TextEdit; after: Firefox — something changed, but not the intended thing
    const r = await menuItem(fakeOsa({ frontmost: ["TextEdit", "firefox"] }) as never, "TextEdit", ["File", "New"]);
    expect(r.ok).toBe(true); expect(r.verified).toBe(false); expect(r.result).toMatch(/frontmost is now firefox.*NOT done/);
  });
  it("a menu click that changes TextEdit's own window IS verified", async () => {
    let n = 0;
    const osa = async (lines: string[]) => { const src = lines.join("\n"); if (src.includes("AXFocusedUIElement")) return n++ === 0 ? "TextEdit\n\nAXWindow\n\n" : "TextEdit\nUntitled\nAXTextArea\n\n"; return ""; };
    const r = await menuItem(osa as never, "TextEdit", ["File", "New"]);
    expect(r.verified).toBe(true);
  });
});
