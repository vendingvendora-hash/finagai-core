#!/usr/bin/env bash
# Real-model J3 evaluation against a disposable LOCAL Postgres (J3 reads the whole state, so every
# case gets its own fresh database). Requires ANTHROPIC_API_KEY in the environment (never in Claude).
set -euo pipefail
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY in your shell (evaluation key)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
PORT="${EVAL_PG_PORT:-54340}"
WORK="$(mktemp -d)"; chmod 777 "$WORK"
as_pg() { if [[ "$(id -u)" == "0" ]]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
trap 'as_pg "\"$PGBIN/pg_ctl\" -D \"$WORK/data\" -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
as_pg "'$PGBIN/initdb' -D '$WORK/data' -U postgres --auth=trust" >/dev/null
as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -o '-p $PORT -k $WORK -c listen_addresses=127.0.0.1' -l '$WORK/log' start" >/dev/null
"$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -q -c "CREATE ROLE finagai_migrator LOGIN; CREATE ROLE finagai_app LOGIN;"
cd "$ROOT" && npm run build >/dev/null
EVAL_PG_ADMIN_URL="postgres://postgres@127.0.0.1:$PORT/postgres" \
EVAL_PG_MIGRATOR_TEMPLATE="postgres://finagai_migrator@127.0.0.1:$PORT/{db}" \
EVAL_PG_APP_TEMPLATE="postgres://finagai_app@127.0.0.1:$PORT/{db}" \
FINAGAI_PUBLIC_BASE_URL="http://localhost" FINAGAI_MCP_RESOURCE_URL="http://localhost/mcp" DATABASE_URL="unused" \
OAUTH_ISSUER="https://unused.invalid" OAUTH_JWKS_URL="https://unused.invalid/jwks" PRINCIPAL_SUBJECT="eval" APPROVAL_CLIENT_ID="eval" \
APPROVAL_CLIENT_SECRET="eval" SESSION_SECRET="eval-session-secret-0123456789abcdef" RESEND_API_KEY="unused" \
NOTIFY_FROM="Finagai <eval@example.invalid>" NOTIFY_TO="eval@example.invalid" NOTIFY_REPLY_TO="eval@example.invalid" \
  node dist/eval/runner/run-j3.js "$@"
