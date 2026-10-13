/** Phase 8 (ADR-088) pure helpers. */
import { describe, expect, it } from "vitest";
import { storedTransition } from "../../src/cos/career-sync.js";
import { subjectKey } from "../../src/events/engine.js";
import { isSecretKey } from "../../src/live/stream.js";
import { failureKey, normalizeFailure } from "../../src/live/failures.js";

describe("Phase 8 helpers", () => {
  it("a new history event on a held job is labelled against the STORED status (live: 'analyzed→offer' while applied)", () => {
    expect(storedTransition("analyzed→offer", "applied", "offer")).toBe("applied→offer");
    expect(storedTransition("analyzed→interviewing", "applied", "interviewing")).toBe("applied→interviewing");
    expect(storedTransition("applied→applied", "applied", null)).toBeNull();                 // a "viewed" notice moves nothing
    expect(storedTransition("analyzed→rejected", "offer", null)).toBeNull();                 // not applied (an offer is never overwritten)
    expect(storedTransition(null, "applied", "offer")).toBeNull();
  });
  it("a workflow need's key carries the object it is about, once", () => {
    const id = "39720e96-9343-445a-a6f6-ee415bb3acf9";
    expect(subjectKey({ key: "career.sync:abc", needs: "judgment", summary: "x", subject: { type: "opportunity", id } })).toBe(`career.sync:abc@opportunity:${id}`);
    expect(subjectKey({ key: `career.sync:abc@opportunity:${id}`, needs: "judgment", summary: "x", subject: { type: "opportunity", id } })).toBe(`career.sync:abc@opportunity:${id}`);
    expect(subjectKey({ key: "career.sync:abc", needs: "judgment", summary: "x" })).toBe("career.sync:abc");
  });
  it("secret keys are matched as words", () => {
    for (const k of ["password", "refresh_token", "refreshTokens", "apiKey", "client_secret", "sessionSecret", "otp"]) expect(isSecretKey(k), k).toBe(true);
    for (const k of ["allPass", "passed", "inputTokens", "maxTokens", "passkey_enrolled", "author", "compass"]) expect(isSecretKey(k), k).toBe(false);
  });
});

describe("failure mining (ADR-088 increment 3): one class per kind of failure, whatever the ids and numbers", () => {
  it("normalizes ids, numbers, dates and quoted values away", () => {
    const a = normalizeFailure("Task 131 stalled at 2026-10-13T07:00:00Z (id 3f2a1b4c-1111-2222-3333-444455556666)");
    const b = normalizeFailure("task 140 stalled at 2026-10-14T09:12:00.123Z (id 9e8d7c6b-aaaa-bbbb-cccc-ddddeeeeffff)");
    expect(a).toBe(b);
    expect(a).toBe("task # stalled at <time> (id <id>)");
    expect(normalizeFailure('No job matches "Altarum pricing"')).toBe(normalizeFailure('No job matches "Amazon R2L"'));
    expect(normalizeFailure("ECONNRESET")).not.toBe(normalizeFailure("invalid_grant"));
    expect(failureKey("tool", "get_project", a)).toMatch(/^[0-9a-f]{10}$/);
    expect(failureKey("tool", "get_project", a)).not.toBe(failureKey("tool", "find_opportunity", a));
  });
});
