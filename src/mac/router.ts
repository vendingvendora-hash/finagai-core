/**
 * WO4/WO8 — capability router (ADR-070). Deterministic, health-aware choice of the execution path for a
 * request: most deterministic → least expensive → most reliable that can complete the task, with the
 * fallback ladder stated explicitly so the planner never starts from a mouse click.
 */
export type Path = "connector_api" | "local_parser" | "app_scripting" | "browser_dom" | "accessibility" | "screen_perception" | "visual_mouse";

export type Health = { filesystem?: string; browser?: string; accessibility?: string; screenCapture?: string; activeWindow?: string } | null | undefined;

export type Route = { primary: Path; ladder: Path[]; reason: string; unavailable: Path[] };

const RUNG_HEALTH: Record<Path, (h: Health) => boolean> = {
  connector_api: () => true,
  local_parser: (h) => (h?.filesystem ?? "PASS") === "PASS",
  app_scripting: (h) => (h?.accessibility ?? "PASS") === "PASS",        // System Events needs Accessibility
  browser_dom: (h) => (h?.browser ?? "PASS") === "PASS",
  accessibility: (h) => (h?.accessibility ?? "PASS") === "PASS",
  screen_perception: (h) => (h?.screenCapture ?? "PASS") === "PASS",
  visual_mouse: (h) => (h?.accessibility ?? "PASS") === "PASS" && (h?.screenCapture ?? "PASS") === "PASS",
};

export function classify(request: string): { domain: string; ladder: Path[]; reason: string } {
  const r = request.toLowerCase();
  if (/^mac_chart:|\b(chart|plot|graph|visuali[sz]e)\b.*\b(xlsx|excel|workbook|spreadsheet|sheet)\b|\b(xlsx|excel|workbook|spreadsheet)\b.*\b(chart|plot|graph)\b/.test(r))
    return { domain: "spreadsheet-chart", ladder: ["local_parser", "app_scripting", "accessibility", "visual_mouse"], reason: "Excel/CSV data is read by the parser, never by clicking" };
  if (/\b(read|analy[sz]e|summari[sz]e|inspect)\b.*\b(xlsx|excel|workbook|spreadsheet|csv)\b/.test(r))
    return { domain: "spreadsheet-read", ladder: ["local_parser", "app_scripting", "accessibility", "visual_mouse"], reason: "workbook content comes from the parser" };
  if (/\b(gmail|email|inbox|calendar|drive|google doc|sheet in drive)\b/.test(r) && !/\b(chrome|safari|browser|tab|open)\b/.test(r))
    return { domain: "google-data", ladder: ["connector_api", "browser_dom", "accessibility", "visual_mouse"], reason: "Google data has a connector; the browser is a fallback" };
  if (/\b(website|web page|url|https?:\/\/|chrome|safari|tab|browser|form|login|sign in|search the web|google\.com)\b/.test(r))
    return { domain: "browser", ladder: ["browser_dom", "accessibility", "screen_perception", "visual_mouse"], reason: "web pages are driven through the DOM/active tab, clicks only as fallback" };
  if (/\b(finder|file|folder|move|rename|trash|open .*\.(pdf|docx|xlsx|txt)|spotlight|downloads|desktop)\b/.test(r))
    return { domain: "files", ladder: ["local_parser", "app_scripting", "accessibility", "visual_mouse"], reason: "file operations are deterministic (Spotlight/open/move), not clicks" };
  // Only a KNOWN scriptable app earns the app-scripting rung; generic UI words (button, dialog) do not.
  if (/\b(textedit|notes|pages|numbers|keynote|excel|word|powerpoint|messages|mail|finder|calendar|reminders|preview|terminal|system settings|system preferences)\b/.test(r))
    return { domain: "native-app", ladder: ["app_scripting", "accessibility", "screen_perception", "visual_mouse"], reason: "native apps expose menus and controls to System Events/Accessibility" };
  return { domain: "unknown-app", ladder: ["accessibility", "screen_perception", "visual_mouse"], reason: "no adapter: inspect the AX tree first, then perceive, then act visually" };
}

/** Route a request against the live health matrix: skip rungs whose capability probe failed. */
export function route(request: string, health: Health): Route & { domain: string } {
  const c = classify(request);
  const unavailable = c.ladder.filter((p) => !RUNG_HEALTH[p](health));
  const ladder = c.ladder.filter((p) => RUNG_HEALTH[p](health));
  const primary = ladder[0] ?? "visual_mouse";
  const reason = unavailable.length ? `${c.reason}; skipping ${unavailable.join(", ")} (capability probe failed)` : c.reason;
  return { domain: c.domain, primary, ladder, reason, unavailable };
}

/** One line for the planner prompt. */
export function routeHint(request: string, health: Health): string {
  const r = route(request, health);
  return `Route (${r.domain}): ${r.primary} → fallback ${r.ladder.slice(1).join(" → ") || "none"}. ${r.reason}.`;
}
