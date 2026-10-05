#!/bin/bash
# One command for the Phase 1 release. Order is enforced: push -> (migration approval + deploy) -> Core reports
# this exact SHA -> THEN update the Mac helper (the new helper needs the new routes) -> runtime tests.
set -euo pipefail
cd "$HOME/Downloads/finagai-core"
git pull "$HOME/Downloads/finagai-phase1-final.bundle" HEAD
git push origin main
SHA=$(git rev-parse --short=7 HEAD)
echo "Pushed $SHA. Waiting for Core to report it (GitHub Actions 'release' will ask for the migration approval)…"
for i in $(seq 1 120); do
  if curl -fsS https://finagai-core.onrender.com/health | grep -q "\"version\":\"$SHA"; then echo "Core is live on $SHA"; break; fi
  sleep 15; [ "$i" = 120 ] && { echo "Core did not reach $SHA in 30 min — stopping before touching the helper"; exit 1; }
done
cp helper/finagai-imessage.mjs helper/fs-ops.mjs helper/mac-actions.mjs helper/finagai-doctor.mjs "$HOME/.finagai/"
launchctl kickstart -k "gui/$(id -u)/com.finagai.imessage"
echo "Helper updated; waiting 25s for its first heartbeat…"; sleep 25
bash helper/phase1-live.sh 2>&1 | tee "$HOME/.finagai/phase1-live.out"
echo "DONE — results saved to ~/.finagai/phase1-live.out (Finagai can read them)."
