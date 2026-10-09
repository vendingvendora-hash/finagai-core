#!/bin/bash
# Finagai Operator — browser channel install (Phase 1, ADR-077). Run from the repo root on Julian's Mac.
# Registers the native-messaging host for Chrome (+ Arc/Edge/Brave if present) and Firefox, and copies the
# extension builds to ~/.finagai/browser-ext/. It does NOT install the extensions themselves — the browsers
# require Julian to do that (instructions printed at the end). No credentials are read or written.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
DEST="$HOME/.finagai"
mkdir -p "$DEST/browser-ext"
node "$ROOT/browser-ext/build.mjs" >/dev/null
rm -rf "$DEST/browser-ext/chrome" "$DEST/browser-ext/firefox"
cp -R "$ROOT/browser-ext/build/chrome" "$ROOT/browser-ext/build/firefox" "$DEST/browser-ext/"
cp "$ROOT/helper/browser-host.mjs" "$ROOT/helper/browser-bridge.mjs" "$DEST/"
( cd "$DEST/browser-ext/firefox" && rm -f ../finagai-operator-firefox.zip && zip -qr ../finagai-operator-firefox.zip . )
# Harmless upload fixture for live acceptance tests (outside protected paths like ~/.finagai and the repo).
mkdir -p "$HOME/Documents/Finagai Test"
cp "$ROOT/test/browser/fixtures/Julian_Perez_Resume_TEST.pdf" "$HOME/Documents/Finagai Test/Julian_Perez_Resume_TEST.pdf"
cat > "$DEST/browser-host.sh" <<HOST
#!/bin/bash
exec "$NODE" "$DEST/browser-host.mjs" "\$@"
HOST
chmod 755 "$DEST/browser-host.sh"
CHROME_ID="fmeaonnombfgboeklgmkgmlbcjdbbbgg"
chromium_manifest() { cat <<JSON
{ "name": "com.finagai.browser", "description": "Finagai Operator native channel", "path": "$DEST/browser-host.sh", "type": "stdio",
  "allowed_origins": ["chrome-extension://$CHROME_ID/"] }
JSON
}
for d in "Google/Chrome" "Chromium" "Arc/User Data" "Microsoft Edge" "BraveSoftware/Brave-Browser"; do
  base="$HOME/Library/Application Support/$d"
  if [ -d "$base" ] || [ "$d" = "Google/Chrome" ]; then mkdir -p "$base/NativeMessagingHosts"; chromium_manifest > "$base/NativeMessagingHosts/com.finagai.browser.json"; echo "registered host for $d"; fi
done
mkdir -p "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
cat > "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/com.finagai.browser.json" <<JSON
{ "name": "com.finagai.browser", "description": "Finagai Operator native channel", "path": "$DEST/browser-host.sh", "type": "stdio",
  "allowed_extensions": ["operator@finagai.local"] }
JSON
echo "registered host for Firefox"
cat <<MSG

Now install the extension in each browser (one time):
  CHROME:  open chrome://extensions → turn on "Developer mode" (top right) → "Load unpacked" → choose
           $DEST/browser-ext/chrome      (extension id must read $CHROME_ID)
  FIREFOX: open about:debugging#/runtime/this-firefox → "Load Temporary Add-on…" → choose
           $DEST/browser-ext/firefox/manifest.json
           then about:addons → Finagai Operator → Permissions → allow "Access your data for all websites".
           (Temporary until Firefox restarts; a signed permanent build needs a Mozilla add-ons API key.)
MSG
