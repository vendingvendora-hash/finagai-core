/** ADR-075: regressions for the failures found running plan_resources against Julian's real data (Oct 5, 2026). */
import { describe, it, expect } from "vitest";
import { driveQuery, gmailQuery, GoogleClient } from "../../src/google/client.js";
import { MultiGoogleClient } from "../../src/google/multi.js";
import { terms } from "../../src/resources/retrieve.js";

describe("search terms (live: 'analysis' alone matched unrelated job sheets)", () => {
  it("drops request verbs and file-kind nouns; content words form ONE group", () => {
    expect(terms({ entities: [], request: "Summarize the Degree of Leverage Analysis spreadsheet" })).toEqual(["degree leverage analysis"]);
    expect(terms({ entities: [], request: "What's the status of Altarum?" })).toEqual(["altarum"]);
    expect(terms({ entities: [], request: "Prepare me for Altarum" })).toEqual(["altarum"]);
    expect(terms({ entities: [], request: "When is my Altarum interview?" })).toEqual(["altarum"]);
    expect(terms({ entities: [], request: "Prepare me for my Northwind Analytics interview" })).toEqual(["northwind analytics"]);
    expect(terms({ entities: [], request: "find the pricing memo" })).toEqual(["pricing memo"]);
  });
  it("Drive requires every word of a group (by name) or the words in full text — never any single word", () => {
    const q = driveQuery(["degree leverage analysis"]);
    expect(q).toContain("name contains 'degree' and name contains 'leverage' and name contains 'analysis'");
    expect(q).not.toMatch(/or name contains 'analysis'\)/);
  });
  it("Gmail ANDs words inside a group, ORs across entity groups", () => {
    expect(gmailQuery(["degree leverage analysis"])).toBe("(degree leverage analysis)");
    expect(gmailQuery(["Altarum", "Northwind"])).toBe('"Altarum" OR "Northwind"');
  });
});

function fakeAccount(email: string, gmailRows: Array<{ name: string }>, fail = false): GoogleClient {
  const c = Object.create(GoogleClient.prototype) as GoogleClient;
  Object.assign(c, {
    account: async () => { if (fail) throw new Error("google token refresh failed: HTTP 400"); return email; },
    gmail: async () => { if (fail) throw new Error("HTTP 401"); return gmailRows.map((r) => ({ ...r, path: "g", text: "t" })); },
    calendar: async () => [], drive: async () => [],
  });
  return c;
}

describe("multi-account Google (live: Altarum mail is in the university account, Finagai only had Vendora's)", () => {
  it("searches every account and labels results with the account they came from", async () => {
    const m = new MultiGoogleClient([fakeAccount("vending.vendora@gmail.com", []),
      fakeAccount("perez.julian@correounivalle.edu.co", [{ name: "Gmail: Interview with Altarum" }])]);
    const rows = await m.gmail(["altarum"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Gmail: Interview with Altarum [perez.julian@correounivalle.edu.co]");
    expect(await m.account()).toBe("vending.vendora@gmail.com, perez.julian@correounivalle.edu.co");
  });
  it("a failing account never hides the others, and is visible in the probe", async () => {
    const m = new MultiGoogleClient([fakeAccount("x@y.com", [], true), fakeAccount("perez.julian@correounivalle.edu.co", [{ name: "Gmail: A" }])]);
    expect(await m.gmail(["altarum"])).toHaveLength(1);
    expect(await m.account()).toMatch(/correounivalle.*\(1 account\(s\) failing\)/);
  });
  it("all accounts failing surfaces the error (status 'failed', not 'empty')", async () => {
    const m = new MultiGoogleClient([fakeAccount("x@y.com", [], true)]);
    await expect(m.gmail(["altarum"])).rejects.toThrow(/401/);
  });
});

import { relevant } from "../../src/resources/retrieve.js";
describe("relevance guard (live R09: Capital One/Canva mail returned as the Altarum interview answer)", () => {
  const rows = [
    { name: "Gmail: Your AutoPay payment is scheduled", text: "From: Capital One" },
    { name: "Gmail: Interview with Altarum / Pricing Analyst", text: "confirmed for 9/28" },
    { name: "Gmail: 20% off Canva Print Shop", text: "When the countdown ends" },
  ];
  it("keeps only results that mention the request's content", () => {
    expect(relevant(rows, ["altarum interview"]).map((r) => r.name)).toEqual(["Gmail: Interview with Altarum / Pricing Analyst"]);
    expect(relevant(rows, ["Altarum"])).toHaveLength(1);
  });
  it("no groups → nothing to filter on", () => { expect(relevant(rows, [])).toHaveLength(3); });
});

import { dedupeVersions } from "../../src/resources/retrieve.js";
describe("live R02 follow-up: résumé JSONs and timestamped backups", () => {
  it("a multi-word Drive subject must be in the file name (no full-text AND of common words)", () => {
    const q = driveQuery(["degree leverage analysis"]);
    expect(q).not.toContain("fullText");
    expect(driveQuery(["altarum"])).toContain("fullText contains 'altarum'");
  });
  it("the guard requires every word of a group", () => {
    expect(relevant([{ name: "Google Drive: knowledge_base.json", text: "B.S. degree ... financial analysis" }], ["degree leverage analysis"])).toHaveLength(0);
    expect(relevant([{ name: "Google Drive: Degree of Leverage Analysis.xlsx", text: "" }], ["degree leverage analysis"])).toHaveLength(1);
  });
  it("timestamped copies collapse to the newest", () => {
    const rows = ["knowledge_base_backup_2026-10-05T05-40-58-108Z.json", "knowledge_base_backup_2026-10-05T05-40-30-140Z.json", "knowledge_base.json",
      "intel_2026-09-19T18-06-53-980Z.json", "intel_2026-09-19T18-05-42-914Z.json", "Degree of Leverage Analysis.xlsx"].map((name) => ({ name }));
    expect(dedupeVersions(rows).map((r) => r.name)).toEqual(["knowledge_base_backup_2026-10-05T05-40-58-108Z.json", "intel_2026-09-19T18-06-53-980Z.json", "Degree of Leverage Analysis.xlsx"]);
  });
});
