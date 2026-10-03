/**
 * Database access for Core. Connects only as finagai_app (no DELETE privilege, insert-only
 * events, read-only charter). search_path is set per connection because Neon's migration role
 * cannot alter roles (recorded in the M0 checklist, section 8).
 */
import pg from "pg";
export function createPool(databaseUrl, max = 5) {
    return new pg.Pool({
        connectionString: databaseUrl,
        max,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        options: "-c search_path=finagai",
    });
}
/** Run fn inside a transaction; every domain write and its event commit or roll back together. */
export async function withTransaction(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    }
    catch (err) {
        await client.query("ROLLBACK");
        throw err;
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=pool.js.map