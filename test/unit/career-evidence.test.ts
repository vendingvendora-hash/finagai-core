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
import { buildCareerPayload, extractSheet } from "../../src/cos/bootstrap.js";


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
type I = ReturnType<typeof interpretCareer>;
/** "<employer> — <title or req>" → status, for every job with evidence. */
const jobs = (i: I) => Object.fromEntries(i.opportunities.map((o) => [`${o.employer} — ${o.reqId ?? o.title ?? "?"}`, o.status]));
const job = (i: I, emp: string, idOrTitle: string) => i.opportunities.find((o) => o.employer === emp && (o.reqId === idOrTitle || o.title === idOrTitle))!;
function shuffled<T>(a: T[], seed: number): T[] { const x = [...a]; let s = seed; for (let i = x.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2 ** 31; const j = s % (i + 1); [x[i], x[j]] = [x[j]!, x[i]!]; } return x; }
function permute(s: CareerSnapshot, seed: number): CareerSnapshot {
  return { ...s, gmail: shuffled(s.gmail, seed).map((g) => ({ ...g, records: shuffled(g.records, seed + 1) })), calendar: shuffled(s.calendar, seed + 2), carryForward: shuffled(s.carryForward, seed + 3) };
}


describe("job identity: one opportunity per job/application, never per employer", () => {
  it("multiple Amazon roles stay separate, each with its own requisition, status and history", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const amz = i.opportunities.filter((o) => o.employer === "Amazon");
    expect(amz.map((o) => [o.reqId, o.title, o.status])).toEqual([
      ["10383371", "Senior Financial Analyst, NACF", "applied"],
      ["10460629", "Sr. Financial Analyst, Amazon Business Finance", "rejected"],
      ["10466286", "Senior Financial Analyst, NACF", "applied"],
      ["10471926", "Senior Financial Analyst, R2L Sub Same Day - Delivery Finance", "applied"],
      ["10491543", "Lease Financial Transformation Manager, Lease Accounting FBI", "withdrawn"],
      ["10499413", "Senior Financial Analyst, AWS Networking Infrastructure Finance", "closed"],
      ["10507439", "Senior Financial Analyst, Sustainability Finance", "rejected"],          // "decided to progress with other candidates" (body)
    ]);
    expect(amz.every((o) => o.identityBasis === "requisition" && o.key === `job:amazon|req:${o.reqId!.toLowerCase()}`)).toBe(true);
    // Same title, two requisitions → two jobs (NACF), never merged.
    expect(amz.filter((o) => o.title === "Senior Financial Analyst, NACF").map((o) => o.reqId)).toEqual(["10383371", "10466286"]);
  });
  it("a status change affects only its own job: the 09/20 rejection closes 10460629 only; withdrawn/closed stay on their own requisitions", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    expect(job(i, "Amazon", "10460629").events.map((e) => `${e.kind}:${e.transition}`)).toEqual(["started:analyzed→preparing", "application:preparing→applied", "rejection:applied→rejected"]);
    expect(job(i, "Amazon", "10471926").events.map((e) => `${e.kind}:${e.transition}`)).toEqual(["started:analyzed→preparing", "application:preparing→applied"]);
    expect(job(i, "Amazon", "10491543").events.map((e) => e.transition)).toEqual(["analyzed→preparing", "preparing→preparing", "preparing→withdrawn"]);
    expect(job(i, "Amazon", "10499413").events.map((e) => e.transition)).toEqual(["analyzed→preparing", "preparing→applied", "applied→closed"]);
    // An Amazon email that names no requisition changes nothing and is kept, with the reason.
    expect(i.unassigned.find((u) => u.recordId === REC.amzAssessment0804.id)).toEqual(expect.objectContaining({ employer: "Amazon", reason: expect.stringMatching(/jobs in evidence and this record names none/) }));
  });
  it("a new application never reopens an old rejected job; a re-application to the same requisition is an anomaly, not a reopen", async () => {
    const again = { ...REC.amzBizFinApplied0821, id: "amz-reapply-1001", threadId: "amz-reapply-1001", internalDate: Date.parse("2026-10-01T12:00:00Z") };
    const i = interpretCareer(await acquireCareerSnapshot(sources([...ALL, again]), "Career Copilot", NOW));
    const j = job(i, "Amazon", "10460629");
    expect(j.status).toBe("rejected");
    expect(j.anomalies).toEqual(["2026-10-01 application after rejected (record amz-reapply-1001)"]);
    expect(job(i, "Amazon", "10471926").status).toBe("applied");   // the 10/05 application is its own job
  });
  it("Vallum Associates: two LinkedIn jobs — Structured Finance Analyst rejected (08/27), Project Finance Analyst - SMR applied (10/09)", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const v = i.opportunities.filter((o) => o.employer === "Vallum Associates");
    expect(v.map((o) => [o.title, o.location, o.status, o.events.map((e) => e.recordId)])).toEqual([
      ["Project Finance Analyst - SMR", "Washington DC-Baltimore Area", "applied", [REC.vallumSent1009.id]],
      ["Structured Finance Analyst", "Washington DC-Baltimore Area", "rejected", [REC.vallumSent0824.id, REC.vallumApp0827.id]],
    ]);
  });
  it("Transurban, Immuta, Altarum: every event lands on the right job; title-less events attach only to an employer's single job", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    expect(job(i, "Transurban", "Senior Financial Planning Analyst").events.map((e) => `${e.kind}:${e.transition}`)).toEqual(["application:analyzed→applied", "viewed:applied→applied", "rejection:applied→rejected"]);
    expect(job(i, "Transurban", "Senior Financial Planning Analyst").location).toBe("Tysons Corner, VA");
    expect(job(i, "Immuta", "FP&A Analyst").events.map((e) => e.transition)).toEqual(["analyzed→applied", "applied→rejected"]);
    const alt = job(i, "Altarum", "Pricing Analyst");
    expect(alt.status).toBe("interviewing"); expect(alt.sheetRows).toEqual(["mtdy30"]); expect(alt.contact).toBe("Beth Young");
    expect(i.opportunities.filter((o) => o.employerKey === "altarum")).toHaveLength(1);
  });
  it("statuses across the real evidence (job level)", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    expect(jobs(i)).toEqual(expect.objectContaining({
      "Altarum — Pricing Analyst": "interviewing", "Immuta — FP&A Analyst": "rejected", "Transurban — Senior Financial Planning Analyst": "rejected",
      "Resource Innovations — Pricing Analyst": "applied", "Cvent — Senior Financial Analyst, Strategic Finance (AI Portfolio)": "rejected",
      "Johns Hopkins University — 120088": "rejected", "Accenture — R00336590": "rejected", "Yahoo — Price and Yield Manager": "rejected",
      "Window Nation — Senior Strategy Analyst": "rejected",
    }));
    expect(i.opportunities.some((o) => /senior$/i.test(o.employer))).toBe(false);
  });
});

