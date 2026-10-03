/** Enrollment-code minting: requires the migration role (the app role has no INSERT on the table). */
import { createHash, randomBytes } from "node:crypto";
export const ENROLLMENT_CODE_TTL_MIN = 15;
export async function mintEnrollmentCode(migratorPool, principalSubject) {
    const code = randomBytes(18).toString("base64url");
    await migratorPool.query(`INSERT INTO finagai.webauthn_enrollment (principal_subject, code_hash, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 minute'))`, [principalSubject, createHash("sha256").update(code).digest("hex"), ENROLLMENT_CODE_TTL_MIN]);
    return code;
}
export async function revokeCredential(pool, credentialUuid) {
    const r = await pool.query(`UPDATE finagai.webauthn_credential SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [credentialUuid]);
    return r.rowCount === 1;
}
//# sourceMappingURL=enrollment.js.map