/** Live-data shapes from Julian's Altarum thread (Phase 2D live fix): correspondence and the panel summary rank first. */
import { describe, it, expect } from "vitest";
import { rankGmail, isMeetingSummary, type GmailMeta } from "../../src/google/client.js";

const m = (id: string, subject: string, from: string, day: number, bulk = false): GmailMeta =>
  ({ id, subject, from, date: `Sep ${day}`, internalDate: Date.UTC(2026, 8, day), bulk, snippet: "" });

const inbox = [
  m("li", "Your profile was viewed by Chimes", "LinkedIn <notifications-noreply@linkedin.com>", 30, true),
  m("ow", "Your Otter weekly digest", "Otter.ai <no-reply@otter.ai>", 29, true),
  m("ot", "Altarum Technical Panel — meeting notes", "Otter.ai <no-reply@otter.ai>", 28),
  m("b3", "Interview confirmation: Altarum technical panel Sep 28", "Beth Young <byoung@altarum.org>", 24),
  m("b2", "Rescheduled: Altarum interview with Ray Sasselli moved to Sep 21", "Beth Young <byoung@altarum.org>", 18),
  m("b1", "Altarum phone screen", "Beth Young <byoung@altarum.org>", 12),
  m("ap", "Thank you for your application to Altarum", "Altarum Careers <careers@altarum.org>", 7),
];

describe("rankGmail on real Altarum shapes", () => {
  const ranked = rankGmail(inbox, ["Altarum"]).map((x) => x.id);
  it("the recruiter correspondence and the panel summary come before notifications", () => {
    expect(ranked.slice(0, 5)).toEqual(expect.arrayContaining(["b3", "b2", "b1", "ot", "ap"]));
  });
  it("LinkedIn view notices and Otter weekly digests are dropped or last", () => {
    for (const noise of ["li", "ow"]) { const i = ranked.indexOf(noise); expect(i === -1 || i >= 5).toBe(true); }
  });
  it("a meeting summary is recognised; a weekly digest from the same sender is not", () => {
    expect(isMeetingSummary(inbox[2]!)).toBe(true);
    expect(isMeetingSummary(inbox[1]!)).toBe(false);
  });
});
