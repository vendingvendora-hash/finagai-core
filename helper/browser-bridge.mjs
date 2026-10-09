/*
 * Finagai browser bridge (Phase 1, ADR-077) — runs inside the Mac helper.
 *
 * Accepts native-host connections on a Unix socket (0600). Each connection is one browser running the Finagai
 * Operator extension (it announces {family, brand}). J6 browser_* steps are routed to the FRONTMOST browser's
 * extension; if that browser has no extension connected the step fails with a clear "fallback" error so the
 * planner drops to Mac Accessibility / vision / coordinates (hierarchy: API → DOM → AX → vision → mouse).
 *
 * Every write op is observe → act → verify: fills are read back, clicks are followed by a wait for an
 * observable change, uploads verify the file control holds the expected name. Results start with
 * "verified:", "unverified:", "refused:" or "error:" (same contract as the AX actions, so the acceptance
 * verifier treats an unverified browser write as NOT done).
 */
import net from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";

const MIME = { ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain", ".rtf": "application/rtf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const CHUNK_B64 = 512 * 1024;

/** Which connected browser serves a frontmost app name. */
export function familyFor(appName) {
  const a = String(appName ?? "").toLowerCase();
  if (/firefox/.test(a)) return { family: "firefox" };
  if (/google chrome|chromium|^arc$|microsoft edge|brave/.test(a)) return { family: "chromium", brand: /edge/.test(a) ? "Microsoft Edge" : /brave/.test(a) ? "Brave Browser" : "Google Chrome" };
  return null;
}

export function createBrowserBridge({ sockPath, log = () => {} }) {
  const conns = new Set();
  let server = null;

  function onConn(sock) {
    const c = { sock, family: null, brand: null, version: null, pending: new Map(), connectedAt: Date.now() };
    conns.add(c);
    let line = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      line += d;
      let i;
      while ((i = line.indexOf("\n")) >= 0) {
        const raw = line.slice(0, i); line = line.slice(i + 1);
        let msg; try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.type === "hello") { c.family = msg.family; c.brand = msg.brand; c.version = msg.version; log("browser extension connected", { family: c.family, brand: c.brand, version: c.version }); continue; }
        if (msg.id && c.pending.has(msg.id)) { const p = c.pending.get(msg.id); c.pending.delete(msg.id); clearTimeout(p.timer); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "browser error")); }
      }
    });
    const drop = () => { conns.delete(c); for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new Error("browser disconnected")); } c.pending.clear(); };
    sock.on("close", drop); sock.on("error", drop);
  }

  function listen() {
    mkdirSync(dirname(sockPath), { recursive: true });
    if (existsSync(sockPath)) { try { unlinkSync(sockPath); } catch { /* stale */ } }
    server = net.createServer(onConn);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => { try { chmodSync(sockPath, 0o600); } catch { /* best effort */ } resolve(); });
    });
  }
  function close() { for (const c of conns) c.sock.destroy(); conns.clear(); return new Promise((r) => (server ? server.close(() => r()) : r())); }

  const connected = () => Array.from(conns).filter((c) => c.family).map((c) => ({ family: c.family, brand: c.brand, version: c.version }));

  function pick(target) {
    const live = Array.from(conns).filter((c) => c.family);
    if (!target) return live[0] ?? null;
    const byFamily = live.filter((c) => c.family === target.family);
    return byFamily.find((c) => !target.brand || c.brand === target.brand) ?? (byFamily.length === 1 ? byFamily[0] : null);
  }

  function call(target, op, args = {}, timeoutMs = 20_000) {
    const c = pick(target);
    if (!c) return Promise.reject(Object.assign(new Error(`no_extension: ${target ? (target.brand ?? target.family) : "no browser"} has no Finagai Operator extension connected`), { code: "no_extension" }));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { c.pending.delete(id); reject(new Error(`timeout: ${op} took over ${timeoutMs} ms`)); }, timeoutMs);
      c.pending.set(id, { resolve, reject, timer });
      c.sock.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }

  return { listen, close, connected, call, pick };
}