describe("no opportunity disappears through deduplication", () => {
  it("every job-bearing record is in exactly one job or explicitly unassigned; every sheet row is a job or linked to one", async () => {
    const s = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const i = interpretCareer(s);
    const cands = i.traces.records.filter((t) => t.stage === "candidate").map((t) => t.recordId).sort();
    const placed = [...i.opportunities.flatMap((o) => o.events.map((e) => e.recordId)), ...i.unassigned.map((u) => u.recordId)].sort();
    expect(placed).toEqual(cands);                                     // a partition: no record lost, none counted twice
    const p = buildCareerPayload(i, s, []);
    const covered = new Set(p.opportunities.flatMap((o) => o.sourceIds.filter((x) => x.startsWith("sheet:")).map((x) => x.slice(6))));
    expect(extractSheet(SHEET_CSV).rows.every((r) => covered.has(r.sourceId))).toBe(true);
    expect(new Set(p.opportunities.map((o) => o.dedupe)).size).toBe(p.opportunities.length);   // identities are unique
  });
  it("sheet duplicates are merged visibly (reported with the row they merged into), never silently", () => {
    const csv = SHEET_CSV + "\ndup777,,,Altarum,Pricing Analyst,\"Silver Spring, MD\",Hybrid,Full-time,https://www.linkedin.com/jobs/view/4462053616/,No Restriction Identified,,Analyzed,88,,,Medium,,,,,";
    expect(extractSheet(csv).duplicateRows).toEqual([{ id: "dup777", sameAs: "mtdy30", key: "linkedin:4462053616" }]);
  });
  it("a job seen in an earlier snapshot is still present later (matched by any alias); if its records vanish, the change names them", async () => {
    const s1 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const s2 = await acquireCareerSnapshot(sources(ALL, { deleted: new Set([REC.amzR2LStarted1005.id, REC.amazonApplied1005.id]) }), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    const d = snapshotDelta(s1, s2);
    expect(d.oppRemoved).toEqual([{ org: "Amazon — Senior Financial Analyst, R2L Sub Same Day - Delivery Finance (10471926)".replace(" (10471926)", ""), becameStatus: null, explainedBy: [REC.amzR2LStarted1005.id, REC.amazonApplied1005.id] }]);
    expect(d.unexplained).toEqual([]);
  });
});

describe("reproducibility on a frozen snapshot", () => {
  it("10 interpretations with permuted record/source order → identical job set, histories and digests", async () => {
    const s = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const base = interpretCareer(s);
    for (let n = 0; n < 10; n++) {
      const i = interpretCareer(permute(s, n + 7));
      expect(interpretationDigest(i)).toBe(interpretationDigest(base));
      expect(JSON.stringify(i.opportunities)).toBe(JSON.stringify(base.opportunities));
    }
  });
  it("10 acquisitions of unchanged sources → identical snapshot digest and job set", async () => {
    let prev: { digest: string; snapshot: CareerSnapshot } | null = null; const digests = new Set<string>(); const sets = new Set<string>();
    for (let n = 0; n < 10; n++) {
      const s = await acquireCareerSnapshot(sources(ALL), "Career Copilot", new Date(NOW.getTime() + n * 60_000), prev);
      const i = interpretCareer(s); digests.add(snapshotDigest(s)); sets.add(opportunitySetDigest(i) + interpretationDigest(i));
      prev = { digest: snapshotDigest(s), snapshot: s };
    }
    expect(digests.size).toBe(1); expect(sets.size).toBe(1);
  });
  it("the acquisition window is fixed, not rolling", async () => {
    const qs: string[] = [];
    const src = { ...sources(ALL), gmailEnumerate: async (q: string) => { qs.push(q); return []; } };
    await acquireCareerSnapshot(src, "x", new Date("2026-10-09T01:00:00Z")); await acquireCareerSnapshot(src, "x", new Date("2026-12-31T23:00:00Z"));
    expect(new Set(qs.map((q) => q.split(" ")[0])).size).toBe(1); expect(qs[0]!.startsWith(`after:${CAREER_EPOCH} `)).toBe(true);
  });
});

describe("evidence reading (kept from ADR-080)", () => {
  const one = (x: GmailRecord, known = new Set<string>()) => classifyRecord(evidenceRecords({ gmail: [{ key: "applications", account: ACCOUNT, records: [x] }], calendar: [], carryForward: [] } as never)[0]!, known);
  it("LinkedIn rejection template, HTML-escaped rejection, body-only rejections, marketing never an employer", () => {
    expect(one(REC.transSenior1002)).toEqual(expect.objectContaining({ kind: "rejection", org: "Transurban", title: "Senior Financial Planning Analyst" }));
    expect(decodeEntities(REC.immutaReject1006.snippet)).toMatch(/we've made the decision/);
    expect(one(REC.immutaReject1006)).toEqual(expect.objectContaining({ kind: "rejection", org: "Immuta", title: "FP&A Analyst" }));
    for (const r of [REC.cventRejected0820, REC.windowNationRejected0821, REC.accentureRejected0903, REC.jhuRejected0911]) expect(one(r).kind).toBe("rejection");
    expect(one(REC.accentureRejected0903).org).toBe("Accenture");
    expect(one(REC.transTrends1006).stage).toBe("excluded"); expect(one(REC.transApplyNow0918).stage).toBe("excluded");
    expect(one(REC.indeedApplied1005).stage).toBe("unparsed");
  });
  it("Amazon: requisition id and title come from the record itself; 'started' and 'posting closed' are their own events", () => {
    expect(one(REC.amzNetClosed0908)).toEqual(expect.objectContaining({ kind: "posting_closed", reqId: "10499413", title: "Senior Financial Analyst, AWS Networking Infrastructure Finance" }));
    expect(one(REC.amzLeaseIncomplete0809)).toEqual(expect.objectContaining({ kind: "started", reqId: "10491543" }));
    expect(one(REC.amzLeaseWithdrawn0817).kind).toBe("withdrawal");
  });
  it("aliases resolve deterministically regardless of input order", () => {
    const a = resolveAliases(["altarum institute", "altarum", "vallum associates", "chimes", "aircommunities", "air communities"]);
    const b = resolveAliases(["air communities", "chimes", "aircommunities", "vallum associates", "altarum", "altarum institute"]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("altarum institute")).toBe("altarum"); expect(a.get("aircommunities")).toBe(a.get("air communities"));
  });
});

describe("stable acquisition (kept from ADR-080)", () => {
  it("a search that stops returning records: carry-forward re-verifies them by id → same input, same output", async () => {
    const s1 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const miss = new Set([REC.immutaSent1005.id, REC.immutaReject1006.id, REC.transSent1002.id]);
    const s2 = await acquireCareerSnapshot(sources(ALL, { omitFromSearch: miss }), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    expect(s2.completeness.searchMisses).toBe(3);
    expect(snapshotDelta(s1, s2)).toEqual(expect.objectContaining({ sameInput: true, sameOutput: true, sameOpportunitySet: true, unexplained: [] }));
  });
  it("new evidence → the delta names the records behind each new job", async () => {
    const before = ALL.filter((x) => ![REC.riSent1009, REC.riThanks1009, REC.riPricing1009, REC.vallumSent1009].includes(x));
    const s1 = await acquireCareerSnapshot(sources(before), "Career Copilot", NOW);
    const s2 = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW, { digest: snapshotDigest(s1), snapshot: s1 });
    const d = snapshotDelta(s1, s2);
    expect(d.oppAdded).toEqual([
      { org: "Resource Innovations — Pricing Analyst", explainedBy: [REC.riSent1009.id, REC.riThanks1009.id, REC.riPricing1009.id] },
      { org: "Vallum Associates — Project Finance Analyst - SMR", explainedBy: [REC.vallumSent1009.id] }]);
    expect(d.unexplained).toEqual([]); expect(d.statusChanged).toEqual([]);
  });
  it("a failing account → incomplete snapshot with the reason", async () => {
    const s = await acquireCareerSnapshot(sources(ALL, { failAccount: "vending.vendora@gmail.com" }), "Career Copilot", NOW);
    expect(s.completeness.complete).toBe(false);
    expect(interpretCareer(s).conflicts.join(" ")).toMatch(/INCOMPLETE SNAPSHOT/);
  });
});

describe("proposal payload (what approval would write)", () => {
  it("one record per job with its own identity, history and source ids; projects per engaged JOB; employer labels traced, not renamed", async () => {
    const s = await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW);
    const i = interpretCareer(s);
    const p = buildCareerPayload(i, s, []);
    const r2l = p.opportunities.find((o) => o.reqId === "10471926")!;
    expect(r2l).toEqual(expect.objectContaining({ org: "Amazon", employerKey: "amazon", status: "applied", identityBasis: "requisition", sourceIds: ["gmail:1a10a379c2323ae3", "gmail:1a10a40993b2093a"] }));
    expect(r2l.events.map((e) => e.kind)).toEqual(["started", "application"]);
    expect(p.activeProjects.map((a) => a.name)).toEqual(expect.arrayContaining(["Altarum — Pricing Analyst", "Amazon — Senior Financial Analyst, R2L Sub Same Day - Delivery Finance (10471926)", "Vallum Associates — Project Finance Analyst - SMR"]));
    expect(p.activeProjects.some((a) => a.name.startsWith("Vallum Associates — Structured"))).toBe(false);
    expect(p.employers!.find((e) => e.key === "amazon")!.jobs).toBe(7);
  });
});

describe("identity safety", () => {
  it("no alias key is shared by two jobs (one title with two requisitions can never merge them)", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    const all = i.opportunities.flatMap((o) => o.aliasKeys);
    expect(all.length).toBe(new Set(all).size);
    expect(i.opportunities.filter((o) => o.reqId === "10383371" || o.reqId === "10466286").flatMap((o) => o.aliasKeys).some((k) => k.includes("|title:"))).toBe(false);
  });
});

