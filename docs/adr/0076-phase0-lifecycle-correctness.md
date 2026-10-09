# ADR-076 — Phase 0: lifecycle, context and measurement correctness

Status: Decided (corrections; no new authority, scope or data class)
Date: 2026-10-09

## Context (audit 2026-10-09, live evidence)
- Helper sent capability keys `screen`/`files`; Core read `screenCapture`/`filesystem` → mac.screen/mac.filesystem
  stuck "unknown". The router compared helper booleans to "PASS", so healthy accessibility rungs were skipped as
  "capability probe failed" in every J6 route hint.
- Firefox frontmost on LinkedIn; `resolve_reference("this page")` returned a background Chrome tab with confidence "high"
  (`browserActiveTab` took the first *running* browser).
- Tasks #104/#113 sat in `waiting_approval` for 4+ days; their interactions said "executing".
- iMessage task #117 created no interaction → telemetry stopped at Oct 5.
- Reconciler/completion paths used `.catch(() => {})`.
- A verifier-unavailable completion was labelled in text only; and (found while building the regression) that path
  never actually completed the task — the `done` step fell through and was inserted as a read step.

## Decision
- **0A** One canonical capability payload (`src/mac/capabilities.ts`). The helper doctor declares each check's key
  (`DOCTOR_CHECK_KEYS`); Core normalizes (legacy keys, booleans → PASS/FAIL/unknown) at the heartbeat boundary; a unit
  test fails on drift. Router: only an explicit FAIL skips a rung.
- **0B** "This page" = the FRONTMOST browser's page only. Helper reads the frontmost browser (Chrome-family/Safari: URL+title;
  Firefox: title only, `introspection:"title_only"`); a background tab is marked `frontmost:false`. Core never resolves a
  background browser as "this page"; a frontmost browser that cannot be introspected yields `uncertain:true`, never high confidence.
- **0C** Human waits are explicit: `control_task.{awaiting_since, awaiting_kind, awaiting_reason, expires_at, reminders_sent}`;
  interaction `awaiting_human`. Policy (approval): remind at 1h and 8h (delivered by helper runtime-13 from the heartbeat reply),
  expire at 24h → task/step/interaction `expired` with a "resume <code>" instruction. "resume <code>" or a late "ok <step>" resumes
  the SAME task and interaction; the stale step is superseded (the planner re-observes). Waiting time accumulates in
  `interaction.waiting_human_s`, separate from active time.
- **0D** `createTask` is the single creation path; non-chat origins open an interaction in the same transaction
  (conversation `self` / contact label, `origin` recorded). Chat `control_mac` now also uses `createTask` (acceptance contract stored).
- **0E** `reportLifecycleError` → sanitized console line + `event(action='lifecycle_error')`, surfaced in `execution_metrics.lifecycle`.
  Reconcile is per-row isolated and returns an error count.
- **0F** `verification_status ∈ {verified, unverified, needs_review, not_applicable}` on task and interaction. Verifier unavailable:
  read-only work → `unverified`; anything changed or explicit criteria → `needs_review`. Metrics view adds completed_verified,
  completed_unverified, needs_review, expired, awaiting_human, waiting_human_s, p50_active_s, origin counts. control_result tells the chat
  model how to word each outcome.

## Consequences
Migration 0024 (backfills existing waits so #104/#113 expire on the first sweep). Helper runtime-13 required for reminders and
frontmost-aware context; Core-side fixes (0A normalization, 0B resolver guard, 0C expiry, 0D, 0E, 0F) work with runtime-12.
