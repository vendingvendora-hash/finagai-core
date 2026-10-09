#!/usr/bin/env node
/**
 * Finagai iMessage helper (ADR-044). Runs on Julian's Mac as a LaunchAgent.
 *
 *  - Reads new messages from ~/Library/Messages/chat.db (read-only, via macOS's sqlite3).
 *  - Forwards messages from allow-listed 1:1 contacts to Finagai Core (/concierge/sync).
 *  - Shows each draft to Julian in his own Messages thread ("note to self").
 *  - Sends a reply to a contact ONLY after Julian answers "ok <code>" or "edit <code> <text>" there,
 *    and only to the contact the draft belongs to, and only if that contact is allow-listed here.
 *
 * Config: ~/.finagai/imessage-helper.json (written by setup.sh, mode 600). No dependencies.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { macDoctor, capabilitiesFromDoctor, getFrontmost, listWindows, browserActiveTab, accessibilityTree, captureScreen, getSelectedFiles } from "./mac-perception.mjs";
import { activateApp, axClick, axSetValue, menuItem, observe as observeUi } from "./mac-actions.mjs";
import { moveFileVerified, trashVerified } from "./fs-ops.mjs";

const run = promisify(execFile);
const HELPER_VERSION = "runtime-13";
const WORKER_ID = "mac-helper-" + process.pid;
const RUNTIME = { startedAt: new Date().toISOString(), caps: {}, capsAt: 0, currentTaskId: null, reconnects: 0, coreDown: false, downSince: null };
/** Real capability probe (mac doctor), cached; refreshed every 10 minutes so the matrix stays truthful. */
async function capabilityMatrix() {
  if (Date.now() - RUNTIME.capsAt < 600_000 && Object.keys(RUNTIME.caps).length) return RUNTIME.caps;
  try {
    const tmp = join(OUT_ROOT, "hb-" + Date.now() + ".png"); mkdirSync(OUT_ROOT, { recursive: true });
    const doc = await macDoctor(run, tmp);
    const m = capabilitiesFromDoctor(doc);   // Phase 0A: canonical keys, declared per check by the doctor
    RUNTIME.caps = m; RUNTIME.capsAt = Date.now();
  } catch (e) { log("capability probe failed", { error: String(e?.message ?? e).slice(0, 120) }); }
  return RUNTIME.caps;
}
/** Heartbeat to Core: liveness + capability matrix + current context + current task. Every tick. */
/** Open document path of the frontmost app, when the app exposes it (Excel, Numbers, Preview, Pages, TextEdit). */
async function frontDocumentPath(appName) {
  if (!appName || !/excel|numbers|preview|pages|textedit|keynote|word|powerpoint/i.test(appName)) return null;
  const js = `(function(){try{var a=Application("${appName.replace(/"/g,'')}");var d=a.documents()[0];if(!d)return "";try{var f=d.file();return f?String(f):"";}catch(e){try{return String(d.path());}catch(e2){return "";}}}catch(e){return "";}})()`;
  try { const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", js], { timeout: 4000 }); const v = stdout.trim(); return v && v !== "undefined" ? v.replace(/^file:\/\//, "") : null; }
  catch { return null; }
}
/** Ephemeral current-context snapshot (WO3). Clipboard deliberately excluded. */
async function gatherContext(fm) {
  const ctx = { app: fm.ok ? fm.app : null, window: fm.ok ? fm.window : null };
  ctx.documentPath = await frontDocumentPath(ctx.app).catch(() => null);
  const sel = await getSelectedFiles(run).catch(() => ({ ok: false }));
  ctx.selectedFiles = sel.ok && Array.isArray(sel.files) ? sel.files.slice(0, 10) : [];
  const tab = await browserActiveTab(run, fm.ok ? fm.app : null, fm.ok ? fm.window : null).catch(() => ({ ok: false }));
  // Phase 0B: carry WHICH browser and whether it is frontmost; Firefox gives a title but no URL.
  ctx.browser = tab.ok && (tab.url || tab.title) ? { app: tab.app || "browser", url: tab.url ?? null, title: tab.title || "", frontmost: tab.frontmost === true, introspection: tab.introspection ?? "full" } : null;
  return ctx;
}
/** Phase 1E: structured diagnostic to Core (sanitized, bounded). Never throws. */
let DIAG_CFG = null;
async function diag(kind, detail, taskId = null) {
  log(kind, { error: String(detail).slice(0, 200), taskId });
  if (!DIAG_CFG) return;
  await core(DIAG_CFG, "/mac/diag", { kind, detail: String(detail).slice(0, 400), taskId, version: HELPER_VERSION }).catch(() => {});
}

/** Render an observe->act->verify outcome for the planner: honest about whether anything changed. */
function verdict(r) {
  const tag = r.ok ? (r.verified ? "verified" : "unverified") : "error";
  const delta = r.before && r.after ? ` [${r.before.app}/${r.before.window} -> ${r.after.app}/${r.after.window}; focus ${r.after.focusedRole || "?"}${r.after.focusedTitle ? " " + JSON.stringify(r.after.focusedTitle) : ""}]` : "";
  return `${tag}: ${r.result}${delta}`;
}

let LAST_HB_AT = 0;
async function heartbeat(cfg) {
  DIAG_CFG = cfg;
  LAST_HB_AT = Date.now();
  const caps = await capabilityMatrix();
  const fm = await getFrontmost(run).catch(() => ({ ok: false }));
  const context = await gatherContext(fm).catch(() => ({}));
  // Reconnect = an EVENT carried by the first successful heartbeat after an outage (Core increments by one).
  // Never a per-process counter: those reset on restart and were hidden by GREATEST() (Phase 1 live test B).
  const reconnected = RUNTIME.coreDown ? { downSince: RUNTIME.downSince, downSeconds: Math.round((Date.now() - Date.parse(RUNTIME.downSince ?? new Date().toISOString())) / 1000) } : null;
  try {
    const hb = await core(cfg, "/mac/heartbeat", { version: HELPER_VERSION, capabilities: caps,
      frontmostApp: fm.ok ? fm.app : null, frontmostWindow: fm.ok ? fm.window : null,
      currentTaskId: RUNTIME.currentTaskId, startedAt: RUNTIME.startedAt, reconnected, context });
    // Phase 0C: Core hands over due human-wait reminders (bounded by policy); deliver them to Julian's own thread.
    for (const r of (hb && hb.humanWaits && Array.isArray(hb.humanWaits.reminders) ? hb.humanWaits.reminders : []).slice(0, 3)) {
      if (cfg.selfHandles?.[0] && typeof r.text === "string") await sendIMessage(cfg.selfHandles[0], r.text).catch((e) => diag("reminder_send_failed", e?.message ?? e));
    }
    if (reconnected) { RUNTIME.coreDown = false; RUNTIME.downSince = null; RUNTIME.reconnects += 1; log("reconnected to Core", reconnected); }
  } catch (e) {
    if (!RUNTIME.coreDown) { log("Core unreachable (will keep retrying every tick)", { error: String(e?.message ?? e).slice(0, 120) }); RUNTIME.downSince = new Date().toISOString(); }
    RUNTIME.coreDown = true;                                    // B/C: network or Core restart — next tick reconnects
  }
}
const rank = (req) => (/^mac_(ping|diag_test)/.test(String(req || "")) ? 0 : String(req || "").startsWith("mac_chart:") ? 1 : 2);
async function claim(cfg, taskId) {
  const r = await core(cfg, "/control/claim", { taskId, workerId: WORKER_ID }).catch(() => null);
  return !!(r && r.claimed);
}
async function progress(cfg, taskId, note) { await core(cfg, "/control/progress", { taskId, note }).catch(() => {}); }
const sentTextLog = [];
const normText = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
function rememberSent(t) { const n = normText(t); if (!n) return; sentTextLog.push(n); if (sentTextLog.length > 200) sentTextLog.splice(0, sentTextLog.length - 200); }
function wasRecentlySent(t) { return sentTextLog.includes(normText(t)); }
const DIR = join(homedir(), ".finagai");
const CONFIG = join(DIR, "imessage-helper.json");
const STATE = join(DIR, "imessage-state.json");
const CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");
const POLL_MS = 15_000;
const HISTORY = 40;
export const DRAFT_PREFIX = "📝 Finagai";
const APPLE_EPOCH_MS = 978_307_200_000;

// ------------------------------------------------------------------------------ pure helpers

/** Normalize a Messages handle so config entries and chat identifiers compare reliably. */
export function normalizeHandle(h) {
  const s = String(h ?? "").trim();
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;          // US number without country code
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return digits;
}

/** Text of a message: the plain column, or decoded from attributedBody (newer macOS leaves text NULL). */
export function messageText(text, attributedHex) {
  if (text && text.trim()) return text;
  if (!attributedHex) return "";
  const buf = Buffer.from(attributedHex, "hex");
  const at = buf.indexOf("NSString");
  if (at < 0) return "";
  const plus = buf.indexOf(0x2b, at + 8);                      // '+' precedes the length
  if (plus < 0) return "";
  let p = plus + 1;
  let len = buf[p];
  if (len === 0x81) { len = buf.readUInt16LE(p + 1); p += 3; }
  else if (len === 0x82) { len = buf.readUIntLE(p + 1, 3); p += 4; }
  else p += 1;
  const direct = buf.subarray(p, p + len).toString("utf8");
  if (direct && !direct.includes("\uFFFD")) return direct;
  return fallbackText(buf, at + 8);
}

/** Fallback: the longest readable UTF-8 run after the NSString marker (format variations across macOS). */
export function fallbackText(buf, from) {
  const tail = buf.subarray(from).toString("utf8");
  const runs = tail.split(/[\u0000-\u0008\u000E-\u001F\uFFFD]+/).map((r) => r.trim())
    .filter((r) => r.length > 0 && !/^(NS|__kIM|streamtyped)/.test(r));
  return runs.sort((a, b) => b.length - a.length)[0]?.replace(/^[+\x80-\xff]/, "") ?? "";
}

export const appleDateToIso = (d) => new Date(Number(d) / 1e6 + APPLE_EPOCH_MS).toISOString();

export function draftNotice(d) {
  return `${DRAFT_PREFIX} #${d.code} → ${d.label}\n${d.summary ? `(${d.summary})\n` : ""}\n${d.body}\n\nReply “ok ${d.code}” to send, “no ${d.code}” to discard, or “edit ${d.code} <your text>”.`;
}

// ------------------------------------------------------------------------------ local files (ADR-046)

/** Never searched or read, whatever Spotlight returns. */
/** Cloud-drive folders live inside ~/Library but are Julian's documents (Google Drive, iCloud, OneDrive, Dropbox). */
export const CLOUD_DIRS = ["Library/CloudStorage", "Library/Mobile Documents"];
export const EXCLUDED_PATH = [/\/Library\/(?!CloudStorage\/|Mobile Documents\/)/, /\/\.[^/]+\//, /node_modules/, /\/Applications\//, /keychain/i, /password/i, /\bpasswords?\b/i,
  /\.ssh/, /\.gnupg/, /\/\.Trash\//, /\.(key|pem|p12|kdbx|keychain-db|sqlite|db)$/i, /finagai-core\//];
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|eml|ics|vcf|log|xml|yaml|yml)$/i;
const TEXTUTIL_EXT = /\.(rtf|rtfd|doc|docx|odt|html?|webarchive)$/i;
const PDF_EXT = /\.pdf$/i;
const MAX_FILES = 6;
const EXCERPT = 3000;

/** Remove obvious secrets before anything leaves the Mac (Core redacts again before the model). */
export function scrubLocal(text) {
  return String(text)
    .replace(/^.*\b(pass(word|code)?|pwd|pin|secret|api[_ -]?key|token)\b.*$/gim, "[line removed: credential]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted SSN]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[redacted number]");
}

/** The passage around the first matching query word, so the model sees the relevant part. */
export function passage(text, queries, size = EXCERPT) {
  const t = String(text).replace(/\r/g, "");
  if (t.length <= size) return t;
  const lower = t.toLowerCase();
  const words = queries.flatMap((q) => q.toLowerCase().split(/\s+/)).filter((w) => w.length > 2);
  let at = -1;
  for (const w of words) { at = lower.indexOf(w); if (at >= 0) break; }
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(size / 3));
  return t.slice(start, start + size);
}

