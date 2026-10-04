#!/usr/bin/env bash
# One-time setup for the Finagai iMessage helper (ADR-044). Run from the finagai-core folder:
#   bash helper/setup.sh
set -euo pipefail

DIR="$HOME/.finagai"
CFG="$DIR/imessage-helper.json"
PLIST="$HOME/Library/LaunchAgents/com.finagai.imessage.plist"
NODE="$(command -v node)"
NODE_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$NODE")"

mkdir -p "$DIR"
cp "$(dirname "$0")/finagai-imessage.mjs" "$DIR/finagai-imessage.mjs"
cp "$(dirname "$0")/mac-perception.mjs" "$DIR/mac-perception.mjs"   # required module; missing it crashed the helper
cp "$(dirname "$0")/finagai-doctor.mjs" "$DIR/finagai-doctor.mjs"   # finagai mac doctor (real probes)
cp "$(dirname "$0")/mac-actions.mjs" "$DIR/mac-actions.mjs"         # WO4 accessibility-first actions
cp "$(dirname "$0")/fs-ops.mjs" "$DIR/fs-ops.mjs"                   # Phase 1B verified file operations

echo
echo "=== Finagai iMessage helper setup ==="
echo "Your own iMessage address: the phone number (with +1) or Apple ID email you text yourself at."
read -r -p "Your own iMessage address: " SELF
CONTACTS="["
echo
echo "Now the people Finagai may answer for you. Use the phone number exactly as in Messages (e.g. +13015551234)."
while true; do
  read -r -p "Name (e.g. Mom), or press Enter to finish: " LABEL
  [ -z "$LABEL" ] && break
  read -r -p "  $LABEL's phone number or iMessage email: " HANDLE
  CONTACTS="$CONTACTS{\"label\":\"$LABEL\",\"handle\":\"$HANDLE\"},"
done
CONTACTS="${CONTACTS%,}]"

if [ -f "$CFG" ] && TOKEN="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$CFG" 2>/dev/null)"; then
  echo "Keeping the existing helper token."
else
  TOKEN="$(openssl rand -hex 32)"
fi

umask 077
cat > "$CFG" <<JSON
{"coreUrl":"https://finagai-core.onrender.com","token":"$TOKEN","selfHandles":["$SELF"],"contacts":$CONTACTS}
JSON
chmod 600 "$CFG"

cat > "$PLIST" <<PLISTXML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.finagai.imessage</string>
  <key>ProgramArguments</key><array><string>$NODE_REAL</string><string>$DIR/finagai-imessage.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/imessage-helper.log</string>
  <key>StandardErrorPath</key><string>$DIR/imessage-helper.log</string>
</dict></plist>
PLISTXML

echo
echo "Done. Three things left:"
echo " 1. When Claude opens the Render page, copy the helper token with:  bash helper/copy-token.sh"
echo "    and paste it as the value of CONCIERGE_HELPER_TOKEN. Do not paste it anywhere else."
echo " 2. Give Full Disk Access to this program, so it can read Messages:"
echo "    $NODE_REAL"
echo "    System Settings opens now: click +, press Cmd+Shift+G, paste the path above, Open."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" || true
printf %s "$NODE_REAL" > "$DIR/node-path.txt"
echo " 3. Then start it:  launchctl load -w \"$PLIST\""
echo "    Check it:       node \"$DIR/finagai-imessage.mjs\" --check"
