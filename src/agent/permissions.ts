/**
 * Permission policy for the autonomous builder (ADR-042). Enforced in a PreToolUse hook, which fires for
 * EVERY tool call (including auto-approved ones), and again in canUseTool. Deny wins.
 *
 * Principles: work only inside the repository; never read or print credentials; never modify the
 * guardrails themselves (operating spec, this policy, project settings, released migrations); never run
 * the provisioner or the admin CLI from the shell (they run in the launcher, where Julian's hidden prompts
 * live); every shell command must be on an explicit allowlist.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

export interface PolicyContext {
  repoDir: string;
  /** Files the agent must never read (for example the API-key helper file). */
  protectedPaths: string[];
  /** True while Julian is doing a human-only action in the browser: browser reads are refused. */
  humanTakeoverActive: () => boolean;
  /** Released migrations are immutable (existing files at launch). */
  releasedMigrations: Set<string>;
}

export type Decision = { allow: true } | { allow: false; reason: string };
const deny = (reason: string): Decision => ({ allow: false, reason });
const ALLOW: Decision = { allow: true };

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SAFE_TOOLS = new Set(["TodoWrite", "WebSearch", "WebFetch", "Task", "Agent", "ExitPlanMode", "ToolSearch"]);

/** Paths never readable or writable by the agent, inside or outside the repository. */
const SECRET_PATH = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|id_[a-z0-9]+|.*\.pem|.*\.key)$/i;
const SECRET_DIRS = [".ssh", ".aws", ".config/gh", ".config/gcloud", ".docker", ".gnupg", "Library/Keychains"];

