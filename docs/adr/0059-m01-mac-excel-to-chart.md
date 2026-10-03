# ADR-059: M01 — deterministic Mac file→chart operator

- Status: Accepted (Julian, principal: "PASS M01 ON MY REAL MAC")
- Date: 2026-10-03

## Objective
"Finagai, make a trend chart of the Altarum pricing case Excel and show it to me" must: search the Mac,
find the workbook, read it, detect a trend, generate a real chart, and return the image — no folder
question, no upload, no stopping at "found it", same-turn where possible.

## Decision
Replace the fragile step-by-step UI approach for this class of task with a DETERMINISTIC operator:
- src/mac/xlsx.ts — dependency-free .xlsx reader (ZIP+XML via zlib; no native libs).
- src/mac/analyze.ts — time-series/measure detection with scoring; date-serial columns recognized.
- src/mac/chart.ts — data-driven SVG (line+least-squares trendline, or bar for categorical).
- src/mac/operator.ts — find→parse→detect→chart with a per-stage VERIFICATION trace; candidate ranking.
- Core routes /mac/chart (run pipeline on helper-provided bytes) and /mac/chart-done (store PNG on task).
- Helper mac_find_workbooks (Spotlight/mdfind + ranked, with a bounded find fallback) → /mac/chart →
  rasterize SVG to PNG (qlmanage) → verify non-empty → return image to the chat (control_result) AND iMessage.
- MCP tool make_mac_chart waits (bounded) for completion and returns the PNG in the same turn.

## Verification (per action)
search: ≥1 readable candidate · parse: ≥1 usable sheet · detect_series: ordered/numeric series ≥2 pts ·
chart: svg built · raster: PNG exists and non-empty. Any failure stops with a precise reason.

## Evidence
Real xlsx (openpyxl) under /tmp/mac_home; dependency-free reader parses them; acceptance suite
M01_real_mac_excel_to_chart passes 9/9 incl. A–H (Downloads/Desktop/nested/approx-name/duplicates/
multi-sheet+formulas/no-time→bar/read-only). Real Core /mac/chart route returns an SVG that rasterizes to
a valid 48KB PNG. Workbook opened read-only (bytes), never modified.

## Limits
Rasterization uses the Mac's qlmanage (SVG→PNG); validated here with cairosvg. Spotlight must be enabled
(bounded find fallback otherwise). Full Disk Access already granted for the helper (ADR-046).