describe("live reinterpretation of #42 (proposal #43) — title artifacts fixed", () => {
  it("email signatures are never job titles ('Beth Young', 'O | 734.302.4736', 'Best regards'); Altarum stays ONE job", async () => {
    const i = interpretCareer(await acquireCareerSnapshot(sources(ALL), "Career Copilot", NOW));
    expect(i.opportunities.filter((o) => o.employerKey === "altarum").map((o) => o.title)).toEqual(["Pricing Analyst"]);
    expect(i.opportunities.every((o) => !o.title || /analyst|manager|accountant|specialist|associate|director|coordinator|consultant|controller|strategist|estimator|lead|officer/i.test(o.title))).toBe(true);
    expect(i.opportunities.every((o) => !o.location || o.location.length <= 60)).toBe(true);
  });
});

describe("title edge cases from #43", () => {
  const one = (x: GmailRecord) => classifyRecord(evidenceRecords({ gmail: [{ key: "a", account: ACCOUNT, records: [x] }], calendar: [], carryForward: [] } as never)[0]!, new Set());
  it("JHU requisition title and Accenture reference role are read cleanly (no signature/team suffix)", () => {
    expect(one(REC.jhuRejected0911)).toEqual(expect.objectContaining({ reqId: "120088", title: "Financial Analyst (DOM General Internal Medicine)" }));
    expect(one(REC.accentureRejected0903)).toEqual(expect.objectContaining({ reqId: "R00336590", title: "Pricing & Deal Structuring Specialist" }));
  });
});
