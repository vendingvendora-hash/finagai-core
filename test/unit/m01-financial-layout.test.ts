/**
 * The real Altarum failure (live task #70 evidence): title in row 1, blank spacer, header row further down,
 * table starting in column B. Row-1-is-header assumption made every real column "no header" -> rejected.
 */
import { describe, it, expect } from "vitest";
import { detectSeries, locateHeaderRow } from "../../src/mac/analyze.js";

const laborBuild = { name: "Labor Build", rows: [
  [null, "Labor Build"],
  [],
  [null, "Role", "Hourly Rate", "Hours", "Total Cost"],
  [null, "Project Director", 150, 40, 6000],
  [null, "Senior Evaluator", 120, 80, 9600],
  [null, "Analyst (x2)", 85, 160, 13600],
  [null, "Data Scientist", 130, 60, 7800],
  [null, "On-site TA Specialist", 95, 120, 11400],
  [],
  [null, "Total", null, null, 48400],
] as Array<Array<string | number | null>> };

describe("financial-model layout (Altarum)", () => {
  it("locates the real header row, not the title", () => {
    expect(locateHeaderRow(laborBuild.rows)).toBe(2);
  });
  it("detects a real series with proper labels and skips the totals block", () => {
    const pick = detectSeries([laborBuild]);
    expect(pick).not.toBeNull();
    expect(pick!.labels).toEqual(["Project Director", "Senior Evaluator", "Analyst (x2)", "Data Scientist", "On-site TA Specialist"]);
    expect(["Total Cost", "Hours", "Hourly Rate"]).toContain(pick!.valueColumn);
    expect(pick!.values.length).toBe(5);
  });
  it("a lone title row with one text cell is never treated as the header", () => {
    expect(locateHeaderRow([["Inputs & Assumptions"], [], ["Item", "Value"], ["Rate", 12]])).toBe(2);
  });
});

describe("chart title never overflows the canvas (task #72 showed a clipped title)", () => {
  it("long titles get a font size whose estimated width fits inside 1200px", async () => {
    const { seriesToSvg } = await import("../../src/mac/chart.js");
    const title = "Altarum_Pricing_Case_Template: Actual cost by Month # (Burn & EAC)";
    const svg = seriesToSvg({ sheet: "Burn & EAC", labelColumn: "Month #", valueColumn: "Actual cost", labels: ["1","2","3"], values: [1,2,3], isTimeLike: true, reason: "" } as never, title);
    const size = Number(svg.match(/font-size="(\d+)"/)?.[1]);
    expect(size).toBeGreaterThanOrEqual(16);
    expect(title.length * 0.56 * size).toBeLessThanOrEqual(1200 - 80);
  });
});
