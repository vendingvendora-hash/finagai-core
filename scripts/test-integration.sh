#!/usr/bin/env bash
# Starts a disposable local Postgres, applies all migrations, and runs the integration tests
# as finagai_app. No external accounts or secrets. If run as root, the cluster runs as 'postgres'.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
PORT="${INTEGRATION_PG_PORT:-54330}"
WORK="$(mktemp -d)"; chmod 777 "$WORK"
as_pg() { if [[ "$(id -u)" == "0" ]]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
cleanup() { as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

as_pg "'$PGBIN/initdb' -D '$WORK/data' -U postgres --auth=trust" >/dev/null
as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -o '-p $PORT -k $WORK -c listen_addresses=127.0.0.1' -l '$WORK/log' start" >/dev/null
PSQL=("$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -U postgres -d postgres -c "CREATE ROLE finagai_migrator LOGIN; CREATE ROLE finagai_app LOGIN;" \
  -c "CREATE DATABASE finagai OWNER finagai_migrator;" -c "CREATE DATABASE finagai_j3 OWNER finagai_migrator;"
for db in finagai finagai_j3; do
  for f in "$ROOT"/migrations/0*.sql; do "${PSQL[@]}" -U finagai_migrator -d "$db" -f "$f"; done
done

# J3 tests get their own database because J3 collection reads the whole state.
INTEGRATION_DATABASE_URL="postgres://finagai_app@127.0.0.1:$PORT/finagai" \
INTEGRATION_DATABASE_URL_J3="postgres://finagai_app@127.0.0.1:$PORT/finagai_j3" \
INTEGRATION_MIGRATOR_URL="postgres://finagai_migrator@127.0.0.1:$PORT/finagai" \
INTEGRATION_ADMIN_URL="postgres://postgres@127.0.0.1:$PORT/postgres" \
INTEGRATION_MIGRATOR_TEMPLATE="postgres://finagai_migrator@127.0.0.1:$PORT/{db}" \
INTEGRATION_APP_TEMPLATE="postgres://finagai_app@127.0.0.1:$PORT/{db}" \
  npx vitest run ${INTEGRATION_FILES:-test/integration} --fileParallelism=false
