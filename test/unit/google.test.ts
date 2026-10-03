import { describe, expect, it } from "vitest";
import { GoogleClient, passageOf, plainBody } from "../../src/google/client.js";

function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    const v = routes[key];
    return typeof v === "string" ? new Response(v) : new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

describe("Google read-only search (ADR-049)", () => {
  it("searches Drive, exports Google Docs as text, reads Gmail and Calendar", async () => {
    const { f, calls } = fakeFetch({
      "oauth2.googleapis.com/token": { access_token: "at", expires_in: 3600 },
      "drive/v3/files?": { files: [{ id: "d1", name: "Miami trip", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-01T00:00:00Z", webViewLink: "https://docs.google.com/d1" }] },
      "drive/v3/files/d1/export": "Hotel: Faena, check-in Nov 14",
      "users/me/messages?": { messages: [{ id: "m1" }] },
      "users/me/messages/m1": { internalDate: "1759000000000", payload: { headers: [{ name: "Subject", value: "Your Delta confirmation" }, { name: "From", value: "Delta" }],
        mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Flight DL123 to MIA on Nov 14").toString("base64url") } }] } },
      "calendar/v3": { items: [{ summary: "Miami trip", start: { date: "2026-11-14" }, location: "MIA" }] },
    });
    const g = new GoogleClient({ clientId: "c", clientSecret: "s", refreshToken: "r" }, f);
    const r = await g.search(["Miami"]);
    expect(r.map((x) => x.name)).toEqual(["Google Drive: Miami trip", "Gmail: Your Delta confirmation", "Google Calendar"]);
    expect(r[0]!.text).toContain("check-in Nov 14");
    expect(r[1]!.text).toContain("DL123");
    expect(r[2]!.text).toContain("2026-11-14");
    expect(calls.filter((c) => c.includes("oauth2")).length).toBe(1); // token reused
  });
  it("one failing service never blocks the others", async () => {
    const { f } = fakeFetch({ "oauth2.googleapis.com/token": { access_token: "at", expires_in: 3600 }, "calendar/v3": { items: [{ summary: "Dentist", start: { date: "2026-10-20" } }] } });
    const r = await new GoogleClient({ clientId: "c", clientSecret: "s", refreshToken: "r" }, f).search(["dentist"]);
    expect(r.map((x) => x.name)).toEqual(["Google Calendar"]);
  });
  it("escapes quotes in Drive queries", async () => {
    const { f, calls } = fakeFetch({ "oauth2.googleapis.com/token": { access_token: "at", expires_in: 3600 }, "drive/v3/files?": { files: [] } });
    await new GoogleClient({ clientId: "c", clientSecret: "s", refreshToken: "r" }, f).drive(["O'Brien"]);
    expect(decodeURIComponent(calls[1]!)).toContain("O\\'Brien");
  });
  it("extracts plain text and passages", () => {
    expect(plainBody({ mimeType: "text/html", body: { data: Buffer.from("<p>Hi <b>there</b></p>").toString("base64url") } })).toContain("Hi there");
    expect(passageOf("x".repeat(9000) + " Kennedy Center " + "y".repeat(9000), ["Kennedy"])).toContain("Kennedy Center");
  });
});
