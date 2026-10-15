# ADR-089 — Finagai Command Center ("Command Live" milestone: slices 0–2)

Status: Accepted (Julian approved VISUAL PRODUCT SPEC v1 on 2026-10-15). In progress.
Authority: `FINAGAI_COMMAND_CENTER_VISUAL_SPEC_v1.md` (project doc) is the product specification. This ADR records only
implementation decisions and deviations.

## Slice 0 — read-only Core enablement (additive, GET-only, no new store, no semantic change)
- **Snapshot (contract v2, additive)**:
  - `areas[].internal` is true for Finagai Test, so the UI never matches it by name.
  - `areas[].health` is the Area's verdict `{color, breaches, warnings}`. It comes from `areaStatusRead`, the same computation as `area_status` but without the overdue sweep, because a read must not write.
  - `waits[].owner` is derived by the engine's own rule: `julian` when the lifecycle rule is in `RULE_NEEDS` or the wait has an open escalation; otherwise `finagai`. Follow-ups have no owner column; ownership has always been derived.
  - `waits[].escalated` and `waits[].project_id`.
  - `needsJulian[].followup_id`, `created_at`, and `subject {type,id}`. The subject is parsed from the escalation key's `@type:id` suffix, or falls back to the follow-up.
- **History**:
  - Filters (area, class, entityType, entityId) now apply before the limit, using a bounded paged scan. Before this, a filtered read returned only the matches among the first 500 rows of all history.
  - `order=desc` with `before=<eventId>` (and `after=`) pages newest-first.
  - The cursor is the event id, not the stream seq, because history covers events older than the 30-day stream window.
- **`GET /live/summary/reliability?days|since`** serves the existing Phase 8 report. It is SELECT-only.
- **Proof** (`test/integration/command-center-reads.test.ts`):
  - 10 rounds of reads over every endpoint, including the stream, add 0 rows to `event`.
  - They change no business row: a fingerprint of 13 tables is identical before and after.
  - An overdue-but-unswept wait stays unswept.
  - `publish()` (the existing stream index) is unchanged behavior.
- **Not built in this milestone:**
  - the remaining D2a summaries (brief, area detail, failures, pipeline), the consequences endpoint (D2c), and the D3 Map fields (objective links, lesson freshness). They belong to slices 3+.

## Slice 1 — BFF (`command/`, Render service `finagai-command`)
- **Sign-in** uses OIDC authorization code + PKCE with Finagai's existing identity provider (WorkOS AuthKit), as a second confidential client next to the approval page.
  - It requests `resource = FINAGAI_MCP_RESOURCE_URL`, the audience Core already verifies.
  - Core's bearer rules are unchanged: issuer, audience, `sub = PRINCIPAL_SUBJECT`, and the client allow-list when it is pinned.
- **Fail closed.** No session is created unless all of these hold:
  - the ID token is for this client, carries our nonce, and names Julian;
  - the access token is a JWT that verifies against the provider's keys;
  - it comes from the same issuer, names Julian, and has Core's resource in its audience.
  The refusal page names the exact reason. The SPA never receives a Core token as a fallback.
- **Sessions** are in BFF memory, keyed by a random id held in a `__Host-` cookie that is HttpOnly, Secure, and `SameSite=Lax`.
  - Core access and refresh tokens never leave the BFF process: they are not in JS, the DOM, URLs, browser storage, or response bodies.
  - A BFF restart ends sessions, and Julian signs in again.
- **Deviation from spec §15 (SameSite=Strict → Lax).** The sign-in callback is a top-level redirect from the identity provider, and a Strict cookie is not sent on that redirect chain, so sign-in would loop. The BFF has no state-changing GET, and its only POST (logout) checks `Origin`.
- **Proxy.**
  - Only GET is allowed, only to `/live/{contract,snapshot,events,history,stream,summary/reliability}`.
  - SSE passes through byte for byte, unbuffered: no compression, `no-transform`, `x-accel-buffering: no`.
  - `Last-Event-ID` is forwarded.
  - On a Core 401 the BFF refreshes the token once, then answers `signed_out`.
- **Static app.** It is served only to a signed-in session; everyone else is redirected to `/auth/login`. CSP is strict: `'self'` only, with no inline script or style.
- **Proof** (`test/integration/command-center-bff.test.ts`), against the real Core HTTP handler and a stand-in provider:
  - Sign-in works, and signed-out requests get nothing.
  - Events arrive in under 2.5 s while the stream is open (Core polls every 100 ms in the test, 1 s in production).
  - `Last-Event-ID` resume delivers exactly the missed events, once each.
  - The token refreshes server-side.
  - No token appears in any body, header, or cookie the browser receives.
  - It fails closed on: no Core audience, the wrong account, and a client missing from Core's allow-list.
- **Setup:** `npm run provision:command` on Julian's machine.
  - It creates the Render service and asks Julian to create the WorkOS application (a dashboard step).
  - It sets the service's settings and adds the client to Core's allow-list if Core pins clients.
  - It deploys and checks `/healthz`.
- **Spike page:** `/spike.html`, signed-in only, read-only. It shows the snapshot, live events with their latency, resume after a simulated 20 s interruption, and a scan for token-like strings visible to JavaScript.
