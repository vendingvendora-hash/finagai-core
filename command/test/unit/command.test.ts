/** What Command shows (spec §3): Needs you only from open escalations; ownership; internal Area excluded; one health rule; calm sentences. */
import { describe, expect, it } from "vitest";
import { calmSentences, canCannot, deriveCommand } from "../../web/src/model/command";
import type { Reliability, SnapshotException } from "../../web/src/model/types";
import { area, need, snapshot, wait } from "./fixtures";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const healthy: Reliability = { window: { from: "", to: "", days: 1 }, verdict: "healthy", why: [], selfCheck: { runs: 288, failingRuns: 0, last: null } };
const ex = (p: Partial<SnapshotException>): SnapshotException => ({ key: "k", detector: "d", area_id: null, owner: "finagai", severity: "warning", needs: null, summary: "Self-check failing",
  first_seen_at: "2026-10-15T11:00:00Z", remediation: null, remediation_attempts: 0, ...p });
const career = area("c", "Career", { health: { color: "red", breaches: ["overdue"], warnings: [] } });
const testArea = area("t", "Finagai Test", { internal: true });

describe("deriveCommand", () => {
  it("Needs you comes only from open escalations — never from waits, exceptions or Julian-owned waits directly", () => {
    const v = deriveCommand(snapshot({
      areas: [career, testArea],
      needsJulian: [need("n1", "c", { due_at: "2026-10-14T00:00:00Z" }), need("n2", "c")],
      waits: [wait("w1", "c"), wait("w2", "c", { owner: "julian", escalated: true }), wait("w3", "c", { owner: "julian", rule: "offer.respond" })],
      exceptions: [ex({ owner: "finagai" })],
    }), healthy, NOW);
    expect(v.needs.map((n) => n.id)).toEqual(["n1", "n2"]);     // due first, then age
    expect(v.waits.map((w) => w.id)).toEqual(["w1"]);            // below the line: Finagai's waits only
  });

  it("never shows Finagai's internal test Area: its decisions, waits, problems and rail row are excluded", () => {
    const v = deriveCommand(snapshot({
      areas: [career, testArea],
      needsJulian: [need("nt", "t")], waits: [wait("wt", "t")], exceptions: [ex({ area_id: "t", owner: "julian" })],
    }), healthy, NOW);
    expect(v.needs).toEqual([]); expect(v.waits).toEqual([]); expect(v.health).toBe("healthy");
    expect(v.areas.map((a) => a.area.name)).toEqual(["Career"]);
    expect(v.internalAreaIds.has("t")).toBe(true);
    expect(v.calm).toBe(true);
  });

  it("health: Attention for a Julian-owned problem, Degraded for a Finagai-owned one / degraded verdict / stalled checks, else Healthy", () => {
    expect(deriveCommand(snapshot({ exceptions: [ex({ owner: "julian" })] }), healthy, NOW).health).toBe("attention");
    expect(deriveCommand(snapshot({ exceptions: [ex({})] }), healthy, NOW).health).toBe("degraded");
    expect(deriveCommand(snapshot({ exceptions: [ex({ severity: "info" })] }), healthy, NOW).health).toBe("healthy");
    expect(deriveCommand(snapshot(), { ...healthy, verdict: "degraded", why: ["2 failed runs"] }, NOW)).toEqual(expect.objectContaining({ health: "degraded", healthWhy: ["2 failed runs"] }));
    expect(deriveCommand(snapshot({ eventLoopLastTick: "2026-10-15T11:40:00Z" }), healthy, NOW)).toEqual(expect.objectContaining({ health: "degraded", stalled: true }));
    expect(deriveCommand(snapshot(), null, NOW).health).toBe("unknown");
  });

  it("calm only when nothing needs Julian and health is Healthy", () => {
    expect(deriveCommand(snapshot(), healthy, NOW).calm).toBe(true);
    expect(deriveCommand(snapshot({ needsJulian: [need("n", null)] }), healthy, NOW).calm).toBe(false);
    expect(deriveCommand(snapshot(), null, NOW).calm).toBe(false);
  });

  it("the Areas rail puts Areas with Julian items first, then by server color", () => {
    const v = deriveCommand(snapshot({ areas: [area("h", "Home"), area("y", "Yard", { health: { color: "yellow", breaches: [], warnings: ["x"] } }), area("c", "Career")],
      needsJulian: [need("n", "c")] }), healthy, NOW);
    expect(v.areas.map((a) => [a.area.name, a.fact])).toEqual([["Career", "green · 1 needs you"], ["Yard", "yellow"], ["Home", "quiet"]]);
  });
});

describe("calmSentences", () => {
  const fmt = (s: string) => s.slice(0, 10), t = (s: string) => s.slice(11, 16);
  it("composes only non-zero facts, at most three sentences", () => {
    const v = deriveCommand(snapshot({ areas: [career], waits: [wait("a", "c", { counterparty: "Chimes" }), wait("b", "c", { counterparty: "Amazon" })] }), healthy, NOW);
    const s = calmSentences(v, fmt, t);
    expect(s).toEqual(["Finagai is watching 2 waits on other people.", "Next due 2026-10-19 — Chimes and Amazon.", "Checks every 5 minutes, last at 11:58."]);
    expect(s.join(" ")).not.toMatch(/\b0\b/);
  });
  it("says so plainly when Finagai has no open work", () => {
    expect(calmSentences(deriveCommand(snapshot(), healthy, NOW), fmt, t)).toEqual(["Finagai has no open work.", "Checks every 5 minutes, last at 11:58."]);
  });
});

describe("canCannot", () => {
  it("maps known decision kinds and never guesses for unknown ones", () => {
    expect(canCannot(need("x", null, { key: "overdue:abc:1" }))?.only).toMatch(/nudge/);
    expect(canCannot(need("x", null, { key: "something:else" }))).toBeNull();
  });
});
