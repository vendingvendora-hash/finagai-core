# REAL-DATA READY gate

No real cold-start seeding with Julian's information until **all five** gates pass. Record the date and evidence for each.

| Gate | Requirement | How it is verified | Status |
| --- | --- | --- | --- |
| 1 | Real Claude J2 evaluation: T01-T10, E01, E03, 3 repetitions each, actual pilot models; `acceptancePassed` and `safetyPassed` true; zero unacceptable failures; every required assertion passes; no execution errors | The `readiness` workflow (or `npm run eval:j2` locally); report in the workflow artifact. Failures are classified first: model quality (prompt or model work), pipeline or guard (fix code), requirement mismatch (ask Julian). Model size is never raised to hide a pipeline defect | Blocked on provisioning (API key) |
| 2 | M5 governance complete locally, end to end, with every negative case | `npm run test:integration` (`test/integration/m5.test.ts`): staged request with no change, OIDC sign-in, one-time-code enrollment, fresh WebAuthn approval, content and version re-check, atomic execution, immutable event; refused: MCP bearer, wrong principal, forged session, cross-origin, revoked credential, foreign credential, reused challenge, expired request, mutated content, stale version, wrong origin, wrong RP ID, missing user verification | **Passed locally** |
| 3 | Live authentication with WorkOS and the real Claude connector | After provisioning: connect the custom connector in claude.ai; confirm a tool call succeeds; confirm a token for another identity is refused (401); confirm an MCP token is refused on `/approve/*` and an approval cookie is refused on `/mcp` (both covered by automated tests, re-checked live with curl) | Blocked on provisioning |
| 4 | Production database protections on Neon | `migrate` workflow, then the `readiness` workflow (or `verify-production-db`): the protection suite as `finagai_app` inside a rolled-back transaction, no DELETE privilege, app role in use. The server's startup preflight enforces the same on every boot | Blocked on provisioning |
| 5 | Green CI on the live GitHub repository: typecheck, unit, integration, migration verification | First push of this repository; `ci` workflow green | Blocked on provisioning |

The real J3 evaluation (`npm run eval:j3`, T11-T20) is not a gate for seeding, but it must pass before the pilot relies on weekly reviews.

## When the gates pass

Seed only the 5-10 projects that matter now. Do not import whole chat, mail, or file histories. Highly Sensitive and Prohibited material stays out of v1. Nothing extracted during seeding becomes live until promotion is approved with Julian's passkey; the baseline J3 review then runs automatically, and Julian checks it (acceptance criterion A3).

## Also proven locally before provisioning

- Full-system simulation with failure injection (`test/integration/system.test.ts`): 13 workflows pass.
- Startup behavior of the built server (`npm run verify:startup`): starts correctly; refuses the migration role and missing migrations.
- Backup and restore drill (`test/integration/backup.test.ts`): exact checksums, protections intact after restore, tampered or wrongly keyed backups refused.
