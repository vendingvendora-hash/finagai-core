/**
 * Encrypted logical backups (ADR-040). No pg_dump needed on any host.
 *
 * Export (read-only, app role): every table in schema finagai as JSON, plus per-table row counts and
 * checksums, gzipped and encrypted with AES-256-GCM (key: BACKUP_ENCRYPTION_KEY, 32 bytes, base64).
 * Restore (migration role, into a freshly migrated EMPTY database): one transaction that suspends user
 * triggers and foreign keys, loads every table, restores identity sequences, re-validates every foreign
 * key, re-enables triggers, and verifies every table checksum against the backup manifest.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import pg from "pg";

const MAGIC = Buffer.from("FNGB1");

export interface BackupManifest { format: "finagai-backup-v2"; createdAt: string; tables: Record<string, { rows: number; checksum: string; columns: string[] }> }
interface BackupBody { manifest: BackupManifest; data: Record<string, unknown[]> }

export function parseKey(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encrypt(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (!blob.subarray(0, 5).equals(MAGIC)) throw new Error("not a Finagai backup");
  const iv = blob.subarray(5, 17), tag = blob.subarray(17, 33);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return gunzipSync(Buffer.concat([d.update(blob.subarray(33)), d.final()])); // throws if tampered
}

async function tables(db: pg.ClientBase): Promise<string[]> {
  return (await db.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'finagai' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
}

/** Stored (non-generated) columns with their exact SQL types. */
async function columns(db: pg.ClientBase, table: string): Promise<Array<{ name: string; type: string }>> {
  return (await db.query<{ name: string; type: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
      WHERE a.attrelid = ('finagai.' || $1)::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attnum`, [table])).rows;
}

async function checksum(db: pg.ClientBase, table: string) {
  const r = (await db.query<{ n: number; c: string }>(
    `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS c FROM finagai.${table} t`)).rows[0]!;
  return { rows: r.n, checksum: r.c };
}

export async function exportBackup(appUrl: string, key: Buffer): Promise<{ blob: Buffer; manifest: BackupManifest }> {
  const db = new pg.Client({ connectionString: appUrl });
  await db.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); // one consistent snapshot
    const manifest: BackupManifest = { format: "finagai-backup-v2", createdAt: new Date().toISOString(), tables: {} };
    const data: Record<string, unknown[]> = {};
    for (const t of await tables(db)) {
      // Every value in its exact SQL text form (SQL NULL stays null): no JSON coercion can change meaning.
      const cols = await columns(db, t);
      data[t] = (await db.query<{ j: unknown[] }>(
        `SELECT coalesce(json_agg(json_build_array(${cols.map((c) => `x."${c.name}"::text`).join(",")})), '[]'::json) AS j FROM finagai.${t} x`)).rows[0]!.j;
      manifest.tables[t] = { ...(await checksum(db, t)), columns: cols.map((c) => c.name) };
    }
    await db.query("COMMIT");
    return { blob: encrypt(Buffer.from(JSON.stringify({ manifest, data } satisfies BackupBody)), key), manifest };
  } finally {
    await db.end();
  }
}

export async function restoreBackup(migratorUrl: string, blob: Buffer, key: Buffer): Promise<{ verified: string[] }> {
  const body = JSON.parse(decrypt(blob, key).toString("utf8")) as BackupBody;
  if (body.manifest.format !== "finagai-backup-v2") throw new Error("unsupported backup format");
  const db = new pg.Client({ connectionString: migratorUrl });
  await db.connect();
  try {
    await db.query("BEGIN");
    const all = await tables(db);
    const missing = Object.keys(body.data).filter((t) => !all.includes(t));
    if (missing.length) throw new Error(`target schema lacks tables ${missing.join(", ")}; apply migrations first`);
    const fks = (await db.query<{ tbl: string; name: string; def: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, c.conname AS name, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'finagai' AND c.contype = 'f'`)).rows;
    for (const t of all) await db.query(`ALTER TABLE finagai.${t} DISABLE TRIGGER USER`);
    for (const f of fks) await db.query(`ALTER TABLE ${f.tbl} DROP CONSTRAINT ${f.name}`);
    await db.query(`TRUNCATE ${all.map((t) => `finagai.${t}`).join(", ")}`);
    for (const [t, rows] of Object.entries(body.data)) {
      if (rows.length === 0) continue;
      const types = new Map((await columns(db, t)).map((c) => [c.name, c.type]));
      const names = body.manifest.tables[t]!.columns;
      const missingCols = names.filter((n) => !types.has(n));
      if (missingCols.length) throw new Error(`target table ${t} lacks columns ${missingCols.join(", ")}`);
      const select = names.map((n, i) => `(r->>${i})::${types.get(n)}`).join(",");
      await db.query(`INSERT INTO finagai.${t} (${names.map((n) => `"${n}"`).join(",")}) OVERRIDING SYSTEM VALUE
                      SELECT ${select} FROM json_array_elements($1::json) r`, [JSON.stringify(rows)]);
    }
    await db.query(`SELECT setval(pg_get_serial_sequence('finagai.event', 'id'), greatest((SELECT max(id) FROM finagai.event), 1))`);
    for (const f of fks) await db.query(`ALTER TABLE ${f.tbl} ADD CONSTRAINT ${f.name} ${f.def}`); // re-validates every reference
    for (const t of all) await db.query(`ALTER TABLE finagai.${t} ENABLE TRIGGER USER`);
    const verified: string[] = [];
    for (const [t, want] of Object.entries(body.manifest.tables)) {
      const got = await checksum(db, t);
      if (got.rows !== want.rows || got.checksum !== want.checksum) throw new Error(`checksum mismatch on ${t}`);
      verified.push(t);
    }
    await db.query("COMMIT");
    return { verified };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}
