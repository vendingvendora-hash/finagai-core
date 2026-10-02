# ADR-035: M3 and J2 implementation choices

- **Date:** 2026-10-01 · **Status:** decided · **Category:** reversible technical choices

1. **Token verification uses `jose`**: JWKS fetched from `OAUTH_JWKS_URL`; asymmetric algorithms only (RS256, ES256, EdDSA); issuer, exact audience (the MCP resource URL), expiry with 60 s tolerance, and subject equal to `PRINCIPAL_SUBJECT`. Claude's client ID is logged until pinned via `ALLOWED_MCP_CLIENT_IDS`. Core depends on no WorkOS-specific API (ADR-029).
2. **Authentication paths are separated**: `/mcp` accepts only bearer tokens and refuses approval cookies; `/approve/*` accepts only the HMAC-signed `SameSite=Strict` session cookie and refuses any `Authorization` header.
3. **WebAuthn uses `@simplewebauthn/server`** for all cryptography (origin, RP ID, user verification, signature, counter). Core implements only policy: principal, credential ownership and revocation, request status and expiry, nonce and content-hash match, challenge binding, single use and TTL, and counter classification. Synced passkeys reporting a 0 counter are accepted; any other non-increasing counter is rejected as a possible clone. Tests use a test-only software authenticator against the real library; production code has no custom WebAuthn cryptography.
4. **G09 redacts before the model**: J2 step 1 redacts Prohibited and Highly Sensitive patterns, and the model sees only redacted text. Quotes must match the redacted text (G01), so no accepted candidate can carry a secret; quotes containing a redaction marker are rejected.
5. **Project resolution (G10) is exact-match only**, accent- and case-insensitive on names and aliases; anything else goes to Unassigned rather than being guessed.
