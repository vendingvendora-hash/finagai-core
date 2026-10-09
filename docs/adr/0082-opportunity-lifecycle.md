# ADR-082 — Phase 4: the opportunity lifecycle Finagai owns (job search as the golden vertical)

Status: Decided (builder, under Julian's 2026-10-09 mandate)
Date: 2026-10-09

## Context
Bootstrap #45 was applied: 400 job records, 133 per-job events, 7 per-job projects, and the objective. The job search
is the golden vertical used to prove general capabilities. It is not Finagai's purpose.

The audit's 21-step job-search case still had these gaps:
- **No ongoing ownership after the import.**
  - Career went red because 5 of 7 projects had no next action.
  - Two bootstrap follow-ups were already overdue when they were created.
- **No answers to "have I applied to X?" or "where am I with all applications?"** Nothing deduplicated a new posting against what Julian had already applied to.
- **Nothing recorded an application** when Julian submits one.
- **New email had to go through another bootstrap** before it changed any state.

## Decision
1. **Lifecycle policy** (`src/cos/lifecycle.ts`). It is pure: no clock and no I/O, and its numbers are data (CAREER_POLICY), so other opportunity kinds can reuse it.
   - **Status only moves forward.** A terminal outcome is never reopened; a later event becomes an anomaly for Julian. An offer cannot be undone by an automated rejection.
   - **Every engaged job has exactly one next step**, with an owner and a date:
     - Preparing: Julian finishes and submits.
     - Applied: waiting on the employer for 14 days. After that, if a named contact exists, it becomes Julian's decision ("nudge or let it ride") until day 30. With no contact, the project closes quietly and the job stays in the pipeline as applied.
     - Interviewing: waiting 7 days after the last contact, then Julian follows up (Finagai can draft it).
     - Offer: Julian answers.
     - Terminal: the project closes and nothing is left waiting.
2. **Reconcile** (`src/cos/opportunities.ts`). It makes the stored state match the policy for each job:
   - Engaged jobs get per-job projects.
   - The engine replaces only its own follow-ups and the bootstrap's (`followup.origin`/`rule`, migration 0030). Julian's own commitments are never replaced.
   - When the employer has exactly one live job, Julian's own area-level "waiting on Beth" follow-up is linked to that job instead of being duplicated.
   - Every change is written as an event. A dry run computes the same changes and rolls them back.
3. **Find, pipeline, track and record** (MCP: `find_opportunity`, `pipeline`, `track_opportunity`, `record_opportunity_update`). These use ADR-081 identity:
   - **Matching.** A posting matches an existing job by requisition, LinkedIn id, dedupe key, or the same employer and title.
   - **Ambiguity.** If a title exists under several requisitions, Finagai asks which one; it never guesses.
   - **Existing jobs.** An existing job is reported as already applied.
   - **Recording.** A recorded event moves exactly one job.
4. **Evidence sync** (`sync_career`, `src/cos/career-sync.ts`). It runs the same deterministic acquisition and interpretation as the bootstrap (ADR-080/081), then reconciles against the applied state:
   - New source records become events on the job they name, and status moves forward.
   - New jobs are created.
   - Backward or reopening evidence and identity collisions become decisions. They are never written.
   - Unassigned employer events are reported.
   - Every change lists the source records behind it.
   - An incomplete acquisition writes nothing.
   - Pending bootstrap proposals are discarded once state is applied.
5. **J6 golden workflow.**
   - **Recording the posting.** `record_opportunity` is a step Core runs itself; it never reaches the Mac. It counts as Finagai's own bookkeeping, so the authority class is OBSERVE. It records the posting the planner read and links the task to the job. If Julian already applied, it tells the planner to stop.
   - **Recording the application.** An EXTERNAL_COMMITMENT step that Julian approved and whose read-back is **verified** ("Submit application") is recorded as that job's application. An unverified click records nothing.
   - **Test postings.** Finagai's own fixture URLs go to the "Finagai Test" area and never into Career.
6. **Executive brief and planner.**
   - The brief shows Julian's lifecycle decisions and the last sync's undecided items under Decisions, and per-job status moves and closed projects under Changes.
   - `plan_resources` routes application and job questions to `state.opportunities` (a new registry capability) before Gmail.

## Evidence
- Unit: lifecycle policy (10 tests, using the live dates of the 7 projects); authority (record_opportunity = OBSERVE).
- Integration: a fresh database built from the real 2026-10-09 evidence, with the bootstrap applied. Tests cover:
  - A preview equals the real run and writes nothing; a second tick changes nothing.
  - Altarum keeps Julian's own follow-up.
  - Amazon 10471926 waits until 10/19.
  - No project is left without a next action.
  - Amazon is separate jobs, and one requisition is found exactly.
  - Tracking an existing requisition reports ALREADY; tracking a new posting creates it once; an ambiguous NACF title asks.
  - A rejection changes only one Amazon job.
  - Sync of the same evidence produces 0 changes; one new email produces exactly one change attributed to its id (and the preview writes nothing); then 0 again.
  - An incomplete acquisition writes nothing.
  - J6: the core step never reaches the helper; the fixture posting lands in the test area; a verified approved submit records the application; an unverified one records nothing.

## Consequences
- Phase 5 (events) adds triggers that call `sync_career` and the lifecycle tick; Phase 4 runs them on demand.
- Tailored resumes and cover letters stay in chat, with Finagai recording `resume_ref`. Learning from outcomes is Phase 6.
- Migration 0030 is additive. It marks the existing bootstrap follow-ups (ASR, KTech) as the bootstrap's, so the lifecycle may replace them.
