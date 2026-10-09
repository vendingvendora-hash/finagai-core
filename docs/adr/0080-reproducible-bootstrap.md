# ADR-080 — Reproducible Career bootstrap: acquisition separated from interpretation

Status: accepted (2026-10-09). Supersedes the bootstrap discovery path of ADR-079.

## Context
Three live bootstrap proposals within 18 minutes disagreed: Immuta (evidence 10/05–10/06) and Transurban (10/02)
appeared and disappeared although every record pre-dated every run. Empirical diagnosis:

1. **Ranked top-N acquisition.** Discovery reused the chat retrieval path: Gmail `maxResults=25` newest per term, a relevance
   score that demotes LinkedIn/no-reply senders, then the top 8. Each newly arrived application email displaced older evidence.
2. **Swallowed failures.** `.catch(() => [])` per source; the multi-account fan-out kept only successes; a failed profile probe
   relabelled an account. A 429 silently removed evidence.
3. **Code changed between runs** (hotfixes 3 and 4) and proposals recorded neither inputs nor code version.
4. **Interpretation errors that no ordering fix would cure:** Gmail snippets are HTML-escaped (`we&#39;ve made the decision`),
   so Immuta's rejection was invisible; LinkedIn's rejection email is titled "Your application to <role> at <org>" and is
   only identifiable by its body/template (`jobs_application_rejected_01`) — Transurban (10/02) and Vallum Associates (08/27)
   were rejections read as applications; several ATS rejections (Cvent "Thank You For Applying", JHU, Accenture, Window Nation)
   are only in the body.
5. The acquisition window rolled with the clock.

## Decision
* **Acquire** exhaustively: fixed queries, fixed epoch (`after:2026/06/01`), full pagination, every message's headers + snippet
  + deterministic body text + template ids, retry on 429/5xx, every per-account/per-query outcome recorded (pages, ids,
  truncation, vanished). Any failure ⇒ snapshot `complete=false` ⇒ proposal not applicable.
* **Carry-forward:** every Gmail record of the previous complete snapshot that no search returns is re-fetched by id; it can only
  leave the evidence set if deleted/trashed at source (recorded with the reason).
* **Freeze:** the snapshot is stored content-addressed (`evidence_snapshot`, digest over records + sheet bytes + window); every run
  is an `evidence_acquisition` row with the exact record ids it saw.
* **Interpret** with a pure function (no model, no clock — as-of date is an input, no I/O): deterministic classifier, ordered org
  rules, alias resolution, event-driven state machine (rejection terminal; a new application reopens; "viewed" never reopens).
* **Prove:** each proposal stores snapshot digest, interpretation digest, opportunity-set digest and interpreter version, plus a
  record-level delta against the previous snapshot; every opportunity change must be explained by specific record ids or sheet
  rows, otherwise the proposal is marked not applicable ("unexplained change").
* **Stable identity:** opportunities upsert by any alias key; nothing is deleted.
* Diagnostics: `bootstrap_trace`, `bootstrap_replay`, `bootstrap_stability` (+ `diagnostic_result`), and the read-only
  `finagai-job:` channel through `control_mac` for surfaces with an older tool list.

## Consequences
Acquisition is heavier (full message bodies, ~300 messages per run). Granularity is still one opportunity per organization;
multiple requisitions at one employer (Amazon) are folded into the latest state.
