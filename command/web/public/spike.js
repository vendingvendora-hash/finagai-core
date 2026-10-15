// ADR-089 spike: proves browser → BFF session → Core /live/snapshot + /live/stream (SSE), resume, and that no Core
// token is visible to this page. Read-only; diagnostics only.
const $ = (id) => document.getElementById(id);
const seen = new Map(); let lastSeq = 0; let es = null; let dupes = 0; const lines = [];
const report = { session: null, snapshot: null, streamOpen: false, events: 0, duplicates: 0, maxLatencyMs: null, resumes: 0, tokenScan: null };
function render() { $("checks").textContent = JSON.stringify(report, null, 2); $("events").textContent = lines.slice(-40).join("\n"); }
function scanForTokens(texts) {
  const jwt = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/;
  const where = [];
  if (jwt.test(document.cookie)) where.push("document.cookie");
  for (let i = 0; i < localStorage.length; i++) where.push(`localStorage:${localStorage.key(i)}`);
  for (let i = 0; i < sessionStorage.length; i++) where.push(`sessionStorage:${sessionStorage.key(i)}`);
  for (const t of texts) if (jwt.test(t)) where.push("a response body");
  if (jwt.test(document.documentElement.outerHTML)) where.push("DOM");
  return { cookieVisibleToJs: document.cookie || "(none — the session cookie is HttpOnly)", jwtLikeFound: where };
}
function open(after) {
  es = new EventSource(`/api/live/stream?after=${after}`);
  es.onopen = () => { report.streamOpen = true; render(); };
  es.onerror = () => { report.streamOpen = false; render(); };
  es.onmessage = handle;
  for (const c of ["entity","relationship","area","objective","project","task","wait","workflow","tool","evidence","inference","lesson","procedure","capability","exception","escalation","approval","authority","notification","rule","source","system","other"])
    for (const v of ["created","updated","state_changed","archived","started","completed","failed","invoked","succeeded","routed","answered","observed","classified","ignored","attached","resolved","expired","cancelled","opened","cleared","notified","delivered","suppressed","checked","check_failed","connected","measured","learned","health_changed","recovered","remediated","fired","rearmed","removed","requested","diagnostic","error","skipped"])
      es.addEventListener(`${c}.${v}`, handle);
}
function handle(m) {
  const e = JSON.parse(m.data);
  if (seen.has(e.seq)) { dupes++; report.duplicates = dupes; render(); return; }
  seen.set(e.seq, true); lastSeq = Math.max(lastSeq, e.seq); report.events = seen.size;
  const lat = Date.now() - Date.parse(e.at); if (lat < 600000) report.maxLatencyMs = Math.max(report.maxLatencyMs ?? 0, lat);
  lines.push(`${new Date().toISOString().slice(11, 19)}  seq ${e.seq}  ${e.class}  ${e.area?.name ?? ""}  ${String(e.summary).slice(0, 80)}  (+${lat} ms)`);
  render();
}
$("drop").onclick = () => {
  if (!es) return; es.close(); report.streamOpen = false; lines.push(`— interrupted after seq ${lastSeq}; resuming in 20 s —`); render();
  setTimeout(() => { report.resumes++; lines.push(`— resuming after ${lastSeq} —`); open(lastSeq); }, 20000);
};
(async () => {
  const s = await fetch("/api/session").then((r) => r.json()); report.session = s;
  if (!s.signedIn) { location.href = "/auth/login"; return; }
  const snapText = await fetch("/api/live/snapshot").then((r) => r.text());
  const snap = JSON.parse(snapText);
  report.snapshot = { v: snap.v, cursor: snap.cursor, areas: snap.areas?.map((a) => `${a.name}${a.internal ? " (internal)" : ""}: ${a.health?.color}`), needsJulian: snap.needsJulian?.length, waits: snap.waits?.length };
  lastSeq = snap.cursor; open(snap.cursor);
  report.tokenScan = scanForTokens([snapText]);
  $("status").textContent = "Signed in. Snapshot loaded; listening for live events.";
  render();
})();
