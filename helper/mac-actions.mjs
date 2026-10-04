/**
 * WO4 — Accessibility-first actions with observe → act → verify (ADR-070).
 *
 * Control hierarchy (prefer higher rungs):
 *   app scripting (activate, menu) → Accessibility (ax_click, ax_set_value) → coordinates (click x,y — the
 *   planner's last resort). Every action here returns { ok, result, before, after, verified, reason } so the
 *   planner and Core's WO9 gate judge the OUTCOME (what changed on screen), never the click itself.
 *
 * Dependencies are injected (run, osa) so this module is testable without macOS.
 */

const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Compact, comparable observation of the current UI state. */
export async function observe(osa) {
  const script = `tell application "System Events"
  set p to first application process whose frontmost is true
  set appName to name of p
  set winTitle to ""
  set focusedRole to ""
  set focusedTitle to ""
  set focusedValue to ""
  try
    set winTitle to name of front window of p
  end try
  try
    set f to value of attribute "AXFocusedUIElement" of p
    set focusedRole to role of f
    try
      set focusedTitle to title of f
    end try
    try
      set focusedValue to value of f as text
    end try
  end try
  return appName & "\\n" & winTitle & "\\n" & focusedRole & "\\n" & focusedTitle & "\\n" & focusedValue
end tell`;
  try {
    const out = await osa([script], [], { timeout: 6000 });
    const [app = "", window = "", focusedRole = "", focusedTitle = "", focusedValue = ""] = String(out).split("\n");
    return { ok: true, app, window, focusedRole, focusedTitle, focusedValue: focusedValue.slice(0, 200) };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/** Activate an application and verify it became frontmost. */
export async function activateApp(osa, name) {
  const before = await observe(osa);
  await osa([`tell application "${esc(name)}" to activate`], [], { timeout: 10_000 });
  await sleep(700);
  const after = await observe(osa);
  const verified = !!after.app && after.app.toLowerCase().includes(String(name).toLowerCase().split(" ")[0]);
  return { ok: verified, result: verified ? `activated ${after.app}` : `activate failed: frontmost is ${after.app || "unknown"}`, before, after, verified };
}

/** Click a menu item by path, e.g. ["File","New"]; verified by a UI state change. */
export async function menuItem(osa, app, path) {
  if (!Array.isArray(path) || path.length < 2) return { ok: false, result: "refused: menu path needs at least [menu, item]", verified: false };
  const before = await observe(osa);
  const [menu, ...rest] = path;
  let ref = `menu bar item "${esc(menu)}" of menu bar 1`;
  // Nest: menu "X" of menu bar item "X" ... menu item "Y" [of menu "Y" of menu item "Y" ...]
  let chain = `menu "${esc(menu)}" of ${ref}`;
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (i === rest.length - 1) chain = `menu item "${esc(item)}" of ${chain}`;
    else chain = `menu "${esc(item)}" of menu item "${esc(item)}" of ${chain}`;
  }
  const script = `tell application "System Events" to tell process "${esc(app)}"
  set frontmost to true
  click ${chain}
end tell`;
  try { await osa([script], [], { timeout: 10_000 }); } catch (e) { return { ok: false, result: `menu click failed: ${String(e?.message ?? e).slice(0, 160)}`, before, verified: false }; }
  await sleep(800);
  const after = await observe(osa);
  const verified = inApp(after, app) && changed(before, after);
  const why = !inApp(after, app) ? ` (frontmost is now ${after.app || "unknown"}, not ${app} — treat as NOT done)` : !verified ? " (no visible UI change — verify by other means)" : "";
  return { ok: true, result: `clicked menu ${path.join(" > ")}${why}`, before, after, verified };
}

/**
 * Click a control by accessibility identity in the frontmost window of `app`.
 * Matches by title (exact, then contains) and optional role (AXButton, AXCheckBox, AXRadioButton, AXMenuButton...).
 */
export async function axClick(osa, app, { title, role } = {}) {
  if (!title) return { ok: false, result: "refused: ax_click needs a title", verified: false };
  const before = await observe(osa);
  const roleFilter = role ? ` whose role is "${esc(role)}"` : "";
  const script = `tell application "System Events" to tell process "${esc(app)}"
  set frontmost to true
  set els to entire contents of front window
  set exact to {}
  set partial to {}
  repeat with e in els
    try
      set t to ""
      try
        set t to title of e
      end try
      if t is "" then
        try
          set t to description of e
        end try
      end if
      if t is "" then
        try
          set t to value of attribute "AXTitle" of e
        end try
      end if
      if t is "${esc(title)}" then
        set end of exact to e
      else if t contains "${esc(title)}" then
        set end of partial to e
      end if
    end try
  end repeat
  set target to missing value
  if (count of exact) > 0 then
    set target to item 1 of exact
  else if (count of partial) > 0 then
    set target to item 1 of partial
  end if
  if target is missing value then return "notfound"
  ${role ? `if role of target is not "${esc(role)}" then return "notfound:role=" & (role of target)` : ""}
  perform action "AXPress" of target
  return "pressed:" & (role of target)
end tell`;
  let out;
  try { out = String(await osa([script], [], { timeout: 15_000 })).trim(); }
  catch (e) { return { ok: false, result: `ax_click failed: ${String(e?.message ?? e).slice(0, 160)}`, before, verified: false }; }
  if (out.startsWith("notfound")) return { ok: false, result: `ax_click: no control titled "${title}"${role ? ` with role ${role}` : ""} in ${app}'s front window (${out})`, before, verified: false };
  await sleep(800);
  const after = await observe(osa);
  const verified = inApp(after, app) && changed(before, after);
  const why = !inApp(after, app) ? ` (frontmost is now ${after.app || "unknown"}, not ${app} — treat as NOT done)` : !verified ? " (no visible UI change)" : "";
  return { ok: true, result: `${out} "${title}"${why}`, before, after, verified };
}

/** Set a text field's value by accessibility identity, then read it back to verify. */
export async function axSetValue(osa, app, { title, role = "AXTextField", value }) {
  const before = await observe(osa);
  const script = `tell application "System Events" to tell process "${esc(app)}"
  set frontmost to true
  set els to entire contents of front window
  set target to missing value
  repeat with e in els
    try
      if role of e is "${esc(role)}" then
        set t to ""
        try
          set t to title of e
        end try
        if t is "" then
          try
            set t to description of e
          end try
        end if
        if ("${esc(title ?? "")}" is "") or (t contains "${esc(title ?? "")}") then
          set target to e
          exit repeat
        end if
      end if
    end try
  end repeat
  if target is missing value then return "notfound"
  set value of target to "${esc(value)}"
  return "set:" & (value of target as text)
end tell`;
  let out;
  try { out = String(await osa([script], [], { timeout: 15_000 })).trim(); }
  catch (e) { return { ok: false, result: `ax_set_value failed: ${String(e?.message ?? e).slice(0, 160)}`, before, verified: false }; }
  if (out === "notfound") return { ok: false, result: `ax_set_value: no ${role}${title ? ` titled "${title}"` : ""} in ${app}'s front window`, before, verified: false };
  const after = await observe(osa);
  const verified = out === `set:${value}` && inApp(after, app);
  return { ok: verified, result: verified ? `set "${title ?? role}" = "${String(value).slice(0, 60)}" (read back OK)` : `set returned ${out} (read-back mismatch)`, before, after, verified };
}

/** Did anything observable change? Window title, focused element, or focused value. */
export function changed(a, b) {
  if (!a?.ok || !b?.ok) return false;
  return a.app !== b.app || a.window !== b.window || a.focusedRole !== b.focusedRole || a.focusedTitle !== b.focusedTitle || a.focusedValue !== b.focusedValue;
}

/** Intended-outcome check: the target app is still frontmost after the action (not "any change anywhere"). */
export function inApp(obs, app) {
  if (!obs?.ok || !app) return false;
  const a = String(obs.app || "").toLowerCase(), want = String(app).toLowerCase();
  return a === want || a.startsWith(want) || want.startsWith(a);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
