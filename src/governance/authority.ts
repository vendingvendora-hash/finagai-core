/**
 * Phase 2 (ADR-078) — bounded delegation instead of per-click approval.
 *
 * The question is no longer "is this technically a write?" but "is this action inside the authority Julian
 * delegated for this outcome?". Every J6 step gets a deterministic AUTHORITY CLASS:
 *
 *   OBSERVE              read/search/analyze                                  → automatic
 *   PREPARATORY          reversible prep: open tabs, navigate, fill/edit an    → automatic INSIDE an active envelope
 *                        unsent draft or form, select/check, attach a file,       (Julian's own request), else ask
 *                        open apps/files, local artifacts
 *   EXTERNAL_COMMITMENT  submit/apply/send/publish/pay/purchase/accept terms   → always Julian's explicit ok
 *                        (or REFUSED outright when his request forbade it, e.g. "do not submit")
 *   HIGH_RISK            delete/trash, shell writes, file moves, credentials,  → always explicit
 *                        account/security settings, money movement
 *
 * The envelope is DERIVED from Julian's words (never from page content), bounded by TTL, steps and model cost.
 * Existing governance is not weakened: commitments and high-risk actions keep per-step approval, and a request
 * from a contact (not the principal) gets no envelope at all.
 */
export type AuthorityClass = "OBSERVE" | "PREPARATORY" | "EXTERNAL_COMMITMENT" | "HIGH_RISK";

export interface DelegationEnvelope {
  version: 1;
  objective: string;
  /** Classes that run without asking while the envelope is active. */
  autoClasses: AuthorityClass[];
  /** Commitment words Julian explicitly forbade ("do not submit", "don't send"): such steps are refused, not asked. */
  forbidden: string[];
  /** Explicit extra grants found in the request (e.g. "organize/move my files" lets move_file be preparatory). */
  grants: string[];
  createdAt: string;
  expiresAt: string;
  maxSteps: number;
  costLimitUsd: number;
  principal: boolean;
}

export const ENVELOPE_DEFAULTS = { ttlMs: 4 * 3_600_000, maxSteps: 120, costLimitUsd: 3 } as const;

const READ = new Set(["screenshot", "read_text", "list_apps", "list_files", "read_file", "wait", "done", "ask", "observe",
  "browser_read", "browser_find", "browser_list_tabs", "browser_wait",
  "record_opportunity"]);   // Phase 4: Finagai's own bookkeeping of a posting Julian is looking at (no external effect)
const PREP = new Set(["open_app", "activate_app", "open_url", "open_path", "menu_item", "ax_click", "ax_set_value", "click", "double_click",
  "right_click", "move", "drag", "scroll", "type", "key", "hotkey", "browser_open_tab", "browser_switch_tab", "browser_navigate", "browser_click",
  "browser_fill", "browser_fill_form", "browser_select", "browser_check", "browser_scroll", "browser_upload", "browser_download", "browser_close_tab"]);
const HIGH = new Set(["run", "trash_file", "move_file"]);

/** External commitments in summaries, click targets and menu paths. */
export const COMMITMENT = /\b(submit|send|enviar|mandar|publish|publicar|tweet|pay|pagar|purchase|buy|comprar|place order|checkout|check out|confirm (?:purchase|order|payment|booking)|book now|reserve|accept (?:terms|offer|agreement)|i agree|agree and|sign (?:and|the|this)|e-?sign|transfer|transferir|wire|reply all|invite|share with|schedule (?:the )?(?:meeting|call|interview)|rsvp)\b/i;
const HIGH_HINT = /\b(delete|borrar|eliminar|remove account|close account|deactivate|change (?:password|email|2fa|security)|reset password|api key|token|credential|unsubscribe all|empty trash|format|wipe)\b/i;

export interface StepLike { kind: string; params: Record<string, unknown>; summary: string; risk?: "read" | "write" }

/** Deterministic authority class of one step. `frontApp` lets "press Return in a browser form" count as a commitment risk. */
/** Kinds that can TRIGGER something (a button, a menu command, a key). Filling, selecting, attaching, scrolling or
 *  switching tabs cannot commit anything, whatever words the summary uses (live #121: "Fill name fields (no submit)"). */
