/** `npm run preflight`: run the startup checks against the configured environment and print them. */
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { createPool } from "../db/index.js";
import { criticalFailures, preflight } from "./preflight.js";
const cfg = loadConfig(process.env);
const pool = createPool(cfg.DATABASE_URL, 1);
const checks = await preflight(pool, { migrationsDir: join(process.cwd(), "migrations"), issuer: cfg.OAUTH_ISSUER, jwksUrl: cfg.OAUTH_JWKS_URL });
for (const c of checks)
    process.stdout.write(`${c.ok ? "PASS" : c.critical ? "FAIL" : "WARN"}  ${c.name}: ${c.detail}\n`);
await pool.end();
process.exit(criticalFailures(checks).length ? 1 : 0);
//# sourceMappingURL=preflight-cli.js.map