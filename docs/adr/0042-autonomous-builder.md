# ADR-042: Autonomous builder on the Claude Agent SDK

- **Date:** 2026-10-02 · **Status:** decided (Julian's direction) · **Category:** tooling; no change to Finagai's architecture, security, or authority

## Decision

`./finagai` (`npm run finagai:build`) launches an autonomous Claude agent through the official **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, the Claude Code engine).

**Execution surfaces considered:**
- **Claude Cowork:** no official programmatic launch API was found; it is the desktop app.
- **Claude Code CLI in headless mode:** works, but the SDK provides the same engine with typed options.
- **Agent SDK (chosen):** working directory, model and effort, allow and deny lists, a permission callback, PreToolUse hooks, in-process MCP tools, turn and USD budget limits, session resume, settings overlays (`apiKeyHelper`, OS sandbox), and streaming messages.

## Design

- **Operating specification:** `prompts/finagai-autonomous-builder.md`, appended to Claude Code's system prompt, plus a briefing regenerated from the repository at every run. The repository is authoritative over the summary.
- **Work loop:** runs resume one session. The launcher checkpoints non-secret state, enforces spend, turn, run, provisioning, and error limits, waits for open human actions, and accepts `FINAGAI READY FOR COLD-START SEEDING` only after its own verification passes (tests, clean and pushed git, every provisioning step, backup and readiness runs, live health and metadata, pinned client).
- **Provisioning and human actions:** these run in the launcher process through in-process MCP tools. Julian's terminal receives hidden prompts and human-only actions; the agent sees statuses only.
- **Permissions:** a PreToolUse hook on every call plus `canUseTool`. The policy covers:
  - repository-only paths;
  - credential locations;
  - a guardrail self-modification ban;
  - immutable released migrations;
  - a Bash command allowlist with denylist;
  - provisioning only through tools;
  - browser scripting refused, and page reads refused during human takeover.

  Project `.claude/settings.json` deny rules add depth, and only project settings are loaded (never user settings that could widen permissions).
- **Credentials:**
  - the builder's key goes through `apiKeyHelper` from a 0600 temporary file, never through the shell environment;
  - the runtime receives a filtered environment;
  - a pre-commit secret scan is installed in git hooks, which the agent cannot edit or bypass.

## Evidence

`test/integration/builder.test.ts` drives the REAL Claude Code runtime with a scripted Messages API. It verifies:
- the specification and briefing were injected;
- repository reads, writes, and commands work;
- forbidden commands and paths, guardrail edits, and shell provisioning are refused with policy reasons;
- the key arrives through `apiKeyHelper` and no key variable exists in the shell;
- a turn-limit checkpoint and a resumed session keep their history;
- a false completion claim is rejected and its gaps are fed back;
- provisioning with a human pause and a hidden secret keeps the secret out of model context, logs, and state;
- the spending limit stops cleanly;
- secret redaction works in output and state.

Unit tests cover the policy, secret scan, verifier, environment filter, and limits.

## Limitations

- The Claude-in-Chrome extension needs a Claude plan sign-in and is not driven with an API key, so browser help uses Chrome DevTools MCP in a separate Chrome window.
- The OS sandbox depends on platform support (macOS natively; Linux with bubblewrap); without it, the policy layer still applies.
- The Bash policy is pattern-based defense in depth, not a proof against a deliberately adversarial model; the key and credential isolation do not depend on it.
- Claude.ai connector setup and every human-only action remain Julian's.
