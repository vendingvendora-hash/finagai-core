# ADR-073 — Capability/resource registry, discovery and resource traces (Phase 2A/2B/2F)
**Decided by:** Julian ("no general resource discovery, no pre-execution resource plan, no empirical routing")

- `capability` table (migration 0023): id, type (state|mac|external|agent|model), scope, access, operations,
  permissions, health (+reason), reliability/samples, p50 latency, cost, risk, freshness, authority, source, last_probe.
- `src/resources/registry.ts`: CATALOG declares what exists; `discover()` derives health and evidence from live
  signals only — DB reachability; Mac heartbeat freshness + the helper's own probes; configured integrations
  (Google is "unknown: configured, not probed" — never claimed healthy without evidence); Resend from
  outbound_delivery; models from llm_call; agents from control_task outcomes; Mac file/AX actions from verified
  control_step results. Reliability is null below 5 samples (no anecdote routing). No masking catches: a schema
  mistake fails loudly (lesson from the Phase 1E diagnostics bug).
- Refresh: at startup, throttled on Mac heartbeats (60 s), and on every `list_capabilities` call.
  `upsertCapability` registers runtime-discovered capabilities (e.g. a new connector).
- `resource_trace`: every control_mac / make_mac_chart writes used / considered / skipped / unavailable rows with
  reasons (route ladder mapped to capability ids).
- MCP: `list_capabilities` (read-only).
Next: Phase 2C resource planner (relevance + authority + health → ResourcePlan before execution), retrieve-before-ask,
registry-driven routing, R01–R10.
