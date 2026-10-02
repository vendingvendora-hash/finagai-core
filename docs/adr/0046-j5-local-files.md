# ADR-046: J5 may consult Julian's own files on his Mac

- Status: Accepted (Julian, principal, 2026-10-02: "give it full access to all my data in the PC ... infer and open a file if needed")
- Date: 2026-10-02

## Decision
Before drafting, J5 runs a short triage call that decides whether a reply is needed and whether Julian's
own files could help, returning up to 3 Spotlight search phrases. The Mac helper (which already has Full
Disk Access) runs `mdfind` in Julian's home folder, extracts text (plain text, Word/RTF/HTML via
`textutil`, PDF via PDFKit), keeps only the passage around the matched words (3,000 chars per file, at
most 6 files), and sends those passages to Core, which drafts with them plus web search.

## Protections
- Never searched: ~/Library, hidden folders, Applications, Trash, key/keychain/password/database files,
  the Finagai repository.
- Scrubbed on the Mac before sending (credential lines, SSN-like and long card/account-like numbers) and
  redacted again in Core with the G09 sensitive detector before any model call.
- Passages are used for that one draft only; Core does not store them.
- The prompt forbids putting credentials, account/ID numbers, tax or health details into a reply unless
  the person clearly needs that exact item. Every reply still needs Julian's `ok <code>`.

## Consequences
One extra small model call per message (triage), which also saves cost by skipping messages needing no
reply. Excerpts of Julian's files reach Anthropic's API (same processor as all Finagai model calls).
