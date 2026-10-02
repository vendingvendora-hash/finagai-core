/**
 * Independent completion check (ADR-042). The builder's own "ready" claim is never sufficient: this runs
 * in the launcher and must pass before FINAGAI READY FOR COLD-START SEEDING is accepted.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StateFile } from "../provision/state.js";
import { STEPS } from "../provision/steps.js";

const exec = promisify(execFile);
export type Runner = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

export const defaultRunner = (cwd: string): Runner => async (cmd, args) => {
  try { const r = await exec(cmd, args, { cwd, maxBuffer: 20 * 1024 * 1024, timeout: 20 * 60_000 }); return { code: 0, out: r.stdout }; }
  catch (e) { const err = e as { code?: number; stdout?: string }; return { code: typeof err.code === "number" ? err.code : 1, out: err.stdout ?? "" }; }
};

export async function verifyCompletion(opts: { provState: StateFile; run: Runner; fetchFn?: typeof fetch; stepIds?: string[] }): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];
  const f = opts.fetchFn ?? fetch;
  if ((await opts.run("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"])).code !== 0) failures.push("typecheck fails");
  if ((await opts.run("npm", ["test"])).code !== 0) failures.push("unit tests fail");
  const dirty = (await opts.run("git", ["status", "--porcelain"])).out.trim();
  if (dirty) failures.push("uncommitted changes in the repository");
  const ahead = await opts.run("git", ["rev-list", "--count", "@{u}..HEAD"]);
  if (ahead.code !== 0 || ahead.out.trim() !== "0") failures.push("local commits are not pushed to GitHub (CI has not seen them)");
  for (const id of opts.stepIds ?? STEPS.map((s) => s.id)) {
    if (opts.provState.data.steps[id]?.status !== "done") failures.push(`provisioning step not done: ${id}`);
  }
  const readiness = opts.provState.data.steps.readiness?.detail ?? "";
  if (!/backup: success/.test(readiness)) failures.push("no successful backup run recorded");
  if (!/readiness: success/.test(readiness)) failures.push("readiness workflow has not passed (Gates 1, 3, 4 and the J3 evaluation)");
  const base = opts.provState.get("base_url");
  if (!base) failures.push("no deployed service URL recorded");
  else {
    const health = await f(`${base}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { status?: string } | null;
    if (health?.status !== "ok") failures.push(`deployed service is not healthy at ${base}/health`);
    const meta = await f(`${base}/.well-known/oauth-protected-resource`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { resource?: string } | null;
    if (meta?.resource !== `${base}/mcp`) failures.push("protected-resource metadata does not name the deployed MCP URL");
  }
  if (!opts.provState.get("pinned_client_id")) failures.push("Claude connector not connected and pinned");
  return { ok: failures.length === 0, failures };
}
