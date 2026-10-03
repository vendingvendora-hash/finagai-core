# ADR-060: Employee-level layer — Areas of Responsibility, closed-loop follow-ups, executive brief

- Status: Accepted (Julian, principal: product mandate — "a highly capable digital employee")
- Date: 2026-10-03

## Decision (per Julian's entity model)
First-class entities, linked to the existing project model, NOT overloading `project`:
- **area** — a persistent domain Finagai continuously manages (Career, Vendora, Personal Admin, Financial).
  Has a `policy` jsonb for configurable service levels. Long-lived (archive, not delete).
- **objective** — a desired outcome within an area ("secure a strong finance role").
- **project.area_id / project.objective_id** — optional links; existing projects keep working unchanged.
- **followup** — closed-loop commitment: open → waiting → overdue → done/cancelled, with due dates,
  counterparty, outcome (institutional memory). (mandate §4)

## Capabilities built on it
- Closed-loop ownership (src/cos/followups.ts): create/markWaiting/close + a deterministic `sweepOverdue`.
- Area health (src/cos/areas.ts): measurable service levels — follow-ups overdue, projects with no next
  action (no open work_item and no open follow-up) — checked against area.policy. (mandate §2, §14)
- Executive brief (src/cos/brief.ts): what Finagai completed (24h), what needs attention (overdue +
  breaches), what needs Julian (pending governance + proposed control steps). Management by exception. (§6, §15)

## Safety / compatibility
Backward compatible (projects untouched; area_id nullable). Least-privilege grants match 0003
(SELECT/INSERT/UPDATE, no DELETE). New event actor `cos`. All governance/approval gates unchanged —
employee-level autonomy still operates within defined authority.

## Evidence
Migration 0016 verified against schema-protection tests. Integration suite drives the whole loop:
area→follow-up→overdue→health breach→brief→close→healthy, and the no-next-action breach. 253 unit +
cos/db integration green.

## Next (continuing autonomously per mandate)
Scheduled brief delivery + overdue sweep (J3/scheduler), MCP tools to create/close follow-ups and read
the brief from chat, event-driven follow-up creation when an email/message is sent, reuse index.
