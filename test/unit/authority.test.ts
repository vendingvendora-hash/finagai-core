/** Phase 2 (ADR-078): authority classes + delegation envelopes are deterministic and never weaken commitments. */
import { describe, it, expect } from "vitest";
import { authorize, classify, deriveEnvelope } from "../../src/governance/authority.js";

const s = (kind: string, params: Record<string, unknown> = {}, summary = kind) => ({ kind, params, summary });
const ACCEPTANCE = "Fill this harmless test application completely but do not submit it.";

describe("authority classes", () => {
  it("classifies observation, preparation, commitments and high risk", () => {
    expect(classify(s("browser_read"))).toBe("OBSERVE");
    expect(classify(s("browser_fill", { label: "First name", value: "Julian" }))).toBe("PREPARATORY");
    expect(classify(s("browser_upload", { label: "Attach resume", path: "~/r.pdf" }))).toBe("PREPARATORY");
    expect(classify(s("browser_click", { label: "Next" }))).toBe("PREPARATORY");
    expect(classify(s("browser_click", { label: "Easy Apply" }))).toBe("PREPARATORY");          // opens the form
    expect(classify(s("browser_click", { label: "Submit application" }))).toBe("EXTERNAL_COMMITMENT");
    expect(classify(s("click", {}, 'Click "Send" to email Maria'))).toBe("EXTERNAL_COMMITMENT");
    expect(classify(s("menu_item", { app: "Mail", path: ["Message", "Send"] }))).toBe("EXTERNAL_COMMITMENT");
    expect(classify(s("key", { key: "return" }), { frontApp: "Google Chrome" })).toBe("EXTERNAL_COMMITMENT");
    expect(classify(s("key", { key: "return" }), { frontApp: "TextEdit" })).toBe("PREPARATORY");
    expect(classify(s("trash_file", { path: "~/x" }))).toBe("HIGH_RISK");
    expect(classify(s("run", { cmd: "rm -rf ~/x" }))).toBe("HIGH_RISK");
    expect(classify(s("browser_click", { label: "Change password" }))).toBe("HIGH_RISK");
    expect(classify(s("totally_new_kind"))).toBe("HIGH_RISK");
  });
});

describe("live #121 regression: negated or non-triggering mentions are not commitments", () => {
  it("filling fields with '(no submit)' in the summary stays preparatory and is auto inside the envelope", () => {
    const env = deriveEnvelope("Fill this harmless test application completely but do not submit it.", { principal: true })!;
    const fill = s("browser_fill_form", { fields: [] }, "Fill First name, Last name and Email on the test form (no submit)");
    expect(classify(fill)).toBe("PREPARATORY");
    expect(authorize(fill, env).decision).toBe("auto");
    expect(classify(s("browser_click", { label: "Next" }, "Go to step 2 without submitting"))).toBe("PREPARATORY");
    expect(classify(s("browser_click", { label: "Submit application" }, "Submit"))).toBe("EXTERNAL_COMMITMENT");
    expect(classify(s("type", { text: "x" }, "type the note; do not send"))).toBe("PREPARATORY");
  });
});

describe("delegation envelope", () => {
  const env = deriveEnvelope(ACCEPTANCE, { principal: true, now: new Date("2026-10-09T16:00:00Z") })!;
  it("is derived from Julian's words: preparation delegated, submission forbidden, bounded", () => {
    expect(env.autoClasses).toEqual(["OBSERVE", "PREPARATORY"]);
    expect(env.forbidden).toContain("submit");
    expect(Date.parse(env.expiresAt) - Date.parse(env.createdAt)).toBe(4 * 3600_000);
    expect(env.costLimitUsd).toBeGreaterThan(0); expect(env.maxSteps).toBeGreaterThan(0);
  });
  it("inside the envelope: no approval per field, per click on Next, or for attaching the resume", () => {
    const now = new Date("2026-10-09T16:10:00Z");
    for (const st of [s("browser_fill_form", { fields: [] }), s("browser_click", { label: "Next" }), s("browser_upload", { label: "Resume" }), s("browser_select", { label: "Country", option: "US" })])
      expect(authorize(st, env, { now }).decision).toBe("auto");
  });
  it("submit is refused outright (Julian already said no) — not even asked", () => {
    const d = authorize(s("browser_click", { label: "Submit application" }), env, { now: new Date("2026-10-09T16:10:00Z") });
    expect(d).toEqual(expect.objectContaining({ decision: "refuse", cls: "EXTERNAL_COMMITMENT" }));
  });
  it("commitments that were not forbidden still need Julian's explicit ok; high risk always does", () => {
    const e2 = deriveEnvelope("Prepare the reply to Beth", { principal: true })!;
    expect(authorize(s("browser_click", { label: "Send" }), e2).decision).toBe("approve");
    expect(authorize(s("trash_file", { path: "~/old.pdf" }), e2).decision).toBe("approve");
  });
  it("Spanish and other negations", () => {
    expect(deriveEnvelope("Llena la solicitud pero no la envíes, sin enviar nada", { principal: true })!.forbidden).toContain("send");
    expect(deriveEnvelope("Get the cart ready, don't buy anything", { principal: true })!.forbidden).toEqual(expect.arrayContaining(["buy", "purchase"]));
  });
  it("bounds: expired, step budget and cost limit fall back to asking", () => {
    expect(authorize(s("browser_fill", { label: "x" }), env, { now: new Date("2026-10-09T21:00:00Z") }).decision).toBe("approve");
    expect(authorize(s("browser_fill", { label: "x" }), env, { now: new Date("2026-10-09T16:10:00Z"), usage: { steps: 500, costUsd: 0 } }).decision).toBe("approve");
    expect(authorize(s("browser_fill", { label: "x" }), env, { now: new Date("2026-10-09T16:10:00Z"), usage: { steps: 3, costUsd: 9 } }).decision).toBe("approve");
  });
  it("a contact's request gets no envelope: preparation still asks Julian", () => {
    expect(deriveEnvelope("(Santiago asked) fill this form", { principal: false })).toBeNull();
    expect(authorize(s("browser_fill", { label: "x" }), null).decision).toBe("approve");
  });
  it("explicit grants: 'organize my Downloads folder' makes move_file preparatory, never trash", () => {
    const e = deriveEnvelope("Organize the files in my Downloads folder by type", { principal: true })!;
    expect(authorize(s("move_file", { from: "~/Downloads/a.pdf", to: "~/Downloads/PDF/a.pdf" }), e).decision).toBe("auto");
    expect(authorize(s("trash_file", { path: "~/Downloads/a.pdf" }), e).decision).toBe("approve");
  });
});

describe("Phase 4 (ADR-082): recording a posting is Finagai's own bookkeeping", () => {
  it("record_opportunity is an observation (automatic, even with words like 'apply' in it), never a commitment", () => {
    const step = { kind: "record_opportunity", params: { employer: "Acme", title: "Pricing Analyst" }, summary: "Record the posting before preparing the application to apply" };
    expect(classify(step)).toBe("OBSERVE");
    expect(authorize(step, null).decision).toBe("auto");
  });
});
