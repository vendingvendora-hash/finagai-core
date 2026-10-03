# ADR-054: J6 runs navigation on its own; only consequential steps confirm

- Status: Accepted (Julian, principal, 2026-10-02: "I don't want it to ask me for everything")
- Date: 2026-10-02

## Problem
J6 asked Julian to approve every write step, including harmless navigation (opening a Drive folder,
clicking, typing, scrolling). A task also looped on the same step because it couldn't tell it had made
progress, producing dozens of identical approval prompts.

## Decision
- Tasks default to AUTO mode: navigation and input (click, double/right click, move, drag, scroll, type,
  key, hotkey, open_app, open_url) run without approval.
- Approval is still required for: sending/posting (send/enviar/mandar/post/publish/reply all),
  paying/buying, deleting/moving files, running shell commands (`run`), and any step whose summary shows
  such intent, in English or Spanish. Messaging a contact always confirms.
- Loop guard: if the same action (kind+summary) is proposed a third time within the last four steps, J6
  stops and asks Julian instead of repeating.
- Planner prefers reliable navigation: open Drive/Gmail/site via a search URL and read the loaded page,
  rather than clicking through a web UI; never repeat an action that didn't change the screen.

## Unchanged
Reads run freely; the irreversible/sending actions above always stop for Julian; contacts only request.
