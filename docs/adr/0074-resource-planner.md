# ADR-074 — Resource planner, retrieve-before-ask, bounded exhaustion (Phase 2C/2D/2E)
**Decided by:** Julian ("Julian must stop being Finagai's prompt engineer, resource router and memory")

- `src/resources/planner.ts planResources`: deterministic and registry-driven. Detects known Finagai state in the
  request (projects, entities incl. aliases, areas), the information slots it needs (schedule, correspondence,
  project state, prior work, documents, current context, messaging), maps slots to sources with an authority
  order, scores relevance (slot, known entity, documents, lexical match to a capability's declared scope — so a
  runtime-registered capability is usable without code (R08) — and explicit naming by Julian, which outranks
  inference), drops unhealthy sources with fallback (R05), bounds to 6 sources (R06/2E), and asks Julian ONLY for
  a slot no healthy relevant source can fill (R07). Trivial requests retrieve nothing.
- `src/resources/retrieve.ts`: executes the Core-side sources (project memory, follow-ups, artifacts, past
  requests, Gmail/Calendar/Drive via the shared GoogleClient) with bounded snippets and provenance; Mac-side
  sources are delegated to the Mac operator; failures recorded per source, never hidden.
- Traces: plan (used/unavailable/skipped with reasons) + retrieval outcomes (retrieved N / nothing found / failed).
- Surfaces: MCP `plan_resources` (call first for substantive requests); J6 planner prompt gets the plan and the
  retrieved context; J6 retrieve-before-ask guard bounces one question about an already-known entity per task.
- Evals R01–R10 on real Postgres with seeded state and a fake Google client; found and fixed during development:
  trivial-request pattern, messaging detection ("send that chart to Beth"), explicitly named source losing to the
  bound, and a test-isolation leak.

## Live-data revision (from a run against Julian's real Altarum data)
Seeded tests hid three defects: (1) an authoritative source that is healthy but EMPTY (no Altarum calendar events;
dates live only in recruiter email) left the need unanswered — retrieval now falls through the slot's source order
and `effectiveAuthority` reports who actually answered; (2) Gmail took the 5 most recent matches, so LinkedIn
notices and Otter weekly digests crowded out the recruiter thread — now 25 candidates by metadata, ranked
(correspondence/sender-domain/interview subjects up, bulk/notifications down), top 8 fetched in full, meeting
summaries kept at 3000 chars instead of 600; (3) a wrong-account Google token would fail silently — the registry
now probes and shows "connected as <email>" (cached 10 min), degraded on probe failure.
