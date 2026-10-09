/**
 * ADR-080 regression suite: the Career bootstrap is a deterministic function of a frozen evidence snapshot, built from
 * the REAL records whose interpretation flipped between live proposals #1–#3 (Altarum, Immuta, Transurban, Vallum
 * Associates, Resource Innovations, and the Transurban LinkedIn email that once produced the employer "Senior").
 */
import { describe, it, expect } from "vitest";
import {
  acquireCareerSnapshot, interpretCareer, interpretationDigest, opportunitySetDigest, snapshotDigest, snapshotDelta, traceOrg, classifyRecord,
  evidenceRecords, decodeEntities, resolveAliases, CAREER_QUERIES, CAREER_EPOCH, type CareerSources, type CareerSnapshot,
} from "../../src/cos/career-evidence.js";
import type { GmailRecord } from "../../src/google/client.js";
import { ACCOUNT, REC, SHEET_CSV, queryHits } from "../fixtures/career-2026-10-09.js";

const ALL = Object.values(REC);
const keyOf = (q: string) => Object.entries(CAREER_QUERIES).find(([, b]) => q.endsWith(b))![0];

function sources(recs: GmailRecord[], o: { failAccount?: string; omitFromSearch?: Set<string>; deleted?: Set<string>; sheetCalls?: Array<string | undefined>; csv?: string; second?: GmailRecord[] } = {}): CareerSources {
  const store = new Map(recs.map((x) => [x.id, x]));
  return {
    sheetCsv: async (_t, preferId) => { o.sheetCalls?.push(preferId); return { id: "sheet-1", name: "Vendora Career Copilot - Job History", modified: "2026-10-09T16:29:38Z", account: "vending.vendora@gmail.com", csv: o.csv ?? SHEET_CSV, candidates: [{ id: "sheet-1", name: "Vendora Career Copilot - Job History", modified: "2026-10-09T16:29:38Z" }] }; },
    gmailEnumerate: async (q) => {
      const hits = queryHits(keyOf(q), recs).filter((x) => !o.omitFromSearch?.has(x.id) && !o.deleted?.has(x.id));
      const main = { account: ACCOUNT, ok: true, records: hits, pages: 1, truncated: false, ids: hits.length, vanished: [] };
      const other = o.failAccount ? { account: o.failAccount, ok: false, error: "google gmail.googleapis.com HTTP 429", records: [], pages: 0, truncated: false, ids: 0 }
        : { account: "vending.vendora@gmail.com", ok: true, records: queryHits(keyOf(q), o.second ?? []), pages: 1, truncated: false, ids: 0, vanished: [] };
      return [main, other];
    },
    gmailMetadata: async (account, ids) => {
      if (account !== ACCOUNT) return { records: [], missing: ids.map((id) => ({ id, reason: "deleted at source" })) };
      return { records: ids.filter((id) => store.has(id) && !o.deleted?.has(id)).map((id) => store.get(id)!).sort((a, b) => a.internalDate - b.internalDate),
        missing: ids.filter((id) => !store.has(id) || o.deleted?.has(id)).map((id) => ({ id, reason: "deleted at source" })) };
    },
    calendarEnumerate: async (q) => [{ account: ACCOUNT, ok: true, pages: 1, records: q === "interview" ? [{ id: "cal-altarum-0928", start: "2026-09-28T15:00:00-04:00", summary: "Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst" }] : [] }],
  };
}
const NOW = new Date("2026-10-09T17:00:00Z");
const status = (i: ReturnType<typeof interpretCareer>) => Object.fromEntries([...i.active, ...i.closed].map((o) => [o.org, o.status]));
function shuffled<T>(a: T[], seed: number): T[] { const x = [...a]; let s = seed; for (let i = x.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2 ** 31; const j = s % (i + 1); [x[i], x[j]] = [x[j]!, x[i]!]; } return x; }
function permute(s: CareerSnapshot, seed: number): CareerSnapshot {
  return { ...s, gmail: shuffled(s.gmail, seed).map((g) => ({ ...g, records: shuffled(g.records, seed + 1) })), calendar: shuffled(s.calendar, seed + 2), carryForward: shuffled(s.carryForward, seed + 3) };
}

