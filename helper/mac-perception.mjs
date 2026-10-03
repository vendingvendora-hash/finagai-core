/**
 * Deterministic Mac perception + capability diagnostic (product mandate: universal Mac perception).
 * These are the RELIABLE substrate beneath the general agent loop: plain AppleScript/shell probes that
 * return structured, bounded data. No LLM in the path. Each returns { ok, ... } or { ok:false, error }.
 *
 * Exported pure-ish helpers (they shell out, but take an injectable `run` for testing).
 */

const OSA = "/usr/bin/osascript";
const DEFAULT_RUN_OPTS = { timeout: 12_000, maxBuffer: 8 * 1024 * 1024 };

/** Run AppleScript lines, return trimmed stdout (or throw). `run` is injected for testability. */
async function osa(run, lines, args = [], opts = {}) {
  const r = await run(OSA, [...lines.flatMap((l) => ["-e", l]), ...args], { ...DEFAULT_RUN_OPTS, ...opts });
  return (r.stdout ?? "").trim();
}
async function osaJS(run, js, args = [], opts = {}) {
  const r = await run(OSA, ["-l", "JavaScript", "-e", js, ...args], { ...DEFAULT_RUN_OPTS, ...opts });
  return (r.stdout ?? "").trim();
}

/** Frontmost application name + its focused window title. */
export async function getFrontmost(run) {
  try {
    const out = await osa(run, [
      'tell application "System Events"',
      '  set p to first process whose frontmost is true',
      '  set app to name of p',
      '  set win to ""',
      '  try',
      '    set win to name of front window of p',
      '  end try',
      'end tell',
      'return app & "\\t" & win',
    ]);
    const [app, win] = out.split("\t");
    return { ok: true, app: app || null, window: win || null };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** All visible apps with window titles + bounds. Bounded to keep payload small. */
export async function listWindows(run, limit = 40) {
  try {
    const js = `
      (function(){
        const se = Application("System Events");
        const out = [];
        for (const p of se.applicationProcesses.whose({visible: true})()) {
          const app = p.name();
          let wins = [];
          try { wins = p.windows(); } catch(e) {}
          for (const w of wins) {
            let t="", pos=[0,0], sz=[0,0];
            try { t = w.name(); } catch(e){}
            try { pos = w.position(); } catch(e){}
            try { sz = w.size(); } catch(e){}
            out.push({app, title:t, x:pos[0], y:pos[1], w:sz[0], h:sz[1]});
            if (out.length >= ${limit}) return JSON.stringify(out);
          }
        }
        return JSON.stringify(out);
      })()`;
    const raw = await osaJS(run, js, [], { timeout: 15_000 });
    return { ok: true, windows: JSON.parse(raw || "[]") };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** List running apps (names only). */
export async function listApps(run) {
  try {
    const out = await osa(run, ['tell application "System Events" to get name of every process whose background only is false']);
    return { ok: true, apps: out.split(", ").map((s) => s.trim()).filter(Boolean) };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** Capture the whole screen to a PNG path (screencapture is silent, -x no sound). */
export async function captureScreen(run, outPath) {
  try {
    await run("/usr/sbin/screencapture", ["-x", outPath], { timeout: 15_000 });
    return { ok: true, path: outPath };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** The frontmost Chrome/Safari tab's URL + title (structured, no screen needed). */
export async function browserActiveTab(run) {
  for (const [appName, script] of [
    ["Google Chrome", ['tell application "Google Chrome"', 'if (count of windows) = 0 then return ""', 'set t to active tab of front window', 'return (URL of t) & "\\t" & (title of t)', 'end tell']],
    ["Safari", ['tell application "Safari"', 'if (count of documents) = 0 then return ""', 'return (URL of front document) & "\\t" & (name of front document)', 'end tell']],
  ]) {
    try {
      const running = await osa(run, [`tell application "System Events" to (name of processes) contains "${appName}"`]);
      if (running !== "true") continue;
      const out = await osa(run, script);
      if (!out) continue;
      const [url, title] = out.split("\t");
      return { ok: true, app: appName, url: url || null, title: title || null };
    } catch { /* try next */ }
  }
  return { ok: false, error: "no supported browser with an open tab" };
}

/** The frontmost browser page's visible text + clickable elements (DOM, when JS-from-AppleEvents is on). */
export async function browserReadPage(run) {
  try {
    const text = await osa(run, [
      'tell application "System Events" to set fm to name of first process whose frontmost is true',
      'if fm is "Google Chrome" then',
      'tell application "Google Chrome" to set t to execute of active tab of front window javascript "document.body?document.body.innerText.slice(0,6000):\\"\\""',
      'return t', 'end if', 'return ""']);
    return { ok: true, pageText: (text || "").slice(0, 6000) || null };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** The accessibility tree (role + title + value) of the front window of a given/ frontmost app. */
export async function accessibilityTree(run, limit = 80) {
  try {
    const js = `
      (function(){
        const se = Application("System Events");
        const p = se.applicationProcesses.whose({frontmost:true})()[0];
        if(!p) return "[]";
        let win; try { win = p.windows()[0]; } catch(e){ return "[]"; }
        if(!win) return "[]";
        const out=[];
        function walk(el, depth){
          if(out.length>=${limit}||depth>6) return;
          let role="",title="",val="";
          try{role=el.role();}catch(e){}
          try{title=el.title&&el.title();}catch(e){}
          try{val=el.value&&el.value();}catch(e){}
          if(role||title) out.push({role,title:(title||"").slice(0,60),value:String(val||"").slice(0,40),depth});
          let kids=[]; try{kids=el.uiElements();}catch(e){}
          for(const k of kids){ if(out.length>=${limit})break; walk(k,depth+1); }
        }
        walk(win,0);
        return JSON.stringify(out);
      })()`;
    const raw = await osaJS(run, js, [], { timeout: 15_000 });
    return { ok: true, tree: JSON.parse(raw || "[]") };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** Files currently selected in Finder. */
export async function getSelectedFiles(run) {
  try {
    const out = await osa(run, ['tell application "Finder" to set sel to selection', 'set p to {}', 'repeat with f in sel', 'set end of p to POSIX path of (f as alias)', 'end repeat', 'return p as text'], [], { timeout: 8000 });
    return { ok: true, files: out ? out.split(", ").filter(Boolean) : [] };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** Clipboard text (where permitted). */
export async function getClipboard(run) {
  try { const out = await run("/usr/bin/pbpaste", [], { timeout: 5000 }); return { ok: true, text: (out.stdout ?? "").slice(0, 4000) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/**
 * mac doctor: probe each capability and report PASS/FAIL with the specific remediation when blocked.
 * Returns a structured report; the helper prints it and can open the right System Settings pane.
 */
export async function macDoctor(run, tmpPath) {
  const checks = [];
  const add = (name, res, settingsHint) => checks.push({ name, ok: !!res.ok, detail: res.ok ? "ok" : (res.error || "blocked"), settingsHint: res.ok ? undefined : settingsHint });

  add("Accessibility / window enumeration", await listApps(run), "Privacy & Security → Accessibility");
  add("Active window", await getFrontmost(run), "Privacy & Security → Accessibility");
  const cap = await captureScreen(run, tmpPath);
  add("Screen Recording (capture)", cap, "Privacy & Security → Screen Recording");
  add("Filesystem search (Spotlight)", await (async () => { try { const r = await run("/usr/bin/mdfind", ["-name", "kMDItemFSName==*", "-onlyin", process.env.HOME || "/"], { timeout: 6000 }); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0,120) }; } })(), "Privacy & Security → Full Disk Access (for the node binary)");
  add("Browser active tab", await browserActiveTab(run), "Open Chrome/Safari with a tab; enable Automation when prompted");
  add("Accessibility tree", await accessibilityTree(run, 10), "Privacy & Security → Accessibility");
  add("Clipboard", await getClipboard(run), "usually available");
  return { checks, allPass: checks.every((c) => c.ok) };
}
