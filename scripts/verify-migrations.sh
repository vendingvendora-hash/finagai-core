#!/usr/bin/env bash
# Applies all migrations to a disposable local Postgres cluster and runs the schema protection tests.
# Requires local PostgreSQL binaries (pg_ctl, initdb, psql). No external accounts or secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
WORK="$(mktemp -d)"
PORT="${VERIFY_PG_PORT:-54329}"
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK" -l "$WORK/log" start >/dev/null
PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -v ON_ERROR_STOP=1 -q -t -A)

"${PSQL[@]}" -U postgres -d postgres <<SQL
CREATE ROLE finagai_migrator LOGIN;
CREATE ROLE finagai_app LOGIN;
CREATE DATABASE finagai OWNER finagai_migrator;
SQL

for f in "$ROOT"/migrations/0*.sql; do
  echo "applying $(basename "$f")"
  "${PSQL[@]}" -U finagai_migrator -d finagai -f "$f"
done

echo "running schema protection tests as finagai_app"
"${PSQL[@]}" -U finagai_app -d finagai -f "$ROOT/test/integration/schema_protections.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /'