describe("interpretation of the real 2026-10-09 evidence", () => {
  it("statuses from the real evidence: active vs closed (Immuta AND Transurban were rejected — neither is active)", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    expect(status(i)).toEqual({ Altarum: "interviewing", Amazon: "applied", Chimes: "applied", "Resource Innovations": "applied", "Vallum Associates": "applied",
      Accenture: "rejected", Cvent: "rejected", Immuta: "rejected", "Johns Hopkins University": "rejected", Transurban: "rejected", "Window Nation": "rejected", Yahoo: "rejected" });
    expect(i.active.map((o) => o.org).sort()).toEqual(["Altarum", "Amazon", "Chimes", "Resource Innovations", "Vallum Associates"]);
    expect(i.closed.find((c) => c.org === "Immuta")).toEqual(expect.objectContaining({ status: "rejected", evidenceIds: ["1a10d239a91c2453", "1a11212c71b7bd81"] }));
    expect(i.closed.find((c) => c.org === "Transurban")).toEqual(expect.objectContaining({ status: "rejected", evidenceIds: ["1a0fa482078ecbcb", "1a0fcd31d9610ef9", "1a0fcfae55d6732e"] }));
  });
  it("Transurban: the LinkedIn 'Your application to … at Transurban' email is a REJECTION (template jobs_application_rejected_01, body 'Your update from Transurban')", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const o = i.traces.orgs.find((x) => x.orgKey === "transurban")!;
    expect(o.records.map((r) => `${r.kind}:${r.transition}`)).toEqual(["application:analyzed→applied", "viewed:applied→applied", "rejection:applied→rejected"]);
    const t = i.traces.records.find((x) => x.recordId === REC.transSenior1002.id)!;
    expect(t.reason).toMatch(/rejection \(LinkedIn template jobs_application_rejected_01\)/);
  });
  it("a new application after a rejection reopens (Vallum 08/27 rejected → 10/09 re-applied; Amazon two requisitions); 'viewed' never reopens", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    expect(i.traces.orgs.find((x) => x.orgKey === "vallum associates")!.records.map((r) => r.transition)).toEqual(["analyzed→applied", "applied→rejected", "rejected→applied"]);
    expect(i.traces.orgs.find((x) => x.orgKey === "amazon")!.records.map((r) => r.transition)).toEqual(["analyzed→rejected", "rejected→applied"]);
  });
  it("rejections visible only in the body are recognised (Cvent 'Thank You For Applying', Window Nation, Accenture, JHU)", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const t = (id: string) => i.traces.records.find((x) => x.recordId === id)!;
    for (const r of [REC.cventRejected0820, REC.windowNationRejected0821, REC.accentureRejected0903, REC.jhuRejected0911]) expect(t(r.id).kind).toBe("rejection");
    expect(t(REC.cventRejected0820.id).reason).toMatch(/rejection wording \(body\)/);
    expect(t(REC.accentureRejected0903.id).org).toBe("Accenture");   // not "Accenture and"
  });
  it("no invented employers: Indeed's 'Title - Department' stays unparsed; community/newsletter mail never becomes an org", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const t = (id: string) => i.traces.records.find((x) => x.recordId === id);
    expect(t(REC.indeedApplied1005.id)).toEqual(expect.objectContaining({ stage: "unparsed" }));
    expect(t(REC.glassdoorCommunity1007.id)?.stage ?? "not acquired").not.toBe("candidate");
    expect(t(REC.newsletter1009.id)?.stage ?? "excluded").toBe("excluded");
  });
  it("'Senior' (or any job-title word) is never an employer; marketing mail never creates an org", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const orgs = i.traces.records.flatMap((t) => (t.org ? [t.org] : []));
    expect(orgs.some((o) => /^(senior|financial|pricing|structured)\b/i.test(o))).toBe(false);
    const t = (id: string) => i.traces.records.find((x) => x.recordId === id)!;
    expect(t(REC.transSenior1002.id)).toEqual(expect.objectContaining({ stage: "candidate", org: "Transurban", title: "Senior Financial Planning Analyst", rule: "linkedin:application_to_title_at_org" }));
    const one = (x: GmailRecord) => classifyRecord(evidenceRecords({ gmail: [{ key: "applications", account: ACCOUNT, records: [x] }], calendar: [], carryForward: [] } as never)[0]!, new Set(["transurban"]));
    expect(one(REC.transTrends1006).stage).toBe("excluded");
    expect(one(REC.transApplyNow0918).stage).toBe("excluded");          // "apply now to … at Transurban" is not an application
    expect(one(REC.otterWeekly1005).stage).toBe("unclassified");
  });
  it("Altarum: one organization across 'Altarum' and 'Altarum Institute', interviewing, contact Beth Young, sheet conflict recorded", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const a = i.active.find((o) => o.orgKey === "altarum")!;
    expect(a.aliases).toEqual(["altarum", "altarum institute"]);
    expect(a.contact).toBe("Beth Young"); expect(a.sheetRows).toEqual(["mtdy30"]);
    expect(a.evidence.map((e) => e.kind)).toContain("screen");
    expect(i.conflicts.join("\n")).toMatch(/Career Copilot sheet lags the email evidence for 1 organization\(s\): Altarum \(sheet "analyzed" → evidence "interviewing"\)/);
    expect(i.pipeline.shortlist.map((s) => s.org)).toEqual(["M.C. Dean, Inc."]);   // Altarum engaged, Northrop needs clearance
  });
  it("Immuta: the HTML-escaped rejection is recognised (root cause of 'Immuta active')", () => {
    expect(decodeEntities(REC.immutaReject1006.snippet)).toMatch(/we've made the decision/);
    const t = classifyRecord(evidenceRecords({ gmail: [{ key: "applications", account: ACCOUNT, records: [REC.immutaReject1006] }], calendar: [], carryForward: [] } as never)[0]!, new Set());
    expect(t).toEqual(expect.objectContaining({ kind: "rejection", org: "Immuta", stage: "candidate" }));
  });
  it("Resource Innovations: Workable 'Title - Org' and 'Thanks for applying' both map to the org; follow-ups are date-based", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const ri = i.active.find((o) => o.org === "Resource Innovations")!;
    expect(ri.evidence.map((e) => e.recordId).sort()).toEqual([REC.riPricing1009.id, REC.riSent1009.id, REC.riThanks1009.id].sort());
    expect(ri.followup).toBeNull(); expect(ri.followupDue).toBe("2026-10-16");
    const ch = i.active.find((o) => o.org === "Chimes")!;
    expect(ch.followup).toBe("Follow up with Chimes — last evidence 2026-09-28, follow-up due 2026-10-05");
  });
});

