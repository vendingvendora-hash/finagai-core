#!/usr/bin/env bash
# Starts the BUILT server exactly as Render will (NODE_ENV=production) against a disposable Postgres:
#   1. correct setup (finagai_app, all migrations via scripts/migrate.sh)  -> starts, /health is 200
#   2. pointed at the migration role                                       -> refuses to start
#   3. a migration missing                                                 -> refuses to start
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
PORT="${STARTUP_PG_PORT:-54360}"; HTTP_PORT="${STARTUP_HTTP_PORT:-18787}"
WORK="$(mktemp -d)"; chmod 777 "$WORK"
as_pg() { if [[ "$(id -u)" == "0" ]]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
trap 'as_pg "\"$PGBIN/pg_ctl\" -D \"$WORK/data\" -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
as_pg "'$PGBIN/initdb' -D '$WORK/data' -U postgres --auth=trust" >/dev/null
as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -o '-p $PORT -k $WORK -c listen_addresses=127.0.0.1' -l '$WORK/log' start" >/dev/null
"$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -q -c "CREATE ROLE finagai_migrator LOGIN; CREATE ROLE finagai_app LOGIN;" \
  -c "CREATE DATABASE finagai OWNER finagai_migrator;" -c "CREATE DATABASE partial OWNER finagai_migrator;"
PATH="$PGBIN:$PATH" MIGRATOR_DATABASE_URL="postgres://finagai_migrator@127.0.0.1:$PORT/finagai" bash "$ROOT/scripts/migrate.sh" >/dev/null
for f in "$ROOT"/migrations/0*.sql; do [[ "$f" == *0010* ]] && break; "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U finagai_migrator -d partial -q -f "$f"; done
"$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U finagai_migrator -d partial -q -c "CREATE TABLE public.finagai_schema_migrations (filename text PRIMARY KEY, applied_at timestamptz DEFAULT now(), sha256 text)" \
  -c "GRANT SELECT ON public.finagai_schema_migrations TO finagai_app" -c "INSERT INTO public.finagai_schema_migrations (filename, sha256) SELECT 'x', 'x' WHERE false"
for f in "$ROOT"/migrations/0*.sql; do [[ "$f" == *0010* ]] && break; "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U finagai_migrator -d partial -q -c "INSERT INTO public.finagai_schema_migrations (filename, sha256) VALUES ('$(basename "$f")', 'x')"; done

run() {
  NODE_ENV=production PORT="$HTTP_PORT" DATABASE_URL="$1" FINAGAI_PUBLIC_BASE_URL="https://finagai.example.test" \
  FINAGAI_MCP_RESOURCE_URL="https://finagai.example.test/mcp" ANTHROPIC_API_KEY="sk-ant-startup-check-not-real" \
  OAUTH_ISSUER="https://idp.example.invalid" OAUTH_JWKS_URL="https://idp.example.invalid/jwks" PRINCIPAL_SUBJECT="user_startup_check" \
  APPROVAL_CLIENT_ID="client_startup_check" APPROVAL_CLIENT_SECRET="startup-check-not-real" SESSION_SECRET="startup-check-session-secret-0123456789" \
  RESEND_API_KEY="re_startup_check_not_real" NOTIFY_FROM="Finagai <review@notify.example.test>" NOTIFY_TO="julian@example.test" \
  NOTIFY_REPLY_TO="julian@example.test" node "$ROOT/dist/src/server/index.js" > "$2" 2>&1 &
  echo $!
}
refused() { # $1 log: the server logged a refusal and is not serving
  grep -q "refusing to start" "$1" && ! curl -fsS "http://127.0.0.1:$HTTP_PORT/health" >/dev/null 2>&1
}
pass=0
PID=$(run "postgres://finagai_app@127.0.0.1:$PORT/finagai" "$WORK/ok.log"); sleep 2
if curl -fsS "http://127.0.0.1:$HTTP_PORT/health" | grep -q '"status":"ok"'; then echo "PASS  correct setup starts and serves /health"; else echo "FAIL  correct setup"; cat "$WORK/ok.log"; pass=1; fi
kill "$PID" 2>/dev/null || true; sleep 1
run "postgres://finagai_migrator@127.0.0.1:$PORT/finagai" "$WORK/migrator.log" >/dev/null; sleep 2
if refused "$WORK/migrator.log" && grep -q "connected as finagai_migrator" "$WORK/migrator.log"; then echo "PASS  migration role: refuses to start"; else echo "FAIL  migration role was accepted"; pass=1; fi
run "postgres://finagai_app@127.0.0.1:$PORT/partial" "$WORK/partial.log" >/dev/null; sleep 2
if refused "$WORK/partial.log" && grep -q "missing: 0010" "$WORK/partial.log"; then echo "PASS  missing migration: refuses to start"; else echo "FAIL  missing migration was accepted"; pass=1; fi
exit $pass
