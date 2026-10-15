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

## Production acceptance findings on hotfix 44 (2026-10-15) — fixed in hotfix 45

- **Existing production check not green (acceptance point 14).** The hourly self-check failed once, at 15:35Z, on `stateEventQuality`, and the 24 h reliability verdict became Degraded.
  - Root cause: the ontology mapped every `concierge_*` action to `task.*`. The J5 concierge's `concierge_no_draft` (and `concierge_budget_blocked`) records a decision to do nothing about a contact: it names no object and has no cause. Classified as a task state change, it failed the check.
  - Fix (Core, read path only):
    - Both actions now classify as `workflow.skipped`; nothing is written differently.
    - A structural test scans every `appendEvent` call that names no object and requires that none of them classifies as a state change.
  - Known latent item, not changed: `concierge_draft_rejected` carries no after-state. Rejecting a draft would trip the same check.
- **A Mac step waiting for Julian was invisible on Command — an ownership-contract breach (a blocker, per Julian).** Found while timing a real state change: Mac task 137 waited for his approval of step 406, yet Command could say "Nothing needs you". Needs you comes only from Core escalations, and a Mac wait never opened one.
  - Fix (Core, one ownership model, no new authority class, no change to the approval policy): every human wait a Mac task enters (`concierge/human-wait.ts`) has exactly one open escalation for that exact task or step.
    - Key: `mac:<task>:step:<step>@control_task:<id>`, or `mac:<task>:<kind>:<since>@…`. It is linked to the task, and `snapshot.needsJulian` lists it with its subject.
    - It is opened in the transaction that starts the wait. It is resolved in the transaction that ends it: approved, declined, resumed, cancelled or expired.
    - A decline opens the next wait ("direction after a no") as its own escalation.
    - The event loop re-derives the same needs from state each tick, as a safety net, with the same key. It never duplicates them.
  - `needs` follows `governance/authority.ts`:

    | Wait | `needs` |
    |---|---|
    | Step approval, `EXTERNAL_COMMITMENT` (goes out as Julian) | `principal_reserved` |
    | Step approval, any other class | `authorization` |
    | Question, loop, step limit, waiting after a "no" | `judgment` |

  - Never escalated: Finagai-owned waits (active tasks, rows outside the human-wait lifecycle) and the `budget` pause, which the budget-ceiling escalation already covers.
  - The Mac helper already prompts Julian in Messages, so these escalations are recorded as notified. They are authoritative state, not a second notification channel.
  - Command needs no special logic: the card comes from `needsJulian` like any decision. Mac task transitions also show in Live activity, titled from Core's fields, with ◆ when the unit ends waiting on Julian (spec §3.5, §14.1).
  - Proof:
    - `test/integration/mac-escalations.test.ts` covers open, deduplication, each kind of resolution, `needs` mapping, the safety net and the never-escalate cases.
    - The browser end-to-end test enters a real approval wait and checks for a Needs-you card within 2 s and no "Nothing needs you"; approving restores calm.
    - A Command unit test checks that an open Mac-approval escalation means not calm.
- **Latency.** State-bearing events other than decisions and problems now refresh the snapshot after 300 ms instead of 1 s. In production a Mac task's handling row took 2.1 s while the tab was in the background.

## Status: Command Live CLOSED (2026-10-15 17:39Z, on `cb98826`)

- All 15 Command Live criteria pass in production, along with Julian's additional checks: the 4-minute disconnect, renewal logging, callback protection, cookie flags, and Mac waits as escalations.
- Mac task 137 opened exactly one escalation at the first event-loop check. Julian's `ok 406` resolved it in the same transaction. No email was sent.
- The self-check at 17:38Z on `cb98826` passed. Reliability since the deploy is Healthy.
- The 24-hour window shows Degraded until 2026-10-16 15:35Z; that is history, and the root cause is fixed.
- The full handoff, including the matrix, deviations, limitations and the Slice 3 recommendation, is the project doc `FINAGAI_COMMAND_LIVE_HANDOFF_2026-10-15.md`. Slice 3 has not been started.

## Slice 3 — the read-only Why inspector, and activity as history (hotfix 46)

No Core change: Slice 3 uses Core's existing `/live/chain/<eventId>` and `/live/history`. The BFF allow-list gains `chain/<eventId>` (GET only, digits only).

### Activity semantics (done first, as asked)

- **One story per unit of work, phrased by how it ended, in the past tense.** The units of work (correlations) about one business object are consolidated into a single Live activity item. Examples:
  - Mac task 137's seven units now read "Mac task 137: you approved step 406; task completed — macOS version is 15.3.1 …". Before, they read as "Active", "Changed", "now your decision" and "no longer needs you".
  - A decision reads "No answer from Beth Young by 2026-10-14 — became your decision", and later "… — resolved (follow-up done)".
- **Nothing is hidden.** Every step of every unit stays in the story's expanded list. Minor fragments, such as `control_step_ran`, join their story only through a recorded business object. They never join through a shared Area, tick, inbound item or tool. Production showed this matters: no-change career syncs on the Career Area had attached themselves to Beth Young's decision.
- **History never reads as an instruction.** Instruction text that Core attached for while a decision was open ("— approve a follow-up …, give a new date, or close it", `Reply "ok 406" …`) is dropped from history. Mac waits are rephrased in the past tense ("asked for your approval"). The instruction still appears where it is current: on the Needs-you card, which comes from the snapshot.
- **◆ comes only from the authoritative snapshot.** An item carries ◆ only while `needsJulian` lists its subject. It is never inferred from an event's `nextOwner`.
- **Dating.** An item is dated, ordered and windowed by its latest significant step, which is the step its title describes. A later routine re-check does not make an old decision look new.

