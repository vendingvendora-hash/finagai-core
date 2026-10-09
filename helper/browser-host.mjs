#!/usr/bin/env node
/*
 * Finagai native-messaging host (Phase 1, ADR-077). Chrome/Firefox launch this when the Finagai Operator
 * extension calls connectNative("com.finagai.browser"); only that extension id is allowed by the host manifest.
 *
 * It is a dumb relay: browser (4-byte little-endian length + JSON on stdin/stdout) <-> Finagai Mac helper
 * (newline-delimited JSON over the Unix socket ~/.finagai/browser.sock, mode 0600). It stores nothing, logs no
 * page content, and exits when the browser closes stdin.
 */
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCK = process.env.FINAGAI_BROWSER_SOCK || join(homedir(), ".finagai", "browser.sock");
const MAX_TO_BROWSER = 1024 * 1024 - 64;   // Chrome's host->browser limit is 1 MB

let sock = null;
const toHelper = [];          // queued while the helper is unreachable (bounded)
let buf = Buffer.alloc(0);
let hello = null;             // re-announced on every (re)connect so a restarted helper knows which browser this is

function writeToBrowser(obj) {
  let json = Buffer.from(JSON.stringify(obj), "utf8");
  if (json.length > MAX_TO_BROWSER) json = Buffer.from(JSON.stringify({ id: obj.id, ok: false, error: "message_too_large" }), "utf8");
  const len = Buffer.alloc(4); len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

function connect() {
  const s = net.createConnection(SOCK);
  let line = "";
  s.setEncoding("utf8");
  s.on("connect", () => { sock = s; if (hello && !toHelper.includes(hello)) s.write(hello + "\n"); while (toHelper.length) s.write(toHelper.shift() + "\n"); });
  s.on("data", (d) => {
    line += d;
    let i;
    while ((i = line.indexOf("\n")) >= 0) {
      const raw = line.slice(0, i); line = line.slice(i + 1);
      if (!raw.trim()) continue;
      try { writeToBrowser(JSON.parse(raw)); } catch { /* ignore malformed */ }
    }
  });
  const retry = () => { if (sock === s) sock = null; setTimeout(connect, 2000); };
  s.on("error", () => {});
  s.on("close", retry);
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const msg = buf.subarray(4, 4 + n).toString("utf8");
    buf = buf.subarray(4 + n);
    if (msg.includes('"type":"hello"')) hello = msg;
    if (sock) sock.write(msg + "\n");
    else if (toHelper.length < 100) toHelper.push(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
connect();
