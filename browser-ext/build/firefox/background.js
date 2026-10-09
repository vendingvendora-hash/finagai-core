/*
 * Finagai browser operator — extension background (Phase 1, ADR-077). Chrome (MV3 service worker) and Firefox
 * (MV3 background script) share this file.
 *
 * Channel: chrome.runtime.connectNative("com.finagai.browser") -> native host (helper/browser-host.mjs) ->
 * Unix socket ~/.finagai/browser.sock (0600) -> Finagai Mac helper. Only this extension's id may launch the host.
 *
 * Security (1E): no "cookies"/"webRequest"/"storage" permission; page content is returned as data; secrets are
 * never read or filled; external-commitment buttons are refused unless the request says Julian authorized it.
 */
const api = globalThis.browser ?? globalThis.chrome;
const HOST = "com.finagai.browser";
const VERSION = "1.0.0";
const IS_FIREFOX = typeof globalThis.browser !== "undefined" && !!globalThis.browser.runtime?.getBrowserInfo;

let port = null;
let backoff = 1000;
const openedByFinagai = new Set();

function brand() {
  if (IS_FIREFOX) return "Firefox";
  const b = (navigator.userAgentData?.brands ?? []).map((x) => x.brand).join(",");
  if (/Edge/i.test(b)) return "Microsoft Edge";
  if (/Brave/i.test(b)) return "Brave Browser";
  return "Google Chrome";   // Chrome, Chromium and Arc all present as Chrome-family
}

function connect() {
  try { port = api.runtime.connectNative(HOST); }
  catch (e) { port = null; setTimeout(connect, backoff = Math.min(backoff * 2, 60_000)); return; }
  port.onMessage.addListener((msg) => { handle(msg).catch(() => {}); });
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, backoff = Math.min(backoff * 2, 60_000)); });
  backoff = 1000;
  port.postMessage({ type: "hello", family: IS_FIREFOX ? "firefox" : "chromium", brand: brand(), version: VERSION });
}

async function handle(msg) {
  if (!msg || msg.type === "ping") { port?.postMessage({ type: "pong", at: Date.now() }); return; }
  const { id, op, args = {} } = msg;
  try {
    const result = await OPS[op]?.(args);
    if (result === undefined && !OPS[op]) throw new Error(`unknown_op: ${op}`);
    port?.postMessage({ id, ok: true, result });
  } catch (e) {
    port?.postMessage({ id, ok: false, error: String(e?.message ?? e).slice(0, 500) });
  }
}

// ---- tabs ------------------------------------------------------------------------------------------------
const tabView = (t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, index: t.index, url: t.url ?? null, title: t.title ?? "", status: t.status, openedByFinagai: openedByFinagai.has(t.id) });
async function activeTab() {
  const [t] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("no active tab");
  return t;
}
function waitComplete(tabId, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const done = () => { api.tabs.onUpdated.removeListener(on); clearTimeout(timer); api.tabs.get(tabId).then(resolve, () => resolve(null)); };
    const on = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, timeoutMs);
    api.tabs.onUpdated.addListener(on);
    api.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }, done);
  });
}

// ---- page (content script in all frames) -----------------------------------------------------------------
async function inject(tabId) {
  await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
}
async function inFrames(tabId, op, args, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  const run = () => api.scripting.executeScript({ target, func: (o, a) => {
    const f = globalThis.__finagai; if (!f) return { __missing: true };
    try { return { value: f[o](a) }; } catch (e) { return { error: String(e && e.message || e) }; }
  }, args: [op, args] });
  let res = await run();
  if (res.some((r) => r.result && r.result.__missing)) { await inject(tabId); res = await run(); }
  return res.map((r) => ({ frameId: r.frameId, ...(r.result ?? {}) }));
}
const splitRef = (ref) => { const m = /^(\d+):(e\d+)$/.exec(String(ref)); if (!m) throw new Error(`bad ref ${ref} (expected "frame:eN" from a read/find)`); return { frameId: Number(m[1]), ref: m[2] }; };
const prefix = (frameId, obj) => JSON.parse(JSON.stringify(obj).replace(/"(ref|form)":"(e\d+)"/g, (_, k, r) => `"${k}":"${frameId}:${r}"`));
async function resolveTab(args) { return args.tabId ? api.tabs.get(args.tabId) : activeTab(); }