### Why inspector (spec §6)

- **Entry points:**
  - Review and Why? on every Needs-you card (Review also appears in the overflow list).
  - Why? on every activity item, which roots at its most significant step.
  - Why? on every expanded step.
  - Clicking an ancestor re-roots the inspector, with a breadcrumb back.
- **State lives in the URL.**
  - `?why=<eventId>` or `?why=<type>:<id>`. An object resolves to its latest event through `/live/history?entityType&entityId&order=desc&limit=1`.
  - Deep links survive sign-in. The BFF keeps only a same-origin `/?<plain query>` return address in a short-lived HttpOnly cookie, so it cannot be an open redirect.
  - Browser back closes the inspector or steps back through re-roots. Esc closes it and returns focus to where it was opened.
- **"How it got here" is exactly Core's chain:** the root and every recorded ancestor, by id, each line with an event id behind it.
  - A cause that an event cites but the chain lacks is shown as missing: "An earlier cause was recorded but isn't available — it is older than Finagai keeps, or further back than the explanation follows". It is never filled in.
  - A recorded starting point says "Started here".
  - Lines may rephrase recorded classes (the `workflow.invoked` triggers become "Finagai's regular 5-minute check ran", "The Mac helper passed on your reply"), but they never add a step.
- **What else it shows:**
  - before → after;
  - evidence (the chain's `evidence` events);
  - the owner now, from the snapshot only (needs, waits, tasks, problems). Otherwise "Nothing about this is open now", plus what was true when it was recorded;
  - "Finagai can / Only you can" while a decision is open. Spec §6.4 copy now covers `mac:` keys;
  - authorization (passkey), verification, confidence and provenance, each shown only when present.
- Event, sequence and correlation ids appear only under "Technical details", which is closed by default.
- **Not shown: consequences.** Core has no `/live/consequences` (D2c), and none is inferred. The inspector says "What happened after this step isn't shown yet."
- **Layout:** a 480 px right panel below the top bar, so connection and health stay visible. On mobile (≤ 900 px) it is a full-screen sheet. Its 180 ms open is the only motion, and it happens on Julian's action.
- **Read-only:** two GETs, and no actions (no approve, reject or close). Internal-testing events stay in a chain (it is Core's chain) with their content withheld.

### Proof

- **Unit tests:** stories built from the production event sequence for task 137 (2671–2717), decline → cancel, decision lifecycle, instruction stripping, Area-only linkage, and ◆ only from the snapshot. Inspector model tests cover the exact chain, missing causes, internal redaction, ownership from the snapshot only, record facts, the loader making two GETs, and failure states.
- **BFF integration:** `/api/live/chain/<id>` equals `causalChain` and other paths stay 404. A deep link survives sign-in, and hostile return addresses land on `/`.
- **Browser end-to-end:**
  - Review opens the inspector rooted at the decision's latest event, and the chain equals Core's and the BFF's.
  - Technical details stay hidden until opened. Re-rooting, the breadcrumb, Esc with focus return, and back all work.
  - Activity Why? roots at the item.
  - After resolution, the item is past tense with no ◆, and the inspector says nothing is open.
  - Twenty random events each show exactly Core's chain.
  - A depth-9 chain and a cause outside retention show as missing, and an object deep link resolves.
  - Mobile is full-screen.
  - Throughout, the page makes only GETs, and no business row, event or stream entry changes.

### Governance note (recorded; not changed in Slice 3)

- **Finding:** Mac task 137's `sw_vers -productVersion` needed Julian's approval as `HIGH_RISK`. Two classifications of the same step disagree:
  - `isReadOnlyCommand` (j6/control.ts) marks it `risk: read`;
  - `governance/authority.ts` classifies every `run` as `HIGH_RISK`, because `run` ∈ `HIGH`.
- **Proposal, before Mac autonomy is broadened.** This is a proposal for Julian's approval. Nothing changes ad hoc.
  1. **One effect-based classifier for `run`, used by both paths.** The command is parsed into argv with no shell. It must name an allow-listed program with an allow-listed argument grammar: no metacharacters, no redirection, no interpreters (`sh`, `python`, `osascript`), no network clients, no package managers, no write flags.
  2. **Effect tiers.** R0, system metadata with no user content (`sw_vers`, `uname`, `date`, `uptime`, `whoami`, `df`, `pwd`) → `OBSERVE` (automatic). R1, reads user content on unprotected user paths (`ls`, `stat`, `cat`, `head`, `grep`, `mdfind`, `mdls`) → `OBSERVE` only inside an active principal envelope. Otherwise ask. Everything else → `HIGH_RISK`, as today.
  3. **Helper enforcement.** The Mac helper runs an R0/R1 command with `execFile` (no shell) under a sandbox profile that denies file writes and network, with a timeout and an output cap. If the helper cannot enforce this, the class falls back to `HIGH_RISK`.
  4. **Shadow first.** For N days, record what the new classifier would have decided next to the current decision. Report the approvals it would have saved and every disagreement, then switch only on Julian's explicit approval.
  5. **Tests:** a table of allowed and refused commands, including adversarial ones: `sw_vers && rm -rf ~`, `$(…)`, `~/.finagai`, `/etc/passwd`, `../`, `cat ~/Library/Keychains/…`.
