/** Local commands the provisioner needs (gh device login, credential-helper push). Shared by the CLI and the builder. */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Log } from "./io.js";
import { Secret } from "./secret.js";
import type { Ctx } from "./steps.js";

const run = promisify(execFile);

export function makeLocalExec(repoDir: string, log: Log): Ctx["exec"] {
  return {
    async ghToken() {
      try { const { stdout } = await run("gh", ["auth", "token"]); return stdout.trim() ? new Secret(stdout.trim()) : null; } catch { return null; }
    },
    async ghLogin() {
      log("\n=== YOUR ACTION: GitHub sign-in ===\n  A browser window opens; approve the device login (scopes: repo, workflow).");
      await new Promise<void>((resolve, reject) => {
        const p = spawn("gh", ["auth", "login", "--web", "--git-protocol", "https", "--scopes", "repo,workflow"], { stdio: "inherit" });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("gh auth login failed"))));
      });
    },
    async gitPush(remote) {
      await run("gh", ["auth", "setup-git"]); // credential helper: no token on any command line
      if (!existsSync(join(repoDir, ".git"))) {
        await run("git", ["init", "-b", "main"], { cwd: repoDir });
        await run("git", ["add", "-A"], { cwd: repoDir });
        await run("git", ["-c", "user.name=Finagai bootstrap", "-c", "user.email=bootstrap@finagai.invalid", "commit", "-m", "Finagai Core"], { cwd: repoDir });
      }
      await run("git", ["remote", "remove", "origin"], { cwd: repoDir }).catch(() => {});
      await run("git", ["remote", "add", "origin", remote], { cwd: repoDir });
      await run("git", ["push", "-u", "origin", "HEAD:main"], { cwd: repoDir });
    },
  };
}
