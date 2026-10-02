/** Restore drill (acceptance criterion A6), automated: backup -> fresh database -> checksum-verified restore. */
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { decrypt, exportBackup, restoreBackup } from "../../src/backup/backup.js";
import { materialize } from "../../eval/runner/j3cases.js";

const appUrl = process.env.INTEGRATION_DATABASE_URL;
const admin = process.env.INTEGRATION_ADMIN_URL, migT = process.env.INTEGRATION_MIGRATOR_TEMPLATE, appT = process.env.INTEGRATION_APP_TEMPLATE;
const key = randomBytes(32);

describe.skipIf(!appUrl || !admin || !migT || !appT)("backup and restore drill", () => {
  it("restores every table into a fresh database with matching checksums, and protections survive", async () => {
    const { blob, manifest } = await exportBackup(appUrl!, key);
    expect(Object.keys(manifest.tables).length).toBeGreaterThanOrEqual(24);
    expect(blob.subarray(0, 5).toString()).toBe("FNGB1");
    expect(blob.toString("latin1")).not.toMatch(/Unassigned|finagai_app|Harbor/); // encrypted at rest

    const db = await materialize({ adminUrl: admin!, migratorTemplate: migT!, appTemplate: appT!, migrationsDir: join(process.cwd(), "migrations") },
      `restoredrill_${Date.now()}`, []);
    try {
      const r = await restoreBackup(migT!.replace("{db}", new URL(db.appUrl).pathname.slice(1)), blob, key);
      expect(r.verified.length).toBe(Object.keys(manifest.tables).length);
      const restored = new pg.Client({ connectionString: db.appUrl, options: "-c search_path=finagai" });
      await restored.connect();
      try {
        const events = Number((await restored.query(`SELECT count(*) AS n FROM event`)).rows[0].n);
        expect(events).toBe(manifest.tables.event!.rows);
        await expect(restored.query(`UPDATE event SET reason = 'x'`)).rejects.toThrow(/permission denied/);        // privileges intact
        await expect(restored.query(`INSERT INTO event (actor, action, approval_id, principal) VALUES ('julian','x', gen_random_uuid(), 'p')`))
          .rejects.toThrow(/fk_event_approval/);                                                                       // foreign keys re-validated
        const next = await restored.query(`INSERT INTO event (actor, action) VALUES ('system','post-restore') RETURNING id`);
        expect(Number(next.rows[0].id)).toBeGreaterThan(events);                                                         // identity sequence restored
      } finally { await restored.end(); }
    } finally { await db.drop(); }
  });

  it("refuses a tampered backup and the wrong key", async () => {
    const { blob } = await exportBackup(appUrl!, key);
    const tampered = Buffer.from(blob); tampered[tampered.length - 5]! ^= 0xff;
    expect(() => decrypt(tampered, key)).toThrow();
    expect(() => decrypt(blob, randomBytes(32))).toThrow();
  });
});
