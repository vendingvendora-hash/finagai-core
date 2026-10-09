/** Phase 3C: Career bootstrap extraction against the real Career Copilot header and real Gmail/Calendar shapes. */
import { describe, it, expect } from "vitest";
import { parseCsv, extractSheet, extractEngagement, dedupeKey, normOrg } from "../../src/cos/bootstrap.js";

const HEADER = "Job ID,Date First Analyzed,Date Last Updated,Company,Title,Location,Work Mode,Employment Type,Posting URL,Eligibility Status,Eligibility Detail,Application Status,Overall Match Score,Fit Concerns Summary,Salary Range,Priority,Next Action,Next Action Date,Latest Resume Link,Latest Cover Letter Link,Job Folder Link";
const CSV = [HEADER,
  'v741fq,2026-08-20T04:37:13.118Z,2026-08-20T04:37:13.118Z,Test Diagnostics Co,QA Verification Role,Remote,,Full-time,,No Restriction Identified,,Analyzed,,,,Medium,,,,,https://drive.google.com/x',
  'k989rg,2026-08-20T05:25:47.427Z,2026-08-20T05:27:08.573Z,MAG Aerospace,Financial Planning and Analysis Analyst,"Fairfax, VA",In Office,Full-time,https://www.linkedin.com/jobs/view/4436412173/,U.S. Citizenship Required,"requires ""US Citizen""",Analyzed,85,"No Deltek, TM1",65000 100000 USD,Medium,,,,,https://drive.google.com/y',
  'mtdy30,2026-09-07T19:32:57.484Z,2026-09-07T19:40:27.722Z,Altarum,Pricing Analyst,"Silver Spring, MD",Hybrid,Full-time,https://www.linkedin.com/jobs/view/4462053616,No Restriction Identified,None,Analyzed,88,"Target title is Pricing Analyst; Costpoint\nexposure",95000 105000 USD,Medium,,,,,https://drive.google.com/z',
  'dup001,2026-09-07T19:32:57.484Z,2026-09-07T19:40:27.722Z,Altarum,Pricing Analyst,"Silver Spring, MD",Hybrid,Full-time,https://www.linkedin.com/jobs/view/4462053616/,No Restriction Identified,None,Analyzed,88,,,Medium,,,,,',
].join("\n");

describe("Career Copilot sheet extraction (by header name)", () => {
  it("parses quoted cells with commas, quotes and newlines", () => {
    const rows = parseCsv(CSV);
    expect(rows[3]![13]).toBe("Target title is Pricing Analyst; Costpoint\nexposure");
    expect(rows[2]![10]).toBe('requires "US Citizen"');
  });
  it("drops test rows, dedupes the same posting, keeps eligibility and scores", () => {
    const r = extractSheet(CSV);
    expect(r.dropped).toBe(1); expect(r.duplicates).toBe(1);
    expect(r.rows.map((x) => x.org)).toEqual(["MAG Aerospace", "Altarum"]);
    const alt = r.rows[1]!;
    expect(alt).toEqual(expect.objectContaining({ title: "Pricing Analyst", fitScore: 88, status: "analyzed", location: "Silver Spring, MD", salary: "95000 105000 USD" }));
    expect(r.rows[0]!.eligibility).toBe("U.S. Citizenship Required");
  });
  it("dedupe key prefers the LinkedIn job id, else normalized org|title", () => {
    expect(dedupeKey("Altarum", "Pricing Analyst", "https://www.linkedin.com/jobs/view/4462053616/")).toBe("linkedin:4462053616");
    expect(dedupeKey("M.C. Dean, Inc.", "Financial Analyst", null)).toBe("m c dean|financial analyst");
    expect(normOrg("The Johns Hopkins University")).toBe("johns hopkins university");
  });
});

describe("engagement evidence (real Gmail/Calendar shapes from the 2026-10-09 audit)", () => {
  it("Gmail threads → org, kind, contact; Otter/self senders are not contacts", () => {
    const g = extractEngagement([
      { name: "Gmail: RE: Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst [perez.julian@correounivalle.edu.co]", modified: "2026-09-24T15:09:36.000Z",
        text: "From: Beth Young <Beth.Young@altarum.org>\nDate: Thu, 24 Sep 2026 15:09:36 +0000\nThank you, Julian!" },
      { name: "Gmail: Phone Screen with Altarum / Julian David Perez Cardozo - Pricing Analyst [x]", modified: "2026-09-14T14:07:29.000Z", text: "From: Beth Young <Beth.Young@altarum.org>\n" },
      { name: "Gmail: Meeting Summary for Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst [x]", text: "From: \"JULIAN DAVID PEREZ CARDOZO via Otter.ai\" <no-reply@otter.ai>\n" },
      { name: "Gmail: Your saved items are waiting [x]", text: "From: Quince <hello@email.quince.com>" },
    ], "gmail");
    expect(g.map((e) => [e.org, e.kind])).toEqual([["Altarum", "interview"], ["Altarum", "screen"], ["Altarum", "interview"]]);
    expect(g[0]!.contact).toBe("Beth Young"); expect(g[2]!.contact).toBeNull();
  });
  it("live: job-title words are never an employer ('Senior' from a LinkedIn application email)", () => {
    const g = extractEngagement([{ name: "Gmail: Your application for Senior Financial Analyst [x]", text: "From: LinkedIn <jobs-noreply@linkedin.com>\n" },
      { name: "Gmail: Julian, your application was sent to Capital One [x]", text: "From: LinkedIn <jobs-noreply@linkedin.com>\n" }], "gmail");
    expect(g.map((e) => e.org)).not.toContain("Senior");
  });
  it("live: LinkedIn application notices yield the real employer (Transurban)", () => {
    const g = extractEngagement([
      { name: "Gmail: Your application to Senior Financial Planning Analyst at Transurban [u]", modified: "2026-10-02T14:18:15Z", text: "From: LinkedIn <jobs-noreply@linkedin.com>\n" },
      { name: "Gmail: Your application was viewed by Transurban [u]", modified: "2026-10-02T13:34:48Z", text: "From: LinkedIn <jobs-noreply@linkedin.com>\n" },
      { name: "Gmail: Julian David, your application was sent to Transurban [u]", modified: "2026-10-02T01:43:46Z", text: "From: LinkedIn <jobs-noreply@linkedin.com>\n" }], "gmail");
    expect(g.map((e) => [e.org, e.kind])).toEqual([["Transurban", "application"], ["Transurban", "application"], ["Transurban", "application"]]);
    expect(g.every((e) => e.contact === null)).toBe(true);
  });
  it("Calendar excerpt with several events", () => {
    const c = extractEngagement([{ name: "Google Calendar [perez.julian@correounivalle.edu.co]",
      text: "2026-09-14T11:30:00-04:00 | Phone Screen with Altarum / Julian David Perez Cardozo - Pricing Analyst | | Hi Julian\n2026-09-28T15:00:00-04:00 | Interview with Altarum / Julian David Perez Cardozo - Pricing Analyst | | panel\n2026-10-01T09:00:00-04:00 | Dentist | |" }], "calendar");
    expect(c.map((e) => [e.org, e.kind, e.when?.slice(0, 10)])).toEqual([["Altarum", "screen", "2026-09-14"], ["Altarum", "interview", "2026-09-28"]]);
  });
});