describe("reproducibility on a frozen snapshot", () => {
  it("10 interpretations with permuted record/source order → identical digests and identical decisions", async () => {
    const s = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const base = interpretCareer(s);
    for (let n = 0; n < 10; n++) {
      const p = permute(s, n + 7);
      expect(snapshotDigest(p)).toBe(snapshotDigest(s));
      const i = interpretCareer(p);
      expect(interpretationDigest(i)).toBe(interpretationDigest(base));
      expect(JSON.stringify({ a: i.active, c: i.closed, k: i.conflicts, p: i.pipeline })).toBe(JSON.stringify({ a: base.active, c: base.closed, k: base.conflicts, p: base.pipeline }));
    }
  });
  it("10 acquisitions of unchanged sources → identical snapshot digest, opportunity set and statuses", async () => {
    let prev: { digest: string; snapshot: CareerSnapshot } | null = null; const digests = new Set<string>(); const sets = new Set<string>();
    for (let n = 0; n < 10; n++) {
      const s = await acquireCareerSnapshot(sources(ALL), "Career Copilot", new Date(NOW.getTime() + n * 60_000), prev);
      const i = interpretCareer(s); digests.add(snapshotDigest(s)); sets.add(opportunitySetDigest(i) + interpretationDigest(i));
      prev = { digest: snapshotDigest(s), snapshot: s };
    }
    expect(digests.size).toBe(1); expect(sets.size).toBe(1);
  });
  it("the acquisition window is fixed, not rolling (a record can't age out between runs)", async () => {
    const qs: string[] = [];
    const src = { ...sources(ALL), gmailEnumerate: async (q: string) => { qs.push(q); return []; } };
    await acquireCareerSnapshot(src, "x", new Date("2026-10-09T01:00:00Z")); await acquireCareerSnapshot(src, "x", new Date("2026-12-31T23:00:00Z"));
    expect(new Set(qs.map((q) => q.split(" ")[0])).size).toBe(1); expect(qs[0]!.startsWith(`after:${CAREER_EPOCH} `)).toBe(true);
  });
});

