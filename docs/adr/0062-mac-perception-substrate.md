# ADR-062: Mac perception substrate + mac doctor

- Status: Accepted (Julian, principal: universal Mac perception mandate)
- Date: 2026-10-03

## Context
The mandate: "if Julian can see it, Finagai should have a path to perceive it." The honest constraint
(from a full day of evidence): the general visual agent loop is not yet reliable. So we build the
RELIABLE deterministic substrate first — it sits beneath the general operator per the agreed control
hierarchy (deterministic → accessibility/DOM/scripting → visual fallback).

## Decision
helper/mac-perception.mjs — deterministic AppleScript/shell probes returning structured, bounded data,
no LLM in the path:
- getFrontmost (active app + window), listWindows (titles + bounds), listApps
- captureScreen (screencapture), accessibilityTree (role/title/value), getSelectedFiles, getClipboard
- browserActiveTab (Chrome/Safari URL+title), browserReadPage (DOM text)
- macDoctor — probes Accessibility, Screen Recording, Filesystem/Spotlight, Browser, Clipboard; reports
  PASS/FAIL per capability with the exact System Settings remediation for each failure.

Helper commands: "mac doctor" runs the diagnostic and reports; "what am I looking at / what's on my
screen" returns current context (frontmost app/window + active browser tab) — first step of
current-context ("this"/"that") resolution.

## Honest status
This is the substrate, not the universal operator. Perception primitives are deterministic and tested
(parsers + report shape, with injected run). Real PASS/FAIL per capability is reported by `mac doctor`
on the actual Mac — permissions decide the matrix. The general visual fallback and planner integration
(U01–U10) are the next, iterative work, measured against the real machine.

## Security
Pull-based: probes run only when a task needs them; no continuous recording. No security bypass — probes
operate within the logged-in session and macOS TCC; missing permissions are surfaced, never worked around.
