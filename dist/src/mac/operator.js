/**
 * M01 Mac operator: a deterministic file→chart pipeline the planner invokes as ONE capability, instead of
 * driving the UI step by step. Core holds the pure logic (parse/analyze/chart) and the verification
 * contract; the Mac helper runs the filesystem + rasterization and ships the result back.
 *
 * Per-action verification is built in: each stage returns a checked result, and the pipeline stops with a
 * precise reason if any check fails (no silent "I found the file" dead-ends).
 */
import { readWorkbook } from "./xlsx.js";
import { describeWorkbook, detectSeries } from "./analyze.js";
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
    if (!add("detect_series", !!pick && pick.values.length >= 2, pick ? pick.reason : "no numeric series with >=2 points")) {
        // WO9: a failure must carry evidence. Say exactly what was seen so the next step is informed, not a guess.
        const inspection = describeWorkbook(sheets);
        const seen = inspection.sheets.map((sh) => `${sh.name}: ${sh.rows} rows; headers [${sh.headers.join(", ")}]; numeric columns ${sh.numericColumns.map((c) => `${c.header}(${c.count} values, ${c.distinct} distinct)`).join(", ") || "none"}`).join(" | ");
        return { ok: false, stages, chosen, inspection,
            message: `No chartable series found in ${chosen.name}. What I saw — ${seen}. If one of these is the column you want, say "chart <column> from ${chosen.name.replace(/\.(xlsx|xlsm|xls)$/i, "")}".` };
    }
    // VERIFY (ADR-065): tool completion is not task completion. Reject a degenerate series —
    // a near-constant column, a pure row-index sequence, or one that is mostly blank/zero —
    // so an index column like "Column 1" (1,2,3,4…) is never surfaced as a successful chart.
    const vals = pick.values;
    const distinct = new Set(vals).size;
    const zeroish = vals.filter((v) => v === 0).length / vals.length;
    // Row-index detection, robust to trailing blank/zero template rows: look at the non-zero values and
    // see if they're (near) consecutive integers 1,2,3,... — that's an index column, not a measure.
    const nz = vals.filter((v) => v !== 0);
    const allInts = nz.length >= 3 && nz.every((v) => Number.isInteger(v));
    const consecutive = allInts && nz.every((v, i) => i === 0 || v === nz[i - 1] + 1);
    const startsLow = nz.length > 0 && nz[0] <= 2;
    const indexLike = consecutive && startsLow;
    const degenerate = distinct <= 1 || indexLike || zeroish > 0.4;
    if (!add("verify", !degenerate, degenerate
        ? `rejected "${pick.valueColumn}": ${indexLike ? "looks like a row index (1,2,3…)" : distinct <= 1 ? "near-constant" : "mostly blank/zero"}`
        : `"${pick.valueColumn}" has ${distinct} distinct values over ${vals.length} points`)) {
        const inspection = describeWorkbook(sheets);
        const cols = inspection.sheets.flatMap((sh) => sh.numericColumns.filter((c) => c.distinct > 2 && !/^\(col/.test(c.header)).map((c) => `${c.header} (${sh.name})`));
        return { ok: false, stages, chosen, inspection,
            message: `The clearest numeric column ("${pick.valueColumn}") looks like a row index or blank template rows, not a real measure.${cols.length ? ` Other numeric columns I can chart: ${cols.join(", ")}. Say "chart <column> from ${chosen.name.replace(/\.(xlsx|xlsm|xls)$/i, "")}".` : " The other columns are empty — this looks like an unfilled template."}` };
    }
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