async function readPage(args) {
  const t = await resolveTab(args);
  const frames = await inFrames(t.id, "snapshot", { maxControls: args.maxControls ?? 150, textChars: args.textChars ?? 6000, links: args.links });
  const out = { tab: tabView(t), frames: [] };
  for (const f of frames) {
    if (f.error) { out.frames.push({ frameId: f.frameId, error: f.error }); continue; }
    if (!f.value) continue;
    const v = prefix(f.frameId, f.value);
    if (f.frameId !== 0 && !v.controls.length && !v.headings.length) continue;   // empty ads/trackers
    out.frames.push({ frameId: f.frameId, ...v });
  }
  return out;
}
async function act(op, args) {
  const t = await resolveTab(args);
  const { frameId, ref } = splitRef(args.ref);
  const [r] = await inFrames(t.id, op, { ...args, ref }, [frameId]);
  if (!r) throw new Error("frame_gone");
  if (r.error) throw new Error(r.error);
  return prefix(frameId, r.value);
}
async function observeTop(tabId) { const [r] = await inFrames(tabId, "observe", {}, [0]); return r?.value ?? null; }

const OPS = {
  hello: async () => ({ family: IS_FIREFOX ? "firefox" : "chromium", brand: brand(), version: VERSION }),
  list_tabs: async () => (await api.tabs.query({})).map(tabView),
  active_tab: async () => tabView(await activeTab()),
  open_tab: async (a) => {
    if (!/^https?:\/\//i.test(String(a.url))) throw new Error("only http(s) URLs");
    const t = await api.tabs.create({ url: a.url, active: a.active !== false });
    openedByFinagai.add(t.id);
    const done = await waitComplete(t.id, a.timeoutMs);
    return tabView(done ?? t);
  },
  switch_tab: async (a) => {
    const t = await api.tabs.update(a.tabId, { active: true });
    await api.windows.update(t.windowId, { focused: true });
    const now = await activeTab();
    return { ok: now.id === a.tabId, verified: now.id === a.tabId, tab: tabView(now) };
  },
  close_tab: async (a) => {
    if (!openedByFinagai.has(a.tabId) && !a.julianAsked) return { ok: false, refused: "not_ours", reason: "Finagai only closes tabs it opened (unless Julian asked)" };
    await api.tabs.remove(a.tabId); openedByFinagai.delete(a.tabId);
    const still = (await api.tabs.query({})).some((t) => t.id === a.tabId);
    return { ok: !still, verified: !still };
  },
  navigate: async (a) => {
    if (!/^https?:\/\//i.test(String(a.url))) throw new Error("only http(s) URLs");
    const t = await resolveTab(a); await api.tabs.update(t.id, { url: a.url });
    const done = await waitComplete(t.id, a.timeoutMs);
    return tabView(done ?? t);
  },
  read_page: readPage,
  find: async (a) => {
    const t = await resolveTab(a);
    const frames = await inFrames(t.id, "find", a.query ?? {});
    const matches = frames.flatMap((f) => (f.value?.matches ?? []).map((m) => prefix(f.frameId, m))).sort((x, y) => y.score - x.score).slice(0, a.query?.limit ?? 8);
    return { tab: tabView(t), matches };
  },
  click: (a) => act("click", a),
  fill: (a) => act("fill", a),
  select: (a) => act("select", a),
  check: (a) => act("check", a),
  read_field: (a) => act("read", a),
  scroll: async (a) => (a.ref ? act("scroll", a) : (async () => { const t = await resolveTab(a); const [r] = await inFrames(t.id, "scroll", a, [0]); return r?.value; })()),
  upload_begin: (a) => act("uploadBegin", a),
  upload_chunk: (a) => act("uploadChunk", a),
  upload_commit: (a) => act("uploadCommit", a),
  observe: async (a) => { const t = await resolveTab(a); return { tab: tabView(t), state: await observeTop(t.id) }; },
  /** Wait for a postcondition: page signature change (navigation/re-render), text present, or timeout. */
  wait_for: async (a) => {
    const t = await resolveTab(a);
    const until = Date.now() + Math.min(Number(a.timeoutMs) || 8000, 30_000);
    let last = null;
    while (Date.now() < until) {
      const cur = await api.tabs.get(t.id);
      if (cur.status === "complete") {
        last = await observeTop(t.id).catch(() => null);
        if (last) {
          if (a.changedFrom && last.signature !== a.changedFrom) return { ok: true, met: "changed", state: last };
          if (a.text && (await inFrames(t.id, "find", { text: a.text, limit: 1 })).some((f) => f.value?.matches?.length)) return { ok: true, met: "text", state: last };
          if (!a.changedFrom && !a.text) return { ok: true, met: "loaded", state: last };
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, met: "timeout", state: last };
  },
  download: async (a) => {
    if (!api.downloads) throw new Error("downloads permission missing");
    const id = await api.downloads.download({ url: a.url, conflictAction: "uniquify", saveAs: false });
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const [d] = await api.downloads.search({ id });
      if (d?.state === "complete") return { ok: true, verified: true, path: d.filename, bytes: d.fileSize };
      if (d?.state === "interrupted") return { ok: false, reason: d.error ?? "interrupted" };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, reason: "download timeout" };
  },
};

connect();