describe("stable identity: evidence never disappears because of search/ordering behaviour", () => {
  it("a search that stops returning Immuta/Transurban records: carry-forward re-verifies them by id → same input, same output", async () => {
    const s1 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const miss = new Set([REC.immutaSent1005.id, REC.immutaReject1006.id, REC.transSent1002.id, REC.transViewed1002.id, REC.transSenior1002.id]);
    const s2 = await acquireCareerSnapshot(sources(ALL, { omitFromSearch: miss }), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    expect(s2.completeness.searchMisses).toBe(5);
    expect(s2.carryForward[0]!.records.map((r) => r.id).sort()).toEqual([...miss].sort());
    const d = snapshotDelta(s1, s2);
    expect(d).toEqual(expect.objectContaining({ sameInput: true, sameOutput: true, sameOpportunitySet: true, unexplained: [] }));
    expect(traceOrg(s2, interpretCareer(s2), "Transurban").found.every((f) => f.acquiredVia.includes("carry-forward"))).toBe(true);
  });
  it("WITHOUT the previous snapshot the same miss is visible as an unexplained removal (what produced proposals #1–#3)", async () => {
    const s1 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const s2 = await acquireCareerSnapshot(sources(ALL, { omitFromSearch: new Set([REC.chimesViewed0928.id]) }), "Career Copilot", NOW);
    const d = snapshotDelta(s1, s2);
    expect(d.oppRemoved.map((o) => o.org)).toEqual(["Chimes"]);
    expect(d.removedRecords.every((r) => r.reason === "not returned by any query and not re-verified")).toBe(true);
  });
  it("evidence deleted at the source is removed WITH its reason and the change is attributed to those record ids", async () => {
    const s1 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const del = new Set([REC.chimesViewed0928.id]);
    const s2 = await acquireCareerSnapshot(sources(ALL, { deleted: del }), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    const d = snapshotDelta(s1, s2);
    expect(d.removedRecords).toEqual([expect.objectContaining({ id: REC.chimesViewed0928.id, reason: "deleted at source" })]);
    expect(d.oppRemoved).toEqual([{ org: "Chimes", becameStatus: null, explainedBy: [REC.chimesViewed0928.id] }]);
    expect(d.unexplained).toEqual([]);
  });
});

describe("delta attribution when new evidence arrives", () => {
  it("state before 10/09 → after: Resource Innovations added and Vallum Associates reopened, each explained by its own records", async () => {
    const before = ALL.filter((x) => ![REC.riSent1009, REC.riThanks1009, REC.riPricing1009, REC.vallumSent1009].includes(x));
    const s1 = await acquireCareerSnapshot(sources(before), "Career Copilot", NOW);
    const s2 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    const d = snapshotDelta(s1, s2);
    expect(d.sameInput).toBe(false);
    expect(d.addedRecords.map((r) => r.id).sort()).toEqual([REC.riPricing1009.id, REC.riSent1009.id, REC.riThanks1009.id, REC.vallumSent1009.id].sort());
    expect(d.oppAdded).toEqual([{ org: "Resource Innovations", explainedBy: [REC.riSent1009.id, REC.riThanks1009.id, REC.riPricing1009.id] }, { org: "Vallum Associates", explainedBy: [REC.vallumSent1009.id] }]);
    expect(d.oppRemoved).toEqual([]); expect(d.statusChanged).toEqual([]); expect(d.unexplained).toEqual([]);
  });
  it("Immuta: application only (10/05) → rejection arrives (10/06) → status change explained by the Lever record", async () => {
    const s1 = await acquireCareerSnapshot(sources(ALL.filter((x) => x !== REC.immutaReject1006)), "Career Copilot", NOW);
    const s2 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    const d = snapshotDelta(s1, s2);
    expect(d.oppRemoved).toEqual([{ org: "Immuta", becameStatus: "rejected", explainedBy: [REC.immutaReject1006.id] }]);
    expect(d.unexplained).toEqual([]);
  });
  it("a sheet edit is attributed to its row ids", async () => {
    const s1 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const csv2 = SHEET_CSV.replace("m18usy,,,\"M.C. Dean, Inc.\",Financial Analyst,\"McLean, VA\",,Full-time,https://www.linkedin.com/jobs/view/4205880810/,No Restriction Identified,,Analyzed", "m18usy,,,\"M.C. Dean, Inc.\",Financial Analyst,\"McLean, VA\",,Full-time,https://www.linkedin.com/jobs/view/4205880810/,No Restriction Identified,,Applied");
    const s2 = await acquireCareerSnapshot(sources(ALL, { csv: csv2 }), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    const d = snapshotDelta(s1, s2);
    expect(d.sheet.statusChanged).toEqual([{ id: "m18usy", from: "analyzed", to: "applied" }]);
    expect(d.oppAdded).toEqual([{ org: "M.C. Dean, Inc.", explainedBy: ["sheet:m18usy"] }]); expect(d.unexplained).toEqual([]);
  });
});

describe("acquisition failures are recorded, never silent", () => {
  it("a failing account → incomplete snapshot with the reason (and the interpretation says so)", async () => {
    const s = await acquireCareerSnapshot(sources(ALL, { failAccount: "vending.vendora@gmail.com" }), "Career Copilot", NOW);
    expect(s.completeness.complete).toBe(false);
    expect(s.completeness.problems).toContain("gmail applications @ vending.vendora@gmail.com: google gmail.googleapis.com HTTP 429");
    expect(interpretCareer(s).conflicts.join(" ")).toMatch(/INCOMPLETE SNAPSHOT/);
  });
  it("the sheet file is pinned from the previous snapshot (source precedence can't drift)", async () => {
    const calls: Array<string | undefined> = [];
    const s1 = await acquireCareerSnapshot(sources(ALL, { sheetCalls: calls }), "Career Copilot", NOW);
    await acquireCareerSnapshot(sources(ALL, { sheetCalls: calls }), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    expect(calls).toEqual([undefined, "sheet-1", "sheet-1", "sheet-1"]);
  });
  it("aliases resolve deterministically regardless of input order", () => {
    const a = resolveAliases(["altarum institute", "altarum", "vallum associates", "chimes"]);
    const b = resolveAliases(["chimes", "vallum associates", "altarum", "altarum institute"]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("altarum institute")).toBe("altarum");
  });
});

describe("live run #22 (first complete snapshot, 231 records) — interpretation defects fixed in career-interpret-4", () => {
  const rec = (id: string, iso: string, subject: string, from: string, snippet = "") => ({ id, threadId: id, internalDate: Date.parse(iso), subject, from, snippet, body: "", templates: [] as string[] });
  const snap = (recs: GmailRecord[]) => acquireCareerSnapshot(sources(recs), "Career Copilot", NOW);
  const LIN = "LinkedIn <jobs-noreply@linkedin.com>";
  it("'AIR Communities' and sender domain 'aircommunities' are one organization; 'Thank You for Your Application to X' parses", async () => {
    const i = interpretCareer(await snap([rec("x1", "2026-08-21T04:59:14Z", "Julian David, your application was sent to AIR Communities", LIN),
      rec("x2", "2026-08-21T04:59:41Z", "Thank You for Your Application to AIR Communities!", "AIR Communities <careers@aircommunities.com>")]));
    expect(i.traces.orgs.filter((o) => o.orgKey !== "altarum").map((o) => [o.org, o.records.length])).toEqual([["AIR Communities", 2]]);   // (fixture calendar holds Altarum)
    expect(i.traces.records.find((t) => t.recordId === "x2")!.rule).toBe("ats:thanks_for_applying_to_org");
  });
  it("a job title is never an organization ('Corporate FP&A Analyst'); 'We Appreciate Your Interest in KBR' → KBR", async () => {
    const i = interpretCareer(await snap([rec("k1", "2026-09-10T01:56:27Z", "We Appreciate Your Interest in KBR", "KBR <kbr@myworkday.com>", "Thank you for your interest in the Corporate FP&A Analyst position. We have received your application")]));
    expect(i.traces.records[0]).toEqual(expect.objectContaining({ org: "KBR", rule: "subject:interest_in_org" }));
  });
  it("Indeed job-match mail ('… In person interview @ GoIntellects Inc.') is not an interview", async () => {
    const r = classifyRecord(evidenceRecords({ gmail: [{ key: "interviews", account: ACCOUNT, records: [rec("g1", "2026-07-20T01:35:51Z", "2years Treasury Analyst - Hybrid - In person interview @ GoIntellects Inc.", "Indeed <donotreply@match.indeed.com>")] }], calendar: [], carryForward: [] } as never)[0]!, new Set());
    expect(r.stage).toBe("excluded");
  });
  it("withdrawals and 'application is incomplete' nags: withdrawn, then a later application reopens", async () => {
    const A = "Amazon.jobs <noreply@mail.amazon.jobs>";
    const i = interpretCareer(await snap([rec("a1", "2026-08-14T10:00:00Z", "Thank you for Applying to Amazon!", A, "Thanks for applying to Amazon! We've received your application"),
      rec("a2", "2026-08-15T10:00:00Z", "Your Amazon job application is incomplete!", A, "Finish your application"),
      rec("a3", "2026-08-17T10:00:00Z", "You've withdrawn your Amazon job application!", A, "You've withdrawn your application for the position")]));
    expect(i.traces.orgs.find((o) => o.orgKey === "amazon")!.records.map((r) => r.transition)).toEqual(["analyzed→applied", "applied→withdrawn"]);
    expect(i.traces.records.find((t) => t.recordId === "a2")!.stage).toBe("excluded");
  });
  it("applyTojob (JazzHR) is an ATS domain, never an employer", async () => {
    const i = interpretCareer(await snap([rec("j1", "2026-08-13T21:18:41Z", "Julián, we've received your application", "Hiring Team <noreply@applytojob.com>", "Thank you for applying for the Financial Analyst position")]));
    expect(i.traces.records[0]!.org).toBeUndefined();
  });
});

import { buildCareerPayload } from "../../src/cos/bootstrap.js";
describe("proposal payload (what Phase 4 would write)", () => {
  const LIN = "LinkedIn <jobs-noreply@linkedin.com>";
  const rec = (id: string, iso: string, subject: string, from: string, snippet = "") => ({ id, threadId: id, internalDate: Date.parse(iso), subject, from, snippet, body: "", templates: [] as string[] });
  it("org-level evidence never relabels unrelated sheet rows; old unanswered applications are pipeline-only (no project/follow-up)", async () => {
    const csv = SHEET_CSV + "\n" + [
      "am1,,,Amazon,\"Sr. Financial Analyst, Amazon Business Finance\",,,,,No Restriction Identified,,Analyzed,80,,,,,,,,",
      "am2,,,Amazon,\"Finance Manager, Amazon Rapid Logistics\",,,,,No Restriction Identified,,Analyzed,80,,,,,,,,"].join("\n");
    const recs = [...Object.values(REC), rec("air1", "2026-08-21T04:59:14Z", "Julian David, your application was sent to AIR Communities", LIN)];
    const s = await acquireCareerSnapshot(sources(recs, { csv }), "Career Copilot", NOW);
    const p = buildCareerPayload(interpretCareer(s), s, []);
    const opp = (id: string) => (p.opportunities as Array<{ sourceId: string; status: string; statusSource: string }>).find((o) => o.sourceId === id)!;
    expect([opp("am1").status, opp("am2").status]).toEqual(["analyzed", "analyzed"]);            // evidence names no Amazon role
    expect(opp("evidence:amazon")).toEqual(expect.objectContaining({ status: "applied", statusSource: "evidence" }));
    expect(opp("mtdy30")).toEqual(expect.objectContaining({ status: "interviewing", statusSource: "evidence" }));   // Altarum's only row
    expect(p.activeProjects.map((a) => a.org)).not.toContain("AIR Communities");
    expect(p.pipelineOnly).toEqual(["AIR Communities (applied, last evidence 2026-08-21)"]);
    expect(p.activeProjects.map((a) => a.org).sort()).toEqual(["Altarum", "Amazon", "Chimes", "Resource Innovations", "Vallum Associates"]);
  });
});