// ---------------------------------------------------------------------------------------------------------------
// Planner-facing rendering (compact, bounded). Core wraps this as UNTRUSTED page content.

const flag = (c) => [c.required && "required", c.disabled && "disabled", c.invalid && `INVALID${c.error ? `: ${c.error}` : ""}`, c.secret && "SECRET(never fill)", c.commit && "COMMIT(needs Julian)",
  c.checked === true && "checked", c.checked === false && "unchecked", c.expanded === true && "expanded"].filter(Boolean).join(", ");
export function renderControl(c) {
  const val = c.files ? ` files=[${c.files.join(", ")}]${c.accept ? ` accept=${c.accept}` : ""}` : c.value !== undefined && c.value !== "" ? ` value="${c.value}"` : c.value === "" ? ` value=""` : "";
  const opts = c.options ? ` options: ${c.options.slice(0, 12).join(" | ")}${c.options.length > 12 || c.optionsTruncated ? " | …" : ""}` : "";
  const f = flag(c);
  return `${c.ref} ${c.role} "${c.name}"${val}${f ? ` [${f}]` : ""}${opts}`;
}
export function renderPage(page, { maxControls = 120, textChars = 3000 } = {}) {
  const top = page.frames.find((f) => f.isTop) ?? page.frames[0];
  const lines = [`${page.tab.title ? `"${page.tab.title}"` : ""} ${page.tab.url ?? ""} (tab ${page.tab.tabId})`.trim()];
  const blockers = Array.from(new Set(page.frames.flatMap((f) => f.blockers ?? [])));
  if (blockers.length) lines.push(`BLOCKERS: ${blockers.join(", ")} — CAPTCHA/MFA/password need Julian (ask).`);
  const headings = page.frames.flatMap((f) => f.headings ?? []).slice(0, 12);
  if (headings.length) lines.push(`Headings: ${headings.map((h) => `H${h.level} ${h.text}`).join(" · ")}`);
  const dialogs = page.frames.flatMap((f) => f.dialogs ?? []);
  if (dialogs.length) lines.push(`Dialogs: ${dialogs.map((d) => `${d.ref} "${d.name}"${d.modal ? " (modal)" : ""}`).join("; ")}`);
  const alerts = page.frames.flatMap((f) => f.alerts ?? []);
  if (alerts.length) lines.push(`Alerts: ${alerts.slice(0, 5).join(" | ")}`);
  const controls = page.frames.flatMap((f) => f.controls ?? []);
  lines.push(`Controls (ref role "name" [state]) — use these refs with browser_* actions:`);
  for (const c of controls.slice(0, maxControls)) lines.push(renderControl(c));
  if (controls.length > maxControls) lines.push(`… ${controls.length - maxControls} more controls (scroll or browser_find)`);
  if (top?.scroll) lines.push(`Scroll: ${top.scroll.y}/${top.scroll.max}px`);
  if (top?.text) lines.push(`Text: ${top.text.slice(0, textChars)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// J6 step execution: observe → act → verify. `allowedPath(p)` is the helper's local-file guard.

const describeTarget = (t) => (t ? `${t.role} "${t.name}"` : "element");

async function resolveRef(call, p, role) {
  if (p.ref) return { ref: String(p.ref) };
  const query = { label: p.label ?? p.name, text: p.text, role: p.role ?? role, selector: p.selector, limit: 3 };
  if (!query.label && !query.text && !query.selector) throw new Error("give ref (from browser_read) or label/text/selector");
  const r = await call("find", { tabId: p.tabId, query });
  const [best, second] = r.matches;
  if (!best) throw new Error(`no ${role ?? "element"} matching ${JSON.stringify(query.label ?? query.text ?? query.selector)} — browser_read and pick a ref`);
  if (second && second.score === best.score && second.name === best.name) throw new Error(`ambiguous: ${r.matches.length} elements named "${best.name}" — use a ref`);
  return { ref: best.ref, matched: best };
}

export async function runBrowserStep(bridge, target, step, { allowedPath, julianApproved = false } = {}) {
  const p = step.params ?? {};
  const call = (op, args, t) => bridge.call(target, op, args, t);
  try {
    switch (step.kind) {
      case "browser_list_tabs": return `tabs: ${JSON.stringify((await call("list_tabs")).map((t) => ({ tabId: t.tabId, active: t.active, title: t.title.slice(0, 80), url: (t.url ?? "").slice(0, 160) })))}`;
      case "browser_read": { const page = await call("read_page", { tabId: p.tabId, maxControls: 200 }); return `page:\n${renderPage(page)}`; }
      case "browser_find": {
        const r = await call("find", { tabId: p.tabId, query: { label: p.label, name: p.name, text: p.text, role: p.role, selector: p.selector, limit: 8 } });
        return r.matches.length ? `found:\n${r.matches.map(renderControl).join("\n")}` : "found: nothing matching — browser_read the page or scroll";
      }
      case "browser_open_tab": {
        const t = await call("open_tab", { url: String(p.url ?? ""), active: p.active !== false }, 30_000);
        return /^https?:/.test(t.url ?? "") ? `verified: opened tab ${t.tabId} "${t.title}" ${t.url}` : `unverified: tab ${t.tabId} did not load (${t.status})`;
      }
      case "browser_navigate": { const t = await call("navigate", { tabId: p.tabId, url: String(p.url ?? "") }, 30_000); return `verified: tab ${t.tabId} now "${t.title}" ${t.url}`; }
      case "browser_switch_tab": {
        let tabId = p.tabId;
        if (!tabId && (p.title || p.url)) {
          const tabs = await call("list_tabs");
          const m = tabs.find((t) => (p.url && (t.url ?? "").includes(p.url)) || (p.title && t.title.toLowerCase().includes(String(p.title).toLowerCase())));
          if (!m) return `error: no tab matching ${JSON.stringify(p.title ?? p.url)}`;
          tabId = m.tabId;
        }
        const r = await call("switch_tab", { tabId });
        return `${r.verified ? "verified" : "unverified"}: active tab ${r.tab.tabId} "${r.tab.title}"`;
      }
      case "browser_close_tab": { const r = await call("close_tab", { tabId: p.tabId, julianAsked: julianApproved }); return r.refused ? `refused: ${r.reason}` : `${r.verified ? "verified" : "unverified"}: closed tab ${p.tabId}`; }
      case "browser_scroll": { const r = await call("scroll", { tabId: p.tabId, ref: p.ref, dir: p.dir, amount: p.amount }); return `verified: scrolled to ${r?.scroll?.y ?? "?"}/${r?.scroll?.max ?? "?"}`; }
      case "browser_wait": { const r = await call("wait_for", { tabId: p.tabId, text: p.text, timeoutMs: Math.min(30_000, (Number(p.seconds) || 8) * 1000) }, 35_000); return r.ok ? `verified: ${r.met}${r.state ? ` — "${r.state.title}" ${r.state.url}` : ""}` : `unverified: waited, condition not met (${p.text ? `text "${p.text}"` : "load"})`; }
      case "browser_click": {
        const { ref } = await resolveRef(call, p);
        const before = await call("observe", { tabId: p.tabId });
        const r = await call("click", { tabId: p.tabId, ref, commitAuthorized: julianApproved });
        if (r.refused) return `refused: ${r.reason}`;
        if (!r.ok) return `error: ${r.reason}`;
        const w = await call("wait_for", { tabId: p.tabId, changedFrom: before.state?.signature, timeoutMs: Math.min(15_000, (Number(p.waitSeconds) || 5) * 1000) }, 20_000).catch(() => ({ ok: false }));
        const s = w.state ?? {};
        if (w.ok) return `verified: clicked ${describeTarget(r.target)}; page changed → "${s.title ?? ""}" ${s.url ?? ""}${s.dialogs?.length ? ` dialogs: ${s.dialogs.join(", ")}` : ""}${s.invalidFields ? ` invalid fields: ${s.invalidFields}` : ""}${s.alerts?.length ? ` alerts: ${s.alerts.join(" | ")}` : ""}`;
        return `unverified: clicked ${describeTarget(r.target)} but nothing observable changed within the wait — browser_read to check (validation errors? custom control?)`;
      }
      case "browser_fill": {
        const { ref } = await resolveRef(call, p, p.ref ? undefined : "textbox");
        const r = await call("fill", { tabId: p.tabId, ref, value: String(p.value ?? "") });
        if (r.refused) return `refused: ${r.reason}`;
        return r.verified ? `verified: "${r.field?.name}" = "${r.actual}"` : `unverified: "${r.field?.name ?? ref}" shows "${r.actual ?? ""}" (wanted "${r.expected ?? ""}") — ${r.reason}`;
      }
      case "browser_fill_form": {
        const out = [];
        for (const f of Array.isArray(p.fields) ? p.fields.slice(0, 40) : []) {
          const kind = f.option !== undefined ? "browser_select" : f.checked !== undefined ? "browser_check" : "browser_fill";
          out.push(await runBrowserStep(bridge, target, { kind, params: { tabId: p.tabId, ...f, value: f.value, option: f.option } }, { allowedPath, julianApproved }));
        }
        const bad = out.filter((x) => !x.startsWith("verified:"));
        return `${bad.length ? "unverified" : "verified"}: ${out.length - bad.length}/${out.length} fields verified\n${out.join("\n")}`;
      }
      case "browser_select": {
        const { ref } = await resolveRef(call, p, p.ref ? undefined : "combobox");
        const r = await call("select", { tabId: p.tabId, ref, value: p.option ?? p.value });
        if (r.needs === "option_click") return `unverified: opened custom dropdown "${r.field?.name}"; now browser_click the option "${p.option ?? p.value}" (by text) and browser_read to confirm`;
        return r.verified ? `verified: "${r.field?.name}" = "${r.actual}"` : `unverified: ${r.reason ?? "selection not kept"}${r.options ? ` (options: ${r.options.slice(0, 15).join(" | ")})` : ""}`;
      }
      case "browser_check": {
        const { ref } = await resolveRef(call, p, p.ref ? undefined : undefined);
        const r = await call("check", { tabId: p.tabId, ref, checked: p.checked !== false });
        return r.verified ? `verified: "${r.field?.name}" ${r.checked ? "checked" : "unchecked"}` : `unverified: ${r.reason}`;
      }
      case "browser_upload": {
        const path = String(p.path ?? "");
        if (!allowedPath || !allowedPath(path)) return "refused: file path not allowed (must be a regular file under your home folder, not hidden/Library/credentials)";
        const size = statSync(path).size;
        if (size > MAX_UPLOAD_BYTES) return `refused: file is ${Math.round(size / 1e6)} MB (limit ${MAX_UPLOAD_BYTES / 1e6} MB)`;
        const { ref } = await resolveRef(call, p, p.ref ? undefined : "file");
        const uploadId = randomUUID();
        const b64 = readFileSync(path).toString("base64");
        const name = basename(path);
        await call("upload_begin", { tabId: p.tabId, ref, uploadId, name, mime: MIME[extname(path).toLowerCase()] });
        for (let i = 0; i < b64.length; i += CHUNK_B64) await call("upload_chunk", { tabId: p.tabId, ref, uploadId, b64: b64.slice(i, i + CHUNK_B64) });
        const r = await call("upload_commit", { tabId: p.tabId, ref, uploadId }, 30_000);
        return r.verified ? `verified: file control holds ${name} (${r.size} bytes)` : `unverified: ${r.reason}`;
      }
      case "browser_download": { const r = await call("download", { url: String(p.url ?? "") }, 70_000); return r.ok ? `verified: downloaded ${r.path} (${r.bytes} bytes)` : `unverified: ${r.reason}`; }
      default: return `error: unknown browser step ${step.kind}`;
    }
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/^no_extension/.test(msg)) return `error: browser DOM channel unavailable (${msg.replace(/^no_extension:\s*/, "")}) — fall back to ax_*/screenshot/click`;
    return `error: ${msg.slice(0, 300)}`;
  }
}
