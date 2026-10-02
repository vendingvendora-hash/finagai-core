# Autonomous builder

One command starts a Claude agent that takes Finagai from its current state to **FINAGAI READY FOR COLD-START SEEDING**:

    ./finagai            # or: npm run finagai:build

| Command | Effect |
| --- | --- |
| `./finagai` or `npm run finagai:build` | Start, or continue the saved session |
| `npm run finagai:resume` | Continue the saved session explicitly |
| `npm run finagai:status` | Checkpoint, spend, milestones, pending action, provisioning steps |
| `npm run finagai:fresh` | New agent session; all project and provisioning state is kept |
| Ctrl-C | Checkpoint and stop; resume later |

Requirements: Node 22, git, GitHub CLI (`gh`), Chrome (for browser help), and an Anthropic API key for the builder itself (asked once, hidden; or `FINAGAI_BUILDER_ANTHROPIC_KEY` in your shell). Use a separate key from Finagai's runtime key.

## What runs

- **Runtime:** the official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which runs the Claude Code engine with its built-in tools: files, Bash, search, web, subagents. Claude Cowork has no programmatic launch API, so the SDK is the supported path (ADR-042).
- **Operating specification:** `prompts/finagai-autonomous-builder.md`, appended to Claude Code's own system prompt, plus a fresh repository briefing at every start (`src/agent/context.ts`).
- **Loop:** each run resumes the same SDK session. Between runs the launcher checkpoints `.finagai/agent-state.json`, enforces limits, waits for open human actions, and independently verifies any completion claim (`src/agent/verify.ts`).
- **Provisioning:** the agent drives `npm run provision`'s steps through the `finagai` tools. They execute in the launcher, so hidden prompts and human actions happen in your terminal, and secrets never reach the agent.
- **Browser:** Chrome DevTools MCP for navigation and non-sensitive form fields only. Scripts are refused, and page reads are refused while you are doing a human-only step.

## Limits (all configurable)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FINAGAI_AGENT_MAX_USD` | 60 | Builder model spend across all runs and resumes; at the limit it checkpoints and stops |
| `FINAGAI_AGENT_MAX_RUN_USD` | 8 | Spend per run before a checkpoint |
| `FINAGAI_AGENT_MAX_TURNS` | 200 | Turns per run |
| `FINAGAI_AGENT_MAX_RUNS` | 30 | Runs per launch |
| `FINAGAI_AGENT_MAX_PROVISION_RUNS` | 6 | Provisioning attempts per launch |
| `FINAGAI_AGENT_MAX_ERRORS` | 3 | Consecutive runtime errors before stopping |
| `FINAGAI_AGENT_MODEL` / `FINAGAI_AGENT_EFFORT` | claude-opus-5-5 / high | Model and reasoning effort |
| `FINAGAI_AGENT_BROWSER` / `FINAGAI_AGENT_SANDBOX` | on / on | Browser help; OS-level Bash sandbox where the platform supports it |

The builder's spend is separate from Finagai's own $30 target and $36 ceiling, which the builder cannot change.

## Guardrails

- A PreToolUse hook checks every tool call, and the same policy answers permission requests.
- Files: the repository only. Never credential files. Never its own spec, `src/agent/`, `.claude/`, git internals, `.finagai/`, or released migrations.
- Bash: an allowlist of command heads. No environment dumps, network clients, force pushes, `--no-verify`, nested agents, or provisioning from the shell.
- The builder's API key reaches the runtime through `apiKeyHelper` from a private temporary file. It is not in the shell environment, the file is unreadable by policy and sandbox, and it is deleted on exit.
- The runtime receives a filtered environment with no provider credentials.
- A pre-commit hook blocks secrets and state files.
