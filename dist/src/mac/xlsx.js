/**
 * Dependency-free .xlsx reader (M01). An .xlsx is a ZIP of XML parts. We read the central directory,
 * inflate the parts we need (workbook.xml, sheet XML, sharedStrings), and extract cell values as a grid.
 * No native libs, so the Starter build stays lean and deploys reliably.
 */
import { inflateRawSync } from "node:zlib";
/** Parse a ZIP buffer's central directory and return decompressed entries (store + deflate only). */
export function readZip(buf) {
    const out = new Map();
    // End of central directory record: signature 0x06054b50, search from the end.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        throw new Error("not a zip (no EOCD)");
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16); // central dir offset
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50)
            break;
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOff = buf.readUInt32LE(p + 42);
        const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
        // Local header to find the actual data start (its name/extra lengths can differ).
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const comp = buf.subarray(dataStart, dataStart + compSize);
        try {
            out.set(name, method === 0 ? Buffer.from(comp) : inflateRawSync(comp));
        }
        catch { /* skip bad entry */ }
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}
const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
/** sharedStrings.xml -> array of strings. */
function parseSharedStrings(xml) {
    const out = [];
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
        // concatenate all <t> runs within the string item
        const text = (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => unescapeXml(t.replace(/<[^>]+>/g, ""))).join("");
        out.push(text);
    }
    return out;
}
function colToIndex(ref) {
    const m = ref.match(/^([A-Z]+)/);
    if (!m)
        return 0;
    let n = 0;
    for (const ch of m[1])
        n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}
/** Excel serial date -> ISO date (1900 date system, with the Excel 1900 leap-year bug offset). */
export function excelSerialToDate(n) {
    const ms = Math.round((n - 25569) * 86400 * 1000); // 25569 = days from 1899-12-30 to 1970-01-01
    return new Date(ms).toISOString().slice(0, 10);
}
/** Read a workbook buffer into sheets with typed cells (numbers, shared strings, dates heuristically). */
export function readWorkbook(buf) {
    const zip = readZip(buf);
    const wbXml = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
    const rels = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
    const shared = parseSharedStrings(zip.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
    // map r:id -> target
    const relMap = new Map();
    for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
        const id = tag.match(/\bId="([^"]+)"/)?.[1];
        const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
        if (id && target)
            relMap.set(id, target);
    }
    const sheets = [];
    for (const tag of wbXml.match(/<sheet\b[^>]*\/?>/g) ?? []) {
        const name = unescapeXml(tag.match(/\bname="([^"]+)"/)?.[1] ?? "");
        const rid = tag.match(/r:id="([^"]+)"/)?.[1] ?? tag.match(/\bid="([^"]+)"/i)?.[1] ?? "";
        let target = relMap.get(rid) ?? "";
        if (!target)
            continue;
        target = target.replace(/^\//, ""); // "/xl/worksheets/sheet1.xml" -> "xl/worksheets/sheet1.xml"
        if (!target.startsWith("xl/"))
            target = "xl/" + target;
        const sxml = zip.get(target)?.toString("utf8");
        if (!sxml)
            continue;
        const rows = [];
        for (const rowm of sxml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
            const rowInner = rowm[1];
            const cells = [];
            for (const cm of rowInner.matchAll(/<c[^>]*r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
                const col = colToIndex(cm[1]);
                const attrs = cm[2];
                const inner = cm[3];
                const t = attrs.match(/t="([^"]+)"/)?.[1];
                const vRaw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
                const isRef = inner.includes("<f>");
                let val = null;
                if (t === "s" && vRaw != null)
                    val = shared[Number(vRaw)] ?? "";
                else if (t === "str" && vRaw != null)
                    val = unescapeXml(vRaw);
                else if (t === "inlineStr")
                    val = unescapeXml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? ""));
                else if (vRaw != null) {
                    const num = Number(vRaw);
                    val = Number.isFinite(num) ? num : unescapeXml(vRaw);
                }
                void isRef; // formula cells carry their cached <v>, which is what we want
                while (cells.length < col)
                    cells.push(null);
                cells[col] = val;
            }
            rows.push(cells);
        }
        sheets.push({ name, rows });
    }
    return sheets;
}
//# sourceMappingURL=xlsx.js.map