async function extractText(path) {
  try {
    if (TEXT_EXT.test(path)) return readFileSync(path, "utf8").slice(0, 200_000);
    if (TEXTUTIL_EXT.test(path)) return (await run("/usr/bin/textutil", ["-convert", "txt", "-stdout", path], { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 })).stdout;
    if (PDF_EXT.test(path)) {
      const js = "ObjC.import('PDFKit');function run(a){var d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0]));if(!d||d.isNil())return '';var s=d.string;return s&&!s.isNil()?ObjC.unwrap(s).slice(0,200000):''}";
      return (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", js, path], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })).stdout;
    }
  } catch { /* unreadable: fall back to the name only */ }
  return "";
}

/** Spotlight search across Julian's home folder; best files first (matches across queries, then recency). */
export async function findFiles(queries) {
  const hits = new Map();
  const roots = [homedir(), ...CLOUD_DIRS.map((d) => join(homedir(), d)).filter((d) => existsSync(d))];
  for (const q of queries.slice(0, 3)) {
    const out = (await Promise.all(roots.map((root) => run("/usr/bin/mdfind", ["-onlyin", root, q], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 })
      .then((r) => r.stdout).catch(() => "")))).join("\n");
    for (const p of [...new Set(out.split("\n").filter(Boolean))].slice(0, 400)) {
      if (EXCLUDED_PATH.some((r) => r.test(p))) continue;
      hits.set(p, (hits.get(p) ?? 0) + 1);
    }
  }
  const ranked = [];
  for (const [p, n] of hits) {
    try { const st = statSync(p); if (st.isFile() && st.size < 25 * 1024 * 1024) ranked.push({ p, n, m: st.mtimeMs }); } catch { /* gone */ }
  }
  ranked.sort((a, b) => b.n - a.n || b.m - a.m);
  const files = [];
  for (const { p, m } of ranked.slice(0, MAX_FILES)) {
    const name = p.split("/").pop();
    const text = await extractText(p);
    files.push({ name, path: p.replace(homedir(), "~"), modified: new Date(m).toISOString(),
      text: scrubLocal(text ? passage(text, queries) : `(file found, contents not readable as text: ${name})`) });
  }
  return files;
}

// ------------------------------------------------------------------------------ other personal sources (ADR-047)

/** Safe for SQL LIKE and AppleScript: letters, digits, spaces and a few separators only. */
export const cleanTerm = (q) => String(q).normalize("NFC").replace(/[^\p{L}\p{N} .,&@_-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);

const APP_SUPPORT = join(homedir(), "Library", "Application Support");
const CHROMIUM = ["Google/Chrome", "Arc/User Data", "BraveSoftware/Brave-Browser", "Microsoft Edge"].map((d) => join(APP_SUPPORT, d));

function chromiumProfiles() {
  const out = [];
  for (const base of CHROMIUM) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) if (d === "Default" || /^Profile \d+$/.test(d)) out.push(join(base, d));
  }
  return out;
}

async function sqliteCopy(path, query) {
  const tmp = join(tmpdir(), `finagai-${process.pid}-${Date.now()}.db`);
  try { copyFileSync(path, tmp); return JSON.parse((await run("/usr/bin/sqlite3", ["-readonly", "-json", tmp, query], { timeout: 15_000 })).stdout || "[]"); }
  catch { return []; } finally { try { rmSync(tmp); } catch { /* ignore */ } }
}

/** Browser history (Chromium browsers and Safari) and Chrome-family bookmarks matching the terms. */
export async function searchBrowsers(terms) {
  const lines = [];
  const where = (cols) => terms.map((t) => `(${cols.map((c) => `${c} LIKE '%${t.replace(/'/g, "''")}%'`).join(" OR ")})`).join(" OR ");
  for (const prof of chromiumProfiles()) {
    const h = join(prof, "History");
    if (existsSync(h)) for (const r of await sqliteCopy(h, `SELECT title, url, datetime(last_visit_time/1000000-11644473600,'unixepoch') AS at FROM urls WHERE ${where(["title", "url"])} ORDER BY last_visit_time DESC LIMIT 10`))
      lines.push(`visited ${r.at}: ${r.title} <${r.url}>`);
    const b = join(prof, "Bookmarks");
    if (existsSync(b)) {
      const walk = (n) => { if (!n) return; if (n.url && terms.some((t) => `${n.name} ${n.url}`.toLowerCase().includes(t.toLowerCase()))) lines.push(`bookmark: ${n.name} <${n.url}>`); (n.children ?? []).forEach(walk); };
      try { Object.values(JSON.parse(readFileSync(b, "utf8")).roots ?? {}).forEach(walk); } catch { /* ignore */ }
    }
  }
  const safari = join(homedir(), "Library", "Safari", "History.db");
  if (existsSync(safari)) for (const r of await sqliteCopy(safari, `SELECT v.title AS title, i.url AS url, datetime(v.visit_time+978307200,'unixepoch') AS at FROM history_visits v JOIN history_items i ON i.id = v.history_item WHERE ${where(["v.title", "i.url"])} ORDER BY v.visit_time DESC LIMIT 10`))
    lines.push(`visited ${r.at}: ${r.title} <${r.url}>`);
  return [...new Set(lines)].slice(0, 25);
}

