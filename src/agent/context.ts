/**
 * Startup briefing (ADR-042): read from the repository and the non-secret state files at every launch, so
 * the agent starts from real state. Repository files stay authoritative over this summary.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const read = (repo: string, p: string, max = 12_000) => {
  const f = join(repo, p);
  if (!existsSync(f)) return `(missing: ${p})`;
  const t = readFileSync(f, "utf8");
  return t.length > max ? `${t.slice(0, max)}\n...(truncated; read ${p} for the rest)` : t;
};

function tree(repo: string, dir: string, depth: number): string[] {
  const abs = join(repo, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs).sort()) {
    if (["node_modules", "dist", ".git", ".finagai"].includes(name)) continue;
    const p = join(abs, name);
    const rel = relative(repo, p);
    if (statSync(p).isDirectory()) { out.push(`${rel}/`); if (depth > 1) out.push(...tree(repo, rel, depth - 1)); }
    else out.push(rel);
  }
  return out;
}

async function git(repo: string, args: string[]) {
  try { return (await exec("git", args, { cwd: repo })).stdout.trim(); } catch { return "(not a git repository yet)"; }
}

export async function buildBriefing(repo: string): Promise<string> {
  const files = [...tree(repo, "src", 3), ...tree(repo, "migrations", 1), ...tree(repo, "test", 2), ...tree(repo, "eval", 2),
    ...tree(repo, "scripts", 1), ...tree(repo, "docs", 2), ...tree(repo, ".github/workflows", 1)];
  const provState = existsSync(join(repo, ".finagai/provision-state.json")) ? read(repo, ".finagai/provision-state.json", 8000) : "(no provisioning has run yet)";
  const agentState = existsSync(join(repo, ".finagai/agent-state.json")) ? read(repo, ".finagai/agent-state.json", 6000) : "(first launch)";
  return [
    "# Startup briefing (generated at launch from the repository; repository files win over this summary)",
    `## Git\nBranch: ${await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])}\nHEAD: ${await git(repo, ["log", "-1", "--oneline"])}\n` +
      `Uncommitted: ${(await git(repo, ["status", "--porcelain"])).split("\n").filter(Boolean).length} file(s)\nRecent commits:\n${await git(repo, ["log", "--oneline", "-15"])}`,
    `## README\n${read(repo, "README.md")}`,
    `## ADR index\n${read(repo, "docs/adr/index.md", 30_000)}`,
    `## Readiness gates\n${read(repo, "docs/runbooks/real-data-gate.md")}`,
    `## Provisioning state (non-secret)\n${provState}`,
    `## Builder state (non-secret)\n${agentState}`,
    `## File inventory\n${files.join("\n")}`,
  ].join("\n\n");
}
