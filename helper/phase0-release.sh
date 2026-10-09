#!/bin/bash
# Phase 0 release (ADR-076). Order: push -> GitHub "release" asks Julian to approve migration 0024 -> Core live on this SHA
# -> THEN install helper runtime-13 (all runtime modules) -> restart -> doctor.
set -euo pipefail
cd "$HOME/Downloads/finagai-core"
git pull "$HOME/Downloads/finagai-phase0.bundle" HEAD
git push origin main
SHA=$(git rev-parse --short=7 HEAD)
echo "Pushed $SHA. Approve the 'migrate' job in GitHub Actions (release workflow) when it asks. Waiting for Core…"
for i in $(seq 1 120); do
  if curl -fsS https://finagai-core.onrender.com/health | grep -q "\"version\":\"$SHA"; then echo "Core is live on $SHA"; break; fi
  sleep 15; [ "$i" = 120 ] && { echo "Core did not reach $SHA in 30 min — stopping before touching the helper"; exit 1; }
done
for f in finagai-imessage.mjs mac-perception.mjs mac-actions.mjs fs-ops.mjs finagai-doctor.mjs; do cp "helper/$f" "$HOME/.finagai/$f"; done
launchctl kickstart -k "gui/$(id -u)/com.finagai.imessage"
echo "Helper runtime-13 installed; waiting 30s for its first heartbeat…"; sleep 30
grep -m1 -o 'runtime-1[0-9]' "$HOME/.finagai/finagai-imessage.mjs"
tail -3 "$HOME/.finagai/imessage-helper.log"
echo "DONE."
