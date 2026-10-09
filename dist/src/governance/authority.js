export const ENVELOPE_DEFAULTS = { ttlMs: 4 * 3_600_000, maxSteps: 120, costLimitUsd: 3 };
const READ = new Set(["screenshot", "read_text", "list_apps", "list_files", "read_file", "wait", "done", "ask", "observe",
    "browser_read", "browser_find", "browser_list_tabs", "browser_wait"]);
const PREP = new Set(["open_app", "activate_app", "open_url", "open_path", "menu_item", "ax_click", "ax_set_value", "click", "double_click",
    "right_click", "move", "drag", "scroll", "type", "key", "hotkey", "browser_open_tab", "browser_switch_tab", "browser_navigate", "browser_click",
    "browser_fill", "browser_fill_form", "browser_select", "browser_check", "browser_scroll", "browser_upload", "browser_download", "browser_close_tab"]);
const HIGH = new Set(["run", "trash_file", "move_file"]);
/** External commitments in summaries, click targets and menu paths. */
export const COMMITMENT = /\b(submit|send|enviar|mandar|publish|publicar|tweet|pay|pagar|purchase|buy|comprar|place order|checkout|check out|confirm (?:purchase|order|payment|booking)|book now|reserve|accept (?:terms|offer|agreement)|i agree|agree and|sign (?:and|the|this)|e-?sign|transfer|transferir|wire|reply all|invite|share with|schedule (?:the )?(?:meeting|call|interview)|rsvp)\b/i;
const HIGH_HINT = /\b(delete|borrar|eliminar|remove account|close account|deactivate|change (?:password|email|2fa|security)|reset password|api key|token|credential|unsubscribe all|empty trash|format|wipe)\b/i;
/** Deterministic authority class of one step. `frontApp` lets "press Return in a browser form" count as a commitment risk. */
export function classify(step, ctx = {}) {
    const target = [step.summary, step.params.label, step.params.name, step.params.text, step.params.title,
        Array.isArray(step.params.path) ? step.params.path.join(" ") : ""].filter(Boolean).join(" ");
    if (READ.has(step.kind))
        return "OBSERVE";
    if (HIGH_HINT.test(target))
        return "HIGH_RISK";
    if (HIGH.has(step.kind)) {
        if (step.kind === "move_file" && ctx.grants?.includes("move_files"))
            return "PREPARATORY";
        return "HIGH_RISK";
    }
    if (COMMITMENT.test(target))
        return "EXTERNAL_COMMITMENT";
    // Return/Enter in a browser submits the focused form: treat as a commitment unless a browser_* fill did it.
    if (step.kind === "key" && /^(return|enter)$/i.test(String(step.params.key ?? "")) && /chrome|firefox|safari|arc|edge|brave/i.test(ctx.frontApp ?? ""))
        return "EXTERNAL_COMMITMENT";
    if (PREP.has(step.kind))
        return "PREPARATORY";
    return "HIGH_RISK"; // unknown kinds are never automatic
}
const NEG = /\b(?:do not|don't|dont|never|without|no|not|sin|no lo)\s+(?:\w+\s+){0,2}?(submit(?:ting)?|send(?:ing)?|enviar|apply(?:ing)?|postular|publish(?:ing)?|post(?:ing)?|pay(?:ing)?|pagar|purchas(?:e|ing)|buy(?:ing)?|comprar|book(?:ing)?|accept(?:ing)?|sign(?:ing)?)\b/gi;
/** Derive the envelope from the principal's own request. A contact's request (principal:false) gets none. */
export function deriveEnvelope(request, opts = { principal: true }) {
    if (!opts.principal)
        return null;
    const now = opts.now ?? new Date();
    const words = Array.from(request.matchAll(NEG)).map((m) => m[1].toLowerCase());
    const forbidden = Object.keys(FORBID_WORDS).filter((k) => words.some((w) => FORBID_WORDS[k].test(w)));
    const grants = [];
    if (/\b(organi[sz]e|tidy|clean up|sort|file|move|rename|archive)\b[^.]{0,60}\b(files?|folders?|downloads|desktop|documents)\b/i.test(request))
        grants.push("move_files");
    return {
        version: 1, objective: request.slice(0, 300), autoClasses: ["OBSERVE", "PREPARATORY"], forbidden, grants,
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ENVELOPE_DEFAULTS.ttlMs).toISOString(),
        maxSteps: ENVELOPE_DEFAULTS.maxSteps, costLimitUsd: ENVELOPE_DEFAULTS.costLimitUsd, principal: true,
    };
}
const FORBID_WORDS = {
    submit: /\bsubmit/i, send: /\b(send|enviar|mandar)/i, apply: /\b(submit (?:the |my )?application|apply|postular|aplicar)/i, publish: /\bpublish|publicar/i, post: /\bpost(?:ing)?\b/i,
    pay: /\b(pay|pagar|checkout|place order)/i, purchase: /\b(purchase|buy|comprar|place order|checkout)/i, buy: /\b(buy|purchase|comprar)/i,
    book: /\b(book|reserve)/i, accept: /\b(accept|agree)/i, sign: /\b(sign|e-?sign)/i,
};
/**
 * Is this step inside the authority Julian delegated? `usage` is the task's current step count and model spend.
 * Commitments are never automatic; forbidden ones are refused without asking (Julian already said no).
 */
export function authorize(step, env, ctx = {}) {
    const cls = classify(step, { frontApp: ctx.frontApp ?? null, grants: env?.grants ?? [] });
    if (cls === "OBSERVE")
        return { decision: "auto", cls, reason: "observation" };
    const target = `${step.summary} ${step.params.label ?? ""} ${step.params.name ?? ""} ${step.params.text ?? ""}`;
    if (env && (cls === "EXTERNAL_COMMITMENT" || cls === "HIGH_RISK")) {
        const hit = env.forbidden.find((w) => (FORBID_WORDS[w] ?? new RegExp(`\\b${w}`, "i")).test(target));
        if (hit)
            return { decision: "refuse", cls, reason: `Julian said not to ${hit} — stop at the review stage instead` };
    }
    if (cls === "EXTERNAL_COMMITMENT")
        return { decision: "approve", cls, reason: "external commitment — Julian's explicit ok" };
    if (cls === "HIGH_RISK")
        return { decision: "approve", cls, reason: "high-risk/destructive — always explicit" };
    // PREPARATORY
    if (!env)
        return { decision: "approve", cls, reason: "no delegation envelope (request not from Julian)" };
    const now = (ctx.now ?? new Date()).getTime();
    if (now > Date.parse(env.expiresAt))
        return { decision: "approve", cls, reason: "delegation expired — ask to continue" };
    if (ctx.usage && ctx.usage.steps >= env.maxSteps)
        return { decision: "approve", cls, reason: `delegation step budget (${env.maxSteps}) used` };
    if (ctx.usage && ctx.usage.costUsd >= env.costLimitUsd)
        return { decision: "approve", cls, reason: `delegation cost limit ($${env.costLimitUsd}) reached` };
    return env.autoClasses.includes(cls) ? { decision: "auto", cls, reason: "preparatory, inside Julian's delegation" } : { decision: "approve", cls, reason: "not delegated" };
}
//# sourceMappingURL=authority.js.map