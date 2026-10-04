# ADR-067 — Durable interactions (WO2)

**Decided by:** Julian ("a conversation must own the work it starts")

## Failure
Claude launched a task, polled a few times, the turn ended, the task finished later and its result never
returned; a follow-up created a duplicate task (#32 beside #9).

## Decision
- `interaction` table (migration 0020): conversation, origin message, stable `request_key`, linked `task_ids`,
  owner, state machine (received → claimed → executing → … → completed | failed | awaiting_human | superseded),
  result + image, `final_response_status` (pending/delivered), retries.
- `openInteraction` REUSES an equivalent open interaction from the last 30 min — follow-ups continue, never duplicate.
- Task terminal states (`/mac/chart-done` done/failed, J6 done) complete the interaction with the result → pending delivery.
- **Async return — the strongest mechanism MCP supports** (there is no server→chat push): (1) same-turn re-poll
  (ADR-065.1), (2) automatic iMessage delivery by the Mac runtime, (3) `helpers.ok` appends
  `finishedWhileYouWereAway` to the NEXT tool response of any kind, with an instruction to surface it; images
  via `pending_results`. Julian is never the polling mechanism.
- Survives Core restart (W3): ownership lives in Postgres, not process memory. Survives worker restart via WO1 reclaim.
