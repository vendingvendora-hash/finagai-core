/** Phase 4 (ADR-082): the lifecycle policy is pure and deterministic. Dates are the live state of 2026-10-09. */
import { describe, expect, it } from "vitest";
import { NEEDS_JULIAN, RULE_NEEDS, nextStepFor, transitionAllowed, type JobFacts } from "../../src/cos/lifecycle.js";

const NOW = new Date("2026-10-09T17:00:00Z");
const job = (o: Partial<JobFacts>): JobFacts => ({ employer: "X", title: "Financial Analyst", reqId: null, status: "applied", contact: null, appliedAt: null, lastEvidenceAt: null, lastInterviewAt: null, createdAt: "2026-10-09T00:00:00Z", ...o });

describe("status moves forward only", () => {
  it("forward transitions are allowed, backward ones are not", () => {
    expect(transitionAllowed("analyzed", "applied").ok).toBe(true);
    expect(transitionAllowed("applied", "interviewing").ok).toBe(true);
    expect(transitionAllowed("interviewing", "applied").ok).toBe(false);
    expect(transitionAllowed("applied", "applied").ok).toBe(false);
  });
  it("a terminal job never reopens — a later event is an anomaly", () => {
    const t = transitionAllowed("rejected", "applied");
    expect(t.ok).toBe(false);
    expect(t.anomaly).toMatch(/never reopened/);
  });
  it("an offer is not undone by an automated rejection, but Julian may decline it", () => {
    expect(transitionAllowed("offer", "rejected").ok).toBe(false);
    expect(transitionAllowed("offer", "withdrawn").ok).toBe(true);
  });
});

describe("one next step per job, with an owner and a date", () => {
  it("Altarum (interviewing, last contact 10/05): waiting on Beth until 10/12", () => {
    const s = nextStepFor(job({ employer: "Altarum", title: "Pricing Analyst", status: "interviewing", contact: "Beth Young", lastEvidenceAt: "2026-10-05T15:39:49Z", lastInterviewAt: "2026-09-24T16:43:08Z" }), NOW);
    expect(s).toEqual(expect.objectContaining({ kind: "action", rule: "interviewing.awaiting_decision", owner: "finagai", due: "2026-10-12", counterparty: "Beth Young" }));
  });
  it("after the decision window an interview process becomes Julian's follow-up", () => {
    const s = nextStepFor(job({ status: "interviewing", contact: "Beth Young", lastEvidenceAt: "2026-09-28T19:00:00Z" }), NOW);
    expect(s).toEqual(expect.objectContaining({ rule: "interviewing.nudge", owner: "julian", due: "2026-10-12" }));
  });
  it("Amazon 10471926 (applied 10/05): waiting on the employer until 10/19", () => {
    const s = nextStepFor(job({ employer: "Amazon", reqId: "10471926", lastEvidenceAt: "2026-10-05T17:29:27Z" }), NOW);
    expect(s).toEqual(expect.objectContaining({ rule: "applied.awaiting_response", owner: "finagai", due: "2026-10-19" }));
  });
  it("American Sugar Refining (applied 9/25, nobody to nudge): 14 days of silence close the project quietly", () => {
    const s = nextStepFor(job({ employer: "American Sugar Refining", lastEvidenceAt: "2026-09-25T13:00:00Z" }), NOW);
    expect(s).toEqual(expect.objectContaining({ kind: "close", rule: "applied.no_response" }));
    expect((s as { outcome: string }).outcome).toMatch(/kept in the pipeline as applied/);
  });
  it("silence with a named contact is Julian's decision until it goes stale", () => {
    expect(nextStepFor(job({ contact: "Dana", lastEvidenceAt: "2026-09-20T13:00:00Z" }), NOW)).toEqual(expect.objectContaining({ rule: "applied.nudge_or_let_go", owner: "julian", counterparty: "Dana" }));
    expect(nextStepFor(job({ contact: "Dana", lastEvidenceAt: "2026-09-01T13:00:00Z" }), NOW)).toEqual(expect.objectContaining({ kind: "close", rule: "applied.no_response" }));
  });
  it("terminal outcomes close; offers and preparation belong to Julian; analyzed postings need nothing", () => {
    expect(nextStepFor(job({ status: "rejected", lastEvidenceAt: "2026-10-06T00:00:00Z" }), NOW)).toEqual(expect.objectContaining({ kind: "close", rule: "rejected.close" }));
    expect(nextStepFor(job({ status: "offer" }), NOW)).toEqual(expect.objectContaining({ rule: "offer.respond", owner: "julian", due: "2026-10-12" }));
    expect(nextStepFor(job({ status: "preparing" }), NOW)).toEqual(expect.objectContaining({ rule: "preparing.submit", owner: "julian" }));
    expect(nextStepFor(job({ employer: "Amazon", reqId: "10461970", status: "preparing", lastEvidenceAt: "2026-08-10T12:00:00Z" }), NOW)).toEqual(expect.objectContaining({ kind: "close", rule: "preparing.abandoned" }));
    expect(nextStepFor(job({ status: "analyzed" }), NOW)).toEqual(expect.objectContaining({ kind: "none" }));
  });
  it("is deterministic", () => {
    const f = job({ status: "interviewing", contact: "Beth Young", lastEvidenceAt: "2026-10-05T15:39:49Z" });
    expect(new Set(Array.from({ length: 10 }, () => JSON.stringify(nextStepFor(f, NOW)))).size).toBe(1);
  });
});

describe("authority model: Finagai owns the next action unless Julian is genuinely required", () => {
  it("every Julian-owned step states why (judgment / authorization / principal-reserved); every waiting step is Finagai's", () => {
    const cases = [
      job({ status: "offer" }), job({ status: "preparing" }), job({ status: "interviewing", contact: "Beth", lastEvidenceAt: "2026-09-20T00:00:00Z" }),
      job({ contact: "Dana", lastEvidenceAt: "2026-09-20T13:00:00Z" }), job({ lastEvidenceAt: "2026-10-05T00:00:00Z" }),
      job({ status: "interviewing", contact: "Beth", lastEvidenceAt: "2026-10-05T00:00:00Z" }),
    ];
    for (const c of cases) {
      const s = nextStepFor(c, NOW);
      if (s.kind !== "action") continue;
      if (s.owner === "julian") { expect(NEEDS_JULIAN).toContain(s.needsJulian?.kind); expect(RULE_NEEDS[s.rule]).toBe(s.needsJulian?.kind); }
      else { expect(s.owner).toBe("finagai"); expect(s.needsJulian).toBeUndefined(); expect(s.state).toBe("waiting"); }
    }
  });
});
