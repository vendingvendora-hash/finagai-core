/**
 * Time-series detection + chart data selection (M01). Given parsed sheets, pick the best primary trend:
 * an ordered period/date column + a numeric measure with enough valid points.
 */
import { excelSerialToDate } from "./xlsx.js";
function looksDateHeader(h) { return /date|day|week|month|quarter|year|period|time|fecha|mes|a[nñ]o/i.test(h); }
function looksMeasureHeader(h) { return /price|cost|amount|total|revenue|sales|value|qty|quantity|rate|usd|\$|margin|util|precio|monto|ingreso/i.test(h); }
/** Choose the best trend series across all sheets, or null if no usable numeric series exists. */
export function detectSeries(sheets) {
    let best = null;
    let bestScore = -1;
    for (const sheet of sheets) {
        if (sheet.rows.length < 2)
            continue;
        // Financial-model layouts (Julian's workbooks): a title in row 1, blank spacer rows, the real header
        // row several rows down, tables starting in column B. Locate the header row instead of assuming row 1.
        const headerRowIdx = locateHeaderRow(sheet.rows);
        if (headerRowIdx < 0)
            continue;
        const header = sheet.rows[headerRowIdx].map((c) => (c == null ? "" : String(c)));
        // The table ends at the first fully blank row after the header (so totals blocks below don't bleed in).
        const after = sheet.rows.slice(headerRowIdx + 1);
        const endIdx = after.findIndex((r) => !r.some((c) => c != null && String(c).trim() !== ""));
        const dataRows = (endIdx >= 0 ? after.slice(0, endIdx) : after).filter((r) => r.some((c) => c != null));
        if (dataRows.length < 2)
            continue;
        const ncol = Math.max(header.length, ...dataRows.map((r) => r.length));
        // classify columns
        const numericCols = [];
        for (let c = 0; c < ncol; c++) {
            const vals = dataRows.map((r) => r[c]).filter((v) => typeof v === "number");
            if (vals.length >= Math.max(2, Math.floor(dataRows.length * 0.6)))
                numericCols.push(c);
        }
        // Pick the x/label column. Priority: a date-named column (even if its cells are numeric serials);
        // then any non-numeric text column; else row index.
        const dateNamedCol = header.findIndex((h) => looksDateHeader(h));
        const textCol = header.findIndex((h, i) => !numericCols.includes(i) && String(h).trim() !== "");
        let labelCol = dateNamedCol >= 0 ? dateNamedCol : (textCol >= 0 ? textCol : -1);
        const labelIsDateSerial = labelCol >= 0 && looksDateHeader(header[labelCol] ?? "");
        for (const vc of numericCols) {
            if (vc === labelCol)
                continue;
            if (vc === dateNamedCol)
                continue;
            if (!header[vc] || String(header[vc]).trim() === "")
                continue; // skip unnamed columns (blank title bug)
            const pairs = [];
            dataRows.forEach((r, i) => {
                const v = r[vc];
                if (typeof v !== "number")
                    return;
                let label;
                const lc = labelCol >= 0 ? r[labelCol] : null;
                if (typeof lc === "number" && labelIsDateSerial && lc > 20000 && lc < 80000)
                    label = excelSerialToDate(lc);
                else if (lc != null && String(lc).trim() !== "")
                    label = String(lc);
                else
                    label = `#${i + 1}`;
                pairs.push({ label, value: v });
            });
            if (pairs.length < 2)
                continue;
            const hdr = header[vc].trim();
            const haveRealLabels = labelCol >= 0 && String(header[labelCol] ?? "").trim() !== "" && pairs.some((p) => !/^#\d+$/.test(p.label));
            const lblHdr = haveRealLabels ? header[labelCol].trim() : "Row";
            const timeLike = haveRealLabels && (labelIsDateSerial || looksDateHeader(lblHdr) || pairs.every((p) => /^\d{4}-\d\d-\d\d$|\bQ[1-4]\b|\b(19|20)\d\d\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(p.label)));
            // Demote columns that are effectively a row index (1,2,3…) or constant — they're not interesting.
            const vals = pairs.map((p) => p.value);
            const distinct = new Set(vals).size;
            const looksSequential = vals.every((v, i) => i === 0 || v === vals[i - 1] + 1);
            let score = 0;
            if (looksMeasureHeader(hdr))
                score += 4; // a named measure (price/cost/revenue/…) is best
            if (haveRealLabels)
                score += 3; // a genuine category/date axis, not #row
            if (timeLike)
                score += 2;
            score += Math.min(pairs.length, 12) / 6;
            if (distinct <= 2)
                score -= 3; // near-constant
            if (looksSequential)
                score -= 4; // it's just an index column
            if (score > bestScore) {
                bestScore = score;
                best = { sheet: sheet.name, labelColumn: lblHdr, valueColumn: hdr,
                    labels: pairs.map((p) => p.label), values: vals,
                    isTimeLike: timeLike,
                    reason: `Charted "${hdr}"${haveRealLabels ? ` by ${lblHdr}` : ""} on sheet "${sheet.name}" (${pairs.length} points${timeLike ? ", time-ordered" : ""}).` };
            }
        }
    }
    return best;
}
/**
 * WO9 evidence: a compact, truthful description of what the reader actually saw. Attached to every chart
 * failure so "no numeric data" is never a dead end — the model (or Julian) can see sheets, headers, how many
 * numeric values each column had, and why candidate columns were rejected.
 */
export function describeWorkbook(sheets) {
    const out = [];
    for (const sh of sheets) {
        const header = (sh.rows[0] ?? []).map((c) => (c == null ? "" : String(c)));
        const body = sh.rows.slice(1);
        const width = Math.max(header.length, ...body.map((r) => r.length), 0);
        const numericColumns = [];
        for (let c = 0; c < width; c++) {
            const vals = body.map((r) => r[c]).filter((v) => typeof v === "number" && Number.isFinite(v));
            if (vals.length >= 2)
                numericColumns.push({ header: (header[c] ?? "").trim() || `(col ${c + 1}, no header)`, count: vals.length, distinct: new Set(vals).size });
        }
        out.push({ name: sh.name, rows: body.length, headers: header.filter(Boolean).slice(0, 20), numericColumns, emptyFormulaCells: 0 });
    }
    return { sheets: out };
}
/**
 * Header-row inference. A header row is the first row with >= 2 non-empty TEXT cells where the next
 * non-empty row has >= 1 numeric cell under one of those text cells. A lone title ("Labor Build") in row 1
 * fails the >= 2 test and is skipped. Falls back to the first non-empty row.
 */
export function locateHeaderRow(rows) {
    const isText = (c) => typeof c === "string" && c.trim() !== "";
    const nonEmpty = (r) => r.some((c) => c != null && String(c).trim() !== "");
    for (let i = 0; i < Math.min(rows.length - 1, 30); i++) {
        const r = rows[i];
        const textIdx = r.map((c, j) => (isText(c) ? j : -1)).filter((j) => j >= 0);
        if (textIdx.length < 2)
            continue;
        // next non-empty row
        let k = i + 1;
        while (k < rows.length && !nonEmpty(rows[k]))
            k++;
        if (k >= rows.length)
            break;
        const next = rows[k];
        const numericUnderHeader = textIdx.some((j) => typeof next[j] === "number");
        // Also accept label-in-first-text-col + numbers in the others (Role | 150 | 40)
        if (numericUnderHeader || textIdx.slice(1).some((j) => typeof next[j] === "number"))
            return i;
    }
    return rows.findIndex(nonEmpty);
}
//# sourceMappingURL=analyze.js.map