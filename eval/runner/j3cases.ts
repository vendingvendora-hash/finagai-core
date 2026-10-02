/**
 * J3 evaluation cases: loading, per-case database materialization, and deterministic assertions.
 * J3 reads the WHOLE state, so every case (and repetition) runs in its own freshly migrated database.
 * Shared by the real-model runner (run-j3.ts) and the local validation test (scripted composer).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { parse } from "yaml";

export const J3_NOW = new Date("2026-10-12T11:00:00Z"); // Monday 07:00 New York

export type J3Assertion =
  | { type: "section_contains" | "section_not_contains"; section: string; id: string; class: Severity; required?: boolean }
  | { type: "section_order"; before: string; after: string; class: Severity; required?: boolean }
  | { type: "recommendation_cites" | "recommendation_not_cites"; id: string; class: Severity; required?: boolean }
  | { type: "recommendation_requires_with"; id: string; with: string; class: Severity; required?: boolean }
  | { type: "rendered_contains"; text: string; class: Severity; required?: boolean }
  | { type: "max_lines"; lines: number; class: Severity; required?: boolean }
  | { type: "rubric"; criterion: string; class: Severity; required?: boolean };
type Severity = "unacceptable" | "costly" | "cheap";

export interface J3Case { id: string; job: "J3"; title: string; repetitions: number; status: string; fixtures: string[]; assertions: J3Assertion[] }

export function loadJ3Cases(dir = join(process.cwd(), "eval", "cases")): J3Case[] {
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => parse(readFileSync(join(dir, f), "utf8")) as J3Case)
    .filter((c) => c.job === "J3" && c.status === "ready").sort((a, b) => a.id.localeCompare(b.id));
}

/** Every case gets an implicit required check: the composed review must not be degraded. */
export function withImplicit(c: J3Case): Array<J3Assertion & { name: string }> {
  return [{ type: "rendered_contains", text: "", class: "costly", name: "review composed (not degraded)" } as J3Assertion & { name: string },
    ...c.assertions.map((a, i) => ({ ...a, name: `${a.type}#${i + 1}` }))];
}

export function expandTimes(sql: string, now = J3_NOW): string {
  return sql.replace(/\{\{NOW([+-]\d+)?d?\}\}/g, (_m, off) => new Date(now.getTime() + (off ? Number(off) : 0) * 86_400_000).toISOString());
}

/** Creates a database owned by the migration role, applies all migrations, loads fixtures as the app role. */
export async function materialize(admin: { adminUrl: string; migratorTemplate: string; appTemplate: string; migrationsDir: string }, dbName: string, fixtures: string[]) {
  const a = new pg.Client({ connectionString: admin.adminUrl });
  await a.connect();
  await a.query(`CREATE DATABASE ${dbName} OWNER finagai_migrator`);
  await a.end();
  const m = new pg.Client({ connectionString: admin.migratorTemplate.replace("{db}", dbName) });
  await m.connect();
  for (const f of readdirSync(admin.migrationsDir).filter((x) => /^0\d+.*\.sql$/.test(x)).sort()) {
    await m.query(readFileSync(join(admin.migrationsDir, f), "utf8"));
  }
  await m.end();
  const appUrl = admin.appTemplate.replace("{db}", dbName);
  const app = new pg.Client({ connectionString: appUrl, options: "-c search_path=finagai" });
  await app.connect();
  for (const sql of fixtures) await app.query(expandTimes(sql));
  await app.end();
  return {
    appUrl,
    drop: async () => { const d = new pg.Client({ connectionString: admin.adminUrl }); await d.connect(); await d.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await d.end(); },
  };
}

function sections(rendered: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = rendered.split(/\n(?=## )/);
  for (const p of parts) if (p.startsWith("## ")) out.set(p.slice(3, p.indexOf("\n") < 0 ? undefined : p.indexOf("\n")).trim(), p);
  return out;
}

function recommendationEntries(rendered: string): string[] {
  const rec = sections(rendered).get("Recommended next actions") ?? "";
  return rec.split(/\n(?=- )/).slice(1);
}

/** Deterministic assertions only; rubric criteria are returned for the grader. */
export function evaluate(c: J3Case, out: { rendered: string; degraded: boolean }): { failures: Array<{ name: string; class: string }>; rubric: Array<{ name: string; criterion: string; class: string }> } {
  const failures: Array<{ name: string; class: string }> = [];
  const rubric: Array<{ name: string; criterion: string; class: string }> = [];
  const sec = sections(out.rendered);
  for (const a of withImplicit(c)) {
    const fail = () => failures.push({ name: a.name, class: a.class });
    switch (a.type) {
      case "rendered_contains":
        if (a.text === "") { if (out.degraded) fail(); }
        else if (!out.rendered.includes(a.text)) fail();
        break;
      case "section_contains": if (!(sec.get(a.section) ?? "").includes(`[${a.id}]`)) fail(); break;
      case "section_not_contains": if ((sec.get(a.section) ?? "").includes(`[${a.id}]`)) fail(); break;
      case "section_order": {
        const i = out.rendered.indexOf(`## ${a.before}`), j = out.rendered.indexOf(`## ${a.after}`);
        if (i < 0 || (j >= 0 && i > j)) fail();
        break;
      }
      case "recommendation_cites": if (!recommendationEntries(out.rendered).some((e) => e.includes(`[${a.id}]`))) fail(); break;
      case "recommendation_not_cites": if (recommendationEntries(out.rendered).some((e) => e.includes(`[${a.id}]`))) fail(); break;
      case "recommendation_requires_with":
        if (recommendationEntries(out.rendered).some((e) => e.includes(`[${a.id}]`) && !e.includes(`[${a.with}]`))) fail();
        break;
      case "max_lines": if (out.rendered.split("\n").length > a.lines) fail(); break;
      case "rubric": rubric.push({ name: a.name, criterion: a.criterion, class: a.class }); break;
    }
  }
  return { failures, rubric };
}
