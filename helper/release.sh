#!/bin/bash
# Combined release (Phases 0–3, ADR-076..079): migrations 0024–0026 (ONE approval in GitHub), Core, helper runtime-14, browser channel.
# Order: push -> Core live on this SHA -> helper runtime-14 (+ bridge/host) -> register native hosts -> restart.
set -euo pipefail
cd "$HOME/Downloads/finagai-core"
git pull "$HOME/Downloads/finagai-release.bundle" HEAD
git push origin main
SHA=$(git rev-parse --short=7 HEAD)
echo "Pushed $SHA. If GitHub asks to approve a migrate job, approve it. Waiting for Core…"
for i in $(seq 1 120); do
  if curl -fsS https://finagai-core.onrender.com/health | grep -q "\"version\":\"$SHA"; then echo "Core is live on $SHA"; break; fi
  sleep 15; [ "$i" = 120 ] && { echo "Core did not reach $SHA in 30 min — stopping before touching the helper"; exit 1; }
done
for f in finagai-imessage.mjs mac-perception.mjs mac-actions.mjs fs-ops.mjs finagai-doctor.mjs browser-bridge.mjs browser-host.mjs; do cp "helper/$f" "$HOME/.finagai/$f"; done
bash helper/browser-install.sh
launchctl kickstart -k "gui/$(id -u)/com.finagai.imessage"
echo "Helper restarted; waiting 30s…"; sleep 30
grep -m1 -o 'runtime-1[0-9]' "$HOME/.finagai/finagai-imessage.mjs"
grep -E "browser bridge listening|browser extension connected" "$HOME/.finagai/imessage-helper.log" | tail -3 || true
