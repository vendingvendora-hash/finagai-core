# ADR-077 — Phase 1: structured browser operating substrate (Chrome + Firefox)

Status: Decided (builder, under Julian's 2026-10-09 mandate; no new data class — page content stays transient)
Date: 2026-10-09

## Context
Audit 2026-10-09: "browser read" was the first AXTextArea of the front window (#118: "(no readable text)" on LinkedIn);
operation was screenshots + coordinates; Firefox unsupported; Chrome page JS needed "Allow JavaScript from Apple Events".

## Options weighed
| Option | Logged-in session | Chrome | Firefox | Security | Verdict |
|---|---|---|---|---|---|
| CDP / WebDriver BiDi on the real profile | yes, but needs --remote-debugging-port | Chrome 136+ refuses it on the default profile | needs remote agent flag | any local process could drive the browser | rejected |
| AppleScript `execute javascript` | yes | needs a global "JS from Apple Events" switch | no | every script can run JS in every tab | rejected |
| **WebExtension + native messaging** | yes (runs inside Julian's own browser) | MV3 | MV3 (same code) | only this extension id may launch the host; host talks to the helper over a 0600 Unix socket; no cookie/storage permissions | **chosen** |
| Vision + coordinates | yes | yes | yes | — | kept as the universal fallback |

## Decision
- `browser-ext/` (Finagai Operator, MV3, one codebase, per-browser manifest; Chrome id fixed by a manifest key:
  fmeaonnombfgboeklgmkgmlbcjdbbbgg; Firefox id operator@finagai.local). Content script gives a semantic snapshot
  (headings, dialogs, alerts, forms, controls with accessible name/role/value/required/invalid/error, file inputs,
  open shadow roots, all frames) and semantic actions with read-back: fill (React-safe native setter), select
  (native + custom combobox two-step), check, click (followed by a wait for an observable change), chunked upload
  verified by the file control's filename, tabs (list/open/switch/close-own), navigate, wait_for, download.
- `helper/browser-host.mjs` native host relays to `helper/browser-bridge.mjs` in the helper; J6 gets `browser_*` kinds.
  Routing: frontmost browser's extension; no extension → explicit "DOM channel unavailable" so the planner falls to
  AX → vision → coordinates. Capability `browserDom` (live) gates the router's browser_dom rung.
- Security: no cookies/webRequest/storage permissions; password/one-time-code fields are reported as SECRET and never
  filled; CAPTCHA/OTP/password are reported as BLOCKERS (Julian); commit-like buttons (submit/apply/send/pay/…) are
  refused unless the step was approved by Julian (helper check on the REAL element name) and Core requires approval for
  commit-like click targets regardless of the planner's summary.
- Untrusted content: page text/snapshots reach the planner only inside `<untrusted>` blocks with an injection scan
  (src/browser/untrusted.ts); authority never comes from content.

## Evidence
Real Chromium 141 + the real extension + native host + bridge over fixture pages: B03–B11, B13 + stale-ref recovery,
iframes, shadow DOM, custom combobox, secret refusal, commit refusal, file upload (test/browser, 16 passing).
Firefox: `web-ext lint` 0 errors; live Firefox and live Chrome runs happen on Julian's Mac after install.
Firefox permanent install needs AMO signing (Julian's Mozilla API key); temporary install works until restart.
