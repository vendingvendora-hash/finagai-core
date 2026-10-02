#!/usr/bin/env bash
# GATE 4: runs the full schema-protection suite against the REAL database as finagai_app, inside ONE
# transaction that is always ROLLED BACK: production data is never changed by this check.
# Requires APP_DATABASE_URL (finagai_app connection string) in the environment: a GitHub environment
# secret for the manual workflow, or your local shell. Never paste it into Claude.
set -euo pipefail
: "${APP_DATABASE_URL:?APP_DATABASE_URL (finagai_app) is required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
{ echo "BEGIN;"; grep -v '^\\set ON_ERROR_STOP' "$ROOT/test/integration/schema_protections.sql" | sed 's/^SET search_path = finagai;/SET LOCAL search_path = finagai;/'; echo "ROLLBACK;"; } \
  | psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -q -t -A 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /' | grep -E "PASS|FAIL|ERROR|ALL" || true
echo "role checks:"
psql "$APP_DATABASE_URL" -q -t -A -c "SELECT CASE WHEN has_table_privilege(current_user, 'finagai.event', 'DELETE') OR has_table_privilege(current_user, 'finagai.project', 'DELETE') THEN 'FAIL: app role can delete' ELSE 'PASS: app role has no DELETE' END"
psql "$APP_DATABASE_URL" -q -t -A -c "SELECT CASE WHEN current_user = 'finagai_app' THEN 'PASS: connected as finagai_app (migration role is not in use)' ELSE 'FAIL: connected as ' || current_user END"
