# ADR-061: Interaction reliability — durable artifacts, inbound idempotency, send fast-path

- Status: Accepted (Julian, principal: interaction-reliability mandate)
- Date: 2026-10-03

## Problem (from Julian's screenshot)
Chart was made; "send Santiago" replied "no recent chart". Root cause: last-chart lived in process/file
state that didn't reliably survive. Also: risk of duplicate inbound processing and duplicate replies.

## Decision
- Durable **artifact registry** (migration 0017): every chart/screenshot/file Finagai makes is registered
  (kind, storage_ref, summary, conversation, state). "send <contact>" / "send that" resolves the most
  recent ready artifact from the DB — survives helper/process restart. Marked 'sent' after forwarding.
- Inbound **idempotency ledger**: each iMessage GUID is claimed via INSERT ON CONFLICT; a duplicate
  delivery is refused, so a message never processes twice. A stale claim (lease expired) is reclaimable,
  so a crashed worker's message is recovered rather than lost.
- Helper: registers the chart on creation; `send <contact>` resolves durably (falls back to local file);
  the fast-path `send` command is claimed-by-GUID and finished immediately to prevent duplicate replies.

## Evidence
test/integration/interaction.test.ts: I08/I09 (send resolves the chart across a simulated restart),
I03 (duplicate GUID claimed once, done never re-executes), I05 (expired claim recovered). 253 unit +
interaction/cos/mcp integration green; migration verified against schema-protection tests.

## Unchanged
All approval/governance gates. Least-privilege grants match 0003.
