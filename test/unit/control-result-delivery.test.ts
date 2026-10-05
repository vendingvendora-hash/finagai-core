/** Live regression: results that finish DURING control_result's wait must be marked delivered (V2/V3 resurfaced). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../../src/tools/server.ts", import.meta.url), "utf8");
describe("control_result delivery marking", () => {
  it("marks delivered after the wait loop, not before it", () => {
    const body = src.slice(src.indexOf('registerTool("control_result"'));
    const loop = body.indexOf("while (Date.now() < until");
    const mark = body.indexOf("final_response_status = 'delivered'");
    expect(loop).toBeGreaterThan(0); expect(mark).toBeGreaterThan(loop);
  });
});
