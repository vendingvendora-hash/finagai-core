# Architecture Decision Record

Full text of ADR-001 to ADR-026 is in the approved Claude Docs; this index is the repository's source of truth from M0 onward.

| ADR | Decision | Status |
| --- | --- | --- |
| ADR-001 | Requirements discovery before architecture | Decided by Julian |
| ADR-002 | Living spec and ADR log in Claude Docs until a permanent home exists | Superseded at M0: the ADR log now lives in this repository |
| ADR-003 | Julian is sole principal; others need an explicit authorization hierarchy | Decided by Julian |
| ADR-004 | Merged limits on autonomous execution; no permanent deletion; model never handles secrets | Decided by Julian (amended) |
| ADR-005 | Classification tiers and least privilege, enforced technically | Decided by Julian |
| ADR-006 | Domains decomposed into jobs with Definitions of Done | Decided by Julian |
| ADR-007 | English and Spanish | Decided by Julian |
| ADR-008 | Budget chosen from cost scenarios | Decided by Julian |
| ADR-009 | Minimum evaluation built with the first job | Decided |
| ADR-010 | First jobs: J3 supported by J2 | Decided by Julian |
| ADR-011 | Hybrid system of record with three authority classes | Decided by Julian |
| ADR-012 | v1 needs no external account access | Decided by Julian |
| ADR-013 | Option B Hybrid; claude.ai is Client v1 | Decided by Julian |
| ADR-014 | Workflow-first, permanent principle | Decided by Julian |
| ADR-015 | Capable design, Lean pilot operation | Decided by Julian |
| ADR-016 | v1 tiers Public/Internal/Confidential; Highly Sensitive excluded; Prohibited never | Decided by Julian |
| ADR-017 | AR07 partial compliance as measured risk; B -> B2 -> C | Decided by Julian |
| ADR-018 | Cold start through staging | Decided by Julian |
| ADR-019 | Two-phase governance with approval page | Decided by Julian |
| ADR-020 | Raw credentials and tokens are Prohibited | Decided by Julian |
| ADR-021 | Classification by sensitivity and source | Decided by Julian |
| ADR-022 | Minimal third-party retention policy in v1 | Decided by Julian |
| ADR-023 | Render, Neon, Resend provisionally approved | Decided by Julian; verified 2026-10-01 (M0 checklist) |
| ADR-024 | AR07 targets 95% / 98% / zero unacceptable | Decided by Julian |
| ADR-025 | Model spend: **budget target $30/month; absolute hard ceiling $36/month**, changed only by Julian. At the ceiling no model call starts (no exemptions); J3 uses a zero-model degraded review and J2 defers screened captures. Infrastructure tracked separately | Decided by Julian (clarified 2026-10-01) |
| ADR-026 | Configurable operating defaults | Decided by Julian |
| ADR-027 | Render: Hobby workspace, Starter web service, one 15-minute scheduler cron dispatching all jobs in America/New_York time; Virginia region; render.yaml blueprint | Decided (reversible technical choice) |
| ADR-028 | Neon Launch, AWS US East, 7-day history window, scale to zero, 0.25-0.5 CU, daily snapshot, $10 spending notification; search_path set per connection | Decided (reversible technical choice) |
| ADR-029 | Identity provider: WorkOS AuthKit free tier; CIMD on, DCR off, sign-up disabled, passkeys required; Core pins subject and Claude client ID. Auth0 is the documented fallback. Core depends only on standard OAuth/OIDC (issuer, JWKS, audience, subject), never on WorkOS-specific APIs beyond that boundary | Decided by Julian, subject to the M3 claude.ai connector test |
| ADR-030 | Every governance approval requires a fresh WebAuthn assertion with user verification. Julian's authenticator holds the private key; Core generates a challenge bound to the request ID, nonce, and content hash, and verifies the signature using stored public credential data (credential ID, public key, sign counter, principal link). Core never possesses or reconstructs the private key. See adr/0030-governance-approval-webauthn.md | Decided by Julian (corrected wording) |
| ADR-031 | Retention defaults: Confidential third-party review 180 days after last linked activity, archival only when no linked project is active; public professional re-verification 365 days; freshness warning at 120 days. Configurable defaults, not constants | Decided by Julian |
| ADR-032 | M2 implementation choices: `pg` driver; plain `node:http` server; Anthropic SDK retries disabled so Core counts and meters every retry; `/health` never touches the database so health checks cannot keep Neon awake; scheduler opens the database only when a job is due | Decided (reversible technical choice) |
| ADR-033 | At-least-once job dispatch: leases, heartbeats, up to 3 attempts, idempotent handlers and delivery ledger. See 0033-at-least-once-jobs.md | Decided (reversible technical choice; requested in M2 review) |
| ADR-034 | Atomic worst-case reservations enforce ADR-025: zero overshoot above $36 under concurrency; $1.00 per-call ceiling. See 0034-spend-cap-reservations.md | Decided (revised per Julian's clarification) |
| ADR-035 | jose token verification; separated MCP and approval authentication; SimpleWebAuthn for all WebAuthn crypto; redact-before-model G09; exact-match project resolution. See 0035-auth-webauthn-guards.md | Decided (reversible technical choices) |
| ADR-036 | J2 rules found during implementation: G06 overwrite-is-conflict, G11 code-confirmed dates, explicit handling of unsupported types, ADR-022 entity checks. See 0036-j2-pipeline-rules.md | Decided (implementation details) |
| ADR-037 | Atomic deferred-queue bound; atomic capture idempotency with payload hash; delivery lease tokens and provider timeout; MCP SDK 2.2 stateless handler and zod 4; J3 rules V5/V6; evaluation harness; arbitrary relationship capture explicitly deferred. See 0037-concurrency-mcp-j3-eval.md | Decided (implementation details and reversible choices) |
| ADR-038 | Sanitize before persist (body only after both classification layers; never at the ceiling before extraction); capture processing leases and recovery; required event-scoped capture keys; lease_lost and uncertain delivery outcomes; acceptance-gated evaluation. See 0038-sanitize-before-persist-capture-recovery.md | Decided (security and implementation corrections) |
| ADR-039 | M5 approval page (OIDC sign-in, enrollment by one-time code or existing passkey, server-fixed challenge, atomic versioned execution); M7 seeding (staging, consolidation, code-generated questions, approval-gated promotion, baseline review); J3 real-model evaluation harness. See 0039-m5-m7-j3-eval.md | Decided (implementation of approved decisions) |
| ADR-040 | Operations: GitHub Actions encrypted backups with a monthly restore drill; daily maintenance job; startup preflight that refuses unsafe production starts; Render build fix; access log without query strings; job-failure alerts; full-system simulation; one-click readiness workflow. See 0040-operations-backups-readiness.md | Decided (reversible technical choices) |
| ADR-041 | Automated provisioning: `npm run provision` on Julian's machine; provider APIs for everything automatable; pauses only for human-only actions; secrets provider -> process -> destination; idempotent detection; supersedes the manual checklist. See 0041-automated-provisioning.md | Decided (Julian's direction) |
| ADR-042 | Autonomous builder: `./finagai` launches a Claude Agent SDK agent with the operating spec, repository briefing, permission hook policy, budgets, checkpoint and resume, launcher-side provisioning and human actions, and independently verified completion. See 0042-autonomous-builder.md | Decided (Julian's direction) |
