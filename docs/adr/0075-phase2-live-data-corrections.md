# ADR-075 — Phase 2 live-data corrections (multi-account Google, relevance, honest outcomes)

Status: Decided (implementation detail under ADR-074; no new authority, scope or data class)
Date: 2026-10-05

## Context
R01–R10 were replayed live at dd3995d against Julian's real data. Seeded tests passed; live runs did not:
- Google was connected only as vending.vendora@gmail.com; every Altarum thread is in perez.julian@correounivalle.edu.co.
  The registry reported "healthy" and nothing could reveal the gap except the account name.
- Search words were OR'd and filler ("when", "summarize", "deck") was kept: "When is my Altarum interview?" returned
  Capital One/Canva/Vercel mail as the authoritative schedule answer; "the Drive deck" returned outreach to "The Deck" bar.
- Artifacts, follow-ups and past requests ignored the request (recent move-file tests returned as Altarum "prior work").
- A Mac source that is only delegated was reported as "had nothing" and silently replaced by unrelated Drive hits;
  Resend (an action) was described as a "Mac-side source".
- The registry read Mac probes only as "PASS"; the helper sends `true`, so working capabilities showed "down".
- Interactions stayed "executing" after their tasks ended; interaction cost_usd was never written.

## Decision
1. Search every authorized Google account (GOOGLE_REFRESH_TOKEN + GOOGLE_REFRESH_TOKENS_EXTRA), label each result with
   its account, isolate per-account failures, and show all accounts in the registry probe. `helper/google-auth.mjs --extra`
   authorizes another account. Read-only scopes unchanged.
2. Search groups: entity names, else one group of content words matched together (Drive/Gmail AND within a group);
   a relevance guard drops Google results that do not mention the request's content.
3. Finagai-state sources filter by the request's content; deictic requests ("that chart") use recency, by artifact kind.
4. A delegated authoritative source stays authoritative; other sources are reported as supplements. Action capabilities
   are labeled as such. plan_resources reports `notFound` needs and which Google accounts were searched, and instructs
   the answer to say so rather than present unrelated items.
5. Mac probe booleans count as PASS. Open interactions are reconciled with their tasks (and abandoned after 6h with
   no task); J6 model calls carry the task id so interaction cost is recorded.

## Consequences
Budget enforcement is unchanged (it already reads llm_call). Adding Julian's university account requires his Google
consent (human-only). A Workspace admin policy on that account could block a third-party app; if so, it is an external
blocker to report, not to work around.

## Follow-up (live re-run after deploy, same day)
"Summarize the Degree of Leverage Analysis spreadsheet" still returned résumé JSONs (full-text AND of common words),
and Job Finder's timestamped backups filled the result slots. Now: capitalized names in the request define the subject
(descriptive words like "interview" are not required); a multi-word subject must appear in the Drive file name; a result
must contain every subject word; timestamped copies collapse to the newest.
