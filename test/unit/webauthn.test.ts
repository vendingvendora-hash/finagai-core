/**
 * ADR-030 policy tests. Assertions are produced by a minimal SOFTWARE AUTHENTICATOR defined here,
 * in test code only, and verified by the real @simplewebauthn/server library: production code
 * contains no custom WebAuthn cryptography.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { SoftwareAuthenticator } from "../helpers/authenticator.js";
import {
  computeApprovalChallenge, evaluateSignCounter, hashChallenge, verifyGovernanceApproval,
  type ApprovalInput, type StoredCredential, type StagedRequest,
} from "../../src/approval/webauthn.js";

const ORIGIN = "https://core.example.test";
const RP_ID = "core.example.test";
const PRINCIPAL = "user_julian_test";

/** Adapter: the shared helper takes origin and RP ID explicitly. */
class Device {
  readonly inner: SoftwareAuthenticator;
  constructor(counter = 0, synced = false) { this.inner = new SoftwareAuthenticator(counter, synced); }
  get credentialId() { return this.inner.credentialId; }
  get cosePublicKey() { return this.inner.cosePublicKey; }
  get counter() { return this.inner.counter; }
  assert(challenge: string, opts: { origin?: string; rpId?: string; userVerified?: boolean; counter?: number } = {}) {
    return this.inner.assert(challenge, opts.origin ?? ORIGIN, opts.rpId ?? RP_ID, opts);
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NOW = new Date("2026-10-01T12:00:00Z");
const nonce = "nonce-abc";
const contentHash = sha("before+after as displayed");
const ceremonyRandom = Buffer.alloc(32, 7);
const challenge = computeApprovalChallenge("req-1", nonce, contentHash, ceremonyRandom);

let device: Device;
const credential = (over: Partial<StoredCredential> = {}): StoredCredential => ({
  id: "cred-uuid-1", credentialId: device.credentialId, publicKey: device.cosePublicKey, signCount: 0,
  transports: ["internal"], principalSubject: PRINCIPAL, revokedAt: null, ...over,
});
const request = (over: Partial<StagedRequest> = {}): StagedRequest => ({
  id: "req-1", status: "pending", expiresAt: new Date(NOW.getTime() + 3_600_000), nonce, nonceHash: sha(nonce), contentHash,
  challengeHash: hashChallenge(challenge), challengeExpiresAt: new Date(NOW.getTime() + 60_000), challengeUsedAt: null, ...over,
});
const input = (over: Partial<ApprovalInput> = {}): ApprovalInput => ({
  sessionSubject: PRINCIPAL, principalSubject: PRINCIPAL, request: request(), displayedContentHash: contentHash, challenge,
  credential: credential(), response: device.assert(challenge), expectedOrigin: ORIGIN, expectedRPID: RP_ID, now: NOW, ...over,
});

beforeAll(() => { device = new Device(); });

describe("ADR-030 approval verification (real library, software authenticator)", () => {
  it("accepts a fresh, user-verified assertion bound to this request", async () => {
    const v = await verifyGovernanceApproval(input());
    expect(v).toEqual({ ok: true, newSignCount: device.counter, credentialId: "cred-uuid-1" });
  });

  it("binds the challenge to request ID, nonce, and content hash", () => {
    const variants = [
      computeApprovalChallenge("req-2", nonce, contentHash, ceremonyRandom),
      computeApprovalChallenge("req-1", "other-nonce", contentHash, ceremonyRandom),
      computeApprovalChallenge("req-1", nonce, sha("different content"), ceremonyRandom),
      computeApprovalChallenge("req-1", nonce, contentHash, Buffer.alloc(32, 8)),
    ];
    expect(new Set([challenge, ...variants]).size).toBe(5);
  });

  const cases: Array<[string, () => Partial<ApprovalInput>, string]> = [
    ["a session for another user", () => ({ sessionSubject: "user_other" }), "not_principal"],
    ["a credential owned by another principal", () => ({ credential: credential({ principalSubject: "user_other" }) }), "credential_not_owned"],
    ["a revoked credential", () => ({ credential: credential({ revokedAt: NOW }) }), "credential_revoked"],
    ["a request that is no longer pending", () => ({ request: request({ status: "approved" }) }), "request_not_pending"],
    ["an expired request", () => ({ request: request({ expiresAt: new Date(NOW.getTime() - 1) }) }), "request_expired"],
    ["content that changed after display", () => ({ displayedContentHash: sha("what Claude wanted shown") }), "content_changed"],
    ["a reused challenge", () => ({ request: request({ challengeUsedAt: NOW }) }), "challenge_reused"],
    ["an expired challenge", () => ({ request: request({ challengeExpiresAt: new Date(NOW.getTime() - 1) }) }), "challenge_expired"],
    ["a challenge for a different request", () => {
      const other = computeApprovalChallenge("req-2", nonce, contentHash, ceremonyRandom);
      return { challenge: other, response: device.assert(other) };
    }, "challenge_mismatch"],
    ["an assertion signed for a different challenge", () => ({ response: device.assert("some-other-challenge") }), "assertion_invalid"],
    ["the wrong origin", () => ({ response: device.assert(challenge, { origin: "https://evil.example.test" }) }), "assertion_invalid"],
    ["the wrong RP ID", () => ({ response: device.assert(challenge, { rpId: "evil.example.test" }) }), "assertion_invalid"],
    ["no user verification", () => ({ response: device.assert(challenge, { userVerified: false }) }), "assertion_invalid"],
  ];
  for (const [name, over, reason] of cases) {
    it(`rejects ${name}`, async () => {
      expect(await verifyGovernanceApproval(input(over()))).toEqual({ ok: false, reason });
    });
  }

  it("rejects a credential whose public key does not match the signer", async () => {
    const impostor = new Device();
    expect(await verifyGovernanceApproval(input({ credential: credential({ publicKey: impostor.cosePublicKey }) })))
      .toEqual({ ok: false, reason: "assertion_invalid" });
  });
});

describe("sign-counter semantics", () => {
  it("accepts synced passkeys that always report 0", async () => {
    const synced = new Device(0, true);
    const v = await verifyGovernanceApproval(input({
      credential: { ...credential(), credentialId: synced.credentialId, publicKey: synced.cosePublicKey, signCount: 0 },
      response: synced.assert(challenge),
    }));
    expect(v).toMatchObject({ ok: true, newSignCount: 0 });
  });

  it("rejects a non-increasing counter as a possible cloned authenticator", async () => {
    const v = await verifyGovernanceApproval(input({
      credential: credential({ signCount: 50 }), response: device.assert(challenge, { counter: 50 }),
    }));
    expect(v).toEqual({ ok: false, reason: "counter_regression" });
  });

  it("evaluates counters per WebAuthn: 0/0 ok, increase ok, otherwise regression", () => {
    expect(evaluateSignCounter(0, 0)).toEqual({ ok: true, next: 0 });
    expect(evaluateSignCounter(5, 6)).toEqual({ ok: true, next: 6 });
    expect(evaluateSignCounter(5, 5).ok).toBe(false);
    expect(evaluateSignCounter(5, 0).ok).toBe(false);
  });
});
