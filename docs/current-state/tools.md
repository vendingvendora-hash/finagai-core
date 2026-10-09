# Tools — current state (audit 2026-10-09)

Source of truth: `docs/FINAGAI_CURRENT_STATE_2026-10-09.md`. Code at `94087a7` (live). Rewritten from code and live evidence; supersedes earlier versions of this file.

| Label | Meaning |
|---|---|
| **LIVE VERIFIED** | Exercised against production (Render + Neon + Julian's Mac) with observed output, today or in a recorded live run |
| **LIVE UNVERIFIED** | Deployed, but no live run observed that proves it works |
| **BUILT** | Code + tests exist; not wired into a live path, or never exercised live |
| **PARTIAL** | Works for a subset of the stated scope; the gap is named |
| **DESIGNED** | ADR/doc only |
| **ABSENT** | Nothing exists |
| **BROKEN** | Exists and produces a wrong result, with evidence |


## 4. MCP tools (28 registered)

See `docs/current-state/tools.md` for schemas and failure modes. Summary:

| Tool | R/W | Engine | Approval | Status |
|---|---|---|---|---|
| plan_resources | R | deterministic + Google API | none | LIVE VERIFIED |
| list_capabilities | R | deterministic + probes | none | LIVE VERIFIED (BROKEN: 2 Mac health fields, §5) |
| execution_metrics | R (runs reconcile) | SQL | none | LIVE VERIFIED (data gaps §18) |
| control_mac | W | J6 LLM planner | per write step over iMessage | LIVE VERIFIED |
| control_result | R | SQL | none | LIVE VERIFIED |
| pending_results | R + marks delivered | SQL | none | LIVE VERIFIED earlier |
| make_mac_chart | R on Mac | deterministic parse + model | none | LIVE VERIFIED, DEGRADED 5/12 |
| mac_status / mac_get_context | R | heartbeat snapshot | none | LIVE VERIFIED |
| resolve_reference | R | deterministic | none | PARTIAL (Firefox wrong, §8) |
| get_state_overview, search_state, get_item, get_project, get_charter, get_latest_review, list_open_conflicts, list_pending_proposals, get_approval_request | R | SQL | none | LIVE VERIFIED (overview today); the rest LIVE UNVERIFIED recently |
| capture | W (DB) | J2 LLM extraction | proposals for preference/procedure changes | BUILT, LIVE UNVERIFIED recently |
| request_proposal_decision, request_conflict_resolution, request_archival, request_seed_promotion | W | deterministic | creates an approval request (WebAuthn page) | BUILT |
| seed_questions, seed_answer, seed_add_source | W (DB) | seed pipeline | — | BUILT |
| operating_review | R | J3 | — | LIVE UNVERIFIED |

**How natural language is mapped to a tool:** there is no router. The claude.ai model picks a tool from the tool descriptions (for example, `plan_resources` says "Call FIRST…"). The only code-level routing is in `src/mac` (chart vs. control) and in J6's regex skill triggers. Tool choice is therefore prompt-only (§20).


## Input schemas (extracted from src/tools/server.ts, src/tools/j3Tools.ts)

| Tool | inputSchema (zod) | annotation |
|---|---|---|
| `get_charter` | `z.object({})` | read-only hint |
| `capture` | `z.object({ text: z.string().min(1).max(30_000), source_type: z.enum(["conversation", "note", "document", "correction"]).default("conversation"), mode: z.enum(["inline", "explicit", "end_of_session", "audit"]).default("inline"), project_hint: z.string().max(200` |  |
| `get_state_overview` | `z.object({})` | read-only hint |
| `get_project` | `z.object({ project: z.string().min(1).max(200) })` | read-only hint |
| `search_state` | `z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(50).default(20) })` | read-only hint |
| `get_item` | `z.object({ type: z.string(), id: z.string().uuid() })` | read-only hint |
| `list_open_conflicts` | `z.object({})` | read-only hint |
| `list_pending_proposals` | `z.object({})` | read-only hint |
| `request_conflict_resolution` | `z.object({ conflict_id: z.string().uuid(), resolution: z.enum(["keep_existing", "accept_new", "both_valid", "custom"]), custom_value: z.string().max(2000).optional(), rationale: z.string().min(1).max(1000), })` |  |
| `request_proposal_decision` | `z.object({ proposal_id: z.string().uuid(), decision: z.enum(["approve", "reject"]), rationale: z.string().min(1).max(1000) })` |  |
| `request_archival` | `z.object({ records: z.array(z.object({ type: z.enum(ARCHIVABLE), id: z.string().uuid() })).min(1).max(50), rationale: z.string().min(1).max(1000), })` |  |
| `request_seed_promotion` | `z.object({ batch_id: z.string().uuid(), rationale: z.string().min(1).max(1000) })` |  |
| `get_approval_request` | `z.object({ approval_id: z.string().uuid() })` | read-only hint |
| `seed_add_source` | `z.object({ text: z.string().min(1).max(30_000), title: z.string().max(200).optional(), idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).describe("A new opaque ID for this source; reuse only when retrying the same call."), })` |  |
| `seed_questions` | `z.object({ batch_id: z.string().uuid().optional() })` |  |
| `seed_answer` | `z.object({ batch_id: z.string().uuid(), answers: z.array(z.union([ z.object({ candidate_id: z.string().uuid(), action: z.enum(["confirm", "reject"]) }), z.object({ candidate_id: z.string().uuid(), action: z.literal("set_project"), value: z.string().min(1).max(` |  |
| `control_mac` | `z.object({ request: z.string().min(1).max(4000) })` |  |
| `make_mac_chart` | `z.object({ filename: z.string().min(1).max(200), title: z.string().max(200).optional() })` |  |
| `list_capabilities` | `z.object({ type: z.enum(["state", "mac", "external", "agent", "model"]).optional() })` |  |
| `plan_resources` | `z.object({ request: z.string().min(2).max(2000) })` |  |
| `execution_metrics` | `z.object({ days: z.number().int().min(1).max(90).optional(), recent: z.number().int().min(0).max(50).optional() })` |  |
| `pending_results` | `z.object({})` |  |
| `mac_get_context` | `z.object({})` |  |
| `resolve_reference` | `z.object({ phrase: z.string().min(1).max(300) })` |  |
| `mac_status` | `z.object({})` |  |
| `control_result` | `z.object({ task_code: z.number().int().positive().optional() })` |  |
| `operating_review` | `z.object({})` |  |
| `get_latest_review` | `z.object({})` | read-only hint |

Output: every tool returns JSON text content; control_result/pending_results/make_mac_chart also return images.

Failure modes: Mac offline → tasks queue as waiting_for_mac; Google token revoked → registry marks google.* down; budget ceiling → BudgetBlockedError; J6 parse failure → model_parse; approval never given → task waits indefinitely (no expiry).
