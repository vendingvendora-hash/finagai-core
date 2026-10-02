import { describe, expect, it } from "vitest";
import { dueJobs } from "../../src/jobs/schedule.js";
import { startOfZonedMonth, zonedParts, zonedWallTimeToUtc } from "../../src/jobs/time.js";

const cfg = {
  FINAGAI_TIMEZONE: "America/New_York",
  WEEKLY_REVIEW_DAY: 1,
  WEEKLY_REVIEW_TIME: "07:00",
  MISSED_RUN_CHECK_TIME: "09:00",
};
const at = (iso: string) => new Date(iso);
const names = (now: Date) => dueJobs(now, cfg).map((j) => j.job).sort();

describe("zoned time conversion (America/New_York)", () => {
  it("maps 07:00 local to 12:00Z in winter (EST) and 11:00Z in summer (EDT)", () => {
    expect(zonedWallTimeToUtc(2026, 3, 2, 7, 0, "America/New_York").toISOString()).toBe("2026-03-02T12:00:00.000Z");
    expect(zonedWallTimeToUtc(2026, 3, 9, 7, 0, "America/New_York").toISOString()).toBe("2026-03-09T11:00:00.000Z");
    expect(zonedWallTimeToUtc(2026, 10, 26, 7, 0, "America/New_York").toISOString()).toBe("2026-10-26T11:00:00.000Z");
    expect(zonedWallTimeToUtc(2026, 11, 2, 7, 0, "America/New_York").toISOString()).toBe("2026-11-02T12:00:00.000Z");
  });

  it("moves a nonexistent spring-forward time to the first valid instant", () => {
    // 2026-03-08 02:30 does not exist in New York; clocks jump from 02:00 EST to 03:00 EDT.
    const d = zonedWallTimeToUtc(2026, 3, 8, 2, 30, "America/New_York");
    expect(d.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(zonedParts(d, "America/New_York").hour).toBe(3);
  });

  it("chooses the earlier occurrence of a repeated fall-back time", () => {
    // 2026-11-01 01:30 happens twice; the first is EDT (05:30Z).
    expect(zonedWallTimeToUtc(2026, 11, 1, 1, 30, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("computes the start of Julian's month in his timezone", () => {
    expect(startOfZonedMonth(at("2026-10-01T03:00:00Z"), "America/New_York").toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(startOfZonedMonth(at("2026-10-01T05:00:00Z"), "America/New_York").toISOString()).toBe("2026-10-01T04:00:00.000Z");
  });
});

describe("weekly review dispatch across DST (ADR-026)", () => {
  it("is not due at 06:45 local on a winter Monday, and due at 07:00", () => {
    expect(names(at("2026-03-02T11:45:00Z"))).not.toContain("weekly_review");
    const due = dueJobs(at("2026-03-02T12:00:00Z"), cfg).find((j) => j.job === "weekly_review");
    expect(due?.scheduledFor.toISOString()).toBe("2026-03-02T12:00:00.000Z");
  });

  it("is due at 07:00 local on the first Monday after spring forward (11:00Z)", () => {
    expect(names(at("2026-03-09T10:45:00Z"))).not.toContain("weekly_review");
    const due = dueJobs(at("2026-03-09T11:00:00Z"), cfg).find((j) => j.job === "weekly_review");
    expect(due?.scheduledFor.toISOString()).toBe("2026-03-09T11:00:00.000Z");
  });

  it("is due at 07:00 local on the first Monday after fall back (12:00Z), not an hour early", () => {
    expect(names(at("2026-11-02T11:00:00Z"))).not.toContain("weekly_review");
    expect(names(at("2026-11-02T12:00:00Z"))).toContain("weekly_review");
  });

  it("stays due for the 120-minute window so a missed tick cannot skip it, then expires", () => {
    expect(names(at("2026-03-09T12:45:00Z"))).toContain("weekly_review");
    expect(names(at("2026-03-09T13:00:00Z"))).not.toContain("weekly_review");
  });

  it("keeps the same scheduledFor on every tick inside the window (idempotency key)", () => {
    const keys = ["11:00", "11:15", "12:30"].map(
      (t) => dueJobs(at(`2026-03-09T${t}:00Z`), cfg).find((j) => j.job === "weekly_review")?.scheduledFor.toISOString(),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("schedules the missed-run check at 09:00 local the same Monday", () => {
    const due = dueJobs(at("2026-11-02T14:00:00Z"), cfg).find((j) => j.job === "missed_run_check");
    expect(due?.scheduledFor.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("never fires weekly jobs on other days", () => {
    expect(names(at("2026-03-10T11:00:00Z"))).not.toContain("weekly_review");
    expect(names(at("2026-03-08T12:00:00Z"))).not.toContain("weekly_review");
  });

  it("honors a configured day and time", () => {
    const sunday = { ...cfg, WEEKLY_REVIEW_DAY: 0, WEEKLY_REVIEW_TIME: "18:30" };
    const due = dueJobs(at("2026-03-08T22:30:00Z"), sunday).find((j) => j.job === "weekly_review");
    expect(due?.scheduledFor.toISOString()).toBe("2026-03-08T22:30:00.000Z"); // 18:30 EDT on spring-forward day
  });
});

describe("daily jobs", () => {
  it("runs daily maintenance at 03:00 local, including on the spring-forward night", () => {
    expect(names(at("2026-03-08T07:00:00Z"))).toContain("daily_maintenance"); // 03:00 EDT
    expect(names(at("2026-03-08T06:45:00Z"))).not.toContain("daily_maintenance");
  });

  it("returns nothing in quiet hours, so the dispatcher never wakes the database", () => {
    expect(dueJobs(at("2026-03-04T20:00:00Z"), cfg)).toEqual([]); // Wednesday 15:00 EST
  });
});
