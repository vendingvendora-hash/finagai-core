/*
 * Finagai browser operator — page side (Phase 1A/1B, ADR-077).
 *
 * Injected into a tab's frames by the extension (isolated world). Provides a SEMANTIC view of the page and
 * semantic actions with read-back verification. Never reads cookies or storage; password and one-time-code
 * values are never returned and never filled.
 *
 * Exposed as globalThis.__finagai = { snapshot, find, click, fill, select, check, scroll, upload*, read, observe }.
 * Refs ("e12") are stable for the life of the page in this frame; the extension prefixes the frame id.
 */
(() => {
  if (globalThis.__finagai && globalThis.__finagai.version === 3) return;

  const refs = new Map();             // ref -> WeakRef(element)
  const elRef = new WeakMap();        // element -> ref
  let nextRef = 1;
  const refOf = (el) => { let r = elRef.get(el); if (!r) { r = "e" + nextRef++; elRef.set(el, r); refs.set(r, new WeakRef(el)); } return r; };
  const byRef = (ref) => { const w = refs.get(String(ref)); const el = w && w.deref(); if (!el || !el.isConnected) throw new Error(`stale_ref: ${ref} is no longer on the page — re-read the page`); return el; };

  const clip = (s, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  const SECRET_AUTOCOMPLETE = /one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp/i;
  const isSecret = (el) => el instanceof HTMLInputElement && (el.type === "password" || SECRET_AUTOCOMPLETE.test(el.autocomplete || ""));

  // ---- walking (document + open shadow roots) -------------------------------------------------------
  function* walk(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const kids = node.children ? Array.from(node.children) : [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      if (node.shadowRoot) stack.push(node.shadowRoot);
      if (node.nodeType === 1) yield node;
    }
  }

  function visible(el) {
    if (el instanceof HTMLInputElement && el.type === "file") return true;   // file inputs are usually visually hidden
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    if (el.closest("[aria-hidden=true],[inert]")) return false;
    return true;
  }

  const INPUT_ROLE = { checkbox: "checkbox", radio: "radio", file: "file", submit: "button", button: "button", reset: "button", image: "button",
    range: "slider", search: "searchbox", email: "textbox", tel: "textbox", url: "textbox", text: "textbox", number: "spinbutton", password: "textbox", date: "textbox", "datetime-local": "textbox", month: "textbox", week: "textbox", time: "textbox" };
  function role(el) {
    const r = el.getAttribute("role");
    if (r) return r.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "input") return INPUT_ROLE[(el.type || "text").toLowerCase()] ?? "textbox";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "dialog") return "dialog";
    if (tag === "form") return "form";
    if (el.isContentEditable) return "textbox";
    return null;
  }

  const textOf = (el) => clip(el.innerText || el.textContent || "", 200);
  function labelledBy(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const root = el.getRootNode();
    return ids.map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id))).filter(Boolean).map(textOf).join(" ");
  }
  /** Accessible name, approximating the accname algorithm closely enough for forms and buttons. */
  function accName(el) {
    const lb = labelledBy(el); if (lb) return clip(lb);
    const al = el.getAttribute("aria-label"); if (al) return clip(al);
    if (el.labels && el.labels.length) return clip(Array.from(el.labels).map((l) => l.innerText || l.textContent).join(" "));
    const wrap = el.closest && el.closest("label"); if (wrap && wrap !== el) return clip(wrap.innerText || wrap.textContent);
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["submit", "button", "reset"].includes(el.type)) return clip(el.value || el.type);
    if (tag === "img") return clip(el.alt);
    if (["button", "a", "summary", "option", "legend", "label"].includes(tag) || /^h[1-6]$/.test(tag) || ["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch"].includes(el.getAttribute("role") || ""))
      { const t = textOf(el); if (t) return t; }
    const ph = el.getAttribute("placeholder"); if (ph) return clip(ph);
    const ti = el.getAttribute("title"); if (ti) return clip(ti);
    // Nearby text: a preceding sibling/label-like element (common in ATS forms that don't use <label for>)
    const prev = el.previousElementSibling; if (prev && /label|span|div|p/i.test(prev.tagName) && textOf(prev).length < 120) return textOf(prev);
    const parentPrev = el.parentElement && el.parentElement.previousElementSibling;
    if (parentPrev && textOf(parentPrev).length < 120) return textOf(parentPrev);
    return "";
  }
  function describedError(el) {
    const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    const msgs = ids.map((id) => document.getElementById(id)).filter(Boolean).map(textOf).filter(Boolean);
    return msgs.join(" ");
  }

  const INTERACTIVE = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox],[role=listbox],[role=option],[role=menuitem],[role=tab],[role=switch],[role=textbox],[role=searchbox],[role=spinbutton],[contenteditable=''],[contenteditable=true]";

  function fieldState(el) {
    const tag = el.tagName.toLowerCase();
    const o = {};
    if (tag === "input" || tag === "textarea") {
      if (el.type === "checkbox" || el.type === "radio") o.checked = el.checked;
      else if (el.type === "file") { o.files = Array.from(el.files || []).map((f) => f.name); if (el.accept) o.accept = el.accept; if (el.multiple) o.multiple = true; }
      else o.value = isSecret(el) ? (el.value ? "[hidden]" : "") : clip(el.value, 300);
      if (el.type && !["text", "textarea"].includes(el.type)) o.type = el.type;
    } else if (tag === "select") {
      const sel = Array.from(el.selectedOptions || []);
      o.value = clip(sel.map((x) => x.text).join(", "), 200);
      o.options = Array.from(el.options).slice(0, 40).map((x) => clip(x.text, 60));
      if (el.options.length > 40) o.optionsTruncated = el.options.length;
    } else if (el.isContentEditable) o.value = clip(el.innerText, 300);
    else if (["combobox", "listbox", "spinbutton", "textbox"].includes(el.getAttribute("role") || "")) o.value = clip(el.getAttribute("aria-valuetext") || el.innerText || "", 120);
    const ariaChecked = el.getAttribute("aria-checked"); if (ariaChecked != null) o.checked = ariaChecked === "true";
    const ariaSel = el.getAttribute("aria-selected"); if (ariaSel != null) o.selected = ariaSel === "true";
    const ariaExp = el.getAttribute("aria-expanded"); if (ariaExp != null) o.expanded = ariaExp === "true";
    if (el.required || el.getAttribute("aria-required") === "true") o.required = true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") o.disabled = true;
    const invalid = el.getAttribute("aria-invalid") === "true" || (el.willValidate && el.validity && !el.validity.valid && (el.value || el.dataset.finagaiTouched));
    if (invalid) { o.invalid = true; const msg = describedError(el) || el.validationMessage; if (msg) o.error = clip(msg, 160); }
    if (isSecret(el)) o.secret = true;
    return o;
  }

  function describe(el) {
    const r = role(el) || "generic";
    const d = { ref: refOf(el), role: r, name: accName(el), ...fieldState(el) };
    if (el.tagName === "A" && el.href) d.href = clip(el.href, 200);
    const form = el.form || el.closest && el.closest("form");
    if (form) d.form = refOf(form);
    return d;
  }

  // External commitments only. "Apply"/"Easy Apply" OPENS an application (preparatory); "Submit application" commits.
  const COMMIT = /\b(submit|send|pay|purchase|buy|place order|confirm (?:and )?(?:pay|order|purchase|booking|submit)|checkout|enviar|pagar|comprar|sign up|register|create account|publish|i agree|accept (?:and|terms|offer))\b/i;

  function detectBlockers() {
    const b = [];
    for (const f of document.querySelectorAll("iframe")) {
      const src = f.src || "";
      if (/recaptcha|hcaptcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha/i.test(src)) { b.push("captcha"); break; }
    }
    if (document.querySelector(".g-recaptcha,.h-captcha,[data-sitekey]")) b.push("captcha");
    if (document.querySelector("input[autocomplete~='one-time-code']")) b.push("one_time_code");
    if (document.querySelector("input[type=password]")) b.push("password_field");
    return Array.from(new Set(b));
  }

  /** Semantic page snapshot: headings, dialogs, forms with fields, other controls, alerts, text excerpt. */
  function snapshot(opts = {}) {
    const maxControls = opts.maxControls ?? 150;
    const headings = [], dialogs = [], alerts = [], controls = [], forms = new Map();
    for (const el of walk(document.documentElement)) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag) && visible(el)) { if (headings.length < 30) headings.push({ level: Number(tag[1]), text: textOf(el) }); continue; }
      if ((tag === "dialog" && el.open) || (el.getAttribute("role") === "dialog" || el.getAttribute("role") === "alertdialog") && visible(el)) {
        dialogs.push({ ref: refOf(el), name: accName(el) || clip(textOf(el), 80), modal: el.getAttribute("aria-modal") === "true" || tag === "dialog" });
      }
      if ((el.getAttribute("role") === "alert" || el.getAttribute("aria-live") === "assertive") && visible(el)) { const t = textOf(el); if (t) alerts.push(t); }
      if (el.matches(INTERACTIVE) && visible(el)) {
        if (controls.length >= maxControls) continue;
        const d = describe(el);
        if (d.role === "link" && opts.links === false) continue;
        if (d.role === "button" && COMMIT.test(d.name)) d.commit = true;   // external-commitment control: never auto-clicked
        controls.push(d);
        const f = el.form || el.closest("form");
        if (f && !forms.has(f)) forms.set(f, { ref: refOf(f), name: accName(f) || clip(f.getAttribute("name") || f.id || "", 60) });
      }
    }
    const main = document.querySelector("main,[role=main]") || document.body;
    const text = clip(main ? main.innerText : "", opts.textChars ?? 6000);
    return {
      url: location.href, title: document.title, frameUrl: location.href, isTop: window === window.top,
      headings, dialogs, alerts: alerts.slice(0, 10), forms: Array.from(forms.values()), controls,
      truncated: controls.length >= maxControls, blockers: detectBlockers(), text,
      scroll: { y: Math.round(scrollY), max: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)) },
    };
  }

  /** Find controls by label/name/role/text/selector. Ranked; exact name beats partial. */
  function find(q = {}) {
    const wantRole = q.role ? String(q.role).toLowerCase() : null;
    // Labels are matched without required-field asterisks on EITHER side (live #126: planner asked for "First name *").
    const needle = String(q.label ?? q.name ?? q.text ?? "").toLowerCase().replace(/\*/g, "").replace(/\s+/g, " ").trim();
    let pool;
    if (q.selector) { try { pool = Array.from(document.querySelectorAll(q.selector)); } catch (e) { throw new Error("bad_selector: " + e.message); } }
    else pool = Array.from(walk(document.documentElement)).filter((el) => el.matches(INTERACTIVE) || (q.text && /^h[1-6]$|^(p|span|div|li|td|label)$/i.test(el.tagName)));
    const scored = [];
    for (const el of pool) {
      if (!visible(el)) continue;
      const d = describe(el);
      if (wantRole && d.role !== wantRole && !(wantRole === "textbox" && ["searchbox", "spinbutton"].includes(d.role))) continue;
      let score = 1;
      if (needle) {
        const name = (q.text && !q.label && !q.name ? textOf(el) : d.name).toLowerCase().replace(/\*/g, "").replace(/\s+/g, " ").trim();
        if (!name) continue;
        if (name === needle) score = 100;
        else if (name.startsWith(needle)) score = 60;
        else if (name.includes(needle)) score = 40;
        else if (needle.split(" ").every((w) => name.includes(w))) score = 25;
        else continue;
        if (q.text && !q.label && !q.name && el.matches(INTERACTIVE)) score += 5;
      }
      scored.push({ score, ...d });
      if (scored.length > 200) break;
    }
    scored.sort((a, b) => b.score - a.score);
    return { matches: scored.slice(0, q.limit ?? 8), total: scored.length };
  }

  // ---- actions with read-back verification -------------------------------------------------------------
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);   // bypasses React/Vue value trackers so frameworks see the change
  }
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const state = (el) => ({ ref: refOf(el), role: role(el), name: accName(el), ...fieldState(el) });

  function click(args) {
    const el = byRef(args.ref);
    const d = describe(el);
    if (d.disabled) return { ok: false, verified: false, reason: "element is disabled", target: d };
    if (role(el) === "button" && COMMIT.test(d.name) && !args.commitAuthorized)
      return { ok: false, verified: false, refused: "commit", reason: `"${d.name}" looks like an external commitment (submit/send/pay). It needs Julian's explicit approval.`, target: d };
    const before = { url: location.href, title: document.title, expanded: el.getAttribute("aria-expanded"), checked: el.checked };
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus({ preventScroll: true });
    el.click();
    const r = el.getBoundingClientRect();
    return { ok: true, target: d, before, point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }, note: "verify navigation/state with wait_for or read" };
  }

  function fill(args) {
    const el = byRef(args.ref);
    if (isSecret(el)) return { ok: false, verified: false, refused: "secret", reason: "password / one-time-code fields are never filled by Finagai — Julian must enter it" };
    const value = String(args.value ?? "");
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
    if (el.isContentEditable) { el.innerText = value; fire(el, "input"); }
    else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (["checkbox", "radio", "file"].includes(el.type)) return { ok: false, verified: false, reason: `use ${el.type === "file" ? "upload" : "check"} for a ${el.type} input` };
      setNativeValue(el, value); fire(el, "input"); fire(el, "change");
    } else return { ok: false, verified: false, reason: `not a text field (role ${role(el)})` };
    el.dataset.finagaiTouched = "1";
    el.dispatchEvent(new FocusEvent("blur", { bubbles: false })); fire(el, "focusout");
    const after = el.isContentEditable ? el.innerText : el.value;
    const norm = (s) => String(s).replace(/\s+/g, " ").trim();
    const verified = norm(after) === norm(value);
    return { ok: verified, verified, expected: clip(value, 200), actual: clip(after, 200), field: state(el), reason: verified ? "read back equals the requested value" : "the field did not keep the value (the site may reformat or reject it)" };
  }

  function select(args) {
    const el = byRef(args.ref);
    const want = String(args.value ?? args.label ?? "").toLowerCase().trim();
    if (el instanceof HTMLSelectElement) {
      const opts = Array.from(el.options);
      const opt = opts.find((o) => o.text.toLowerCase().trim() === want || o.value.toLowerCase() === want)
        || opts.find((o) => o.text.toLowerCase().includes(want));
      if (!opt) return { ok: false, verified: false, reason: `no option matching "${args.value ?? args.label}"`, options: opts.slice(0, 40).map((o) => o.text) };
      setNativeValue(el, opt.value); fire(el, "input"); fire(el, "change");
      const verified = el.selectedOptions[0] === opt;
      return { ok: verified, verified, actual: el.selectedOptions[0] ? el.selectedOptions[0].text : null, field: state(el) };
    }
    // Custom combobox/listbox: open it; the caller then clicks the option it can now see (two-step, verified by read).
    el.click();
    return { ok: true, verified: false, needs: "option_click", reason: "custom dropdown opened — find the option by text and click it, then read the field back", field: state(el) };
  }

  function check(args) {
    const el = byRef(args.ref);
    const want = args.checked !== false;
    const isNative = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
    const cur = () => (isNative ? el.checked : el.getAttribute("aria-checked") === "true");
    if (cur() !== want) { el.scrollIntoView({ block: "center" }); el.click(); }
    const verified = cur() === want;
    return { ok: verified, verified, checked: cur(), field: state(el), reason: verified ? "state read back" : "state did not change (the control may need a different target, e.g. its label)" };
  }

  function scroll(args) {
    if (args.ref) { byRef(args.ref).scrollIntoView({ block: "center" }); }
    else { const dy = (args.dir === "up" ? -1 : 1) * (Number(args.amount) || 0.8) * innerHeight; scrollBy(0, dy); }
    return { ok: true, verified: true, scroll: { y: Math.round(scrollY), max: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)) } };
  }

  // Uploads arrive in chunks (native messaging limits a host->browser message to 1 MB).
  const uploads = new Map();
  function uploadBegin(args) { uploads.set(args.uploadId, { name: args.name, mime: args.mime || "application/octet-stream", parts: [] }); return { ok: true }; }
  function uploadChunk(args) { const u = uploads.get(args.uploadId); if (!u) throw new Error("unknown upload"); u.parts.push(args.b64); return { ok: true, parts: u.parts.length }; }
  function uploadCommit(args) {
    const u = uploads.get(args.uploadId); if (!u) throw new Error("unknown upload");
    uploads.delete(args.uploadId);
    const el = byRef(args.ref);
    if (!(el instanceof HTMLInputElement) || el.type !== "file") return { ok: false, verified: false, reason: "target is not a file input" };
    const bin = atob(u.parts.join(""));
    const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], u.name, { type: u.mime });
    const dt = new DataTransfer();
    if (el.multiple) for (const f of Array.from(el.files || [])) dt.items.add(f);
    dt.items.add(file);
    el.files = dt.files;
    fire(el, "input"); fire(el, "change");
    const names = Array.from(el.files || []).map((f) => f.name);
    const verified = names.includes(u.name);
    return { ok: verified, verified, files: names, size: file.size, reason: verified ? `file control now holds ${u.name}` : "the file control did not keep the file" };
  }

  function read(args) { const el = byRef(args.ref); return { ok: true, field: state(el) }; }

  /** Cheap state for postcondition checks and change detection. */
  function observe() {
    const dlg = Array.from(document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog]")).filter(visible).map((d) => accName(d) || clip(textOf(d), 80));
    const alerts = Array.from(document.querySelectorAll("[role=alert]")).filter(visible).map(textOf).filter(Boolean).slice(0, 5);
    const invalid = Array.from(document.querySelectorAll("[aria-invalid=true]")).filter(visible).length;
    const h1 = document.querySelector("h1"); const sig = `${location.href}|${document.title}|${h1 ? textOf(h1) : ""}|${dlg.join(",")}|${document.body ? document.body.innerText.length : 0}`;
    return { url: location.href, title: document.title, h1: h1 ? textOf(h1) : null, dialogs: dlg, alerts, invalidFields: invalid, signature: sig, blockers: detectBlockers() };
  }

  globalThis.__finagai = { version: 3, snapshot, find, click, fill, select, check, scroll, uploadBegin, uploadChunk, uploadCommit, read, observe };
})();
