# Tests / evals (Core 45e80d0)

Run: `npx vitest run test/unit` (all green: **31 files, 304 tests** at 45e80d0); integration needs `INTEGRATION_DATABASE_URL` (`scripts/test-integration.sh` spins Postgres + migrations); schema protections in `test/integration/schema_protections.sql`.

| File | it() | describe blocks |
|---|---|---|
| `test/integration/backup.test.ts` | 2 |  |
| `test/integration/builder.test.ts` | 5 | autonomous builder on the real Claude Code runtime |
| `test/integration/cos.test.ts` | 3 |  |
| `test/integration/db.test.ts` | 15 |  |
| `test/integration/interaction.test.ts` | 3 |  |
| `test/integration/interactions.test.ts` | 5 |  |
| `test/integration/j2.test.ts` | 28 |  |
| `test/integration/j3-eval-cases.test.ts` | 2 |  |
| `test/integration/j3.test.ts` | 15 |  |
| `test/integration/j5.test.ts` | 9 |  |
| `test/integration/j6.test.ts` | 9 |  |
| `test/integration/m5.test.ts` | 13 |  |
| `test/integration/mac-runtime.test.ts` | 6 |  |
| `test/integration/mcp.test.ts` | 5 |  |
| `test/integration/provision.test.ts` | 5 |  |
| `test/integration/system.test.ts` | 13 |  |
| `test/unit/agent-parts.test.ts` | 9 | pre-commit secret scan; independent completion verification; runtime environment and state; builder spend accounting and stop conditions |
| `test/unit/agent-permissions.test.ts` | 10 | builder permissions: files; builder permissions: shell; builder permissions: tools and browser |
| `test/unit/concierge.test.ts` | 27 | J5 commands from Julian's own thread; J5 model verdict parsing; J5 prompt safety; J5 helper authentication; J5 spend bound; Mac helper pure functions; |
| `test/unit/config.test.ts` | 8 | config; placeholder detection |
| `test/unit/control.test.ts` | 16 | J6 risk classification; J6 approval gate (the core safety property); J6 step parsing; J6 commands from Julian's thread; J6 helper auth; J6 executor gu |
| `test/unit/dates.test.ts` | 11 | G11 date parsing (EN/ES, Julian's timezone); G11 verification against the model's resolution |
| `test/unit/delivery.test.ts` | 16 | deterministic keys; 1. provider retry inside its retention window; 2. retry after the provider's retention window; 3. same key with a mutated payload; |
| `test/unit/deploy-config.test.ts` | 4 | render.yaml deployment manifest |
| `test/unit/dispatcher.test.ts` | 9 | ADR-033 at-least-once dispatch; 6. a job retried end to end produces one externally visible email |
| `test/unit/eval-verdict.test.ts` | 4 | evaluation verdicts (ADR-038) |
| `test/unit/google.test.ts` | 4 | Google read-only search (ADR-049) |
| `test/unit/guards.test.ts` | 18 | G02 extraction schema; G01 quotes must come from the input; G03 only explicitly stated work items; G04 completion requires a completion statement; G09 |
| `test/unit/helper-pickup.test.ts` | 4 | helper task pickup is unconditional (WO1) |
| `test/unit/j2-alerts.test.ts` | 1 | deferred-queue alerts are idempotent |
| `test/unit/j3-degraded.test.ts` | 6 | J3 degraded review at the hard ceiling (zero model calls) |
| `test/unit/j6-context.test.ts` | 3 | J6 current-context line (ADR-062) |
| `test/unit/llm.test.ts` | 20 | G20 budget target $30 and hard ceiling $36 (ADR-025 clarified); pricing; retry policy; worst-case estimate (ADR-034); metered model client with reserv |
| `test/unit/m01-acceptance.test.ts` | 9 |  |
| `test/unit/m01-financial-layout.test.ts` | 4 | financial-model layout (Altarum); chart title never overflows the canvas (task #72 showed a clipped title) |
| `test/unit/m01-interaction.test.ts` | 3 | M01-INTERACTION coordinator contract (ADR-065) |
| `test/unit/mac-actions.test.ts` | 9 | observe → act → verify; intended-outcome verification (live task #77 finding) |
| `test/unit/mac-context.test.ts` | 6 | WO3 referent resolution |
| `test/unit/mac-perception.test.ts` | 6 | Mac perception substrate (ADR-062) |
| `test/unit/mac-router.test.ts` | 8 | capability router |
| `test/unit/mac-routing.test.ts` | 3 | /mac/* routing (M01 404 regression) |
| `test/unit/mac-runtime.test.ts` | 7 | Mac runtime lifecycle (ADR-066) |
| `test/unit/provision-neon.test.ts` | 5 | provider busy statuses (Neon 423 right after project creation); Neon plan-limit detection (ADR-028 needs Launch) |
| `test/unit/schedule.test.ts` | 14 | zoned time conversion (America/New_York); weekly review dispatch across DST (ADR-026); daily jobs |
| `test/unit/sensitive.test.ts` | 8 | G09 detector: Prohibited secrets (ADR-020); G09 detector: Highly Sensitive identifiers (ADR-016); no false positives on ordinary work content; redacti |
| `test/unit/server.test.ts` | 12 | public endpoints; M3 bearer verification on /mcp; separation of MCP and approval authentication |
| `test/unit/webauthn.test.ts` | 7 | ADR-030 approval verification (real library, software authenticator); sign-counter semantics |

## Mandate → regression coverage
| Mandate | Regression | Status |
|---|---|---|
| Mac task not claimed (33/34) | `helper-pickup.test.ts` (fails on old helper), `mac-runtime` integration D/E/F/G, sweep + ordering | covered |
| Stale worker can't complete | `mac-runtime` integration G | covered |
| Duplicate task (#9/#32) | `interactions` W1, `m01-interaction` | covered |
| Async result returns without "check again" | `interactions` W2/W3 | covered (surface); live verified |
| Chart quality (index column, template rows, financial layout) | `m01-acceptance` 9, `m01-financial-layout` 4 | covered |
| Cropped artifact | aspect gate is helper code — **no unit test (macOS-only)**; live task #73 proved rejection | partial |
| Reference resolution U1–U6 | `mac-context` 6 | covered (resolver); live U2 |
| Control hierarchy / router | `mac-router` 8, `mac-actions` 9 | covered |
| Employee layer | `cos.test.ts` (integration) | services only |
| Real-Mac daemon restart (A), soak (H) | doctor `--probe-restart`, `--soak` scripted | **NOT RUN** |
| Unknown-app task | — | **NOT RUN** |
| Event-driven workflows (WO5), procedural learning (WO7), false-completion benchmark (WO9 full), failure telemetry (WO11), metrics (WO12), exception engine (WO13), ambient (WO14) | — | NOT IMPLEMENTED |
