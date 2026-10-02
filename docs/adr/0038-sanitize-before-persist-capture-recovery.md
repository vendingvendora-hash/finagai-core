# ADR-038: Sanitize before persist, capture recovery, event-scoped idempotency, honest delivery, acceptance gating

- **Date:** 2026-10-01 · **Status:** decided · **Category:** security and implementation corrections required by Julian's review
- **Supersedes in part:** ADR-034/ADR-025 deferral behavior before extraction; ADR-037 capture idempotency details

## 1. Security: sanitize before persist (G09)

**Invariant, enforced by the database:** a capture body exists only if both classification layers ran (`ck_capture_body_sanitized`: `source_text` is NULL unless `sanitized_at` is set).

- Intake persists metadata, payload hash, timestamps, and redaction counts, never the body.
- The deterministically redacted text stays in memory through extraction.
- After extraction, every span the model labeled Highly Sensitive or Prohibited is replaced with `[REDACTED:SENSITIVE_CONTENT]` (whitespace- and case-tolerant). If a span cannot be located, the whole body is withheld (fail safe).
- Rejected sensitive candidates are audited as metadata only: temp ID, item type, classification, guard reason, and the marker. Every other persisted candidate is scrubbed of withheld spans too, because a quote can overlap withheld content. Guards run against the sanitized text, so an accepted quote can never contain withheld content.
- **At the hard ceiling before extraction**, the body is never persisted: the capture ends as `budget_blocked_not_persisted` and the client is told to resubmit with the same key. Security takes precedence over lossless deferral.
- **At the ceiling after extraction**, only the sanitized body may be deferred (`budget_deferred`), still under the atomic queue bound. A full queue stores nothing and refuses loudly.
- Residual risk (unchanged and documented): the classifier itself may miss sensitive prose.
- **Evidence:** adversarial medical and legal prose missed by the regex detector but labeled Highly Sensitive by the model is absent from every table in the schema (searched row-by-row as text) and from the tool output. Also covered: overlapping quotes, quotes differing in case and spacing, unlocatable spans, sanitized deferral and replay.

## 2. Capture processing recovery

Captures carry `processing_token`, `processing_until` (10-minute lease), and `attempts`. Every terminal transition requires the current token, and the final commit locks the row and verifies ownership first.

| Existing state on retry with the same key and identical request | Result |
| --- | --- |
| processed, partially_applied, dry_run, budget_deferred | `already_captured` |
| processing with a live lease | `in_progress` |
| failed, budget_blocked_not_persisted, or a stale lease | reclaim the same capture and retry; the original event time is kept |
| different request under the key | `idempotency_conflict` |

A stale worker that resumes after a reclaim cannot commit: its attempt returns `in_progress` and writes nothing. **Evidence:** crash after row creation, crash during processing, active-lease retry, stale-lease reclaim with the stale worker refused, a transient failure retried once, and a completed capture never processed twice.

## 3. Event-scoped capture idempotency

- The MCP `capture` tool now requires an opaque event ID (`[A-Za-z0-9_-]{16,128}`, for example a UUID) generated once per capture and reused only for retries of that call. The content-hash fallback is removed.
- The payload hash covers source type, mode, project hint, and the deterministically redacted text.
- **Evidence:** the same request is an idempotent replay; different keys with identical text are two capture events; the same key with different text, project hint, or mode is a conflict.

## 4. Honest delivery outcomes

- `deliverOnce()` returns `lease_lost`, never `sent`, when `markSent` fails because another attempt owns the lease. The same applies to stale failure and conflict updates. `deliverReview()` marks a review delivered only on `sent` or `already_sent`.
- Ambiguous provider outcomes (timeout, network error, 5xx, concurrent-request 409) become `uncertain`, with `first_ambiguous_at` preserved across reclaims. A retry with the same key is automatic only within 20 hours of the first ambiguous attempt (inside Resend's retention). After that, Core returns `needs_reconciliation` and sends nothing. Core records what it knows; it does not claim exactly-once delivery indefinitely.
- **Evidence:** the stale-owner sequence at the `deliverOnce()` level, and at the `deliverReview()` level against a real review row; ambiguous outcomes inside and beyond the window.

## 5. Evaluation verdicts

The runner reports `safetyPassed` (zero unacceptable failures) and `acceptancePassed` (every required assertion passed in every repetition, with no execution errors). The CLI exit code uses `acceptancePassed`. Severity is kept for analysis and never averages failures away. No statistical thresholds exist until Julian defines them from real results.

## Sequencing

- M5 continues in parallel.
- M7 seeding with Julian's data waits on item 1, which is now fixed and tested.
- The first real-model T01-T10 run counts as an acceptance result only under item 5, which is now fixed.
