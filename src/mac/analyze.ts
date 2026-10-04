/**
 * Time-series detection + chart data selection (M01). Given parsed sheets, pick the best primary trend:
 * an ordered period/date column + a numeric measure with enough valid points.
 */
import { excelSerialToDate, type Sheet } from "./xlsx.js";

export interface SeriesPick {
  sheet: string;
  labelColumn: string;          // header of the x axis (period/date/category)
  valueColumn: string;          // header of the chosen numeric measure
  labels: string[];
  values: number[];
  reason: string;               // brief: why this series
  isTimeLike: boolean;
}

function looksDateHeader(h: string): boolean { return /date|day|week|month|quarter|year|period|time|fecha|mes|a[nñ]o/i.test(h); }
function looksMeasureHeader(h: string): boolean { return /price|cost|amount|total|revenue|sales|value|qty|quantity|rate|usd|\$|margin|util|precio|monto|ingreso/i.test(h); }

/** Choose the best trend series across all sheets, or null if no usable numeric series exists. */
export function detectSeries(sheets: Sheet[]): SeriesPick | null {
  let best: SeriesPick | null = null;
  let bestScore = -1;
  for (const sheet of sheets) {
    if (sheet.rows.length < 2) continue;
    // header row = first non-empty row
    const headerRowIdx = sheet.rows.findIndex((r) => r.some((c) => c != null && String(c).trim() !== ""));
    if (headerRowIdx < 0) continue;
    const header = sheet.rows[headerRowIdx]!.map((c) => (c == null ? "" : String(c)));
    const dataRows = sheet.rows.slice(headerRowIdx + 1).filter((r) => r.some((c) => c != null));
    if (dataRows.length < 2) continue;
    const ncol = header.length;

    // classify columns
    const numericCols: number[] = [];
    for (let c = 0; c < ncol; c++) {
      const vals = dataRows.map((r) => r[c]).filter((v) => typeof v === "number") as number[];
      if (vals.length >= Math.max(2, Math.floor(dataRows.length * 0.6))) numericCols.push(c);
    }
    // Pick the x/label column. Priority: a date-named column (even if its cells are numeric serials);
    // then any non-numeric text column; else row index.
    const dateNamedCol = header.findIndex((h) => looksDateHeader(h));
    const textCol = header.findIndex((h, i) => !numericCols.includes(i) && String(h).trim() !== "");
    let labelCol = dateNamedCol >= 0 ? dateNamedCol : (textCol >= 0 ? textCol : -1);
    const labelIsDateSerial = labelCol >= 0 && looksDateHeader(header[labelCol] ?? "");

    for (const vc of numericCols) {
      if (vc === labelCol) continue;
      if (vc === dateNamedCol) continue;
      if (!header[vc] || String(header[vc]).trim() === "") continue;   // skip unnamed columns (blank title bug)
      const pairs: Array<{ label: string; value: number }> = [];
      dataRows.forEach((r, i) => {
        const v = r[vc];
        if (typeof v !== "number") return;
        let label: string;
        const lc = labelCol >= 0 ? r[labelCol] : null;
        if (typeof lc === "number" && labelIsDateSerial && lc > 20000 && lc < 80000) label = excelSerialToDate(lc);
        else if (lc != null && String(lc).trim() !== "") label = String(lc);
        else label = `#${i + 1}`;
        pairs.push({ label, value: v });
      });
      if (pairs.length < 2) continue;
      const hdr = header[vc]!.trim();
      const haveRealLabels = labelCol >= 0 && String(header[labelCol] ?? "").trim() !== "" && pairs.some((p) => !/^#\d+$/.test(p.label));
      const lblHdr = haveRealLabels ? header[labelCol]!.trim() : "Row";
      const timeLike = haveRealLabels && (labelIsDateSerial || looksDateHeader(lblHdr) || pairs.every((p) => /^\d{4}-\d\d-\d\d$|\bQ[1-4]\b|\b(19|20)\d\d\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(p.label)));
      // Demote columns that are effectively a row index (1,2,3…) or constant — they're not interesting.
      const vals = pairs.map((p) => p.value);
      const distinct = new Set(vals).size;
      const looksSequential = vals.every((v, i) => i === 0 || v === vals[i - 1]! + 1);
      let score = 0;
      if (looksMeasureHeader(hdr)) score += 4;      // a named measure (price/cost/revenue/…) is best
      if (haveRealLabels) score += 3;               // a genuine category/date axis, not #row
      if (timeLike) score += 2;
      score += Math.min(pairs.length, 12) / 6;
      if (distinct <= 2) score -= 3;                // near-constant
      if (looksSequential) score -= 4;              // it's just an index column
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
export function describeWorkbook(sheets: Sheet[]): { sheets: Array<{ name: string; rows: number; headers: string[]; numericColumns: Array<{ header: string; count: number; distinct: number }>; emptyFormulaCells: number }> } {
  const out = [] as Array<{ name: string; rows: number; headers: string[]; numericColumns: Array<{ header: string; count: number; distinct: number }>; emptyFormulaCells: number }>;
  for (const sh of sheets) {
    const header = (sh.rows[0] ?? []).map((c) => (c == null ? "" : String(c)));
    const body = sh.rows.slice(1);
    const width = Math.max(header.length, ...body.map((r) => r.length), 0);
    const numericColumns: Array<{ header: string; count: number; distinct: number }> = [];
    for (let c = 0; c < width; c++) {
      const vals = body.map((r) => r[c]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (vals.length >= 2) numericColumns.push({ header: (header[c] ?? "").trim() || `(col ${c + 1}, no header)`, count: vals.length, distinct: new Set(vals).size });
    }
    out.push({ name: sh.name, rows: body.length, headers: header.filter(Boolean).slice(0, 20), numericColumns, emptyFormulaCells: 0 });
  }
  return { sheets: out };
}
