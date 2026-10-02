/**
 * Backup CLI (used by the GitHub Actions backup and restore-drill workflows, or locally).
 *   export <file>    needs BACKUP_DATABASE_URL (finagai_app) and BACKUP_ENCRYPTION_KEY
 *   restore <file>   needs RESTORE_DATABASE_URL (migration role of an EMPTY, freshly migrated database)
 *                    and BACKUP_ENCRYPTION_KEY
 * Prints table counts only; never prints data, connection strings, or keys.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { exportBackup, parseKey, restoreBackup } from "./backup.js";

async function main() {
  const [cmd, file] = process.argv.slice(2);
  const key = parseKey(process.env.BACKUP_ENCRYPTION_KEY ?? "");
  if (cmd === "export" && file) {
    const url = process.env.BACKUP_DATABASE_URL;
    if (!url) throw new Error("BACKUP_DATABASE_URL is required");
    const { blob, manifest } = await exportBackup(url, key);
    writeFileSync(file, blob);
    const rows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
    process.stdout.write(`backup written: ${Object.keys(manifest.tables).length} tables, ${rows} rows, ${blob.length} bytes (encrypted)\n`);
  } else if (cmd === "restore" && file) {
    const url = process.env.RESTORE_DATABASE_URL;
    if (!url) throw new Error("RESTORE_DATABASE_URL is required");
    const r = await restoreBackup(url, readFileSync(file), key);
    process.stdout.write(`restore verified: ${r.verified.length} tables match their backup checksums\n`);
  } else {
    process.stdout.write("usage: export <file> | restore <file>\n");
  }
}

main().catch((e) => { process.stderr.write(`backup ${e instanceof Error ? e.message : "error"}\n`); process.exit(1); });
