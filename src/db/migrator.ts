/**
 * Node migration runner (same ledger as scripts/migrate.sh: public.finagai_schema_migrations), so the
 * bootstrapper needs no psql. Applies each new file in one transaction; refuses an applied file whose
 * contents changed (released migrations are immutable).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export async function migrate(migratorUrl: string, migrationsDir: string, ssl: boolean): Promise<{ applied: string[]; skipped: number }> {
  const c = new pg.Client({ connectionString: migratorUrl, ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}) });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS public.finagai_schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await c.query<{ filename: string; sha256: string }>(`SELECT filename, sha256 FROM public.finagai_schema_migrations`)).rows.map((r) => [r.filename, r.sha256]));
    const applied: string[] = [];
    let skipped = 0;
    for (const f of readdirSync(migrationsDir).filter((x) => /^0\d+.*\.sql$/.test(x)).sort()) {
      const sql = readFileSync(join(migrationsDir, f), "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      const prior = done.get(f);
      if (prior) {
        if (prior !== sha) throw new Error(`migration ${f} changed after it was applied; released migrations are immutable`);
        skipped++;
        continue;
      }
      await c.query(sql); // each file carries its own BEGIN/COMMIT
      await c.query(`INSERT INTO public.finagai_schema_migrations (filename, sha256) VALUES ($1, $2)`, [f, sha]);
      applied.push(f);
    }
    await c.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finagai_app') THEN
                     GRANT SELECT ON public.finagai_schema_migrations TO finagai_app; END IF; END $$`);
    return { applied, skipped };
  } finally {
    await c.end();
  }
}
