# ADR-043: The finagai-core repository is public (principal decision)

- **Date:** 2026-10-02 · **Status:** decided by Julian (principal), in writing, after reviewing the options · **Category:** security posture, principal-reserved

## Context

GitHub enforces required reviewers on an environment, the control that makes every workflow using production secrets wait for Julian's approval (ADR-040/041), only on public repositories, or on private repositories under GitHub Enterprise. The options presented were:
- **A.** Enterprise, about $21/month;
- **B.** a public repository;
- **C.** private on Pro, with required reviewers replaced by weaker compensating controls.

## Decision

**B. The repository is public.** Every security control stays as designed, including required reviewers on `production` and protection of `main`.

## Consequences, accepted by Julian

- Code, workflow definitions, and workflow logs are publicly readable. Secrets are never in the code (pre-commit secret scan, ADR-042) and are masked in logs by GitHub.
- Backup artifacts are downloadable by any GitHub user. They are AES-256-GCM encrypted with a 256-bit random key held only in the `production` environment secret and Julian's password manager (ADR-040), so their confidentiality rests on that key.
- Evaluation and readiness reports use synthetic data only.
- Workflows from forks receive no secrets (GitHub default), and production workflows still wait for Julian's approval.

## For the builder

Do not reopen this decision, do not move the repository back to private, and do not weaken any control because of it.
