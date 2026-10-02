# Provisioning

One command, on your machine, from the repository folder (Node 22, git, and the GitHub CLI `gh` installed):

    npm ci
    npm run provision

It provisions everything that has an API and pauses only for actions that need you: signing in, billing, first keys, passkeys, authorizations, approvals. Each pause shows one instruction, waits, and continues. Run it again any time; finished work is detected and skipped.

- `npm run provision -- --plan`: steps and their last status.
- `npm run provision -- --status`: recorded identifiers (no secrets exist in the state file).

Design and the exact list of human actions: "FINAGAI AUTOMATED PROVISIONING DESIGN"
(https://claude.ai/code/artifact/9ddd59e7-97e0-4969-bc89-a674447b0506). Decision record: ADR-041.

When it finishes, send Claude `.finagai/provision-report.md` (it contains no secrets).
