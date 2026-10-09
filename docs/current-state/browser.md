# Browser — current state (audit 2026-10-09)

Source of truth: `docs/FINAGAI_CURRENT_STATE_2026-10-09.md`. Code at `94087a7` (live). Rewritten from code and live evidence; supersedes earlier versions of this file.

| Label | Meaning |
|---|---|
| **LIVE VERIFIED** | Exercised against production (Render + Neon + Julian's Mac) with observed output, today or in a recorded live run |
| **LIVE UNVERIFIED** | Deployed, but no live run observed that proves it works |
| **BUILT** | Code + tests exist; not wired into a live path, or never exercised live |
| **PARTIAL** | Works for a subset of the stated scope; the gap is named |
| **DESIGNED** | ADR/doc only |
| **ABSENT** | Nothing exists |
| **BROKEN** | Exists and produces a wrong result, with evidence |


## 7. Browser: READ vs OPERATE

- **READ, active tab URL/title**: PARTIAL. Chrome and Safari only, through AppleScript. **Firefox is unsupported**, and Julian is using Firefox right now.
- **READ, page text**: **BROKEN as a browser read.** `read_text` returns the value of the first AXTextArea of the front window, not the DOM text. #118 got "(no readable text)" from LinkedIn in Firefox. Today the only real page read is a screenshot plus vision.
- **OPERATE**: PARTIAL. `open_url` plus coordinate click/type. There is no DOM-level action (no selectors, form fill or tab management). The `fill-a-form` skill relies on screen coordinates. Not exercised today (Julian was mid-application). **LIVE UNVERIFIED** for multi-step web flows.
- Gmail/Calendar/Drive are read through APIs (Core side), not the browser. **LIVE VERIFIED**.


## 8. Deictic references

- `resolve_reference("this page")` today → **resolved, wrongly, with "high" confidence**: it returned the Chrome tab `julianperezconsulting.webflow.io/job-finder` while the frontmost app was **Firefox** on a LinkedIn job page. Cause: `browserActiveTab` returns the first *running* supported browser, without checking which one is frontmost. **BROKEN** whenever Firefox is in front and Chrome is open in the background.
- "This file" with Finder files selected: LIVE VERIFIED (selected file returned). "The spreadsheet I have open": LIVE VERIFIED for Excel (WO3, Oct 4).

