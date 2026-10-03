# ADR-050: J6 Mac control agent

- Status: Accepted (Julian, principal, 2026-10-02: "navigate this Mac as if it were me, no restrictions", agreeing to the three limits below)
- Date: 2026-10-02

## Context
Julian wants Finagai to operate his Mac as him: open apps, click, type, run commands, use his
logged-in sessions (Google, banking, Messages), not just read and search. He accepts that three limits
remain: (1) a one-tap approval for world-changing/irreversible actions; (2) passwords, payment
confirmations and legal "I agree" clicks stay with him; (3) nothing illegal or built to cause harm.

## Decision
Finagai works one step at a time with vision. For each step it sees a screenshot and proposes the next
action as JSON, classified READ (observe) or WRITE (changes the world). The Mac helper runs READ steps
immediately; WRITE steps are queued and run only after Julian replies "ok <code>" in his own Messages
thread. "stop <code>" cancels a task. Tasks start from a Claude chat (the `control_mac` MCP tool) or
from Julian's thread. State lives in `control_task`/`control_step` (migration 0012); every proposal,
decision and run is an event (new actor `j6`). Model vision calls are metered under the $30/$36 caps.

## Safety properties (enforced, not advisory)
- Risk is computed in Core from the action kind; a model that labels a click "read" is overridden to
  "write" (`classifyRisk`). READ-only kinds are a fixed allowlist.
- A WRITE step can reach approved/running/done only with Julian's decision recorded: DB check
  `ck_control_write_decided`, plus `getStep` returning only approved steps to the executor.
- Even with per-task auto-approve, `run` (shell), `trash_file`, `move_file` and any step whose summary
  implies send/pay/delete/post/submit/buy always require an explicit per-step ok (`needsApproval`).
- The executor refuses file paths outside Julian's home or inside excluded locations (ADR-046/047),
  refuses non-http(s) URLs, and never handles passwords/2FA (the planner must `ask` for those).
- Decisions are one-shot; cancel supersedes pending steps; tables are append-only to the app role.

## Consequences
This is the highest-privilege capability Finagai has: a cloud service that can drive the Mac and act in
logged-in sessions. If Core or the helper token is compromised, the blast radius is Julian's machine;
the approval gate on irreversible actions is the main containment. Auto-approve for low-risk steps is
available per task; fully unattended irreversible actions are intentionally not offered.
