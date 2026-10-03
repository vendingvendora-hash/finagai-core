# ADR-053: Finagai looks things up by using the browser, as Julian would

- Status: Accepted (Julian, principal, 2026-10-02: "if I can access it by going into the browser, the agent should too")
- Date: 2026-10-02

## Decision
When answering a request would require opening the browser or an app — a web-only Google Drive file,
Gmail, any site, anything behind a login — J5 triage routes it to J6 instead of only trying the read-only
APIs. The J6 planner is instructed to do what Julian does: open the browser (Chrome, where he is signed
in), navigate to Drive/Gmail/the site, search the page, open the item, and read or screenshot it. open_url
opens in Chrome and waits for load so the next screenshot shows the page. Step budget raised to 80.

## Why
The read-only Drive/Gmail APIs (ADR-049/052) miss things Julian can plainly see in his browser (shared
drives, odd folders, pages behind logins). Browsing with his session removes that gap: if he can reach it,
Finagai can.

## Unchanged
Every world-changing or sending step still needs Julian's `ok`; contacts only request. Browsing and
reading are read steps and run on their own; downloading/sending/clicking destructive controls do not.
