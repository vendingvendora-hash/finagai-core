import { describe, expect, it } from "vitest";
import { parseDateExpression, verifyResolvedDate } from "../../src/pipelines/j2/dates.js";

const TZ = "America/New_York";
// Thursday, October 1, 2026, 10:00 New York time.
const received = new Date("2026-10-01T14:00:00Z");
const p = (e: string, lang: "es" | "en" | "mixed" = "en") => parseDateExpression(e, received, TZ, lang);
const day = (year: number, month: number, d: number) => ({ year, month, day: d });

describe("G11 date parsing (EN/ES, Julian's timezone)", () => {
  it("parses Spanish explicit dates with a weekday check (T03)", () => {
    expect(p("antes del viernes 9 de octubre", "es")).toEqual(day(2026, 10, 9));
    expect(p("el 15 de noviembre de 2026", "es")).toEqual(day(2026, 11, 15));
  });
  it("parses English month-day forms and ISO dates", () => {
    expect(p("by Oct 9")).toEqual(day(2026, 10, 9));
    expect(p("October 20th, 2026")).toEqual(day(2026, 10, 20));
    expect(p("9th of October")).toEqual(day(2026, 10, 9));
    expect(p("due 2026-12-01")).toEqual(day(2026, 12, 1));
  });
  it("rolls a past month-day into next year, with a 7-day grace for recent past dates", () => {
    expect(p("January 15")).toEqual(day(2027, 1, 15));
    expect(p("September 28")).toEqual(day(2026, 9, 28)); // 3 days ago: still this year
  });
  it("parses relative days and weekdays", () => {
    expect(p("tomorrow")).toEqual(day(2026, 10, 2));
    expect(p("pasado mañana", "es")).toEqual(day(2026, 10, 3));
    expect(p("hoy", "es")).toEqual(day(2026, 10, 1));
    expect(p("next Friday")).toEqual(day(2026, 10, 2));
    expect(p("el próximo jueves", "es")).toEqual(day(2026, 10, 8)); // today is Thursday: the next one
  });
  it("handles numeric dates only when unambiguous for the language", () => {
    expect(p("10/9", "en")).toEqual(day(2026, 10, 9));
    expect(p("9/10", "es")).toEqual(day(2026, 10, 9));
    expect(p("25/10")).toEqual(day(2026, 10, 25));
    expect(p("10/9", "mixed")).toBeNull();
  });
  it("detects a weekday that contradicts the date", () => {
    expect(p("viernes 10 de octubre", "es")).toEqual({ contradiction: expect.stringContaining("viernes") });
  });
  it("refuses vague expressions", () => {
    expect(p("soon")).toBeNull();
    expect(p("end of the month")).toBeNull();
    expect(p("Friday next week")).toBeNull();
  });
});

describe("G11 verification against the model's resolution", () => {
  it("verifies when code and model agree on the calendar day in New York", () => {
    expect(verifyResolvedDate("antes del viernes 9 de octubre", "2026-10-09T23:59:00-04:00", received, TZ, "es"))
      .toEqual({ kind: "verified", day: day(2026, 10, 9) });
  });
  it("flags a mismatch instead of storing the model's date", () => {
    expect(verifyResolvedDate("by Oct 9", "2026-10-10T12:00:00-04:00", received, TZ, "en")).toMatchObject({ kind: "mismatch" });
  });
  it("compares in Julian's timezone, not UTC", () => {
    // 2026-10-10T02:00Z is still Oct 9 in New York.
    expect(verifyResolvedDate("by Oct 9", "2026-10-10T02:00:00Z", received, TZ, "en")).toMatchObject({ kind: "verified" });
  });
  it("marks unparseable expressions unverifiable, and missing halves as mismatches", () => {
    expect(verifyResolvedDate("sometime soon", "2026-10-09T00:00:00Z", received, TZ, "en")).toEqual({ kind: "unverifiable" });
    expect(verifyResolvedDate("by Oct 9", null, received, TZ, "en")).toMatchObject({ kind: "mismatch" });
    expect(verifyResolvedDate(null, null, received, TZ, "en")).toBeNull();
  });
});
