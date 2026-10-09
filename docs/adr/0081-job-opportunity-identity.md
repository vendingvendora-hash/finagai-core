# ADR-081 — Career opportunities are jobs, not employers

Status: accepted (2026-10-09). Refines ADR-080 (interpretation only; acquisition unchanged).

## Context
ADR-080 made the Career bootstrap reproducible, but modelled one opportunity per employer. Real evidence has many jobs per
employer (Amazon: 6+ requisitions; Vallum Associates: a rejected and a live application; Transurban: an applied posting and
a different saved posting), so one rejection could close unrelated roles and a new application could "reopen" a rejected one.

## Decision
* **Employer** is a shared entity (`employer`: canonical key, name as the evidence spells it, aliases, party =
  employer / recruiter_or_staffing / job_board_or_recruiter with the evidence-based reason; never hand-renamed).
* **Opportunity = one job/application.** Identity: employer → requisition id when the record carries one
  ("(ID: 10471926)", "req #120088", "R00336590", "R2026-2409") → job title (normalized) → location only when the same title
  exists at several locations. LinkedIn job cards ("title / company / location") and rejection subjects provide titles.
* An event that names no job attaches only when the employer has exactly one job in evidence (or one Career Copilot row);
  otherwise it is kept as an **unassigned employer event** with the reason, and changes nothing.
* A Career Copilot row links to a job only on an exact normalized-title match with exactly one job; otherwise it stays its own
  record. Sheet duplicates are merged visibly (reported with the row they merged into).
* Per-job state machine; terminal outcomes are final for that job (a later application to it is an anomaly, never a reopen).
  New event kinds: `started` (Amazon "keep track"/"incomplete" → preparing), `posting_closed` (→ closed), `withdrawal`.
* Every job carries its own status, event history (`opportunity_event`), evidence ids, contact, dates, source ids, project
  and follow-up. Alias keys shared by two jobs are dropped from both, and `apply` merges only on an exact key or a single
  unambiguous alias — no job can be merged into another.
* Proposals stay read-only; `apply_bootstrap` (approval) is the only writer. `reinterpret` re-runs a stored snapshot through
  the current interpreter into a new proposal without acquiring or writing Career state.
