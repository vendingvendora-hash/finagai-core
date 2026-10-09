/** ADR-080: exhaustive, retried, order-independent Gmail/Calendar acquisition; failures surfaced, never swallowed. */
import { describe, expect, it } from "vitest";
import { GoogleClient } from "../../src/google/client.js";
import { MultiGoogleClient } from "../../src/google/multi.js";

const meta = (id: string, date: number, subject: string, labelIds: string[] = ["INBOX"]) => ({ id, threadId: id, internalDate: String(date), labelIds, snippet: `snip ${id}`,
  payload: { headers: [{ name: "Subject", value: subject }, { name: "From", value: "LinkedIn <jobs-noreply@linkedin.com>" }] } });

function mailbox(o: { flaky429?: number; gone?: string[]; trashed?: string[]; profile?: string; profileFails?: boolean; listFails?: boolean } = {}) {
  let left429 = o.flaky429 ?? 0; const calls: string[] = [];
  const msgs = Array.from({ length: 7 }, (_, i) => meta(`m${i}`, 1_790_000_000_000 + ((i * 37) % 7) * 1000, `Your application was sent to Org${i}`, o.trashed?.includes(`m${i}`) ? ["TRASH"] : ["INBOX"]));
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.includes("oauth2")) return json({ access_token: "t", expires_in: 3600 });
    if (url.includes("/profile")) return o.profileFails ? json({}, 500) : json({ emailAddress: o.profile ?? "a@x.com" });
    if (url.includes("/messages?")) {
      if (o.listFails) return json({ error: 1 }, 403);
      if (left429-- > 0) return json({ error: "rate" }, 429);
      const page = new URL(url).searchParams.get("pageToken");
      return page === "p2" ? json({ messages: msgs.slice(3).map((m) => ({ id: m.id })) }) : json({ messages: msgs.slice(0, 3).map((m) => ({ id: m.id })), nextPageToken: "p2" });
    }
    const id = /messages\/(m\d+)/.exec(url)?.[1];
    if (id) return o.gone?.includes(id) ? json({ error: "gone" }, 404) : json(msgs.find((m) => m.id === id));
    return json({}, 404);
  }) as typeof fetch;
  return { f, calls };
}
const client = (f: typeof fetch) => new GoogleClient({ clientId: "c", clientSecret: "s", refreshToken: "r1234567890" }, f);

describe("GoogleClient.gmailEnumerate", () => {
  it("follows every page, returns all messages sorted by (internalDate, id), retries 429", async () => {
    const { f, calls } = mailbox({ flaky429: 2 });
    const r = await client(f).gmailEnumerate("after:2026/06/01 subject:application", { pageSize: 3 });
    expect(r.pages).toBe(2); expect(r.ids).toBe(7); expect(r.truncated).toBe(false);
    expect(r.records.map((x) => x.internalDate)).toEqual([...r.records.map((x) => x.internalDate)].sort((a, b) => a - b));
    expect(new Set(r.records.map((x) => x.id)).size).toBe(7);
    expect(calls.filter((c) => c.includes("/messages?")).length).toBe(4);   // 2 × 429 then 2 pages
  }, 10_000);
  it("reports truncation instead of silently cutting", async () => {
    const r = await client(mailbox().f).gmailEnumerate("q", { maxMessages: 3, pageSize: 3 });
    expect(r.truncated).toBe(true); expect(r.records).toHaveLength(3);
  });
  it("a message deleted between list and get is recorded as vanished; a permanent error throws (no silent [])", async () => {
    const r = await client(mailbox({ gone: ["m4"] }).f).gmailEnumerate("q");
    expect(r.vanished).toEqual(["m4"]); expect(r.records).toHaveLength(6);
    await expect(client(mailbox({ listFails: true }).f).gmailEnumerate("q")).rejects.toThrow(/HTTP 403/);
  });
  it("gmailMetadata re-verifies ids: deleted and trashed are reported with reasons", async () => {
    const r = await client(mailbox({ gone: ["m1"], trashed: ["m2"] }).f).gmailMetadata(["m0", "m1", "m2"]);
    expect(r.records.map((x) => x.id)).toEqual(["m0"]);
    expect(r.missing).toEqual([{ id: "m1", reason: "deleted at source" }, { id: "m2", reason: "moved to trash" }]);
  });
});

describe("MultiGoogleClient enumeration", () => {
  it("each account's outcome is reported; an unverifiable account is a recorded failure, never relabelled", async () => {
    const good = client(mailbox({ profile: "perez.julian@correounivalle.edu.co" }).f), bad = client(mailbox({ profileFails: true }).f);
    const m = new MultiGoogleClient([good, bad]);
    const r = await m.gmailEnumerate("q");
    expect(r.map((x) => [x.account, x.ok])).toEqual([["perez.julian@correounivalle.edu.co", true], ["unverified account", false]]);
    expect(r[1]!.error).toMatch(/HTTP 500/);
    await expect(m.gmailMetadata("nobody@x.com", ["m0"])).rejects.toThrow(/not connected/);
    expect((await m.gmailMetadata("perez.julian@correounivalle.edu.co", ["m0"])).records).toHaveLength(1);
  }, 15_000);
});

import { messageText } from "../../src/google/client.js";
describe("messageText (deterministic body + LinkedIn template ids)", () => {
  const b64 = (t: string) => Buffer.from(t).toString("base64url");
  it("reads the template id from tracking URLs, removes URLs, appends HTML text when the text part is a stub", () => {
    const plain = "Your update from Transurban\n\n----\nLearn why we included this: https://www.linkedin.com/help/linkedin/answer/4788?lipi=urn%3Ali%3Apage%3Aemail_email_jobs_application_rejected_01%3BunS&trk=eml-email_jobs_application_rejected_01-SecurityHelp-0\n";
    const html = "<html><head><style>.x{}</style></head><body><p>Thank you for your interest in the Senior Financial Planning Analyst position at Transurban.</p><p>Unfortunately, we will not be moving forward.</p></body></html>";
    const r = messageText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64(plain) } }, { mimeType: "text/html", body: { data: b64(html) } }] });
    expect(r.templates).toEqual(["jobs_application_rejected_01"]);
    expect(r.text).not.toMatch(/https?:/);
    expect(r.text).toMatch(/^Your update from Transurban/);
    expect(r.text).toMatch(/will not be moving forward/);
    expect(messageText({ mimeType: "text/plain", body: { data: b64("x https://a.b/?trk=eml-email_application_confirmation_with_nba_01-x") } }).templates).toEqual(["application_confirmation_with_nba_01"]);
  });
});
