/**
 * M01 Mac operator: a deterministic file→chart pipeline the planner invokes as ONE capability, instead of
 * driving the UI step by step. Core holds the pure logic (parse/analyze/chart) and the verification
 * contract; the Mac helper runs the filesystem + rasterization and ships the result back.
 *
 * Per-action verification is built in: each stage returns a checked result, and the pipeline stops with a
 * precise reason if any check fails (no silent "I found the file" dead-ends).
 */
import { readWorkbook } from "./xlsx.js";
import { detectSeries } from "./analyze.js";
import { seriesToSvg } from "./chart.js";
/** Rank filename candidates for a requested name: exact stem, spreadsheet ext, then newest. */
export function rankCandidates(cands, requested) {
    const want = requested.toLowerCase().replace(/\.(xlsx|xlsm|xls)$/, "");
    const score = (c) => {
        const stem = c.name.toLowerCase().replace(/\.(xlsx|xlsm|xls)$/, "");
        let s = 0;
        if (stem === want)
            s += 100;
        else if (stem.startsWith(want))
            s += 60;
        else if (stem.includes(want))
            s += 40;
        else if (want.includes(stem) && stem.length > 4)
            s += 20;
        if (/\.xlsx$/i.test(c.name))
            s += 8;
        else if (/\.(xlsm|xls)$/i.test(c.name))
            s += 5;
        s += Math.min(c.mtimeMs / 1e13, 1); // tiny recency tiebreak
        return s;
    };
    return [...cands].filter((c) => /\.(xlsx|xlsm|xls)$/i.test(c.name)).sort((a, b) => score(b) - score(a));
}
/**
 * Given the workbook bytes (read by the helper) build the chart + verification trace. Pure/deterministic.
 * The helper does file discovery + rasterization around this.
 */
export function analyzeWorkbookToChart(chosen, bytes, requestTitle) {
    const stages = [];
    const add = (stage, ok, detail) => { stages.push({ stage, ok, detail }); return ok; };
    add("search", true, `selected ${chosen.name} (${chosen.size} bytes)`);
    // PARSE
    let sheets;
    try {
        sheets = readWorkbook(bytes);
    }
    catch (e) {
        add("parse", false, `parser error: ${String(e.message).slice(0, 120)}`);
        return { ok: false, stages, message: "Could not parse the workbook." };
    }
    const usable = sheets.filter((s) => s.rows.length >= 2);
    if (!add("parse", usable.length > 0, usable.length ? `${sheets.length} sheet(s): ${sheets.map((s) => `${s.name}(${s.rows.length}r)`).join(", ")}` : "no usable sheets"))
        return { ok: false, stages, message: "The workbook has no readable sheets." };
    // TIME-SERIES / MEASURE DETECTION
    const pick = detectSeries(sheets);
    if (!add("detect_series", !!pick && pick.values.length >= 2, pick ? pick.reason : "no numeric series with >=2 points"))
        return { ok: false, stages, chosen, message: "No numeric data suitable for a chart was found. The workbook may have no measurable columns." };
    // CHART (data-driven; trendline when time-like, bar otherwise)
    const fileTitle = chosen.name.replace(/\.(xlsx|xlsm|xls)$/i, "");
    const measure = (pick.valueColumn && pick.valueColumn.trim()) ? pick.valueColumn.trim() : "values";
    const byPart = (pick.labelColumn && pick.labelColumn !== "Row") ? ` by ${pick.labelColumn}` : "";
    const title = `${fileTitle}: ${measure}${byPart}`;
    void requestTitle;
    const svg = seriesToSvg(pick, title);
    if (!add("chart", svg.includes("<svg") && svg.length > 500, `svg ${svg.length} bytes, ${pick.isTimeLike ? "line+trendline" : "bar"}`))
        return { ok: false, stages, chosen, message: "Chart generation failed." };
    return {
        ok: true, stages, chosen,
        pick: { sheet: pick.sheet, labelColumn: pick.labelColumn, valueColumn: pick.valueColumn, isTimeLike: pick.isTimeLike, reason: pick.reason, points: pick.values.length },
        svg, title,
        message: `Built a ${pick.isTimeLike ? "trend" : "bar"} chart of ${measure} from ${chosen.name}. ${pick.reason}`,
    };
}
//# sourceMappingURL=operator.js.map