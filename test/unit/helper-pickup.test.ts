/**
 * WO1 regression (ADR-066.3): the real-Mac round-trip timeouts (tasks 36/37/38). The helper's tick returned
 * early when no new iMessage had arrived, and task pickup lived AFTER that return — so Core-created tasks
 * were only claimed when Julian happened to text. Lock: pickup runs on every tick, before any early return.
 * (The helper is an .mjs with import-time side effects, so this checks the structural invariant in source.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../helper/finagai-imessage.mjs", import.meta.url), "utf8");
const tickStart = src.indexOf("async function tick(cfg, state)");
const tickBody = src.slice(tickStart);

describe("helper task pickup is unconditional (WO1)", () => {
  it("pickupTasks exists as its own function", () => {
    expect(src).toMatch(/async function pickupTasks\(cfg\)/);
  });
  it("tick calls pickupTasks BEFORE its first early return (the 'no new messages' gate)", () => {
    const pickupAt = tickBody.indexOf("await pickupTasks(cfg)");
    const firstReturn = tickBody.indexOf("\n    return;");
    expect(pickupAt).toBeGreaterThan(0);
    expect(firstReturn).toBeGreaterThan(0);
    expect(pickupAt).toBeLessThan(firstReturn);
  });
  it("the /control/pending call no longer lives inside tick after the message gate", () => {
    const afterGate = tickBody.slice(tickBody.indexOf("\n    return;"));
    expect(afterGate).not.toContain('"/control/pending"');
  });
  it("heartbeat still precedes pickup (Core knows the worker is alive before it claims)", () => {
    expect(tickBody.indexOf("await heartbeat(cfg)")).toBeLessThan(tickBody.indexOf("await pickupTasks(cfg)"));
  });
});

describe("heartbeat liveness is independent of task execution (live #107 regression)", () => {
  it("an independent heartbeat interval exists outside the busy-guarded tick loop", () => {
    const src = readFileSync(new URL("../../helper/finagai-imessage.mjs", import.meta.url), "utf8");
    const main = src.slice(src.indexOf("setInterval(loop, POLL_MS)"));
    expect(main).toMatch(/setInterval\(async \(\) => \{[\s\S]*await heartbeat\(cfg\)[\s\S]*\}, 15_000\)/);
    expect(main).toMatch(/hbBusy/);
  });
});
