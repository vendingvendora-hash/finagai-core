/**
 * ADR-030 approval verification. Cryptography is delegated entirely to @simplewebauthn/server;
 * Core owns policy: who may approve, which request the signature is bound to, freshness,
 * single use, counter handling, and the order of checks.
 *
 * Key custody: Julian's authenticator holds the private key. Core stores and uses only public
 * verification data (credential ID, public key, sign counter, transports, principal link).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** challenge = SHA-256("finagai-approval-v1" || request_id || nonce || content_hash || ceremony_random) */
export function computeApprovalChallenge(requestId, nonce, contentHash, ceremonyRandom) {
    const h = createHash("sha256");
    for (const part of ["finagai-approval-v1", requestId, nonce, contentHash])
        h.update(part).update("\u0000");
    h.update(ceremonyRandom);
    return h.digest("base64url");
}
export function newCeremonyRandom() {
    return randomBytes(32);
}
export const hashChallenge = (challenge) => createHash("sha256").update(challenge).digest("hex");
export function evaluateSignCounter(stored, received) {
    if (stored === 0 && received === 0)
        return { ok: true, next: 0 };
    if (received > stored)
        return { ok: true, next: received };
    return { ok: false, reason: "counter_regression" };
}
const eqHex = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
/**
 * Policy checks in a fixed order; every check must pass before Core executes anything.
 * Record-version re-checks and the atomic execution happen in the executor's transaction (M5),
 * after this verdict.
 */
export async function verifyGovernanceApproval(input, verifier = verifyAuthenticationResponse) {
    const { request: r, credential: c, now } = input;
    const fail = (reason) => ({ ok: false, reason });
    if (input.sessionSubject !== input.principalSubject)
        return fail("not_principal");
    if (c.principalSubject !== input.principalSubject)
        return fail("credential_not_owned");
    if (c.revokedAt)
        return fail("credential_revoked");
    if (input.response.id !== c.credentialId)
        return fail("credential_mismatch");
    if (r.status !== "pending")
        return fail("request_not_pending");
    if (r.expiresAt.getTime() <= now.getTime())
        return fail("request_expired");
    if (!eqHex(createHash("sha256").update(r.nonce).digest("hex"), r.nonceHash))
        return fail("nonce_mismatch");
    if (!eqHex(input.displayedContentHash, r.contentHash))
        return fail("content_changed");
    if (!r.challengeHash || !r.challengeExpiresAt)
        return fail("challenge_missing");
    if (r.challengeUsedAt)
        return fail("challenge_reused");
    if (r.challengeExpiresAt.getTime() <= now.getTime())
        return fail("challenge_expired");
    if (!eqHex(hashChallenge(input.challenge), r.challengeHash))
        return fail("challenge_mismatch");
    let result;
    try {
        result = await verifier({
            response: input.response,
            expectedChallenge: input.challenge,
            expectedOrigin: input.expectedOrigin,
            expectedRPID: input.expectedRPID,
            requireUserVerification: true,
            credential: { id: c.credentialId, publicKey: c.publicKey, counter: c.signCount, transports: c.transports },
        });
    }
    catch (err) {
        // The library rejects a non-increasing counter itself; classify it for Julian's alert.
        if (err instanceof Error && /counter/i.test(err.message))
            return fail("counter_regression");
        return fail("assertion_invalid");
    }
    if (!result.verified)
        return fail("assertion_invalid");
    if (!result.authenticationInfo.userVerified)
        return fail("user_not_verified");
    const counter = evaluateSignCounter(c.signCount, result.authenticationInfo.newCounter);
    if (!counter.ok)
        return fail("counter_regression");
    return { ok: true, newSignCount: counter.next, credentialId: c.id };
}
//# sourceMappingURL=webauthn.js.map