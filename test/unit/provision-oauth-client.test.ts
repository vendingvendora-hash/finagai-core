/**
 * The WorkOS OAuth client prompt (ADR-089 setup, found live on 2026-10-15): an application created on the wrong
 * WorkOS page has a client ID whose secrets WorkOS rejects. The ID must not be kept; Julian re-enters it.
 */
import { describe, expect, it } from "vitest";
import type { Prompter } from "../../src/provision/io.js";
import { askOAuthClient, workosOAuthAppSteps } from "../../src/provision/oauth-client.js";
import { CLIENT_REJECTED } from "../../src/provision/providers/others.js";
import { Secret } from "../../src/provision/secret.js";

function scripted(ids: string[], secrets: string[]) {
  const asked: string[] = [];
  const p: Prompter = {
    ask: async (id) => { asked.push(id); return ids.shift()!; },
    askSecret: async (id, _q, validate) => {
      for (;;) { asked.push(id); const s = new Secret(secrets.shift()!); const problem = validate ? await validate(s) : null; if (!problem) return s; }
    },
    act: async () => {},
  };
  return { p, asked };
}
// WorkOS accepts only the Connect application's ID with its secret
const probe = async (id: string, s: Secret) => (id === "client_CONNECT" && s.reveal() === "good-secret" ? null : id === "client_CONNECT" ? "bad secret format" : CLIENT_REJECTED);

describe("askOAuthClient", () => {
  it("re-asks the client ID when WorkOS rejects the pair, and returns only an accepted pair", async () => {
    const log: string[] = [];
    const { p, asked } = scripted(["client_AUTHKITAPP", "client_CONNECT"], ["sk_authkit_key", "good-secret"]);
    const r = await askOAuthClient(p, (l) => log.push(l), { idKey: "id", secretKey: "secret", probe });
    expect(r.clientId).toBe("client_CONNECT");
    expect(r.secret.reveal()).toBe("good-secret");
    expect(asked).toEqual(["id", "secret", "id", "secret"]);
    expect(log.join("\n")).toMatch(/Connect > Applications/);
  });
  it("a stored ID that WorkOS rejects is replaced, not reused forever", async () => {
    const { p, asked } = scripted(["client_CONNECT"], ["anything", "good-secret"]);
    const r = await askOAuthClient(p, () => {}, { idKey: "id", secretKey: "secret", stored: "client_AUTHKITAPP", probe });
    expect(r.clientId).toBe("client_CONNECT");
    expect(asked).toEqual(["secret", "id", "secret"]);
  });
  it("other secret problems re-ask the secret only, and non-IDs are refused", async () => {
    const log: string[] = [];
    const { p, asked } = scripted(["not-an-id", "client_CONNECT"], ["typo", "good-secret"]);
    const r = await askOAuthClient(p, (l) => log.push(l), { idKey: "id", secretKey: "secret", probe });
    expect(r.clientId).toBe("client_CONNECT");
    expect(asked).toEqual(["id", "id", "secret", "secret"]);
    expect(log[0]).toMatch(/not a WorkOS client ID/);
  });
  it("the dashboard steps point to Connect > Applications and warn about the other Applications page", () => {
    const s = workosOAuthAppSteps("Finagai Command Center", "https://x.example/auth/callback").join("\n");
    expect(s).toMatch(/^Connect > Applications > Create application > OAuth application, named "Finagai Command Center"/);
    expect(s).toMatch(/not OAuth client secrets/);
    expect(s).toMatch(/confidential/);
    expect(s).toMatch(/Redirect URI: https:\/\/x\.example\/auth\/callback/);
  });
});
