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
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
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

// ------------------------------------------------------------------------------ I/O

function loadConfig() {
  const c = JSON.parse(readFileSync(CONFIG, "utf8"));
  if (!c.coreUrl || !c.token || !Array.isArray(c.contacts) || !Array.isArray(c.selfHandles)) throw new Error(`incomplete config in ${CONFIG}`);
  c.contacts = c.contacts.map((x) => ({ handle: normalizeHandle(x.handle), label: String(x.label).trim() }));
  c.selfHandles = c.selfHandles.map(normalizeHandle);
  return c;
}
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { lastRowId: null, backfilled: [] });
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
  await run("/usr/bin/osascript", [...script.flatMap((l) => ["-e", l]), text, handle]);
}

// ------------------------------------------------------------------------------ loop

const toMsg = (r, history) => ({ guid: r.guid, handle: normalizeHandle(r.chat), fromMe: r.fromMe === 1,
  text: messageText(r.text, r.ab), sentAt: appleDateToIso(r.date), ...(history ? { history: true } : {}) });

async function tick(cfg, state) {
  const allowed = new Map(cfg.contacts.map((c) => [c.handle, c.label]));
  const self = new Set(cfg.selfHandles);

  if (state.lastRowId === null) {
    const [{ max }] = await sql(`SELECT max(ROWID) AS max FROM message`);
    state.lastRowId = Number(max ?? 0);                      // never process old messages as new requests
  }
  // Style history for contacts not yet backfilled (once per contact).
  for (const c of cfg.contacts.filter((x) => !state.backfilled.includes(x.handle))) {
    const rows = (await sql(`${BASE} ORDER BY m.ROWID DESC LIMIT 2000`)).filter((r) => normalizeHandle(r.chat) === c.handle).slice(0, HISTORY);
    const messages = rows.map((r) => toMsg(r, true)).filter((m) => m.text);
    await core(cfg, "/concierge/sync", { contacts: cfg.contacts, messages });
    state.backfilled.push(c.handle);
    saveState(state);
    log("backfilled style history", { contact: c.label, messages: messages.length });
  }

  const rows = await sql(`${BASE} AND m.ROWID > ${Number(state.lastRowId)} ORDER BY m.ROWID LIMIT 500`);
  const anyRows = await sql(`SELECT count(*) AS n, max(ROWID) AS max FROM message WHERE ROWID > ${Number(state.lastRowId)}`);
  if (anyRows[0]?.n > 0) {
    const seen = {};
    for (const r of rows) { const h = normalizeHandle(r.chat); const k = allowed.get(h) ?? (self.has(h) ? "SELF" : `other:${h}`); seen[k] = (seen[k] ?? 0) + 1; }
    log("new messages", { total: anyRows[0].n, oneToOne: rows.length, byThread: seen, empty: rows.filter((r) => !messageText(r.text, r.ab)).length });
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
    if (self.has(h)) { if (!text.startsWith(DRAFT_PREFIX)) commands.push(text); continue; }
    if (allowed.has(h)) contactMsgs.push(toMsg(r, false));
  }
  state.lastRowId = Math.max(...rows.map((r) => Number(r.rowid)));

  if (contactMsgs.length) {
    const resp = await core(cfg, "/concierge/sync", { contacts: cfg.contacts, messages: contactMsgs, capabilities: ["files"] });
    const drafts = [...(resp.drafts ?? [])];
    for (const fr of resp.fileRequests ?? []) {
      const files = await findEverything(fr.queries).catch(() => []);
      log("searched files", { contact: allowed.get(fr.handle), queries: fr.queries.length, files: files.length });
      const r = await core(cfg, "/concierge/context", { handle: fr.handle, trigger: fr.trigger, files });
      drafts.push(...(r.drafts ?? []));
    }
    for (const d of drafts) {
      await sendIMessage(cfg.selfHandles[0], draftNotice(d));
      log("draft shown to Julian", { code: d.code, contact: d.label });
    }
  }
  for (const text of commands) {
    const r = await core(cfg, "/concierge/decision", { text }).catch(() => null);  // 422 = ordinary note, not a command
    if (!r || r.status !== "send") continue;
    if (!allowed.has(normalizeHandle(r.handle))) { log("refused: handle not allow-listed", {}); await core(cfg, "/concierge/sent", { id: r.id, ok: false }); continue; }
    try {
      await sendIMessage(r.handle, r.body);
      await core(cfg, "/concierge/sent", { id: r.id, ok: true });
      log("reply sent", { contact: allowed.get(normalizeHandle(r.handle)) });
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
  log("finagai imessage helper started", { contacts: cfg.contacts.map((c) => c.label), handles: cfg.contacts.map((c) => c.handle), self: cfg.selfHandles });
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
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { log("fatal", { error: String(err?.message ?? err) }); process.exit(1); });