const TRIGGERS = new Set(["browser_click", "click", "double_click", "right_click", "ax_click", "menu_item", "key", "hotkey", "run", "browser_download"]);
/** Remove negated mentions so "(no submit)", "without sending", "do not pay" never read as the commitment itself. */
export function stripNegations(s: string): string {
  return s.replace(/\b(?:no|not|never|without|don'?t|do not|sin|no lo)\s+(?:\w+\s+){0,2}?(?:submit\w*|send\w*|enviar|apply\w*|pay\w*|pagar|purchas\w*|buy\w*|comprar|publish\w*|post\w*|book\w*|accept\w*|sign\w*|delet\w*)\b/gi, " ");
}

export function classify(step: StepLike, ctx: { frontApp?: string | null; grants?: string[] } = {}): AuthorityClass {
  const target = stripNegations([step.summary, step.params.label, step.params.name, step.params.text, step.params.title,
    Array.isArray(step.params.path) ? (step.params.path as unknown[]).join(" ") : ""].filter(Boolean).join(" "));
  if (READ.has(step.kind)) return "OBSERVE";
  if (PREP.has(step.kind) && !TRIGGERS.has(step.kind)) return "PREPARATORY";
  if (HIGH_HINT.test(target)) return "HIGH_RISK";
  if (HIGH.has(step.kind)) {
    if (step.kind === "move_file" && ctx.grants?.includes("move_files")) return "PREPARATORY";
    return "HIGH_RISK";
  }
  if (COMMITMENT.test(target)) return "EXTERNAL_COMMITMENT";
  // Return/Enter in a browser submits the focused form: treat as a commitment unless a browser_* fill did it.
  if (step.kind === "key" && /^(return|enter)$/i.test(String(step.params.key ?? "")) && /chrome|firefox|safari|arc|edge|brave/i.test(ctx.frontApp ?? "")) return "EXTERNAL_COMMITMENT";
  if (PREP.has(step.kind)) return "PREPARATORY";
  return "HIGH_RISK";   // unknown kinds are never automatic
}

const NEG = /\b(?:do not|don't|dont|never|without|no|not|sin|no lo)\s+(?:\w+\s+){0,2}?(submit(?:ting)?|send(?:ing)?|enviar|apply(?:ing)?|postular|publish(?:ing)?|post(?:ing)?|pay(?:ing)?|pagar|purchas(?:e|ing)|buy(?:ing)?|comprar|book(?:ing)?|accept(?:ing)?|sign(?:ing)?)\b/gi;

/** Derive the envelope from the principal's own request. A contact's request (principal:false) gets none. */
export function deriveEnvelope(request: string, opts: { principal: boolean; now?: Date } = { principal: true }): DelegationEnvelope | null {
  if (!opts.principal) return null;
  const now = opts.now ?? new Date();
  const words = Array.from(request.matchAll(NEG)).map((m) => m[1]!.toLowerCase());
  const forbidden = Object.keys(FORBID_WORDS).filter((k) => words.some((w) => FORBID_WORDS[k]!.test(w)));
  const grants: string[] = [];
  if (/\b(organi[sz]e|tidy|clean up|sort|file|move|rename|archive)\b[^.]{0,60}\b(files?|folders?|downloads|desktop|documents)\b/i.test(request)) grants.push("move_files");
  return {
    version: 1, objective: request.slice(0, 300), autoClasses: ["OBSERVE", "PREPARATORY"], forbidden, grants,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ENVELOPE_DEFAULTS.ttlMs).toISOString(),
    maxSteps: ENVELOPE_DEFAULTS.maxSteps, costLimitUsd: ENVELOPE_DEFAULTS.costLimitUsd, principal: true,
  };
}

export type AuthorityDecision =
  | { decision: "auto"; cls: AuthorityClass; reason: string }
  | { decision: "approve"; cls: AuthorityClass; reason: string }
  | { decision: "refuse"; cls: AuthorityClass; reason: string };

const FORBID_WORDS: Record<string, RegExp> = {
  submit: /\bsubmit/i, send: /\b(send|enviar|mandar)/i, apply: /\b(submit (?:the |my )?application|apply|postular|aplicar)/i, publish: /\bpublish|publicar/i, post: /\bpost(?:ing)?\b/i,
  pay: /\b(pay|pagar|checkout|place order)/i, purchase: /\b(purchase|buy|comprar|place order|checkout)/i, buy: /\b(buy|purchase|comprar)/i,
  book: /\b(book|reserve)/i, accept: /\b(accept|agree)/i, sign: /\b(sign|e-?sign)/i,
};

/**
 * Is this step inside the authority Julian delegated? `usage` is the task's current step count and model spend.
 * Commitments are never automatic; forbidden ones are refused without asking (Julian already said no).
 */
export function authorize(step: StepLike, env: DelegationEnvelope | null, ctx: { frontApp?: string | null; now?: Date; usage?: { steps: number; costUsd: number } } = {}): AuthorityDecision {
  const cls = classify(step, { frontApp: ctx.frontApp ?? null, grants: env?.grants ?? [] });
  if (cls === "OBSERVE") return { decision: "auto", cls, reason: "observation" };
  const target = stripNegations(`${step.summary} ${step.params.label ?? ""} ${step.params.name ?? ""} ${step.params.text ?? ""}`);
  if (env && (cls === "EXTERNAL_COMMITMENT" || cls === "HIGH_RISK")) {
    const hit = env.forbidden.find((w) => (FORBID_WORDS[w] ?? new RegExp(`\\b${w}`, "i")).test(target));
    if (hit) return { decision: "refuse", cls, reason: `Julian said not to ${hit} — stop at the review stage instead` };
  }
  if (cls === "EXTERNAL_COMMITMENT") return { decision: "approve", cls, reason: "external commitment — Julian's explicit ok" };
  if (cls === "HIGH_RISK") return { decision: "approve", cls, reason: "high-risk/destructive — always explicit" };
  // PREPARATORY
  if (!env) return { decision: "approve", cls, reason: "no delegation envelope (request not from Julian)" };
  const now = (ctx.now ?? new Date()).getTime();
  if (now > Date.parse(env.expiresAt)) return { decision: "approve", cls, reason: "delegation expired — ask to continue" };
  if (ctx.usage && ctx.usage.steps >= env.maxSteps) return { decision: "approve", cls, reason: `delegation step budget (${env.maxSteps}) used` };
  if (ctx.usage && ctx.usage.costUsd >= env.costLimitUsd) return { decision: "approve", cls, reason: `delegation cost limit ($${env.costLimitUsd}) reached` };
  return env.autoClasses.includes(cls) ? { decision: "auto", cls, reason: "preparatory, inside Julian's delegation" } : { decision: "approve", cls, reason: "not delegated" };
}
