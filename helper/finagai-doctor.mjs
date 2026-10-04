#!/usr/bin/env node
/**
 * finagai mac doctor (WO1). Every line is a REAL probe — nothing passes from configuration alone.
 *
 *   node ~/.finagai/finagai-doctor.mjs                 full diagnostic incl. a live round-trip task
 *   node ~/.finagai/finagai-doctor.mjs --probe-restart kill the daemon and verify launchd restarts it (test A)
 *   node ~/.finagai/finagai-doctor.mjs --soak 100      100 sequential round-trip tasks without a restart (test H)
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { macDoctor } from "./mac-perception.mjs";

const run = promisify(execFile);
const DIR = join(homedir(), ".finagai");
const PLIST = join(homedir(), "Library/LaunchAgents/com.finagai.imessage.plist");
const LABEL = "com.finagai.imessage";
const rows = [];
const mark = (name, ok, detail = "") => { rows.push({ name, ok, detail }); };
const pad = (s, n) => (s + " ").padEnd(n, ".");

function loadCfg() {
  const p = join(DIR, "imessage-helper.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
async function core(cfg, path, body) {
  const r = await fetch(new URL(path, cfg.coreUrl), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` }, body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}
async function daemonPid() {
  try {
    const { stdout } = await run("/bin/launchctl", ["list"]);
    const line = stdout.split("\n").find((l) => l.includes(LABEL));
    if (!line) return { loaded: false, pid: null };
    const pid = parseInt(line.trim().split(/\s+/)[0], 10);
    return { loaded: true, pid: Number.isFinite(pid) && pid > 0 ? pid : null };
  } catch { return { loaded: false, pid: null }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function roundTrip(cfg, timeoutMs = 60_000) {
  const t0 = Date.now();
  const started = await core(cfg, "/control/start", { request: "mac_ping" });
  const code = started.taskCode;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    const st = await core(cfg, "/mac/status", {});
    const cur = st.currentTask;
    // task leaves "current" once finished; read it back
    const res = await core(cfg, "/control/result", { taskCode: code }).catch(() => null);
    if (res && res.status === "done") return { ok: true, ms: Date.now() - t0, code };
    if (res && res.status === "failed") return { ok: false, ms: Date.now() - t0, code, detail: res.summary };
    void cur;
  }
  return { ok: false, ms: Date.now() - t0, code, detail: "timeout" };
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = loadCfg();

  // 1. daemon installed / running
  mark("Daemon installed (LaunchAgent plist)", existsSync(PLIST), PLIST);
  const d = await daemonPid();
  mark("Daemon loaded in launchd", d.loaded);
  mark("Daemon running (has PID)", !!d.pid, d.pid ? `pid ${d.pid}` : "no live process");
  mark("Helper file present", existsSync(join(DIR, "finagai-imessage.mjs")));
  mark("Perception module present", existsSync(join(DIR, "mac-perception.mjs")));
  mark("Config present (coreUrl + token)", !!cfg, cfg ? cfg.coreUrl : "~/.finagai/imessage-helper.json missing/invalid");

  if (args.includes("--probe-restart")) {
    if (!d.pid) { mark("A: crash -> auto-restart", false, "daemon not running"); return report(); }
    process.kill(d.pid, "SIGKILL");
    const t0 = Date.now(); let np = null;
    while (Date.now() - t0 < 30_000) { await sleep(1000); const x = await daemonPid(); if (x.pid && x.pid !== d.pid) { np = x.pid; break; } }
    mark("A: crash -> auto-restart (launchd KeepAlive)", !!np, np ? `old pid ${d.pid} -> new pid ${np} in ${Math.round((Date.now() - t0) / 1000)}s` : "no new PID within 30s");
    return report();
  }

  if (!cfg) return report();

  // 2. Core connectivity + auth
  let health = null;
  try { health = await fetch(new URL("/health", cfg.coreUrl)).then((r) => r.json()); mark("Core reachable (/health)", true, `version ${health.version}`); }
  catch (e) { mark("Core reachable (/health)", false, String(e?.message ?? e).slice(0, 80)); }
  let status = null;
  try { status = await core(cfg, "/mac/status", {}); mark("Auth accepted (bearer token)", true); }
  catch (e) { mark("Auth accepted (bearer token)", false, String(e?.message ?? e).slice(0, 80)); }

  // 3. heartbeat as Core sees it
  if (status) {
    mark("Heartbeat fresh (Core sees this Mac online)", status.connected === true, status.lastHeartbeatSecondsAgo != null ? `${status.lastHeartbeatSecondsAgo}s ago, helper ${status.helperVersion}` : "never");
    mark("Runtime counters", true, `restarts ${status.restartCount} · reconnects ${status.reconnectCount} · last success ${status.lastSuccess ? "task " + status.lastSuccess.taskCode : "none"}`);
  }

  // 4. capability probes (real)
  const doc = await macDoctor(run, join(DIR, "doctor-probe.png")).catch((e) => ({ checks: [{ name: "capability probe", ok: false, detail: String(e?.message ?? e) }] }));
  for (const c of doc.checks) mark(c.name, c.ok, c.ok ? "" : `${c.detail}${c.settingsHint ? " → " + c.settingsHint : ""}`);
  // keyboard/mouse: System Events can post keystrokes only with Accessibility; probe a harmless no-op.
  try { await run("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 63']); mark("Keyboard/mouse control (System Events)", true); }
  catch (e) { mark("Keyboard/mouse control (System Events)", false, "Accessibility permission → Privacy & Security → Accessibility"); }

  // 5. round-trip task
  if (status && status.connected) {
    const rt = await roundTrip(cfg);
    mark("Round-trip task (Core -> Mac -> result)", rt.ok, rt.ok ? `task ${rt.code} in ${rt.ms}ms` : `task ${rt.code}: ${rt.detail}`);
  } else mark("Round-trip task (Core -> Mac -> result)", false, "skipped: Mac not online");

  // H: soak
  const si = args.indexOf("--soak");
  if (si >= 0) {
    const n = parseInt(args[si + 1] || "100", 10); let okN = 0, worst = 0; const t0 = Date.now();
    for (let i = 0; i < n; i++) { const r = await roundTrip(cfg, 45_000); if (r.ok) okN++; worst = Math.max(worst, r.ms); }
    mark(`H: ${n} sequential tasks without restart`, okN === n, `${okN}/${n} ok, worst ${worst}ms, total ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  report();
}
function report() {
  const allOk = rows.every((r) => r.ok);
  console.log("\nFINAGAI MAC DOCTOR");
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.name, 48)} ${r.detail}`);
  console.log(`\n${allOk ? "ALL PASS" : rows.filter((r) => !r.ok).length + " FAILING — fix the FAIL lines above"}`);
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error("doctor crashed:", e); process.exit(2); });