/** Files that define the agent's own guardrails: read allowed, write never. */
const GUARDRAIL_FILES = [/^prompts\/finagai-autonomous-builder\.md$/, /^src\/agent\//, /^\.claude\//, /^scripts\/finagai-agent/, /^finagai$/, /^\.git\//, /^\.finagai\//];

function inRepo(ctx: PolicyContext, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(ctx.repoDir, p);
  const rel = relative(ctx.repoDir, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel.replace(/\\/g, "/");
}

function pathProblem(ctx: PolicyContext, p: string | undefined, write: boolean): string | null {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : resolve(ctx.repoDir, p);
  if (ctx.protectedPaths.some((x) => abs === x || abs.startsWith(`${x}/`))) return "that path is a protected credential location";
  if (SECRET_DIRS.some((d) => abs.startsWith(resolve(homedir(), d)))) return "credential directories are off limits";
  if (SECRET_PATH.test(abs)) return "credential files (.env, keys) are never read or written by the builder";
  const rel = inRepo(ctx, abs);
  if (rel === null) return "the builder works only inside the repository";
  if (write) {
    if (GUARDRAIL_FILES.some((re) => re.test(rel))) return "the builder cannot modify its own guardrails, git internals, or provisioning state";
    if (ctx.releasedMigrations.has(rel)) return "released migrations are immutable: add a new forward migration instead";
    if (rel.startsWith("node_modules/")) return "dependencies change only through npm";
  } else if (rel.startsWith(".finagai/") && !/^\.finagai\/(provision-state|agent-state)\.json$|^\.finagai\/.*report\.md$/.test(rel)) {
    return "only the non-secret state and report files in .finagai are readable";
  }
  return null;
}

// ------------------------------------------------------------------------------------------- Bash
const ALLOWED_HEADS = new Set([
  "npm", "npx", "node", "git", "bash", "sh", "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "sed", "awk", "diff", "mkdir", "cp", "mv",
  "touch", "echo", "printf", "pwd", "which", "jq", "test", "[", "sort", "uniq", "tsc", "vitest", "sleep", "date", "rm", "true", "false", "cd",
  "tr", "cut", "xargs", "tee", "basename", "dirname", "realpath", "stat", "file", "less", "more", "time", "timeout", "env-check",
]);

const BASH_DENY: Array<[RegExp, string]> = [
  [/\bsudo\b|\bsu\s/, "no privilege escalation"],
  [/(^|\s)(env|printenv|set|export\s+-p|declare\s+-x)(\s*$|\s*[|;&])/, "environment dumps could expose credentials"],
  [/\$\{?(ANTHROPIC|GITHUB|GH_|RENDER|NEON|WORKOS|RESEND|CLOUDFLARE|AWS|DATABASE_URL|MIGRATOR|APP_DATABASE|BACKUP_ENCRYPTION|SESSION_SECRET)\w*/i, "credential variables are never read by the builder"],
  [/\/proc\/[^ ]*\/environ/, "process environments are off limits"],
  [/\bgh\s+(auth\s+(token|status\s+(-t|--show-token))|secret|ssh-key)\b/, "GitHub credentials are handled only by the provisioner"],
  [/\bsecurity\s+find-|\bsecret-tool\b|\bkeyctl\b/, "keychains are off limits"],
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--mirror\b|\s--delete\b|\s:\S)/, "no force-push or remote deletion"],
  [/\bgit\s+(-c\s+\S+\s+)*(commit|merge|rebase|am|cherry-pick|push)\b[^;&|]*--no-verify\b/, "the secret-scanning pre-commit hook may not be skipped"],
  [/\bgit\s+config\b[^;&|]*(credential|core\.hooksPath|url\.)/, "git credential and hook configuration is fixed"],
  [/\bgit\s+add\b[^;&|]*\s(-f|--force)\b/, "ignored files (state, credentials) may not be force-added"],
  [/\bgit\s+(reset\s+--hard\s+origin|clean\s+-[a-z]*x)/, "destructive git operations against shared history are not allowed"],
  [/\bgit\s+remote\s+(set-url|add|remove)\b/, "git remotes are set by the provisioner"],
  [/\.git\/hooks|\.git\/config/, "git internals are fixed"],
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/, "no recursive deletion outside the repository"],
  [/(^|[;&|]\s*)(npm\s+run\s+(provision|admin)|node\s+\S*provision\/cli|node\s+\S*admin\/cli)/, "the provisioner and admin CLI run only through the finagai tools, where Julian's hidden prompts live"],
  [/\b(curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet)\b/, "direct network clients are not allowed; use the smoke script, npm, or git"],
  [/\bnpm\s+(publish|adduser|login|token|config\s+set)\b/, "npm account operations are not allowed"],
  [/\bclaude\b(\s|$)/, "no nested agents"],
  [/--dangerously|bypassPermissions|allowDangerouslySkipPermissions/i, "permission bypass is never used"],
  [/\bchmod\s+(-R\s+)?[0-7]*7[0-7]*\s+\//, "no world-writable system paths"],
  [/\bdocker\b|\bkubectl\b/, "container control is out of scope"],
];

/** Splits on command separators (outside quotes, roughly) and returns each segment's first word. */
export function commandHeads(cmd: string): string[] {
  const segments = cmd.split(/&&|\|\||;|\||\n|\$\(|`/).map((s) => s.trim()).filter(Boolean);
  return segments.map((s) => s.replace(/^(\w+=\S*\s+)+/, "").replace(/^[({\s]+/, "").split(/\s+/)[0] ?? "");
}

export function decideBash(ctx: PolicyContext, command: string): Decision {
  for (const p of ctx.protectedPaths) if (command.includes(p)) return deny("that path is a protected credential location");
  if (/(^|\s|["'=])(~\/\.(ssh|aws|config\/gh|docker|gnupg)|\.env\b|\/\.env)/.test(command)) return deny("credential files are off limits");
  for (const [re, why] of BASH_DENY) if (re.test(command)) return deny(why);
  for (const head of commandHeads(command)) {
    const h = head.replace(/^.*\//, "");
    if (h && !ALLOWED_HEADS.has(h) && !/^\.\/scripts\/|^scripts\//.test(head)) return deny(`'${h}' is not on the builder's command allowlist`);
    if ((h === "bash" || h === "sh") && !/(^|[;&|]\s*)(bash|sh)\s+(-[a-z]+\s+)*(\.\/)?scripts\/[\w.-]+\.sh\b/.test(command)) {
      return deny("shells may only run repository scripts (bash scripts/<name>.sh)");
    }
  }
  return ALLOW;
}

// ------------------------------------------------------------------------------------------- browser
const BROWSER_READ = /^mcp__chrome-devtools__(take_snapshot|take_screenshot|list_network_requests|get_network_request|list_console_messages|get_console_message)$/;
const BROWSER_FORBIDDEN = /^mcp__chrome-devtools__(evaluate_script|upload_file|handle_dialog)$/;

export function decide(ctx: PolicyContext, toolName: string, input: Record<string, unknown>): Decision {
  if (SAFE_TOOLS.has(toolName)) return ALLOW;
  if (toolName.startsWith("mcp__finagai__")) return ALLOW;
  if (toolName.startsWith("mcp__chrome-devtools__")) {
    if (BROWSER_FORBIDDEN.test(toolName)) return deny("scripts, uploads, and dialogs in the browser are not allowed (they can read credentials)");
    if (ctx.humanTakeoverActive() && BROWSER_READ.test(toolName)) return deny("Julian is doing a human-only action in the browser; the builder may not look at the page until he is done");
    return ALLOW;
  }
  if (READ_TOOLS.has(toolName)) {
    const p = (input.file_path ?? input.path) as string | undefined;
    const problem = pathProblem(ctx, p ?? ctx.repoDir, false);
    return problem ? deny(problem) : ALLOW;
  }
  if (WRITE_TOOLS.has(toolName)) {
    const problem = pathProblem(ctx, (input.file_path ?? input.notebook_path) as string | undefined, true);
    return problem ? deny(problem) : ALLOW;
  }
  if (toolName === "Bash") return decideBash(ctx, String(input.command ?? ""));
  if (toolName === "BashOutput" || toolName === "KillShell" || toolName === "KillBash") return ALLOW;
  return deny(`tool ${toolName} is not part of the builder's toolset`);
}

/** Tools pre-approved at the CLI level (the hook still checks every call). */
export const PREAPPROVED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "Bash", "TodoWrite", "WebSearch", "WebFetch", "mcp__finagai"];
/** Tools removed entirely. */
export const DISALLOWED_TOOLS = ["mcp__chrome-devtools__evaluate_script", "mcp__chrome-devtools__upload_file"];
