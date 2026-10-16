# ADR-090 — Experience System read models (E0): A5 ontology, health and contract corrections

Status: A5 approved by Julian on 2026-10-16 ("A5 only, under the previously agreed scope"). A1–A4, A8 not started; A6/A7 and any Mac approval-policy change excluded.
Authority: `FINAGAI_E0_AUTHORIZATION_PACKAGE.md` (project doc) is the approved scope; `FINAGAI_EXPERIENCE_SYSTEM_SPEC_v1.md` §19 holds the binding E1 requirements. This ADR records implementation decisions and deviations only.

## A5 — what changed and why (hotfix 49)

Seven confirmed defects, each with a regression test in `test/unit/a5-ontology.test.ts` written against the real writer.

**Read side (`src/live/ontology.ts`, `http.ts`, `acceptance.ts`): history is reclassified, no row changes.**
1. `control_step_proposed` reads the stored `approval` field (`pipelines/j6/control.ts`). `needsApproval` never existed on a row. **No risk fallback:** the first J6 writer (`cc665da`, 2026-10-03) already stored `after.approval` as a boolean, and release #1 was 2026-10-04, so every production row carries it; a row without it (none expected) classifies as `task.step_proposed` with `nextOwner: null`, an unknown approval state, never an invented authority boundary. Effect: a `run` step that waited for Julian (tasks 137/138, `sw_vers`) is `authority.boundary_encountered` / `julian`; a write-risk step auto-approved inside the envelope is `task.step_proposed` / `finagai`. Tested separately for the four cases (read+asked, write+auto, write+asked, read+auto) and for the absent field.
2. `control_step_approved|rejected|ran|failed` → `task.step_approved|step_rejected|step_ran|step_failed`; `status_change` (a work item done from a capture) → `task.state_changed`. All five were `other.*` because they are written through ternaries the test scanner could not see.
3. Ten rules with no writer were removed (`recover`, `terminal`, `set_due`, `archive_records`, `resolve_conflict`, `decide_proposal`, `promote_seed_batch`, `confirm`, `route`, `ignore`): the scanner had matched decision and request kinds, not events. `workflow_ran` (2026-10-09 to 10-11) and `followup_reply_received` (2026-10-09) are kept as `LEGACY_ACTIONS` so stored history classifies.
4. `knowledge_item`: `create` classifies by the stored `epistemic_status` — `inference|hypothesis` → `inference.created`; `fact|user_provided|documented_claim` → `knowledge.created`; absent or `unknown` → `knowledge.unclassified` (seeded rows store no status; a guess is never shown as a fact). `update` → `knowledge.updated`, `supersede` → `knowledge.superseded`. New domain `knowledge`, added to the self-check's state domains.
5. `control_task_done.verified` reads `after.verification_status`: verified → true, unverified and needs_review → false (the two stay distinguishable by the status itself, which the envelope's sanitized `after` keeps). Fallback for rows written since hotfix 35: `terminal_reason === 'verified'` → true. The fallback cannot upgrade an unverified or needs-review completion, because that path sets `terminal_reason = 'verifier_unavailable'` first and completion only `COALESCE`s a null reason (`control.ts`). Rows older than hotfix 35 stay `null`.
6. The contract's domain list is derived from one exported `DOMAINS` array (`system` and `knowledge` were emitted but undeclared).

**Writer side (event content; no schema change, no backfill).**
7. `control_task_done` carries `verification_status` in its context. The column was set before the `before` snapshot, so the transition diff dropped it.
8. `area_health_changed` uses `areaStatusRead` (green / yellow / red, the snapshot's verdict) instead of `areaHealth` (green / red), and stores `warnings` beside `breaches`. The stream and the snapshot can no longer disagree. Old two-colour events stay valid: the classifier treats `color` as text and only red hands the Area to Finagai.

**Test scanner.** `writtenActions()` now reads the `action:` expression of every `appendEvent`, `recordTransition` and `recordBulkTransitions` call and the first argument of every capture `ev(...)`, taking every ternary branch and only ternary branches (compared values such as `status === "approved"` are not actions). Two new invariants: every rule has a writer or is declared legacy; the contract advertises exactly the domains the ontology emits.

**Contract version.** Unchanged at 2: no snapshot or envelope field changed; classes and the domain list are declared evolvable (ADR-087). The bump to 3 arrives with A1 (snapshot fields).

**Command Center.** No code change. `command/test/unit/units.test.ts` replays Mac task 138 under both the old and the A5 classes; every title, ownership and open/done verdict is identical. The two `other.*` label entries in `units.ts` are now dead but harmless.

**Deviation from the package.** `test/integration/live.test.ts` pinned the baseline Area colour to green; under A5 the fixture (no open objective) is yellow with that warning. The assertion now states the real invariant: the colour and warnings on the stream equal the snapshot's.

## Production acceptance for A5 (to run after hotfix 49; all read-only, no synthetic events)
1. Core and Command live on the hotfix 49 SHA; MCP digest `bb1861cd165d` unchanged.
2. `/live/contract` lists `system` and `knowledge` among the domains; `v` is 2.
3. `/live/history?entityType=control_step&entityId=<step 407>`: event 2760 is `authority.boundary_encountered` with `nextOwner: julian`; 2767 `task.step_approved`; 2769 `task.step_ran`. Event 2771 (`control_task_done`) reads `verified: true` through the `terminal_reason` fallback. Every production `control_step_proposed` row carries `after.approval` (count of rows without it = 0).
4. No `other.*` class in the last 30 days of history except actions written before their rule existed (none expected).
5. Area health: pre-A5 `area_health_changed` events are two-colour and may legitimately differ from today's snapshot (state moved since they were written), so they are **not** compared. Agreement is verified only on a genuine new event emitted by a tick after deployment: its `color` and `warnings` must equal `/live/snapshot` `areas[].health` for that Area at that time. If no Area's verdict changes during the acceptance window, this live check is reported as **unobserved**, and the integration fixture (`live.test.ts`: stream equals snapshot on a fresh database) stands as the evidence. No event is created to force it.
6. Hourly self-check (ADR-087) and the canary stay green across two cycles; `/live/summary/reliability` healthy.
7. Command: the Beth Young and task 138 stories render unchanged; the Why inspector chains 2408→2416 and 2755→2773 equal `/live/chain`; 10 read rounds write 0 events.
