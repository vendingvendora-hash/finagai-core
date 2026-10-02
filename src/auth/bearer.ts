/**
 * M3: access-token verification for /mcp (ADR-029). Provider-neutral: depends only on standard
 * OAuth/OIDC artifacts (issuer, JWKS, audience, subject) via the `jose` library.
 *
 * A token is accepted only if ALL hold:
 *   signature valid under the issuer's JWKS, with an asymmetric algorithm (RS256 / ES256 / EdDSA)
 *   iss === OAUTH_ISSUER
 *   aud contains FINAGAI_MCP_RESOURCE_URL exactly (RFC 8707 resource indicator)
 *   exp in the future, nbf/iat not in the future (60 s clock tolerance)
 *   sub === PRINCIPAL_SUBJECT (Julian is the only principal, ADR-003)
 *   client_id/azp in the pinned allow-list, when one is configured
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface BearerPolicy {
  issuer: string;
  audience: string;
  principalSubject: string;
  /** Empty means "not pinned yet": the observed client ID is logged so it can be pinned (M3 step). */
  allowedClientIds: readonly string[];
  keys: JWTVerifyGetKey;
}

export interface VerifiedPrincipal {
  subject: string;
  clientId: string | null;
  expiresAt: Date;
}

export type AuthFailure =
  | "missing_token" | "malformed_token" | "invalid_signature" | "wrong_issuer" | "wrong_audience"
  | "expired" | "not_yet_valid" | "wrong_subject" | "client_not_allowed" | "keys_unavailable";

export class AuthError extends Error {
  constructor(readonly code: AuthFailure) {
    super(code);
  }
}

const ALGORITHMS = ["RS256", "ES256", "EdDSA"];

export function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
}

export function extractBearer(header: string | undefined): string {
  if (!header) throw new AuthError("missing_token");
  const m = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(header.trim());
  if (!m?.[1]) throw new AuthError("malformed_token");
  return m[1];
}

export async function verifyAccessToken(token: string, policy: BearerPolicy): Promise<VerifiedPrincipal> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, policy.keys, {
      issuer: policy.issuer,
      audience: policy.audience,
      algorithms: ALGORITHMS,
      clockTolerance: 60,
      requiredClaims: ["exp", "sub"],
    }));
  } catch (err) {
    throw new AuthError(mapJoseError(err));
  }
  if (payload.sub !== policy.principalSubject) throw new AuthError("wrong_subject");
  const clientId = typeof payload.client_id === "string" ? payload.client_id
    : typeof payload.azp === "string" ? payload.azp : null;
  if (policy.allowedClientIds.length > 0 && (!clientId || !policy.allowedClientIds.includes(clientId))) {
    throw new AuthError("client_not_allowed");
  }
  return { subject: payload.sub, clientId, expiresAt: new Date((payload.exp ?? 0) * 1000) };
}

function mapJoseError(err: unknown): AuthFailure {
  if (err instanceof errors.JWTExpired) return "expired";
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === "iss") return "wrong_issuer";
    if (err.claim === "aud") return "wrong_audience";
    if (err.claim === "nbf" || err.claim === "iat") return "not_yet_valid";
    return "malformed_token";
  }
  if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWSSignatureVerificationFailed) return "invalid_signature";
  if (err instanceof errors.JOSEAlgNotAllowed) return "invalid_signature";
  if (err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid) return "keys_unavailable";
  return "malformed_token";
}
