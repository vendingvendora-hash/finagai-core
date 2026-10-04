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
