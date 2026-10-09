# ADR-084 — Phase 5: event-driven proactivity (a reusable engine; Career is one plug-in)

Status: Decided (builder, under Julian's 2026-10-09 mandate)
Date: 2026-10-09

## Context
Through Phase 4, Finagai acted only when asked. The audit recorded event-driven proactivity as ABSENT: the `event` table is an audit log, and nothing watched mail, calendars or deadlines.

Julian (2026-10-09): external events and approaching deadlines must wake the right Area or workflow automatically, update state, and execute Finagai-owned actions. Finagai escalates to him only when his judgment, his authorization, or a principal-reserved action is actually required. Career stays the golden test case, not the purpose.

## Decision
**Engine** (`src/events/engine.ts`). It is generic and runs inside Core every 5 minutes. Core runs it because it holds the Google credentials. An advisory lock keeps it to a single runner, and every tick is recorded in `event_tick`. Each tick:
1. **Watchers.** Polls every watcher that is due and records each real-world event once in `inbound_event`, keyed by (source, external_id). Each watcher keeps its cursor in `event_cursor`.
2. **Routing.** Sends every new event to each subscription that claims it, recording the reason. An event nobody subscribes to is marked `ignored` with that reason.
3. **Workflows.** Runs each workflow once per tick with all of its events, so ten emails produce one sync. Failed events are retried up to 5 times, and none are lost.
4. **Escalations from state.** Derives what only Julian can do from current state, not from the events:
   - A lifecycle step whose rule needs Julian (offer → judgment; submit or a message sent as him → principal-reserved).
   - A wait Julian created that passed its date: following up goes out as him.
   - Judgment calls a workflow could not resolve.

   Each need is escalated once, under a stable key. When its source closes, it is resolved automatically and never re-escalated.
5. **Notification.** New escalations go to Julian in one email digest, sent through the idempotent delivery ledger. Quiet hours run 22:00–07:00 America/New_York, and held items go out in the morning.

A preview runs the same tick and writes and sends nothing (no cursor, event or escalation changes).

**Modules.** An Area plugs in watchers, subscriptions and workflows; the engine does not change.
- **Generic module:**
  - Watchers: Gmail (all accounts), Calendar (next 14 days), and deadlines of tracked follow-ups.
  - Reactions: a reply from someone Julian is waiting on is recorded on that follow-up as a change, not an escalation. Follow-up dates sweep overdue items. Lifecycle steps whose time has come run the lifecycle tick.
- **Career module:**
  - Watches the Career Copilot sheet for edits.
  - Routes mail to Career only when the ADR-080/081 classifier calls it job evidence, or when it comes from the contact of a live job. A match on the employer's name alone counts only for jobs at interview or offer stage, so an Amazon order email cannot wake Career.
  - Routes interview calendar events and sheet edits the same way. All of these run one `career.sync`.

**Surfaces:**
- MCP tools: `proactivity_status` (heartbeat, recent events with their routing, open escalations, i.e. what needs Julian) and `run_event_tick` (`preview` option).
- The executive brief's decisions list is the open escalations. Its changes show what Finagai handled on its own, and a stalled loop appears as a risk.
- Operator channel: `events [n]`, `tick-preview`.

## Authority
- **Workflows** perform only Finagai-owned internal changes: evidence sync, lifecycle next steps, overdue sweeps, and recording replies.
- **The only outbound message** is the escalation digest to Julian himself, through the same channel and ledger as the weekly review.
- **Never automatic:** sending to third parties and submitting applications remain principal-reserved.

## Evidence
Integration tests run on a fresh database built from the real 2026-10-09 evidence (`test/integration/events.test.ts`, 7 tests):
- **Preview:** writes and sends nothing.
- **Mail routing:** job mail wakes Career, unrelated mail is ignored with its reason, many emails produce one sync, and a quiet tick does nothing.
- **Rejection email:** the job's status and project update by themselves, with no escalation.
- **Calendar:** an interview event wakes Career; a dentist appointment does not.
- **Overdue wait:** Julian's own overdue wait is escalated once as principal-reserved, sent as one digest, appears in the brief, is never repeated, and resolves when he closes it.
- **Quiet hours:** the digest is held overnight and sent in the morning.
- **Replies:** a reply from a waited-on counterparty is recorded with no escalation.
- **Failures and concurrency:** a failed sync loses no event and is retried, and a concurrent tick is skipped.
