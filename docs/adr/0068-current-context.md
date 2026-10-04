# ADR-068 — Current-context awareness (WO3)
**Decided by:** Julian ("Finagai must know what I'm looking at")

Gathering is deterministic and local (helper, every heartbeat): frontmost app, active window, open document
path (Excel/Numbers/Preview/Pages/Word/PowerPoint via scripting), selected Finder items, active browser tab
(app/url/title). Clipboard is excluded by default. Stored as an ephemeral `mac_runtime.context` snapshot
(migration 0021), overwritten each heartbeat — never a history.

Resolution is deterministic (`src/mac/context.ts`): explicit kinds (spreadsheet/page/file/last chart) first,
then the focused thing (document → tab → single selection → window), with recent artifacts for "that".
`ambiguous:true` only when two high-confidence referents tie. Tools: `mac_get_context`, `resolve_reference`.
U1–U6 locked as unit cases; the same cases run on the real Mac post-deploy.
