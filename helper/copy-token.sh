#!/usr/bin/env bash
# Copies the helper token to the clipboard for pasting into Render (CONCIERGE_HELPER_TOKEN).
set -euo pipefail
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.finagai/imessage-helper.json")))["token"],end="")' | pbcopy
echo "Helper token copied to the clipboard."
