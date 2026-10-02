# ADR-044: J5 ticket concierge over iMessage

- Status: Accepted (Julian, principal, 2026-10-02: "I give you written permission to do what it takes")
- Date: 2026-10-02

## Context
Julian's mother and partner text him loose ticket requests ("find me flights to Bogotá for December").
He wants Finagai to own the errand: notice the request, research options, reply as him, and adjust on
follow-ups. Everyone involved knows he uses Finagai. Finagai Core runs on Render and cannot see his Mac.

## Decision
1. **Mac helper** (`helper/finagai-imessage.mjs`, LaunchAgent, no dependencies) reads
   `~/Library/Messages/chat.db` read-only with macOS's `sqlite3`, and sends with Messages via
   `osascript` (text passed as argv, never interpolated into script source). It forwards only 1:1
   threads with allow-listed contacts (config file, mode 600).
2. **Core** stores those threads (`concierge_*` tables, migration 0011) and, when the newest message is
   from the contact, drafts Julian's reply with Claude plus Anthropic web search (`MODEL_J5_CONCIERGE`,
   at most `CONCIERGE_MAX_SEARCHES` searches). Calls are metered under the same $30/$36 caps (ADR-034).
3. **Approval in Julian's own Messages thread.** The helper shows each draft to Julian (note-to-self
   thread) with a short code. Nothing is sent until Julian replies `ok <code>`, `edit <code> <text>`
   or `no <code>`. Core approves a draft exactly once; a newer request supersedes an unanswered draft.
4. **Scope limits:** a reply can only go to the contact whose message created the draft, and the helper
   re-checks the allow-list before sending. Core has no payment capability; the prompt forbids claiming
   a purchase. Thread text is treated as data (prompt-injection resistant by construction: the worst
   a malicious message can do is produce a draft Julian sees before anything is sent).
5. **Credential:** `CONCIERGE_HELPER_TOKEN` (32+ chars, generated on the Mac, stored on Render). It is
   accepted only on `/concierge/*`; `/mcp` and `/approve/*` never accept it. Unset means J5 is off.

## Why the approval is a Messages reply and not a passkey
The protected action is "send an iMessage as Julian". Anyone who controls Julian's Messages can already
do that, so a reply in his own thread is exactly as strong as the action, and it works from his phone
with no extra step. Governance changes to Finagai's own state still require the passkey (ADR-030).

## Consequences
- Family messages are third-party data (ADR-022). Stored only for allow-listed contacts; review and
  retention follow `RETENTION_CONFIDENTIAL_THIRD_PARTY_DAYS` (purge job is a follow-up).
- The web-search cost bound is an allowance, not a proof like other calls (search results are
  unbounded input); `max_uses` and the per-call $1 ceiling keep a single draft well under $1.
- Requires on the Mac: Full Disk Access for the node binary, and Automation permission for Messages.
- Unattended auto-send (no approval) is not enabled; it would need a new decision.
