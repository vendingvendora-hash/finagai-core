# ADR-087 — Live State / Visualization Contract (prerequisite to Phase 8)

Status: Decided (builder, under Julian's 2026-10-11 requirement)
Date: 2026-10-11

## Context
Julian (2026-10-11): Finagai is meant to become his persistent virtual self. He must eventually be able to watch it
operate and evolve in real time: what it knows, learns, infers, owns, watches, does, fails at and recovers from, and
what it needs from him. A visual Command Center will come later. Before Phase 8, the platform must be
**visualization-ready**:
- Every meaningful state transition is durably observable through one general Live State Stream, across all Areas.
- Movement in the future UI corresponds to real events, never decorative motion.
- There is one source of truth.
- Viewing is read-only.

Phase 8's reliability and observability must build on the same foundation.

## Decision
**One source of truth.** The append-only `event` table (AR05; every change already writes it in the same transaction)
*is* the semantic history. It is extended, not duplicated:
- `event` gains `correlation_id` (one unit of work), `cause_ids` (the events that directly caused it) and `area_id`.
  There are no foreign keys, because events are immutable.
- `live_event(seq, event_id)` is only an **ordering index**. It assigns a commit-ordered, gap-free stream cursor to
  events as they become visible.

  This is needed because identity ids are allocated at insert, not at commit: a long transaction can make a *lower* id
  visible *after* a higher one, and a cursor over raw ids would silently skip it. A single publisher (advisory lock)
  inserts newly visible events within a 20,000-id late-commit window.
- Retention is a 30-day **read window**: positions older than 30 days cannot be resumed from. Nothing is ever deleted; the app role stays archive-only (see the 2026-10-11 deploy fix below).

**Causal context without touching every call site.** `withCause()` (AsyncLocalStorage) carries correlation, cause
ids and Area through awaits, and `appendEvent` fills them automatically:
- Each event-engine tick is a correlation.
- Each real-world input enters as `evidence_observed`.
- Routing is recorded as `evidence_routed`, caused by the observation.
- A workflow is bracketed by `workflow_started`, caused by the routed evidence, and `workflow_completed` or
  `workflow_failed`. Everything the workflow writes, such as an opportunity status or a closed wait, is caused by
  `workflow_started`.
- Escalations record `escalation_opened` and `escalation_resolved`; digests record `notification_delivered` or
  `notification_suppressed` (quiet hours, or a delivery failure); Area health records `area_health_changed`
  (green/red, with a baseline).
- Every MCP tool call is its own correlation.

The chain *email received → classified → workflow → state change → escalation → notification* is therefore
followable by id.

**Ontology** (`src/live/ontology.ts`). Each stored row is classified as a pure function into `<domain>.<verb>`:
- Domains: entity, relationship, area, objective, project, task, wait, workflow, tool, evidence, inference, lesson,
  procedure, capability, exception, escalation, approval, authority, notification, rule, source.
- Cross-cutting facts derived per row: who owns the next action (finagai or julian), human authorization (from
  `approval_id`), verified, confidence, and low value.
- Unknown actions still stream, as `other.<action>`, and a test fails if any action Finagai writes lacks a
  classification.
- Classification happens at read time, so live and replay always agree and the ontology can evolve without
  rewriting history.

**Envelope (contract v1).** Each event carries:

| Field | Meaning |
|---|---|
| `seq` | stream cursor |
| `eventId` | id of the stored event |
| `at` | time, in UTC |
| `class`, `domain`, `verb`, `action`, `actor` | what happened, and who did it |
| `area` | `{id, name}` of the Area affected |
| `entity` | `{type, id}` affected |
| `summary` | one human line |
| `before`, `after` | the change, sanitized |
| `cause` | `{correlationId, eventIds, requestId}` |
| `nextOwner` | who owns the next action |
| `humanAuthorized`, `verified`, `confidence` | authorization, verification and confidence, when they apply |
| `lowValue` | high-frequency, low-value; may be coalesced |

**Delivery** (`/live/*`):
- **Access:** read-only. GET only; anything else gets 405. Authenticated exactly like `/mcp`: Julian's bearer token
  for the same audience, with the same client pin.
- **Endpoints:**
  - `/live/snapshot`: the authoritative state (areas, objectives, projects, waits, needs-Julian, exceptions, active
    Mac tasks, lessons, rules, opportunity counts, event loop) and its cursor, read in **one** repeatable-read
    snapshot. Every change visible in it has `seq ≤ cursor` or arrives after; consumers apply events idempotently
    by `seq`.
  - `/live/stream`: Server-Sent Events. `id` is the `seq`, so the stream resumes with `Last-Event-ID`; it includes a
    heartbeat and a retry hint, and writes wait for the client to drain (backpressure).
  - `/live/events`: the same events as polling pages.
  - `/live/history`: semantic replay over **all** stored events, beyond the stream's retention.
  - `/live/chain/<id>`: the causal chain behind one event.
  - `/live/contract`: this contract.
- **Behaviour:** results can be filtered by Area, class or domain, and entity. A run of 3 or more low-value events is
  coalesced into one message with a count, carrying the last `seq` so resume is never broken. A cursor older than
  retention gets a `reset` (409): take a new snapshot. It is never skipped silently.

**Safety.** Payload keys and values that look like secrets (passwords, tokens, keys, cookies, JWTs, bearer strings)
are redacted, and sizes are bounded. The authenticated principal is never exposed. Viewing writes nothing
operational; the stream code writes only `live_event`. Any future interactive action from a Command Center must
call the normal governed tools; there is no new mutation path.

**Phase 8.** Reliability and observability build on this stream. Tool, workflow and capability measurements,
exceptions and recoveries are already in it. Phase 8 adds no parallel monitoring store.

## Deferred to the frontend (intentionally not built)
- The Command Center UI and its visual layers: world model, learning graph, ownership map, live activity, workflow
  graph, capability map, inference graph, authority boundaries.
- Layouts and animation.
- Client-side state reducers.

Also deferred:
- A token flow for a non-claude.ai client (it will reuse the same OAuth issuer and audience).
- Fine-grained per-step J6 causal context. J6 events already carry the task id; per-step correlation comes with
  Phase 8.
- An objective-progress metric, which needs a definition per objective.

## Evidence
`test/integration/live.test.ts` (10 tests, fresh database):
- **Ordered and gap-free** when a lower id commits after a higher one. The in-flight event is not visible, then
  arrives later, and stream order is commit order.
- **Resumable from any cursor.** Re-publishing is idempotent.
- **Expired cursor** gets a reset.
- **Full causal chain from a real input:** evidence → routed → workflow → state change. One correlation id across the
  routing, workflow, state change, escalation and notification. The Area is attributed and a health baseline is
  recorded.
- **Secrets** are redacted and no principal is exposed.
- **Consistency:** replaying escalation events equals the snapshot's needs-Julian set.
- **Filtering** by Area and class works, and coalescing works with a count.
- **HTTP:** 401 without a token or with another subject; 405 for POST; SSE in order and resumable with
  `Last-Event-ID`; viewing changed nothing.
- **A dry-run tick** leaves no trace.
- **`withCause`** nests correctly.

`test/unit/live-contract.test.ts` checks that every action written in `src` is classified (it found two unclassified
ones, now fixed), that sanitization works, that coalescing keeps the resume point, and that the stream code writes only
its index and serves GET only.

## Deploy fix (2026-10-11, release #43 → hotfix 32)
Release #43 applied migration 0034, and then Core **refused to start**. Its preflight requires the app role to hold no
DELETE privilege anywhere (the archive-only invariant), and 0034 had granted DELETE on `live_event` for pruning. The
running Core stayed on the previous version, and nothing broke.

The fix:
- **Migration 0035** revokes that DELETE.
- **Retention became a read window.** A cursor whose position was published more than 30 days ago gets a `reset`. A
  fresh subscriber (cursor 0) starts at the beginning of the window.
- **A new integration test** asserts the app role holds no DELETE on any table. It would have caught this.
- **The structural test** now allows only INSERT on `live_event`.

## Live acceptance support (2026-10-11, hotfix 33)
Two changes came out of preparing the live acceptance.

**1. Escalations and notifications were linked only by correlation, not by cause.** Before this fix:
- An escalation opened by a workflow shared the tick's correlation id but cited no cause.
- The digest that notified Julian cited no cause either.

So `/live/chain/<notification>` could not walk back to the input. Now the causes are:
- **A workflow's escalation:** the `workflow_completed` event of the run that raised it.
- **A state-derived escalation:** the latest event on its follow-up, its `exception_opened`, its watch rule's
  triggering event, or its `lesson_proposed`.
- **`escalation_resolved`:** the follow-up event that closed it.
- **`notification_delivered` / `notification_suppressed`:** the `escalation_opened` events of the items they carried.

The chain is now one connected graph: input → routing → workflow → state change / escalation → notification. Separately,
`followup_cancelled` was written through a ternary and was unclassified; it is now `wait.cancelled`.

**2. A read-only live self-check, `finagai-job: live-acceptance`** (`src/live/acceptance.ts`). It runs inside the live
Core against the production database and reports every acceptance property with its evidence:
- **Privileges:** checks DELETE, TRUNCATE, and UPDATE on the event log, using `has_table_privilege` for every table.
- **Health:** checks Core and the scheduler.
- **Ordering:** checks that sequence numbers are gap-free and that there is one row per event.
- **Snapshot vs stream:** replaying the stream up to the snapshot's cursor reproduces the snapshot's exceptions and
  "needs Julian" set.
- **The latest real causal chain.**
- **Disconnect/reconnect:** runs through the real SSE handler with `Last-Event-ID`.
- **Expired cursor:** uses a clock 31 days ahead.
- **Authentication:** makes real HTTP calls to the process's own port with no token and with a forged token.
- **Read-only:** checks every non-GET method, and that operational state is unchanged after every route.
- **Redaction:** scans every envelope in the window.

An integration test runs the same self-check on a fresh database.
