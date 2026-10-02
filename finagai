#!/usr/bin/env bash
# Finagai autonomous builder: ./finagai [build|resume|status|fresh]
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js 22 first: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm ci
exec npm run "finagai:${1:-build}"
