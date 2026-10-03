# ADR-056/057: Mac task results return to the chat; expanded skill library

- Status: Accepted (Julian, principal, 2026-10-02)
- Date: 2026-10-02

## Result return path (ADR-056)
A J6 task now stores result_summary and result_detail on completion (migration 0014). result_detail
accumulates what the read steps found. A new MCP tool `control_result` lets the chat that started a task
(or any chat) read its status and, when done, the summary + gathered detail — so the chat can use the
findings (e.g. build a chart) instead of the answer only appearing in Julian's iMessage thread. The
planner is instructed to put the actual answer (numbers, file name, facts) in read-step results and in
the final summary. Messaging Finagai over iMessage is unchanged.

## Expanded skills (ADR-057)
The skill library grows from 4 to 10 playbooks, injected by request type: find-in-drive (multi-account),
read-or-build-spreadsheet (gather numbers for charts), read-gmail, calendar, fill-a-form/job-application,
make-a-doc, download-a-file, organize-files, research-web, and a Vendora-specific play (check the separate
Vendora Google account). Each encodes a concrete, reliable procedure and the relevant safety stops.

## Unchanged
All approval gates (reads free; send/pay/delete/run + send-intent need Julian's ok; passwords/pay/consent
always stop). Opus planner, extended thinking, plan-act-reflect and richer perception from ADR-055 remain.
