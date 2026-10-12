/** Phase 8 (ADR-088) pure helpers. */
import { describe, expect, it } from "vitest";
import { storedTransition } from "../../src/cos/career-sync.js";
import { subjectKey } from "../../src/events/engine.js";
import { isSecretKey } from "../../src/live/stream.js";

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
