# Finagai iMessage helper (J5, ADR-044)

Runs on Julian's Mac. Watches Messages for allow-listed contacts, lets Finagai draft replies,
and sends a reply only after Julian answers `ok <code>` in his own Messages thread.

Setup (once): `bash helper/setup.sh`, then grant Full Disk Access to the node path it prints,
paste the token into Render (`bash helper/copy-token.sh`), and start it:
`launchctl load -w ~/Library/LaunchAgents/com.finagai.imessage.plist`.

Check: `node ~/.finagai/finagai-imessage.mjs --check` · Log: `~/.finagai/imessage-helper.log`
Stop: `launchctl unload -w ~/Library/LaunchAgents/com.finagai.imessage.plist`
Add a contact: re-run `bash helper/setup.sh` (keeps the token), then unload and load again.

## J6 Mac control (ADR-050)
Finagai can operate the Mac: ask it in a Claude chat ("Finagai, open X and do Y") or it runs a task you
started. It works one step at a time; anything that changes or sends something arrives in your own
Messages thread as "🖐 Finagai wants to: …  ok <code> / no <code> / stop <code>". Read-only steps
(looking at the screen, reading a file) run on their own. Passwords, payments and "I agree" stay with you.
Needs macOS Accessibility permission for the node binary (System Settings → Privacy & Security →
Accessibility) in addition to Full Disk Access.
