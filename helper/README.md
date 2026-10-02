# Finagai iMessage helper (J5, ADR-044)

Runs on Julian's Mac. Watches Messages for allow-listed contacts, lets Finagai draft replies,
and sends a reply only after Julian answers `ok <code>` in his own Messages thread.

Setup (once): `bash helper/setup.sh`, then grant Full Disk Access to the node path it prints,
paste the token into Render (`bash helper/copy-token.sh`), and start it:
`launchctl load -w ~/Library/LaunchAgents/com.finagai.imessage.plist`.

Check: `node ~/.finagai/finagai-imessage.mjs --check` · Log: `~/.finagai/imessage-helper.log`
Stop: `launchctl unload -w ~/Library/LaunchAgents/com.finagai.imessage.plist`
Add a contact: re-run `bash helper/setup.sh` (keeps the token), then unload and load again.
