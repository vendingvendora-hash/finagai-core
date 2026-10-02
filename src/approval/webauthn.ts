/**
 * ADR-030 approval verification. Cryptography is delegated entirely to @simplewebauthn/server;
 * Core owns policy: who may approve, which request the signature is bound to, freshness,
 * single use, counter handling, and the order of checks.
 *
 * Key custody: Julian's authenticator holds the private key. Core stores and uses only public
 * verification data (credential ID, public key, sign counter, transports, principal link).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthenticationResponseJSON, VerifiedAuthenticationResponse } from "@simplewebauthn/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

export const CHALLENGE_TTL_MS = 5 * 60_000;

/** challenge = SHA-256("finagai-approval-v1" || request_id || nonce || content_hash || ceremony_random) */
export function computeApprovalChallenge(requestId: string, nonce: string, contentHash: string, ceremonyRandom: Buffer): string {
  const h = createHash("sha256");
  for (const part of ["finagai-approval-v1", requestId, nonce, contentHash]) h.update(part).update("\u0000");
  h.update(ceremonyRandom);
  return h.digest("base64url");
}

export function newCeremonyRandom(): Buffer {
  return randomBytes(32);
}

export const hashChallenge = (challenge: string) => createHash("sha256").update(challenge).digest("hex");

/**
 * WebAuthn sign-counter semantics (WebAuthn Level 3, section 6.1.1). Synced (multi-device) passkeys
 * commonly report 0 forever; that is valid and carries no clone signal. Otherwise the counter must
 * strictly increase; a non-increasing counter means a possible cloned authenticator.
 */
export type CounterVerdict = { ok: true; next: number } | { ok: false; reason: "counter_regression" };

export function evaluateSignCounter(stored: number, received: number): CounterVerdict {
  if (stored === 0 && received === 0) return { ok: true, next: 0 };
  if (received > stored) return { ok: true, next: received };
  return { ok: false, reason: "counter_regression" };
}

export interface StoredCredential {
  id: string;               // internal UUID (governance_request.approval_credential_id)
  credentialId: string;     // base64url WebAuthn credential ID
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
  principalSubject: string;
  revokedAt: Date | null;
}

export interface StagedRequest {
  id: string;
  status: string;
  expiresAt: Date;
  nonce: string;            // raw nonce held only in the page flow; Core stores its hash
  nonceHash: string;
  contentHash: string;
  challengeHash: string | null;
  challengeExpiresAt: Date | null;
  challengeUsedAt: Date | null;
}

export interface ApprovalInput {
  sessionSubject: string;           // from the verified approval-page session cookie
  principalSubject: string;         // configured PRINCIPAL_SUBJECT
  request: StagedRequest;
  displayedContentHash: string;     // hash of what the page showed Julian
  challenge: string;                // recomputed server-side from the stored ceremony random
  credential: StoredCredential;
  response: AuthenticationResponseJSON;
  expectedOrigin: string;
  expectedRPID: string;
  now: Date;
}

export type ApprovalFailure =
  | "not_principal" | "credential_not_owned" | "credential_revoked" | "credential_mismatch"
  | "request_not_pending" | "request_expired" | "nonce_mismatch" | "content_changed"
  | "challenge_missing" | "challenge_expired" | "challenge_reused" | "challenge_mismatch"
  | "assertion_invalid" | "user_not_verified" | "counter_regression";

export type ApprovalVerdict =
  | { ok: true; newSignCount: number; credentialId: string }
  | { ok: false; reason: ApprovalFailure };

type Verifier = typeof verifyAuthenticationResponse;

const eqHex = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/**
 * Policy checks in a fixed order; every check must pass before Core executes anything.
 * Record-version re-checks and the atomic execution happen in the executor's transaction (M5),
 * after this verdict.
 */
export async function verifyGovernanceApproval(input: ApprovalInput, verifier: Verifier = verifyAuthenticationResponse): Promise<ApprovalVerdict> {
  const { request: r, credential: c, now } = input;
  const fail = (reason: ApprovalFailure): ApprovalVerdict => ({ ok: false, reason });

  if (input.sessionSubject !== input.principalSubject) return fail("not_principal");
  if (c.principalSubject !== input.principalSubject) return fail("credential_not_owned");
  if (c.revokedAt) return fail("credential_revoked");
  if (input.response.id !== c.credentialId) return fail("credential_mismatch");

  if (r.status !== "pending") return fail("request_not_pending");
  if (r.expiresAt.getTime() <= now.getTime()) return fail("request_expired");
  if (!eqHex(createHash("sha256").update(r.nonce).digest("hex"), r.nonceHash)) return fail("nonce_mismatch");
  if (!eqHex(input.displayedContentHash, r.contentHash)) return fail("content_changed");

  if (!r.challengeHash || !r.challengeExpiresAt) return fail("challenge_missing");
  if (r.challengeUsedAt) return fail("challenge_reused");
  if (r.challengeExpiresAt.getTime() <= now.getTime()) return fail("challenge_expired");
  if (!eqHex(hashChallenge(input.challenge), r.challengeHash)) return fail("challenge_mismatch");

  let result: VerifiedAuthenticationResponse;
  try {
    result = await verifier({
      response: input.response,
      expectedChallenge: input.challenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRPID,
      requireUserVerification: true,
      credential: { id: c.credentialId, publicKey: c.publicKey as never, counter: c.signCount, transports: c.transports as never },
    });
  } catch (err) {
    // The library rejects a non-increasing counter itself; classify it for Julian's alert.
    if (err instanceof Error && /counter/i.test(err.message)) return fail("counter_regression");
    return fail("assertion_invalid");
  }
  if (!result.verified) return fail("assertion_invalid");
  if (!result.authenticationInfo.userVerified) return fail("user_not_verified");

  const counter = evaluateSignCounter(c.signCount, result.authenticationInfo.newCounter);
  if (!counter.ok) return fail("counter_regression");
  return { ok: true, newSignCount: counter.next, credentialId: c.id };
}
