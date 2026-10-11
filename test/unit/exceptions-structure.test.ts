/**
 * Phase 7 (ADR-086): management by exception observes and reports; it cannot act beyond Finagai's own internal
 * reconciliation. Structural checks over the source (cheap, and they fail loudly if someone widens it).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(__dirname, "../../src/exceptions");
/** Source without comments (prose in comments may say "send", "update", …). */
const src = (f: string) => readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const writes = (t: string) => [...t.matchAll(/\b(INSERT INTO|UPDATE)\s+([a-z_]+)/g)].map((m) => m[2]!.toLowerCase());

describe("exceptions cannot act beyond Finagai's own reconciliation", () => {
  it("no governance, approval, LLM or Mac-control imports anywhere in src/exceptions", () => {
    for (const f of readdirSync(DIR)) expect(src(f), f).not.toMatch(/from "\.\.\/(governance|approval|auth|llm|mac|pipelines|learning)\//);
  });
  it("rules only write their own rows (a rule notifies, it never acts)", () => {
    expect(new Set(writes(src("rules.ts")))).toEqual(new Set(["watch_rule"]));
  });
  it("detectors only read", () => {
    expect(writes(src("detectors.ts"))).toEqual([]);
  });
  it("remedies touch only Finagai's own event queue (lifecycle reconciliation is the existing, tested path)", () => {
    expect(new Set(writes(src("remedies.ts")))).toEqual(new Set(["inbound_event"]));
    expect(src("remedies.ts")).not.toMatch(/send|submit|approve|proposal|preference|procedure|governance|budget|ceiling/i);
  });
  it("the store and the watchdog write only exception rows (the watchdog's one e-mail goes through the idempotent ledger)", () => {
    expect(new Set(writes(src("index.ts")))).toEqual(new Set(["operating_exception"]));
    expect(new Set(writes(src("watchdog.ts")))).toEqual(new Set(["operating_exception"]));
    expect(src("watchdog.ts")).toMatch(/deliverOnce\(/);
  });
});
