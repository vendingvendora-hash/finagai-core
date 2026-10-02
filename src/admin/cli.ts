/**
 * Admin CLI, run ONLY on Julian's machine with the migration role (MIGRATOR_DATABASE_URL in the local
 * shell environment; never on the host, never pasted into Claude).
 *
 *   node dist/src/admin/cli.js enroll-code             prints a one-time, 15-minute passkey enrollment code
 *   node dist/src/admin/cli.js revoke-credential <id>  revokes a passkey (it can never approve again)
 *   node dist/src/admin/cli.js list-credentials        lists passkeys (no key material exists to show)
 */
import pg from "pg";
import { mintEnrollmentCode, revokeCredential } from "./enrollment.js";

async function main() {
  const url = process.env.MIGRATOR_DATABASE_URL;
  const principal = process.env.PRINCIPAL_SUBJECT;
  if (!url || !principal) throw new Error("MIGRATOR_DATABASE_URL and PRINCIPAL_SUBJECT must be set in your local shell");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === "enroll-code") {
      const code = await mintEnrollmentCode(pool, principal);
      process.stdout.write(`One-time enrollment code (valid 15 minutes): ${code}\nEnter it at /approve/enroll after signing in.\n`);
    } else if (cmd === "revoke-credential" && arg) {
      process.stdout.write((await revokeCredential(pool, arg)) ? "Revoked.\n" : "No active credential with that ID.\n");
    } else if (cmd === "list-credentials") {
      const r = await pool.query(`SELECT id, created_at, last_used_at, revoked_at, enrolled_via FROM finagai.webauthn_credential ORDER BY created_at`);
      for (const c of r.rows) process.stdout.write(`${c.id}  created ${c.created_at.toISOString()}  ${c.revoked_at ? "REVOKED" : "active"}  via ${c.enrolled_via}\n`);
    } else {
      process.stdout.write("usage: enroll-code | revoke-credential <id> | list-credentials\n");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : "error"}\n`); process.exit(1); });
