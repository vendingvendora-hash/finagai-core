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
- **Setup fix (found live on 2026-10-15).** WorkOS has two pages called "Applications":
  - The sidebar's page holds AuthKit applications. Their API keys are not OAuth client secrets.
  - **Connect > Applications** holds OAuth clients. This is the one that works.

  The setup steps now name Connect explicitly. The client ID and secret are asked as a pair, and the ID is kept only once WorkOS accepts the pair (`src/provision/oauth-client.ts`). A client created in the wrong place can now be replaced without editing the state file.
- **Spike page:** `/spike.html`, signed-in only, read-only. It shows the snapshot, live events with their latency, resume after a simulated 20 s interruption, and a scan for token-like strings visible to JavaScript.

## Slice 2 — Command (wireframes A and B)

- **One store, Core as the only truth** (`command/web/src/live/store.ts`).
  - The snapshot is replaced whole and never patched from events. A snapshot at an older cursor never replaces a newer one.
  - Events are kept for the activity rail only: deduplicated by event id, applied once (`seq ≤ lastSeq` is dropped), and capped at 2,000.
  - State-bearing events schedule a snapshot read. Decisions and problems (`escalation`, `exception`, `approval`, `authority`) refresh after 150 ms, to meet the spec's 2 s target. Everything else coalesces for 1 s.
- **Stream reader: fetch, not EventSource.** EventSource hides Core's heartbeat comments, and the UI needs them to tell "quiet" from "dead". Fetch also lets the UI control the resume cursor and the backoff.
- **Connection states (spec §3.6).**
  - `Reconnecting…` on an error or after 30 s without any byte.
  - `Offline since HH:MM` after 60 s, with the stale banner. The Needs-you count reads "as of" and relative times switch to absolute ones.
  - On resume, the UI shows `Caught up — N changes while disconnected` for 8 s, adds a gap marker in the activity rail, and refreshes the snapshot once.
  - A stream that Core ends cleanly after its maximum duration resumes at once, without a reconnecting state.
- **Command derivation** (`model/command.ts`) is pure and computes no business verdict. Area colours, wait owners and the reliability verdict all come from Core.
  - Needs you comes only from `needsJulian` (open escalations).
  - Below the ownership line: waits whose `owner` is Finagai, active Mac tasks, Finagai-owned problems at warning or above, armed rules, and the last check.
  - Finagai's internal Area is excluded everywhere.
- **Live activity** (`model/units.ts`). Events are grouped by `cause.correlationId` and titled by the most significant event (spec §3.5).
  - The §14.2 hidden set, canary units and internal-Area units are dropped. "Everything" is available only with `?diag`.
- **Motion.** A card fades in only when its own `escalation.opened` arrived over the live stream. An activity unit slides in only when every event in it arrived live.
  - Nothing else animates, and nothing animates under `prefers-reduced-motion`.
  - A settled page has no running animations (`document.getAnimations()` is empty).
- **Proof** (`test/integration/command-center-ui.test.ts`) uses headless Chromium against the real Core handler, the BFF and the built app:
  - **Calm state:** at most three sentences, no zero rows, and nothing from the internal Area, canary or low-value traffic. The UI writes zero business rows and zero events.
  - **A decision raised by the engine** appears in under 2 s, with the card, the count, the rail ◆ and an activity unit. It sits above the ownership line.
  - **Interruption:** 72 s, covering reconnecting → offline/stale → resume. Every missed event is present exactly once, and the fresh snapshot shows the resolution.
  - **A clean stream end** resumes silently.
  - **Mobile at 390×844:** the spec's order and no horizontal scroll.
  - **Tokens:** no token in cookies, storage, IndexedDB, the DOM, URLs or response bodies, and the session cookie is HttpOnly.
  - Model and stream unit tests are in `command/test/unit`.
- **Deviations from the spec in this milestone** (all later slices or not needed yet):
  - No command bar (slice 10).
  - No Review / Why? buttons on cards (slice 3).
  - No mobile tab bar (only Command exists).
  - No "All Areas" or "Earlier" links (slices 4 and 5).
  - Between 900 and 1180 px the three columns narrow instead of the activity rail becoming a drawer.
  - The reset state shows "Loading Finagai's state…" instead of "Reloading…".

## Production acceptance findings (2026-10-15) — fixed in hotfix 44

- **Canary decision in Live activity (acceptance point 5).**
  - Seen: a canary judgment opened before hotfix 41 recorded an Area on decisions. Its later resolution had no Area and showed as "Career: ADR088-CANARY… — no longer needs you".
  - Root cause: the client dropped only units whose events carried the internal Area.
  - Fix: a pure linkage computed from the events (`internalLinks`).
    - Objects an internal-Area event touched are internal, and so is everything about them (a decision whose key names one as its subject, and its resolution).
    - Each event is classified on its own. A run that did both real and test work shows only its outcomes on real objects; its run-wide summaries, which list both, are dropped.
    - A canary run stays internal from start to finish.
    - The same links exclude such decisions and waits from Needs you and Finagai is handling.
  - The client keeps 24 h of events as context and shows 12 h.
- **False "Finagai's checks stopped" (correctness).**
  - Root cause: a quiet check writes no event; it only moves `eventLoopLastTick`. The client re-read the snapshot only when events arrived, so after 15 quiet minutes it would have claimed the checks had stopped and shown Degraded.
  - Fix: while live and visible, the snapshot and the reliability report are re-read every 60 s and when the tab returns to view. While disconnected the snapshot is left "as of" the disconnect.
  - "Stopped" is claimed only from a snapshot read in the last 2 minutes.
- **Token renewal is now observable.** The BFF logs `access renewed` with timings and whether the refresh token rotated, and `renewal failed; session ended` with the reason. No token is ever logged.
- **Core-side gap (classified B, not built).** Decision rows created before hotfix 41 have no Area, so their events carry none. The envelope could derive an Area from the decision's subject. The client linkage covers this, and new rows are correct.
