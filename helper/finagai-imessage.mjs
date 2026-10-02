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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
  return buf.subarray(p, p + len).toString("utf8");
}

export const appleDateToIso = (d) => new Date(Number(d) / 1e6 + APPLE_EPOCH_MS).toISOString();

export function draftNotice(d) {
  return `${DRAFT_PREFIX} #${d.code} → ${d.label}\n${d.summary ? `(${d.summary})\n` : ""}\n${d.body}\n\nReply “ok ${d.code}” to send, “no ${d.code}” to discard, or “edit ${d.code} <your text>”.`;
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
  if (!rows.length) return;
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
    const { drafts } = await core(cfg, "/concierge/sync", { contacts: cfg.contacts, messages: contactMsgs });
    for (const d of drafts ?? []) {
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
  log("finagai imessage helper started", { contacts: cfg.contacts.map((c) => c.label) });
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
