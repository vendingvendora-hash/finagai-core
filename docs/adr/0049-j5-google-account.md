# ADR-049: J5 reads Julian's Google account (Drive, Gmail, Calendar)

- Status: Accepted (Julian, principal, 2026-10-02: "complete access to everything ... if I can do it or view it in my Mac it also can")
- Date: 2026-10-02

## Context
Julian's Google Drive lives in the browser, not on disk, so the Mac search (ADR-046/047) could not see it.

## Decision
Core holds a read-only OAuth refresh token for Julian's Google account (scopes: drive.readonly,
gmail.readonly, calendar.readonly), obtained once with `helper/google-auth.mjs` (loopback + PKCE on the
Mac; the token never passes through Claude). For each request with search terms, Core searches Drive
(full text and names, all drives; Google Docs/Sheets/Slides exported as text), Gmail and Google Calendar,
and adds the passages to the draft context with the same G09 redaction and size caps.

## Protections
Read-only scopes: Finagai cannot change, delete, share or send anything in Google. Settings are secrets in
Render (`GOOGLE_*`); revoking access is one click at myaccount.google.com/permissions. Every reply still
needs Julian's `ok <code>`. The prompt no longer claims missing access; it says when something was not found.
