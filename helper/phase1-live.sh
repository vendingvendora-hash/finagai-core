#!/bin/bash
# Phase 1 live runtime tests on Julian's Mac (A restart, H soak, B reconnect). Prints doctor before/after.
set -u
D="$HOME/.finagai/finagai-doctor.mjs"
echo "== 1/5 doctor (baseline)";        node "$D"
echo "== 2/5 A: crash -> launchd restart"; node "$D" --probe-restart
sleep 20
echo "== 3/5 H: soak 20 sequential round-trips"; node "$D" --soak 20
echo "== 4/5 B: network disconnect/reconnect (Wi-Fi off 40s)"
IF=$(networksetup -listallhardwareports | awk '/Wi-Fi|AirPort/{getline; print $2; exit}')
if [ -n "$IF" ]; then networksetup -setairportpower "$IF" off && sleep 40 && networksetup -setairportpower "$IF" on && sleep 45; else echo "no Wi-Fi interface found — toggle network manually for 40s, then press Enter"; read -r; fi
echo "== 5/5 doctor (after; expect reconnects +1, restarts +1, round-trip PASS)"; node "$D"
