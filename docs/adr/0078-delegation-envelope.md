# ADR-078 — Phase 2: bounded delegation (authority classes + delegation envelope)

Status: Decided (builder, under Julian's 2026-10-09 mandate). Existing governance is NOT weakened globally.
Date: 2026-10-09

## Decision
- Every J6 step gets a deterministic authority class (src/governance/authority.ts): OBSERVE, PREPARATORY,
  EXTERNAL_COMMITMENT, HIGH_RISK. Unknown kinds are HIGH_RISK.
- Julian's own request (chat or his own iMessage thread) yields a delegation envelope stored on the task
  (migration 0025): OBSERVE + PREPARATORY run automatically; TTL 4h, 120 steps, $3 model cost; past any bound, steps ask again.
- EXTERNAL_COMMITMENT (submit/send/pay/publish/accept/book…, Return in a browser form) always needs Julian's explicit ok;
  if his request forbade it ("do not submit", "sin enviar"), the step is REFUSED without asking and recorded
  (event authority_refused); the planner is steered to finish at the review stage.
- HIGH_RISK (trash, shell writes, file moves without an explicit organize grant, credentials/security settings, money) is
  always explicit.
- A contact's request gets no envelope (they can ask; only Julian delegates).
- Completion in a delegated task produces one REVIEW PACKET: verified preparatory actions, actions held back by Julian's rules,
  and `needsJulian` items the planner could not safely answer (salary, attestations, demographic fields).
- The helper independently refuses commit-like buttons unless the step came through Julian's explicit approval (ADR-077).

## Acceptance (integration, real Postgres, scripted planner)
"Fill this harmless test application completely but do not submit it." → fills, Next, resume upload run with zero approvals;
Submit refused; review packet lists the held-back Submit and the salary question; user_interventions = 0.
