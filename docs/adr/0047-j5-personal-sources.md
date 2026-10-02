# ADR-047: J5 consults cloud drives, Notes, Contacts, Calendar and browser history

- Status: Accepted (Julian, principal, 2026-10-02: "full access to my drive, my browsers, EVERYTHING")
- Date: 2026-10-02

## Decision
The Mac helper's lookup (ADR-046) also searches: synced cloud drives (Google Drive, iCloud Drive,
OneDrive, Dropbox under ~/Library/CloudStorage and ~/Library/Mobile Documents); Apple Notes, Contacts and
Calendar (90 days back, 180 ahead) through their apps; and browser history (Chrome, Arc, Brave, Edge,
Safari) plus Chrome-family bookmarks, read from copies of their databases. Search terms are reduced to
letters, digits and simple separators before reaching SQL or AppleScript.

## Never read
Saved passwords (Login Data), cookies and sessions, autofill and saved cards, keychains, SSH/GPG keys.
These would allow account takeover and have no drafting value. The exclusion is permanent, not a setting.

## Unchanged
Passages are scrubbed on the Mac and redacted again in Core, used for one draft only, and every reply
still needs Julian's `ok <code>`. Gmail and Google Calendar (cloud APIs) are a separate decision: they
need an OAuth grant to Finagai.
