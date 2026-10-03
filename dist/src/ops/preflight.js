/**
 * Startup preflight. In production the server REFUSES TO START on any critical failure, so a
 * misconfigured deploy fails loudly instead of running with weakened protections.
 *   critical: database reachable; connected as finagai_app (never the migration role); no DELETE
 *             privilege; every repository migration applied (and nothing unknown applied)
 *   warning:  identity provider discovery reachable; JWKS reachable
 */
import { readdirSync } from "node:fs";
export async function preflight(pool, opts) {
    const checks = [];
    const add = (name, ok, critical, detail) => checks.push({ name, ok, critical, detail });
    try {
        const who = (await pool.query(`SELECT current_user AS u`)).rows[0].u;
        add("database reachable", true, true, "connected");
        add("app role", who === "finagai_app", true, who === "finagai_app" ? "connected as finagai_app" : `connected as ${who}; the host must use finagai_app only`);
        const del = (await pool.query(`SELECT bool_or(has_table_privilege(current_user, c.oid, 'DELETE')) AS d FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'finagai' AND c.relkind = 'r'`)).rows[0].d;
        add("no DELETE privilege", !del, true, del ? "the app role can DELETE: protections are weakened" : "archive-only enforced");
        const want = readdirSync(opts.migrationsDir).filter((f) => /^0\d+.*\.sql$/.test(f)).sort();
        const have = (await pool.query(`SELECT filename FROM public.finagai_schema_migrations ORDER BY filename`).catch(() => ({ rows: [] }))).rows.map((r) => r.filename);
        const missing = want.filter((f) => !have.includes(f));
        const unknown = have.filter((f) => !want.includes(f));
        add("migrations applied", missing.length === 0 && unknown.length === 0, true, missing.length ? `missing: ${missing.join(", ")} (run the migrate workflow)` : unknown.length ? `unknown applied: ${unknown.join(", ")}` : `${want.length} applied`);
    }
    catch (err) {
        add("database reachable", false, true, err instanceof Error ? err.name : "connection failed");
    }
    if (checks.some((c) => c.critical && !c.ok))
        return checks; // fail fast: no network waits before refusing to start
    const f = opts.fetchFn ?? fetch;
    for (const [name, url] of [["identity provider discovery", opts.issuer ? `${opts.issuer.replace(/\/$/, "")}/.well-known/openid-configuration` : null],
        ["identity provider keys", opts.jwksUrl ?? null]]) {
        if (!url)
            continue;
        const ok = await f(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
        add(name, ok, false, ok ? "reachable" : "unreachable (sign-in and token checks will fail until it is)");
    }
    return checks;
}
export const criticalFailures = (c) => c.filter((x) => x.critical && !x.ok);
//# sourceMappingURL=preflight.js.map