async function appleScript(lines, args, timeout = 25_000) {
  return (await run("/usr/bin/osascript", [...lines.flatMap((l) => ["-e", l]), ...args], { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

/** Apple Notes, Contacts and Calendar matches (the first use asks Julian to Allow each app once). */
export async function searchApps(terms) {
  const found = [];
  for (const t of terms) {
    const notes = await appleScript(["on run argv", "set q to item 1 of argv", "set out to \"\"",
      'tell application "Notes"', "repeat with n in (every note whose name contains q or plaintext contains q)",
      "set out to out & \"### \" & (name of n) & \" (\" & ((modification date of n) as string) & \")\" & linefeed & (plaintext of n) & linefeed",
      "end repeat", "end tell", "return out", "end run"], [t]).catch(() => "");
    if (notes.trim()) found.push({ name: `Apple Notes matching "${t}"`, text: notes });
    const people = await appleScript(["on run argv", "set q to item 1 of argv", "set out to \"\"",
      'tell application "Contacts"', "repeat with p in (every person whose name contains q or organization contains q)",
      "set out to out & (name of p) & \" | phones: \" & ((value of phones of p) as string) & \" | emails: \" & ((value of emails of p) as string) & \" | addresses: \" & ((formatted address of addresses of p) as string) & linefeed",
      "end repeat", "end tell", "return out", "end run"], [t]).catch(() => "");
    if (people.trim()) found.push({ name: `Contacts matching "${t}"`, text: people });
    const events = await appleScript(["on run argv", "set q to item 1 of argv", "set out to \"\"", "set d0 to (current date) - 90 * days", "set d1 to (current date) + 180 * days",
      'tell application "Calendar"', "repeat with c in calendars", "repeat with e in (every event of c whose summary contains q and start date > d0 and start date < d1)",
      "set out to out & (summary of e) & \" | \" & ((start date of e) as string) & \" | \" & (location of e as string) & linefeed",
      "end repeat", "end repeat", "end tell", "return out", "end run"], [t], 40_000).catch(() => "");
    if (events.trim()) found.push({ name: `Calendar events matching "${t}"`, text: events });
  }
  return found;
}

/** Everything Finagai may consult for one request: files first, then apps and browsers. */
export async function findEverything(queries) {
  const terms = [...new Set(queries.map(cleanTerm).filter((t) => t.length > 1))].slice(0, 3);
  const [files, apps, browser] = await Promise.all([
    findFiles(terms).catch(() => []), searchApps(terms).catch(() => []), searchBrowsers(terms).catch(() => []),
  ]);
  const extra = apps.map((a) => ({ name: a.name, path: a.name, text: scrubLocal(passage(a.text, terms)) }));
  if (browser.length) extra.push({ name: "Browser history and bookmarks", path: "browsers", text: scrubLocal(browser.join("\n")) });
  return [...files, ...extra];
}

// ------------------------------------------------------------------------------ M01 Mac operator

/** Find spreadsheet candidates by approximate name using Spotlight, then rank locally. */
export async function mac_find_workbooks(requested) {
  const stem = requested.replace(/\.(xlsx|xlsm|xls)$/i, "");
  const queries = [stem, stem.replace(/[_-]+/g, " "), stem.replace(/\s+/g, "_")];
  const roots = [homedir(), ...CLOUD_DIRS.map((d) => join(homedir(), d)).filter((d) => existsSync(d))];
  const hits = new Set();
  for (const q of [...new Set(queries)]) {
    for (const root of roots) {
      const out = await run("/usr/bin/mdfind", ["-onlyin", root, q], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout).catch(() => "");
      for (const p of out.split("\n").filter(Boolean)) if (/\.(xlsx|xlsm|xls)$/i.test(p) && !EXCLUDED_PATH.some((r) => r.test(p))) hits.add(p);
    }
  }
  // Fallback: a bounded find if Spotlight is cold.
  if (hits.size === 0) {
    const out = await run("/bin/zsh", ["-lc", `find ${homedir()} -maxdepth 6 -iname '*${stem.replace(/[^a-z0-9]/gi,"*")}*.xls*' 2>/dev/null | head -50`], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout).catch(() => "");
    for (const p of out.split("\n").filter(Boolean)) hits.add(p);
  }
  const cands = [];
  for (const p of hits) { try { const st = statSync(p); if (st.isFile() && st.size < 50 * 1024 * 1024) cands.push({ path: p, name: p.split("/").pop(), size: st.size, mtimeMs: st.mtimeMs }); } catch { /* gone */ } }
  return cands;
}

/** Full M01: find -> send bytes to Core (parse/analyze/chart) -> rasterize SVG to PNG -> verify. */
export async function runMacChart(cfg, requested, taskId, onProgress = async () => {}) {
  const cands = await mac_find_workbooks(requested);
  if (!cands.length) return { ok: false, message: `I searched your Mac (Spotlight) and couldn't find a spreadsheet matching "${requested}".` };
  await onProgress(`found ${cands.length} candidate file(s); reading`);
  // Core ranks + reads the chosen file's bytes we send, and returns the chart SVG + verification trace.
  const top = cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Let Core pick the best candidate by name; send the small set of candidates with bytes of the top few.
  const withBytes = [];
  for (const c of top.slice(0, 5)) { try { withBytes.push({ ...c, b64: readFileSync(c.path).toString("base64") }); } catch { /* skip */ } }
  await onProgress("analyzing workbook and building chart");
  const resp = await core(cfg, "/mac/chart", { requested, candidates: withBytes });
  if (!resp || !resp.ok || !resp.svgB64) return { ok: false, message: resp?.message || "Could not build the chart." };
  await onProgress("rendering chart image");
  // Rasterize the SVG to PNG on the Mac (Quick Look), verify non-empty.
  const dir = join(OUT_ROOT, "m01-" + Date.now()); mkdirSync(dir, { recursive: true });
  const svgPath = join(dir, "chart.svg"); writeFileSync(svgPath, Buffer.from(resp.svgB64, "base64"));
  // Deterministic rasterizer first (AppKit NSImage -> bitmap at the SVG's exact size, 2x for crispness);
  // Quick Look only as a fallback — it is a thumbnailer and squared/cropped a 1200x700 chart (task #72).
  const svgText = Buffer.from(resp.svgB64, "base64").toString("utf8");
  const svgW = Number(svgText.match(/<svg[^>]*\swidth="(\d+)"/)?.[1] ?? 0), svgH = Number(svgText.match(/<svg[^>]*\sheight="(\d+)"/)?.[1] ?? 0);
  // Rasterizer ladder, most deterministic first; the chosen path is logged so a failure is diagnosable.
  let png = null, via = null;
  if (svgW && svgH) {
    png = await chromeSvgPng(svgPath, join(dir, "chart.png"), svgW, svgH).catch((e) => { diag("chrome_raster_failed", e?.message ?? e); return null; });
    via = png ? "chrome" : null;
    if (!png) { png = await svgToPng(svgPath, join(dir, "chart-nsimage.png"), svgW, svgH).catch((e) => { diag("nsimage_raster_failed", e?.message ?? e); return null; }); via = png ? "nsimage" : null; }
  }
  if (!png) { png = await quickLookPng(svgPath, dir).catch(() => null); via = png ? "quicklook" : null; }
  log("chart rasterized", { via, svg: `${svgW}x${svgH}` });
  if (!png || !existsSync(png) || statSync(png).size < 1000) return { ok: false, message: "Chart rasterization produced an empty image." };
  // WO9 VERIFY: the artifact must not be materially cropped — its aspect must match the SVG's.
  const dims = await pngDims(png).catch(() => null);
  if (svgW && svgH && dims && Math.abs(dims.w / dims.h - svgW / svgH) > 0.05) {
    await diag("chart_cropped", `expected ${svgW}x${svgH}, got ${dims.w}x${dims.h}`);
    return { ok: false, message: `Chart image was cropped by the renderer (expected ${svgW}x${svgH} aspect, got ${dims.w}x${dims.h}); not delivering a cropped artifact.` };
  }
  // Return the PNG to the chat (store on the task) and to iMessage.
  const pngB64 = readFileSync(png).toString("base64");
  await core(cfg, "/mac/chart-done", { taskId, workerId: WORKER_ID, imageB64: pngB64, summary: resp.message });
  await core(cfg, "/artifact/register", { kind: "chart", mime: "image/png", storageRef: png, summary: resp.message, conversation: "self" }).catch(() => {});
  await sendIMessage(cfg.selfHandles[0], `📈 ${resp.message}`);
  await sendIMessageFile(cfg.selfHandles[0], png).catch(() => {});
  return { ok: true, message: resp.message, png };
}

// ------------------------------------------------------------------------------ attachments (ADR-048)

const OUT_ROOT = join(homedir(), "Pictures", "Finagai");          // Messages reliably sends files from ~/Pictures
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4"];

/** A self-contained SVG chart (bar, line or pie); rendered to PNG with Quick Look. */
export function chartSvg(spec) {
  const W = 1200, H = 760, L = 110, R = 40, T = 110, B = 150;
  const title = `<text x="${W / 2}" y="60" font-size="34" font-family="Helvetica" text-anchor="middle" font-weight="bold">${xmlEsc(spec.title)}</text>`;
  const legend = spec.series.map((s, i) => `<rect x="${L + i * 220}" y="${H - 50}" width="22" height="22" fill="${PALETTE[i % 6]}"/><text x="${L + i * 220 + 30}" y="${H - 32}" font-size="22" font-family="Helvetica">${xmlEsc(s.name)}</text>`).join("");
  if (spec.kind === "pie") {
    const vals = spec.series[0].values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    let a0 = -Math.PI / 2;
    const cx = W / 2 - 150, cy = H / 2 + 20, r = 250;
    const slices = vals.map((v, i) => {
      const a1 = a0 + (v / total) * 2 * Math.PI;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
      a0 = a1;
      return `<path d="${d}" fill="${PALETTE[i % 6]}" stroke="white" stroke-width="2"/>`;
    }).join("");
    const keys = spec.labels.map((l, i) => `<rect x="${W - 420}" y="${170 + i * 40}" width="24" height="24" fill="${PALETTE[i % 6]}"/><text x="${W - 385}" y="${190 + i * 40}" font-size="24" font-family="Helvetica">${xmlEsc(l)} (${Math.round((vals[i] ?? 0) / total * 100)}%)</text>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/>${title}${slices}${keys}</svg>`;
  }
  const all = spec.series.flatMap((s) => s.values);
  const max = Math.max(1, ...all), min = Math.min(0, ...all);
  const pw = W - L - R, ph = H - T - B, n = spec.labels.length;
  const y = (v) => T + ph - ((v - min) / (max - min)) * ph;
  const grid = Array.from({ length: 5 }, (_, i) => { const v = min + ((max - min) * i) / 4; return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/><text x="${L - 12}" y="${y(v) + 8}" font-size="20" text-anchor="end" font-family="Helvetica">${Number(v.toFixed(2)).toLocaleString("en-US")}</text>`; }).join("");
  const xl = spec.labels.map((l, i) => `<text x="${L + (i + 0.5) * (pw / n)}" y="${T + ph + 34}" font-size="20" text-anchor="middle" font-family="Helvetica">${xmlEsc(l).slice(0, 14)}</text>`).join("");
  let marks = "";
  if (spec.kind === "bar") {
    const gw = pw / n, bw = (gw * 0.8) / spec.series.length;
    marks = spec.series.map((s, si) => s.values.map((v, i) => `<rect x="${L + i * gw + gw * 0.1 + si * bw}" y="${Math.min(y(v), y(0))}" width="${bw - 2}" height="${Math.abs(y(0) - y(v))}" fill="${PALETTE[si % 6]}"/>`).join("")).join("");
  } else {
    marks = spec.series.map((s, si) => `<polyline fill="none" stroke="${PALETTE[si % 6]}" stroke-width="5" points="${s.values.map((v, i) => `${L + (i + 0.5) * (pw / n)},${y(v)}`).join(" ")}"/>`).join("");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/>${title}${grid}${marks}${xl}${legend}</svg>`;
}

const expandHome = (p) => p.replace(/^~(?=\/)/, homedir());
const allowedLocal = (p) => p.startsWith(homedir() + "/") && !EXCLUDED_PATH.some((r) => r.test(p)) && existsSync(p) && statSync(p).isFile() && statSync(p).size <= MAX_ATTACHMENT_BYTES;

/** Exact-size SVG rasterization via headless Chrome (the path already proven for web screenshots). */
async function chromeSvgPng(src, out, w, h) {
  if (!existsSync(CHROME)) return null;
  // An SVG document loaded directly renders at its intrinsic size from (0,0); window = exact size, 2x DPR.
  await run(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", `--screenshot=${out}`,
    `--window-size=${w},${h}`, "--user-data-dir=" + join(dirname(out), ".chrome"), "file://" + src], { timeout: 45_000 });
  return existsSync(out) && statSync(out).size > 1000 ? out : null;
}

/** Exact-size SVG rasterization via AppKit (CoreSVG). Returns the PNG path or null. */
async function svgToPng(src, out, w, h) {
  if (!w || !h) return null;
  const js = `ObjC.import('AppKit');
function run(a){var img=$.NSImage.alloc.initWithContentsOfFile(a[0]);if(!img||img.isNil())return 'noimg';
var W=parseInt(a[2],10)*2,H=parseInt(a[3],10)*2;
var rep=$.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWideHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null,W,H,8,4,true,false,$.NSCalibratedRGBColorSpace,0,0);
$.NSGraphicsContext.saveGraphicsState;var ctx=$.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);$.NSGraphicsContext.setCurrentContext(ctx);
$.NSColor.whiteColor.setFill;$.NSRectFill($.NSMakeRect(0,0,W,H));
img.drawInRectFromRectOperationFraction($.NSMakeRect(0,0,W,H),$.NSZeroRect,2,1.0);
$.NSGraphicsContext.restoreGraphicsState;
var data=rep.representationUsingTypeProperties(4,$());data.writeToFileAtomically(a[1],true);return 'ok'}`;
  const r = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", js, src, out, String(w), String(h)], { timeout: 30_000 });
  return r.stdout.trim() === "ok" && existsSync(out) && statSync(out).size > 1000 ? out : null;
}
async function pngDims(p) {
  const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", p], { timeout: 10_000 });
  const w = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]), h = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
}

async function quickLookPng(src, outDir) {
  await run("/usr/bin/qlmanage", ["-t", "-s", "1600", "-o", outDir, src], { timeout: 30_000 });
  const png = join(outDir, `${src.split("/").pop()}.png`);
  return existsSync(png) ? png : null;
}

async function pdfPagePng(src, page, highlight, out) {
  const js = `ObjC.import('PDFKit');ObjC.import('AppKit');
function run(a){var d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0]));if(!d||d.isNil())return 'nodoc';
var i=Math.max(0,Math.min(parseInt(a[1],10)-1,d.pageCount-1));var p=d.pageAtIndex(i);
if(a[3]){var sels=d.findStringWithOptions(a[3],1);for(var k=0;k<sels.count;k++){var s=sels.objectAtIndex(k);var ps=s.pages;for(var j=0;j<ps.count;j++){if(ps.objectAtIndex(j).isEqual(p)){var b=s.boundsForPage(p);var an=$.PDFAnnotation.alloc.initWithBoundsForTypeWithProperties(b,'Highlight',$());an.color=$.NSColor.yellowColor;p.addAnnotation(an);}}}}
var box=p.boundsForBox(0);var sc=1600/Math.max(box.size.width,1);var img=p.thumbnailOfSizeForBox($.NSMakeSize(1600,box.size.height*sc),0);
var rep=$.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);var data=rep.representationUsingTypeProperties(4,$());data.writeToFileAtomically(a[2],true);return 'ok'}`;
  const r = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", js, src, String(page), out, highlight ?? ""], { timeout: 40_000 });
  return r.stdout.trim() === "ok" && existsSync(out) ? out : null;
}

/** Build every attachment of a draft on the Mac; returns the files ready to send (skips anything unsafe). */
export async function buildAttachments(draftId, specs) {
  const dir = join(OUT_ROOT, String(draftId).replace(/[^a-z0-9-]/gi, ""));
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [i, a] of (specs ?? []).entries()) {
    try {
      if (a.type === "file" || a.type === "preview" || a.type === "pdf_page") {
        const src = expandHome(a.path);
        if (!allowedLocal(src)) { log("attachment refused", { type: a.type }); continue; }
        if (a.type === "file") { const dst = join(dir, src.split("/").pop()); copyFileSync(src, dst); files.push(dst); }
        else if (a.type === "preview") { const png = await quickLookPng(src, dir); if (png) files.push(png); }
        else { const png = await pdfPagePng(src, a.page, a.highlight, join(dir, `page-${a.page}-${i}.png`)); if (png) files.push(png); }
      } else if (a.type === "chart") {
        const svg = join(dir, `chart-${i}.svg`);
        writeFileSync(svg, chartSvg(a));
        const png = await quickLookPng(svg, dir); if (png) files.push(png);
      } else if (a.type === "web_screenshot" && existsSync(CHROME) && /^https:\/\//.test(a.url)) {
        const out = join(dir, `web-${i}.png`);
        await run(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--screenshot=${out}`, "--window-size=1280,1600", "--user-data-dir=" + join(dir, ".chrome"), a.url], { timeout: 45_000 });
        rmSync(join(dir, ".chrome"), { recursive: true, force: true });
        if (existsSync(out)) files.push(out);
      }
    } catch (err) { log("attachment failed", { type: a.type, error: String(err?.message ?? err).slice(0, 120) }); }
  }
  return files;
}

/** Phase 1B: evidence for an outgoing attachment to `handle` after `sinceApple` (Apple epoch ns).
 *  Returns null (no record) | {rowid, delivered:false} (outgoing recorded locally) | {rowid, delivered:true} (receipt). */
async function outgoingEvidence(handle, sinceApple) {
  const rows = await sql(`SELECT m.ROWID AS id, m.is_delivered AS delivered, m.is_sent AS sent, m.error AS err FROM message m JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 1 AND m.cache_has_attachments = 1 AND m.date > ${Math.floor(sinceApple)} AND h.id = '${String(handle).replace(/'/g, "''")}'
    ORDER BY m.ROWID DESC LIMIT 1`);
  if (!Array.isArray(rows) || !rows.length) return null;
  const r = rows[0];
  return { rowid: r.id, delivered: Number(r.delivered) === 1, sent: Number(r.sent) === 1, error: Number(r.err) || 0 };
}
function sendWordingLocal(state, label) {
  if (state === "delivered") return `✅ Delivered to ${label} (Messages delivery receipt).`;
  if (state === "outgoing_observed") return `📤 Sent to ${label} — the outgoing message is recorded on this Mac; no delivery receipt yet.`;
  if (state === "accepted") return `📤 Handed to Messages for ${label}, but I couldn't see the outgoing record yet — check the thread.`;
  return `⚠️ Couldn't send to ${label}.`;
}

export async function sendIMessageFile(handle, path) {
  const script = ["on run argv", "set theFile to POSIX file (item 1 of argv)", "set theHandle to item 2 of argv",
    'tell application "Messages"', "set svc to 1st account whose service type = iMessage", "send theFile to participant theHandle of svc", "end tell", "end run"];
  await run("/usr/bin/osascript", [...script.flatMap((l) => ["-e", l]), path, handle]);
}

// ------------------------------------------------------------------------------ Mac control (ADR-050)

const SHOT = join(tmpdir(), "finagai-shot.png");

/** Best-effort page text + clickable elements of the frontmost window, so the planner reads, not guesses. */
async function perception() {
  const osa = (lines) => run("/usr/bin/osascript", lines.flatMap((l) => ["-e", l]), { timeout: 12_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout.trim()).catch(() => "");
  // If Chrome is frontmost, pull the page's text and the tag/text/coords of links & buttons via JS.
  const chromeText = await osa([
    'tell application "System Events" to set fm to name of first process whose frontmost is true',
    'if fm is "Google Chrome" then',
    'tell application "Google Chrome" to set t to execute of active tab of front window javascript "document.body?document.body.innerText.slice(0,4000):\"\""',
    'return t',
    'end if', 'return ""']).catch(() => "");
  const chromeAx = await osa([
    'tell application "System Events" to set fm to name of first process whose frontmost is true',
    'if fm is "Google Chrome" then',
    'tell application "Google Chrome" to set a to execute of active tab of front window javascript "(function(){try{var e=[...document.querySelectorAll(\'a,button,[role=button],input,[role=link]\')].slice(0,60).map(function(x){var r=x.getBoundingClientRect();if(r.width<2||r.height<2)return null;var t=(x.innerText||x.value||x.getAttribute(\'aria-label\')||\'\').trim().slice(0,40);return t?((Math.round(r.left+r.width/2))+\',\'+(Math.round(r.top+r.height/2))+\' \'+t):null}).filter(Boolean);return e.join(\'\\n\')}catch(e){return\'\'}})()"',
    'return a', 'end if', 'return ""']).catch(() => "");
  const clean = (x) => (x ? String(x).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, 4000) : undefined);
  // Current context: frontmost app + active window (reliable JXA), plus browser URL when applicable.
  const fm = await getFrontmost(run).catch(() => ({ ok: false }));
  const tab = await browserActiveTab(run, fm.ok ? fm.app : null, fm.ok ? fm.window : null).catch(() => ({ ok: false }));
  const context = {};
  if (fm.ok && fm.app) context.app = fm.app;
  if (fm.ok && fm.window) context.window = fm.window;
  if (tab.ok && tab.url && tab.frontmost) context.url = tab.url;   // Phase 0B: only the frontmost browser's URL is "the page"
  return { pageText: clean(chromeText), axTree: clean(chromeAx), context };
}

/** Full-screen screenshot as base64 PNG (downscaled so uploads stay small). */
async function screenshotB64() {
  await run("/usr/sbin/screencapture", ["-x", "-t", "png", SHOT], { timeout: 15_000 });
  // Downscale to 1600px wide via sips to keep tokens and upload size reasonable.
  await run("/usr/bin/sips", ["-Z", "1200", SHOT], { timeout: 15_000 }).catch(() => {});
  return readFileSync(SHOT).toString("base64");
}

const KEYCODE = { return: 36, enter: 36, tab: 48, esc: 53, escape: 53, space: 49, delete: 51, left: 123, right: 124, down: 125, up: 126 };

/** Run one control action with AppleScript / CLIs. Returns a short result string. */
export async function runControlStep(step) {
  const p = step.params ?? {};
  const osa = (lines, args = []) => run("/usr/bin/osascript", [...lines.flatMap((l) => ["-e", l]), ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  // Text-returning variant for mac-actions.mjs (observe/ax_* parse stdout).
  const osaText = (lines, args = [], opts = {}) => run("/usr/bin/osascript", [...lines.flatMap((l) => ["-e", l]), ...args], { timeout: opts.timeout ?? 30_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout.trim());
  const cursor = (x, y, click) => osa([`tell application "System Events" to ${click || "click"} at {${Math.round(x)}, ${Math.round(y)}}`]);
  switch (step.kind) {
    case "wait": await new Promise((r) => setTimeout(r, Math.min(30, Number(p.seconds) || 1) * 1000)); return "waited";
    case "list_apps": return (await osa(['tell application "System Events" to get name of (every process whose background only is false)'])).stdout.trim();
    case "list_files": return (await run("/bin/ls", ["-la", expandHome(String(p.dir || "~"))], { timeout: 10_000 }).catch((e) => ({ stdout: String(e.message) }))).stdout.slice(0, 2000);
    case "read_file": { const f = expandHome(String(p.path || "")); if (!allowedLocal(f)) return "refused: path not allowed"; return readFileSync(f, "utf8").slice(0, 4000); }
    case "read_text": return (await run("/usr/bin/osascript", ["-e", 'tell application "System Events" to get value of (first text area of front window of (first process whose frontmost is true))'], { timeout: 10_000 }).catch(() => ({ stdout: "" }))).stdout.slice(0, 4000) || "(no readable text)";
    case "click": await cursor(p.x, p.y); return "clicked";
    case "double_click": await cursor(p.x, p.y, "double click"); return "double-clicked";
    case "right_click": await cursor(p.x, p.y, "right click"); return "right-clicked";
    case "move": await osa([`tell application "System Events" to set the position of the mouse to {${Math.round(p.x)}, ${Math.round(p.y)}}`]).catch(() => {}); return "moved";
    case "scroll": await osa([`tell application "System Events" to scroll {${Number(p.amount) || 3} * ${p.dir === "up" ? 1 : -1}}`]).catch(() => {}); return "scrolled";
    case "type": await osa(["on run a", 'tell application "System Events" to keystroke (item 1 of a)', "end run"], [String(p.text ?? "")]); return "typed";
    case "key": { const k = String(p.key || "").toLowerCase(); if (KEYCODE[k] == null) { await osa(["on run a", 'tell application "System Events" to keystroke (item 1 of a)', "end run"], [k]); return "key"; } await osa([`tell application "System Events" to key code ${KEYCODE[k]}`]); return "key"; }
    case "hotkey": { const keys = (p.keys || []).map((k) => String(k).toLowerCase()); const mods = keys.filter((k) => ["cmd","command","option","alt","control","ctrl","shift"].includes(k)).map((k) => ({ cmd: "command down", command: "command down", option: "option down", alt: "option down", control: "control down", ctrl: "control down", shift: "shift down" }[k])); const main = keys.find((k) => !["cmd","command","option","alt","control","ctrl","shift"].includes(k)) || ""; await osa(["on run a", `tell application "System Events" to keystroke (item 1 of a) using {${mods.join(", ")}}`, "end run"], [main]); return "hotkey"; }
    case "open_app": await run("/usr/bin/open", ["-a", String(p.name || "")], { timeout: 15_000 }); return `opened ${p.name}`;
    // WO4: Accessibility-first actions with observe -> act -> verify. The JSON result lets the planner see what changed.
    case "activate_app": { const r = await activateApp(osaText, String(p.name || "")); return verdict(r); }
    case "menu_item": { const r = await menuItem(osaText, String(p.app || ""), Array.isArray(p.path) ? p.path.map(String) : []); return verdict(r); }
    case "ax_click": { const r = await axClick(osaText, String(p.app || ""), { title: p.title == null ? undefined : String(p.title), role: p.role == null ? undefined : String(p.role) }); return verdict(r); }
    case "ax_set_value": { const r = await axSetValue(osaText, String(p.app || ""), { title: p.title == null ? undefined : String(p.title), role: p.role == null ? undefined : String(p.role), value: String(p.value ?? "") }); return verdict(r); }
    case "observe": { const o = await observeUi(osaText); return `observed: ${JSON.stringify(o)}`; }
    case "open_url": { if (!/^https?:\/\//.test(String(p.url || ""))) return "refused: bad url"; await run("/usr/bin/open", ["-a", "Google Chrome", String(p.url)], { timeout: 15_000 }).catch(() => run("/usr/bin/open", [String(p.url)], { timeout: 15_000 })); await new Promise((r) => setTimeout(r, 2500)); return "opened url in Chrome"; }
    case "open_path": { const f = expandHome(String(p.path || "")); if (!f.startsWith(homedir())) return "refused"; await run("/usr/bin/open", [f], { timeout: 15_000 }); return "opened"; }
    case "move_file": {   // Phase 1B: verified by resulting state (fs-ops.mjs)
      const a = expandHome(String(p.from || "")), b = expandHome(String(p.to || ""));
      if (!a.startsWith(homedir()) || !b.startsWith(homedir())) return "refused";
      const r = await moveFileVerified(a, b, { overwrite: p.overwrite === true });
      return `${r.verdict}: ${r.reason}${r.dest ? ` -> ${r.dest}` : ""}`;
    }
    case "trash_file": {
      const f = expandHome(String(p.path || "")); if (!f.startsWith(homedir()) || EXCLUDED_PATH.some((r) => r.test(f))) return "refused";
      const r = await trashVerified(f, { trashDir: join(homedir(), ".Trash"),
        trashFn: (x) => osa(["on run a", 'tell application "Finder" to delete (POSIX file (item 1 of a) as alias)', "end run"], [x]) });
      return `${r.verdict}: ${r.reason}`;
    }
    case "run": { const out = await run("/bin/zsh", ["-lc", String(p.cmd || "")], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }).catch((e) => ({ stdout: "", stderr: String(e.message) })); return (out.stdout + (out.stderr ? `\n[stderr] ${out.stderr}` : "")).slice(0, 4000) || "(no output)"; }
    default: return `unknown kind ${step.kind}`;
  }
}

/** Drive one control task to a natural stopping point: runs reads and approved steps; stops to wait on approvals. */
export async function driveControl(cfg, taskId, onProgress = async () => {}) {
  let lastResult;
  let failures = 0;
  for (let i = 0; i < 40; i++) {
    const shot = await screenshotB64().catch(() => null);
    const per = await perception().catch(() => ({}));
    let r;
    try {
      await onProgress("planning next step");
      r = await core(cfg, "/control/next", { taskId, workerId: WORKER_ID, screenshot: shot, lastResult, pageText: per.pageText, axTree: per.axTree, context: per.context });
    } catch (e) {
      failures++;
      log("control next failed", { attempt: failures, error: String(e?.message ?? e).slice(0, 120) });
      if (failures >= 3) { await sendIMessage(cfg.selfHandles[0], "⚠️ Finagai couldn't run that task (server error). I've stopped it; please try again."); return; }
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    failures = 0;
    if (r.status === "done") {
      // Send the final artifact image to Julian's thread (and it is also returned to the chat via control_result).
      const dir = join(OUT_ROOT, "done-" + Date.now()); mkdirSync(dir, { recursive: true });
      let png = null;
      const ir = await core(cfg, "/control/result-image", { taskCode: taskCodeCache[taskId] }).catch(() => null);
      const b64 = (ir && ir.imageB64) || await screenshotB64().catch(() => null);
      if (b64) { png = join(dir, "result.png"); writeFileSync(png, Buffer.from(b64, "base64")); }
      await sendIMessage(cfg.selfHandles[0], `✅ Finagai finished${r.requester ? ` ${r.requester}'s task` : ""}: ${r.message || "done"}`);
      if (png) await sendIMessageFile(cfg.selfHandles[0], png).catch(() => {});
      // Register the result image as an artifact (kind "result") so "send <contact>" can forward it too,
      // not just charts.
      if (png) await core(cfg, "/artifact/register", { kind: "result", mime: "image/png", storageRef: png, summary: r.message || "task result", conversation: "self" }).catch(() => {});
      if (r.requester && png) {
        const handle = (cfg.contacts.find((c) => c.label === r.requester) || {}).handle;
        if (handle) await sendIMessage(cfg.selfHandles[0], `Reply “send ${r.requester}” to forward this to ${r.requester}.`);
      }
      return;
    }
    if (r.status === "failed") { await sendIMessage(cfg.selfHandles[0], `⚠️ Finagai stopped: ${r.message || "couldn't continue"}`); return; }
    if (r.status === "cancelled") return;
    if (r.status === "ask") { await sendIMessage(cfg.selfHandles[0], `❓ Finagai needs you: ${r.message}\nReply in this thread, or “stop ${taskCodeCache[taskId] ?? ""}”.`); return; }
    if (r.status === "await_approval") {
      if (r.step) await sendIMessage(cfg.selfHandles[0], `🖐 Finagai wants to: ${r.step.summary}\nReply “ok ${r.step.code}” to allow, “no ${r.step.code}” to skip, “stop ${taskCodeCache[taskId] ?? ""}” to cancel.`);
      else await sendIMessage(cfg.selfHandles[0], `🖐 Finagai paused: ${r.message || "needs your ok"}.`);
      return; // resumes when Julian approves (handled in the message loop)
    }
    // run_read or run_approved: execute now, report, continue
    const res = await runControlStep(r.step).catch((e) => `error: ${String(e?.message ?? e).slice(0, 200)}`);
    await core(cfg, "/control/ran", { stepId: r.step.id, ok: !String(res).startsWith("error") && !String(res).startsWith("refused"), result: res });
    lastResult = `${r.step.summary}: ${res}`;
  }
  await sendIMessage(cfg.selfHandles[0], "⏸ Finagai paused this task (long run). Reply to continue.");
}

const taskCodeCache = {};

// ------------------------------------------------------------------------------ I/O

function loadConfig() {
  const c = JSON.parse(readFileSync(CONFIG, "utf8"));
  if (!c.coreUrl || !c.token || !Array.isArray(c.contacts) || !Array.isArray(c.selfHandles)) throw new Error(`incomplete config in ${CONFIG}`);
  c.contacts = c.contacts.map((x) => ({ handle: normalizeHandle(x.handle), label: String(x.label).trim() }));
  c.selfHandles = c.selfHandles.map(normalizeHandle);
  return c;
}
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { lastRowId: null, backfilled: [], seenGuids: [] });
const saveState = (s) => { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s), { mode: 0o600 }); };
const log = (msg, f = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...f }));

async function sql(query) {
  const { stdout } = await run("/usr/bin/sqlite3", ["-readonly", "-json", CHAT_DB, query], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

const BASE = `SELECT m.ROWID AS rowid, m.guid, m.is_from_me AS fromMe, m.date AS date, m.text AS text,
                     hex(m.attributedBody) AS ab, c.chat_identifier AS chat
                FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id
               WHERE c.style = 45 AND m.item_type = 0`;

async function core(cfg, path, body) {
  const r = await fetch(new URL(path, cfg.coreUrl), {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

/** Send an iMessage; argv passing keeps message text out of the AppleScript source. */
export async function sendIMessage(handle, text) {
  const script = [
    "on run argv",
    "set theText to item 1 of argv",
    "set theHandle to item 2 of argv",
    'tell application "Messages"',
    "set svc to 1st account whose service type = iMessage",
    "send theText to participant theHandle of svc",
    "end tell",
    "end run",
  ];
  rememberSent(text);
  await run("/usr/bin/osascript", [...script.flatMap((l) => ["-e", l]), text, handle]);
}

// ------------------------------------------------------------------------------ loop

const toMsg = (r, history) => ({ guid: r.guid, handle: normalizeHandle(r.chat), fromMe: r.fromMe === 1,
  text: messageText(r.text, r.ab), sentAt: appleDateToIso(r.date), ...(history ? { history: true } : {}) });

/** Task pickup (WO1). Runs EVERY tick, regardless of iMessage traffic — previously it only ran when a
 * new iMessage arrived (tick returned early on quiet ticks), so Core-created tasks starved. */
async function pickupTasks(cfg) {
// J6: pick up any control tasks Julian started from a Claude chat, and drive them.
const pending = await core(cfg, "/control/pending", {}).catch(() => null);
// Cheap deterministic work first (ping, chart); at most ONE open-ended J6 drive per tick so a long
// task never starves the round-trip/heartbeat path.
const tasks = (pending?.tasks ?? []).slice().sort((a, b) => rank(a.request) - rank(b.request));
let drives = 0;
for (const t of tasks) {
  if (rank(t.request) === 2 && drives++ >= 1) break;
  taskCodeCache[t.id] = t.code;
  if (!(await claim(cfg, t.id))) { log("task already claimed elsewhere", { code: t.code }); continue; }
  RUNTIME.currentTaskId = t.id;
  try {
    if (typeof t.request === "string" && t.request.startsWith("mac_diag_test")) {
      // Phase 1E live proof: emit one safe, sanitized diagnostic through Core, then complete the task.
      await diag("diag_selftest", `requested by task; helper ${HELPER_VERSION}; no action taken`, t.id);
      await core(cfg, "/mac/chart-done", { taskId: t.id, workerId: WORKER_ID, done: true, summary: "diagnostic self-test emitted" });
    } else if (typeof t.request === "string" && t.request.startsWith("mac_ping")) {
      await core(cfg, "/mac/chart-done", { taskId: t.id, workerId: WORKER_ID, done: true, summary: `pong from ${HELPER_VERSION} at ${new Date().toISOString()}` });
    } else if (typeof t.request === "string" && t.request.startsWith("mac_chart:")) {
      const spec = t.request.slice("mac_chart:".length);
      const [filename] = spec.split("::");
      await progress(cfg, t.id, "searching Mac for workbook");
      const r = await runMacChart(cfg, filename, t.id, (note) => progress(cfg, t.id, note));
      if (r && r.ok === false) {
        // Terminal failure with a concrete reason — never leave the task 'active'.
        await core(cfg, "/mac/chart-done", { taskId: t.id, workerId: WORKER_ID, failed: true, summary: r.message }).catch(() => {});
        await sendIMessage(cfg.selfHandles[0], `⚠️ ${r.message}`);
      }
    } else {
      await progress(cfg, t.id, "planning first step");
      await driveControl(cfg, t.id, (note) => progress(cfg, t.id, note));
    }
  } catch (e) {
    log("task failed", { code: t.code, error: String(e?.message ?? e).slice(0, 160) });
    await core(cfg, "/mac/chart-done", { taskId: t.id, workerId: WORKER_ID, failed: true, summary: `Mac worker error: ${String(e?.message ?? e).slice(0, 140)}` }).catch(() => {});
  } finally { RUNTIME.currentTaskId = null; }
}

}

async function tick(cfg, state) {
  const allowed = new Map(cfg.contacts.map((c) => [c.handle, c.label]));
  const self = new Set(cfg.selfHandles);

  if (state.lastRowId === null) {
    const [{ max }] = await sql(`SELECT max(ROWID) AS max FROM message`);
    state.lastRowId = Number(max ?? 0);                      // never process old messages as new requests
  }
  if (Date.now() - LAST_HB_AT > 10_000) await heartbeat(cfg);   // the independent timer usually already sent one
  await pickupTasks(cfg).catch((e) => diag("task_pickup_failed", e?.message ?? e));
  // Style history for contacts not yet backfilled (once per contact).
  for (const c of cfg.contacts.filter((x) => !state.backfilled.includes(x.handle))) {
    const rows = (await sql(`${BASE} ORDER BY m.ROWID DESC LIMIT 2000`)).filter((r) => normalizeHandle(r.chat) === c.handle).slice(0, HISTORY);
    const messages = rows.map((r) => toMsg(r, true)).filter((m) => m.text);
    await core(cfg, "/concierge/sync", { contacts: cfg.contacts, messages });
    state.backfilled.push(c.handle);
    saveState(state);
    log("backfilled style history", { contact: c.label, messages: messages.length });
  }

  // Self-heal: if the saved cursor is somehow ahead of the DB's real max ROWID (iCloud rewrites,
  // DB swap, a bad earlier max), reset it so we don't silently skip everything forever.
  const [{ dbmax }] = await sql(`SELECT max(ROWID) AS dbmax FROM message`);
  if (Number(dbmax ?? 0) < Number(state.lastRowId)) {
    log("cursor ahead of db; resetting", { was: state.lastRowId, dbmax });
    state.lastRowId = Math.max(0, Number(dbmax ?? 0) - 50);
    saveState(state);
  }

  // Primary: new rows by ROWID. Secondary: anything in the last 12 minutes we haven't seen, so a stuck
  // or drifting cursor can never make us miss a real message (Apple messages via Messages/MessagesInAppStore).
  const APPLE_12MIN_AGO = `((strftime('%s','now') - 720 - 978307200) * 1000000000)`;
  const rowsById = await sql(`${BASE} AND m.ROWID > ${Number(state.lastRowId)} ORDER BY m.ROWID LIMIT 500`);
  const rowsByTime = await sql(`${BASE} AND m.date > ${APPLE_12MIN_AGO} ORDER BY m.ROWID DESC LIMIT 100`);
  const byGuid = new Map();
  for (const r of [...rowsById, ...rowsByTime]) if (!state.seenGuids?.includes(r.guid)) byGuid.set(r.guid, r);
  const rows = [...byGuid.values()].sort((a, b) => Number(a.rowid) - Number(b.rowid));
  const anyRows = await sql(`SELECT count(*) AS n, max(ROWID) AS max FROM message WHERE ROWID > ${Number(state.lastRowId)}`);
  if (rows.length || anyRows[0]?.n > 0) {
    const seen = {};
    for (const r of rows) { const h = normalizeHandle(r.chat); const k = allowed.get(h) ?? (self.has(h) ? "SELF" : `other:${h}`); seen[k] = (seen[k] ?? 0) + 1; }
    log("new messages", { byId: rowsById.length, byTime: rowsByTime.length, toProcess: rows.length, byThread: seen });
  }
  if (!rows.length) {
    if (anyRows[0]?.n > 0) { state.lastRowId = Number(anyRows[0].max); saveState(state); }
    return;
  }
  const contactMsgs = [];
  const commands = [];
  for (const r of rows) {
    const h = normalizeHandle(r.chat);
    const text = messageText(r.text, r.ab);
    if (!text) continue;
    if (self.has(h)) {
      if (text.startsWith(DRAFT_PREFIX)) continue;
      if (wasRecentlySent(text)) { log("skip self-echo of our reply", { text: text.slice(0, 40) }); continue; }
      commands.push({ text, guid: r.guid, rowid: r.id ?? r.ROWID ?? null });
      continue;
    }
    if (allowed.has(h)) contactMsgs.push(toMsg(r, false));
  }
  state.lastRowId = Math.max(Number(state.lastRowId), ...rows.map((r) => Number(r.rowid)));
  // Remember recently processed guids (bounded) so the time-window query doesn't re-handle them.
  state.seenGuids = [...(state.seenGuids ?? []), ...rows.map((r) => r.guid)].slice(-400);
  saveState(state);

  if (contactMsgs.length) {
    const resp = await core(cfg, "/concierge/sync", { contacts: cfg.contacts, messages: contactMsgs, capabilities: ["files", "control"] });
    const drafts = [...(resp.drafts ?? [])];
    for (const fr of resp.fileRequests ?? []) {
      const files = await findEverything(fr.queries).catch(() => []);
      log("searched files", { contact: allowed.get(fr.handle), queries: fr.queries.length, files: files.length });
      const r = await core(cfg, "/concierge/context", { handle: fr.handle, trigger: fr.trigger, files, queries: fr.queries });
      drafts.push(...(r.drafts ?? []));
    }
    for (const t of resp.controlTasks ?? []) {
      const _req = String(t.request ?? "");
      // A chart/graph/plot word ALONE is enough — don't also require the word "spreadsheet".
      const _chartLike = /\b(chart|trend|graph|plot|gr[aá]fico|visuali[sz]e|diagram)\b/i.test(_req);
      if (_chartLike) {
        // Extract the subject: an explicit .xls name, a quoted title, or the text between the chart verb
        // and a trailing "and send…/for…/to me" clause.
        let filename = "";
        const em = _req.match(/([A-Za-z0-9 _.\-()]+\.(?:xlsx|xlsm|xls))/i) || _req.match(/[“"']([^”"']{2,80})[”"']/);
        if (em) filename = em[1].trim();
        if (!filename) {
          const vm = _req.match(/\b(?:chart|graph|plot|visuali[sz]e|diagram|trend(?:\s+chart)?)\s+(?:of\s+|the\s+|a\s+|my\s+)?(.+?)(?:\s+(?:and|then|,|for me|for Santiago|and send.*|to me|please)\b.*)?$/i);
          if (vm) filename = vm[1].replace(/\s+(excel|xlsx|workbook|spreadsheet|file|sheet)\b.*$/i, "").trim();
        }
        if (!filename) filename = _req.trim();
        taskCodeCache[t.taskId] = t.taskCode;
        log("routing contact request to mac chart", { label: t.label, filename });
        await sendIMessage(cfg.selfHandles[0], `🖥️ ${t.label} asked Finagai to chart “${filename}”. Building it now.`);
        const rr = await runMacChart(cfg, filename, t.taskId).catch((e) => { log("contact mac chart failed", { error: String(e?.message ?? e).slice(0,160) }); return { ok:false }; });
        if (rr?.ok) await sendIMessage(cfg.selfHandles[0], `Reply “send ${t.label}” to forward the chart to ${t.label}.`);
        continue;
      }
      taskCodeCache[t.taskId] = t.taskCode;
      await sendIMessage(cfg.selfHandles[0], `🖥️ ${t.label} asked Finagai to do something on your Mac:\n“${t.request}”\nFinagai will start; it will ask you to approve each step that changes anything. “stop ${t.taskCode}” to cancel.`);
      await driveControl(cfg, t.taskId).catch((e) => log("contact control drive failed", { error: String(e?.message ?? e).slice(0, 160) }));
    }
    for (const d of drafts) {
      const files = d.attachments?.length ? await buildAttachments(d.id, d.attachments) : [];
      state.attachments = { ...(state.attachments ?? {}), [d.id]: files };
      saveState(state);
      await sendIMessage(cfg.selfHandles[0], draftNotice(d) + (files.length ? `\n\n📎 ${files.length} attachment(s) below will be sent too.` : ""));
      for (const f of files) await sendIMessageFile(cfg.selfHandles[0], f).catch(() => {});
      log("draft shown to Julian", { code: d.code, contact: d.label, attachments: files.length });
    }
  }
  const seenCmdText = new Set();
  for (const cmd of commands) {
    const text = cmd.text;
    const _nk = normText(text);
    if (seenCmdText.has(_nk)) { log("skip duplicate self-command", { text: text.slice(0,40) }); continue; }
    seenCmdText.add(_nk);
    if (cmd.guid) {
      const claim = await core(cfg, "/interaction/claim", { guid: cmd.guid, handle: cfg.selfHandles[0] }).catch(() => ({ claim: true }));
      if (!claim.claim) { log("skip duplicate command (claimed)", { guid: cmd.guid }); continue; }
      await core(cfg, "/interaction/finish", { guid: cmd.guid, ok: true }).catch(() => {});
    }
    // "send <contact>": forward the recent chart artifact to an allow-listed contact.
    const sendM = text.trim().match(/^send\s+(?:(?:it|that|this|the (?:last |latest )?\w+)\s+)?(?:to\s+)?(.+?)(?:\s+again)?[.!]?$/i);
    if (sendM) {
      const label = sendM[1].trim().toLowerCase();
      const contact = cfg.contacts.find((c) => c.label.toLowerCase() === label);
      if (!contact) { await sendIMessage(cfg.selfHandles[0], `I don't have a contact named “${sendM[1].trim()}”. Try: ${cfg.contacts.map((c)=>c.label).join(", ")}.`); continue; }
      // Resolve the most recent artifact of ANY kind (chart, Drive screenshot, task result), not just charts.
      const art = await core(cfg, "/artifact/recent", { conversation: "self" }).catch(() => null);
      const path = art && art.artifact && existsSync(art.artifact.storageRef) ? art.artifact.storageRef : null;
      if (!path) { await sendIMessage(cfg.selfHandles[0], "I don't have anything recent to send. Ask me to make or find something first."); continue; }
      // Phase 1B (corrected): idempotency = THIS explicit request (its message guid) × op × artifact × recipient.
      // A replay of the same message never sends twice; "send it to Santiago again" is a new message → new action.
      const requestRef = cmd.guid || `self-row-${cmd.rowid ?? Date.now()}`;
      const claim = await core(cfg, "/action/claim", { requestRef, operation: "send_artifact", artifactId: art.artifact.id, recipient: contact.handle })
        .catch((e) => ({ decision: "error", error: String(e?.message ?? e) }));
      if (claim.decision === "already_done" || claim.decision === "in_flight") { log("send suppressed (same request replayed)", { decision: claim.decision, requestRef }); continue; }
      if (claim.decision === "exhausted" || claim.decision === "error") { await sendIMessage(cfg.selfHandles[0], `⚠️ Couldn't send to ${contact.label} (${claim.decision}).`); continue; }
      const sinceApple = Math.floor(((claim.decision === "reconcile" ? new Date(claim.requestedAt).getTime() : Date.now()) / 1000 - 978307200 - 5) * 1e9);
      if (claim.decision === "reconcile") {
        // Outcome of an earlier attempt is unknown (crash/restart mid-send): look for evidence BEFORE resending.
        const ev = await outgoingEvidence(contact.handle, sinceApple).catch(() => null);
        if (ev) { const st = ev.delivered ? "delivered" : "outgoing_observed"; await core(cfg, "/action/report", { actionId: claim.actionId, state: st, evidence: ev }).catch(() => {});
          await sendIMessage(cfg.selfHandles[0], sendWordingLocal(st, contact.label)); continue; }
      }
      try {
        await sendIMessageFile(contact.handle, path);
        await core(cfg, "/action/report", { actionId: claim.actionId, state: "accepted", evidence: { via: "osascript", path } }).catch(() => {});
      } catch (e) {
        await core(cfg, "/action/report", { actionId: claim.actionId, state: "failed", evidence: { error: String(e?.message ?? e).slice(0, 160) } }).catch(() => {});
        await diag("artifact_send_failed", e?.message ?? e);
        await sendIMessage(cfg.selfHandles[0], `⚠️ Couldn't send to ${contact.label}: ${String(e?.message ?? e).slice(0,120)}`); continue;
      }
      // Evidence ladder: outgoing record (local) → delivery receipt (is_delivered). Never claim more than observed.
      let state = "accepted", ev = null;
      for (let i = 0; i < 4 && state !== "delivered"; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        ev = await outgoingEvidence(contact.handle, sinceApple).catch(() => null);
        if (ev) state = ev.delivered ? "delivered" : "outgoing_observed";
      }
      if (state !== "accepted") await core(cfg, "/action/report", { actionId: claim.actionId, state, evidence: ev }).catch(() => {});
      if (art.artifact) await core(cfg, "/artifact/sent", { id: art.artifact.id }).catch(() => {});
      await sendIMessage(cfg.selfHandles[0], sendWordingLocal(state, contact.label));
      log("forwarded artifact", { contact: contact.label, state, requestRef });
      continue;
    }
    // "mac doctor": capability diagnostic.
    if (/^(mac doctor|finagai doctor)$/i.test(text.trim())) {
      const tmp = join(OUT_ROOT, "doctor-" + Date.now() + ".png"); mkdirSync(OUT_ROOT, { recursive: true });
      const doc = await macDoctor(run, tmp).catch((e) => ({ checks: [{ name: "doctor", ok: false, detail: String(e?.message ?? e).slice(0,120) }], allPass: false }));
      const lines = ["🩺 Finagai Mac doctor"];
      for (const c of doc.checks) lines.push(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : ` — ${c.detail}${c.settingsHint ? ` → ${c.settingsHint}` : ""}`}`);
      if (!doc.allPass) lines.push("Fix the ❌ items in System Settings → Privacy & Security, then run “mac doctor” again.");
      await sendIMessage(cfg.selfHandles[0], lines.join("\n"));
      continue;
    }
    // "what am I looking at": current context.
    if (/^(what(?:'s| is| am i)?(?: on)?(?: my)? (?:screen|looking at|open)|current context)\b/i.test(text.trim())) {
      const fm = await getFrontmost(run).catch(() => ({ ok:false }));
      const tab = await browserActiveTab(run).catch(() => ({ ok:false }));
      const parts = [];
      if (fm.ok) parts.push(`Frontmost: ${fm.app}${fm.window ? ` — “${fm.window}”` : ""}`);
      if (tab.ok) parts.push(`Browser: ${tab.title || tab.url}`);
      await sendIMessage(cfg.selfHandles[0], parts.length ? `🖥️ ${parts.join("\n")}` : "Couldn't read screen context (run “mac doctor”).");
      continue;
    }
    // Control commands first (ok/no/stop <code>): approve a Mac step or cancel a task.
    const cr = await core(cfg, "/control/decision", { text }).catch(() => null);
    if (cr && (cr.status === "approved" || cr.status === "rejected")) {
      if (cr.status === "approved" && cr.stepId) {
        const step = await core(cfg, "/control/step", { stepId: cr.stepId }).catch(() => null);
        if (step && step.step) {
          const res = await runControlStep(step.step).catch((e) => `error: ${String(e?.message ?? e).slice(0, 200)}`);
          await core(cfg, "/control/ran", { stepId: cr.stepId, ok: !String(res).startsWith("error") && !String(res).startsWith("refused"), result: res });
        }
      }
      if (cr.taskId) await driveControl(cfg, cr.taskId).catch((e) => log("control resume failed", { error: String(e?.message ?? e).slice(0, 160) }));
      continue;
    }
    if (cr && cr.status === "cancelled") continue;
    // Phase 0C: a recognized command that changed nothing (already handled / unknown code / not resumable) gets a
    // plain answer — it must never fall through and become a new task.
    if (cr && ["already_handled", "not_found", "not_resumable"].includes(cr.status)) {
      const msg = cr.status === "not_found" ? "I don't have a task or step with that number." : cr.status === "not_resumable" ? "That task isn't waiting or expired, so there's nothing to resume." : "That step was already handled.";
      await sendIMessage(cfg.selfHandles[0], `ℹ️ ${msg}`).catch(() => {});
      continue;
    }
    const r = await core(cfg, "/concierge/decision", { text }).catch(() => null);  // 422 = ordinary note, not a command
    if (!r || r.status !== "send") {
      // Natural-language request from Julian's own thread (not a command, not a contact draft).
      // Route it so the self thread is never a dead end.
      const nreq = text.trim();
      if (nreq.length >= 2 && !/^(ok|no|stop|edit|resume|continue)\b/i.test(nreq)) {
        const chartWord = /\b(chart|trend|graph|plot|gr[aá]fico|visuali[sz]e|analy[sz]e)\b/i.test(nreq);
        const sheetWord = /\b(excel|xlsx|workbook|spreadsheet|hoja|sheet|\.xls)\b/i.test(nreq);
        // Resolve a filename from: an explicit .xls name, a quoted name, an "analysis/case/report"-style
        // title (no extension), or the frontmost window. Accept names WITHOUT an extension.
        const pickName = (txt) => {
          const m = txt.match(/([A-Za-z0-9 _.\-()]+\.(?:xlsx|xlsm|xls))/i)   // explicit extension
                || txt.match(/[“"']([^”"']{2,80})[”"']/)                        // quoted title
                || txt.match(/\b([A-Z][A-Za-z0-9]*(?:\s+[A-Za-z0-9()]+){1,6})\b/); // Title Case phrase
          return m ? m[1].trim() : "";
        };
        // Is this a reply to our own "Which spreadsheet?" prompt? Then treat the whole text as the name.
        const answeringWhich = wasRecentlySent("Which spreadsheet? Tell me the file name, or open it so it's the front window.");
        if (chartWord || answeringWhich) {
          let filename = pickName(nreq);
          if (!filename && (chartWord && sheetWord)) { const fm = await getFrontmost(run).catch(() => ({ ok:false })); if (fm.ok && fm.window) filename = String(fm.window).replace(/\s+—.*$/, "").trim(); }
          if (!filename && answeringWhich) filename = nreq;   // the reply IS the name
          if (filename) {
            await sendIMessage(cfg.selfHandles[0], `On it — charting “${filename}”.`);
            const t = await core(cfg, "/control/start", { request: `mac_chart:${filename}` }).catch(() => null);
            if (!t) await sendIMessage(cfg.selfHandles[0], "Couldn't start that just now — try again in a moment.");
          } else {
            await sendIMessage(cfg.selfHandles[0], "Which spreadsheet? Tell me the file name, or open it so it's the front window.");
          }
          continue;
        }
        // Non-chart natural request → general Mac task (J6).
        await sendIMessage(cfg.selfHandles[0], "On it.");
        const t = await core(cfg, "/control/start", { request: nreq }).catch(() => null);
        if (!t) await sendIMessage(cfg.selfHandles[0], "Couldn't start that just now — try again in a moment.");
        continue;
      }
      continue;
    }
    if (!allowed.has(normalizeHandle(r.handle))) { log("refused: handle not allow-listed", {}); await core(cfg, "/concierge/sent", { id: r.id, ok: false }); continue; }
    try {
      await sendIMessage(r.handle, r.body);
      const files = (state.attachments ?? {})[r.id] ?? [];
      for (const f of files) if (existsSync(f)) await sendIMessageFile(r.handle, f);
      delete (state.attachments ?? {})[r.id];
      await core(cfg, "/concierge/sent", { id: r.id, ok: true });
      log("reply sent", { contact: allowed.get(normalizeHandle(r.handle)), attachments: files.length });
    } catch (err) {
      await core(cfg, "/concierge/sent", { id: r.id, ok: false });
      log("send failed", { error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  saveState(state);
}

async function main() {
  const cfg = loadConfig();
  if (process.argv.includes("--check")) {
    const [{ n }] = await sql(`SELECT count(*) AS n FROM message`);
    const h = await fetch(new URL("/health", cfg.coreUrl)).then((r) => r.json());
    console.log(`Messages database readable (${n} messages). Finagai Core: ${h.status}. Contacts: ${cfg.contacts.map((c) => c.label).join(", ")}.`);
    return;
  }
  const state = loadState();
  log("finagai imessage helper started", { version: HELPER_VERSION, contacts: cfg.contacts.map((c) => c.label), handles: cfg.contacts.map((c) => c.handle), self: cfg.selfHandles });
  setInterval(() => log("alive", { lastRowId: state.lastRowId }), 600_000);
  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try { await tick(cfg, state); } catch (err) { log("tick failed", { error: String(err?.message ?? err).slice(0, 300) }); }
    finally { busy = false; }
  };
  await loop();
  setInterval(loop, POLL_MS);
  // Liveness is independent of work: a long J6 drive inside tick() must never suppress heartbeats
  // (live: Mac reported offline for 62s while executing task #107, and the health gate refused new work).
  let hbBusy = false;
  setInterval(async () => {
    if (hbBusy || Date.now() - LAST_HB_AT < 12_000) return;
    hbBusy = true;
    try { await heartbeat(cfg); } catch { /* heartbeat() records coreDown itself */ } finally { hbBusy = false; }
  }, 15_000);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { log("fatal", { error: String(err?.message ?? err) }); process.exit(1); });
