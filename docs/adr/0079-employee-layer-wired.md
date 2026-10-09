# ADR-079 — Phase 3: employee layer wired as tools; structured waiting-on; exception-first brief; Career bootstrap

Status: Decided (builder, under Julian's 2026-10-09 mandate)
Date: 2026-10-09

## Context
Audit: src/cos (areas, follow-ups, brief) was imported by nothing; live state held 1 project and 0 areas; "What am I
waiting on?" was a Gmail keyword search that returned spam; brief.ts queried a non-existent column (hidden by a catch).

## Decision
- MCP tools in Julian's words, names never UUIDs: create_area, set_objective, place_under_area, track_waiting,
  resolve_waiting, waiting_on, area_status, executive_brief, bootstrap_area, apply_bootstrap.
- Hierarchy AREA → OBJECTIVE → PROJECT → follow-ups/work items, linking existing records (no duplicates).
- "Waiting on" is structured follow-up state; plan_resources routes such questions to state.areas only (commitments slot).
- Area health green/yellow/red with every reason (red = breached service level, yellow = early warning).
- Executive brief ordered for management by exception: decisions → blocked → changes → risks → completed → rest.
- Opportunity pipeline table (0026, generic kind; jobs first) with dedupe keys, and a staged Career bootstrap:
  discover (Career Copilot sheet CSV, Gmail/Calendar interview evidence, existing projects) → extract (by header name;
  test rows dropped; duplicates removed) → link (normalized org) → conflicts (sheet status lagging interviews; clearance-
  restricted roles) → proposal with short code → Julian approves → apply (idempotent).
