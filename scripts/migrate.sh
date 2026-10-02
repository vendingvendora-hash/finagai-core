#!/usr/bin/env bash
# Applies pending migrations to the database in $MIGRATOR_DATABASE_URL (finagai_migrator role).
# Intended to run only from the manual "migrate" GitHub workflow, where the URL is a repository secret.
# Never prints the URL. Idempotent: applied files are recorded in public.finagai_schema_migrations.
set -euo pipefail
: "${MIGRATOR_DATABASE_URL:?MIGRATOR_DATABASE_URL is not set}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -q -t -A)

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS public.finagai_schema_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), sha256 text NOT NULL)"

"${PSQL[@]}" -c "GRANT SELECT ON public.finagai_schema_migrations TO finagai_app"

for f in "$ROOT"/migrations/0*.sql; do
  name="$(basename "$f")"
  sum="$(sha256sum "$f" | cut -d' ' -f1)"
  recorded="$("${PSQL[@]}" -c "SELECT sha256 FROM public.finagai_schema_migrations WHERE filename = '$name'")"
  if [[ -n "$recorded" ]]; then
    [[ "$recorded" == "$sum" ]] || { echo "ERROR: $name changed after it was applied"; exit 1; }
    echo "skip   $name"; continue
  fi
  echo "apply  $name"
  "${PSQL[@]}" -f "$f"
  "${PSQL[@]}" -c "INSERT INTO public.finagai_schema_migrations (filename, sha256) VALUES ('$name', '$sum')"
done

echo "post-migration check (read-only):"
"${PSQL[@]}" -c "SELECT count(*) || ' tables in schema finagai' FROM information_schema.tables WHERE table_schema = 'finagai'"
"${PSQL[@]}" -c "SELECT count(*) || ' check constraints' FROM information_schema.check_constraints WHERE constraint_schema = 'finagai'"
"${PSQL[@]}" -c "SELECT CASE WHEN has_table_privilege('finagai_app', 'finagai.project', 'DELETE') THEN 'FAIL: app role can delete' ELSE 'ok: app role has no DELETE' END"
