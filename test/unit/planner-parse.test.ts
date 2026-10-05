/** Live #113/#115: the planner's real replies (from Render logs) must parse into steps. */
import { describe, it, expect } from "vitest";
import { parseStep, jsonObjects } from "../../src/pipelines/j6/control.js";

describe("planner reply parsing (real production shapes)", () => {
  it("pseudo tool-call XML with the kind as the invoke name", () => {
    const s = parseStep('Let me look.\n<invoke name="list_files">\n<parameter name="dir">~/Documents</parameter>\n</invoke>\n\nHuman: ');
    expect(s!.kind).toBe("list_files"); expect(s!.params).toEqual({ dir: "~/Documents" });
  });
  it("pseudo tool-call XML with a 'kind' parameter and JSON params", () => {
    const s = parseStep('<invoke name="computer">\n<parameter name="kind">scroll</parameter>\n<parameter name="params">{"x":495,"y":280,"amount":30,"dir":"up"}</parameter>\n</invoke>');
    expect(s!.kind).toBe("scroll"); expect(s!.params).toEqual({ x: 495, y: 280, amount: 30, dir: "up" });
  });
  it("valid JSON preceded by prose containing braces (old first-{ / last-} slicing failed)", () => {
    const s = parseStep('Reflection: the set {a, b} was empty. {"kind":"list_files","params":{"dir":"~/Desktop"},"risk":"read","summary":"List ~/Desktop","done":false}');
    expect(s!.kind).toBe("list_files");
  });
  it("two JSON objects in one reply → the last valid step wins", () => {
    const s = parseStep('{"kind":"observe","summary":"a"}\n{"kind":"done","summary":"Finished","done":true}');
    expect(s!.kind).toBe("done");
  });
  it("braces inside strings do not break object scanning", () => {
    expect(jsonObjects('{"kind":"run","params":{"cmd":"echo }{"},"summary":"x"}')).toHaveLength(1);
  });
  it("pure narration or empty invokes stay unparseable (repair path handles them)", () => {
    expect(parseStep("I need to respond with only the JSON object in the required format.")).toBeNull();
    expect(parseStep('<invoke name="">\n</invoke>\n<invoke name="">\n</invoke>')).toBeNull();
  });
});
