/**
 * Pre-commit secret scanner, installed by the launcher as .git/hooks/pre-commit (the agent cannot edit
 * git internals or pass --no-verify). Blocks staged state files, credential files, and secret-shaped
 * strings in added lines.
 */
import { execFileSync } from "node:child_process";
const PATTERNS = [
    [/sk-ant-(api|admin)\d*-[A-Za-z0-9_-]{20,}/, "Anthropic key"],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/, "GitHub token"],
    [/\bre_[A-Za-z0-9_]{20,}\b/, "Resend key"],
    [/\brnd_[A-Za-z0-9]{20,}\b/, "Render key"],
    [/\bnapi_[A-Za-z0-9]{20,}\b/, "Neon key"],
    [/\bsk_(live|test)_[A-Za-z0-9]{20,}\b/, "WorkOS or Stripe key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS key"],
    [/postgres(ql)?:\/\/[^:\s/]+:[^@\s]{8,}@/, "database URL with password"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];
const BLOCKED_PATHS = /(^|\/)(\.finagai\/|\.env(\..*)?$|.*\.pem$|.*\.key$|id_[a-z0-9]+$)/;
export function scanDiff(paths, addedLines) {
    const problems = [];
    for (const p of paths)
        if (BLOCKED_PATHS.test(p))
            problems.push(`staged file must never be committed: ${p}`);
    for (const line of addedLines)
        for (const [re, what] of PATTERNS) {
            if (re.test(line) && !/example|placeholder|xxxx|not[-_]real|\.\.\./i.test(line))
                problems.push(`possible ${what} in a staged line`);
        }
    return [...new Set(problems)];
}
if (process.argv[2] === "--staged") {
    const paths = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const added = execFileSync("git", ["diff", "--cached", "-U0"], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const problems = scanDiff(paths, added);
    if (problems.length) {
        process.stderr.write(`commit blocked by Finagai secret scan:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
        process.exit(1);
    }
}
//# sourceMappingURL=secretScan.js.map