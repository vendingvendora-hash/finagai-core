/**
 * Phase 6 (ADR-085) — what learning is ALLOWED to change. Code-enforced; learning cannot widen it.
 *
 * Learning never touches: authority classes, the delegation envelope, commit/submit/send/pay rules, password/secret
 * handling, approval requirements, escalation categories (what needs Julian), budgets, classification, or identity.
 * Those modules do not import src/learning at all (a test enforces it). The only effects that exist:
 *
 *   planner_hint     advisory text for the Mac planner, from OBSERVED records (n ≥ 3) or Julian's STATED words; authorization stays code
 *   routing_override "ignore mail from X" / "mail from X belongs to <workflow>", STATED by Julian only
 *   procedure        a learned procedure, applied ONLY after Julian approves it (existing proposal → procedure path)
 *   policy_param     a bounded lifecycle parameter, applied ONLY after Julian approves it (proposal → preference path)
 */
import { COMMITMENT, stripNegations } from "../governance/authority.js";

export type Effect =
  | { type: "planner_hint"; match: string[]; text: string }
  | { type: "routing_override"; sender: string; action: "ignore" | "route"; workflow?: string }
  | { type: "procedure"; name: string; when: string[]; steps: string[] }
  | { type: "policy_param"; area: string; param: PolicyParam; value: number | boolean };

/** Bounded, per-Area lifecycle parameters learning may propose. Nothing else is a policy parameter. */
export const POLICY_BOUNDS = {
  responseDays: { min: 7, max: 45 },
  interviewDecisionDays: { min: 3, max: 21 },
  staleAppliedDays: { min: 14, max: 90 },
  julianActionDays: { min: 1, max: 7 },
  nudgeWithContact: { bool: true },
} as const;
export type PolicyParam = keyof typeof POLICY_BOUNDS;

const SECURITY = /\b(password|passcode|one[- ]time code|2fa|otp|secret|token|api key|credential|ssn|social security|bank account|card number|cvv)\b/i;
const GOVERNANCE = /\b(skip|bypass|without|no need for|don'?t (?:ask|wait for)|auto[- ]?approve|ignore)\b[^.]{0,40}\b(approval|confirmation|julian|authori[sz]ation|review|verification|verify)\b/i;

export class EffectRejected extends Error {}

/** Validate an effect against the whitelist and bounds. `basis` decides which effect types are even possible. */
export function validateEffect(e: Effect, basis: "observed" | "stated" | "inferred"): Effect {
  switch (e.type) {
    case "planner_hint": {
      if (basis === "inferred") throw new EffectRejected("planner hints come only from observed records or Julian's own words");
      const text = String(e.text ?? "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 240) throw new EffectRejected("hint must be 1–240 characters");
      // A hint may never tell the planner to commit, or to get around approval, verification or secrets.
      if (COMMITMENT.test(stripNegations(text))) throw new EffectRejected("hint mentions an external commitment");
      if (SECURITY.test(text)) throw new EffectRejected("hint touches secrets/credentials");
      if (GOVERNANCE.test(text)) throw new EffectRejected("hint tries to relax approval/verification");
      return { type: "planner_hint", match: (e.match ?? []).map(String).filter(Boolean).slice(0, 6), text };
    }
    case "routing_override": {
      if (basis !== "stated") throw new EffectRejected("routing overrides only come from Julian's own words");
      const sender = String(e.sender ?? "").toLowerCase().trim();
      if (sender.length < 3 || !/^[a-z0-9._%+@-]+$/.test(sender)) throw new EffectRejected("sender must be an address or domain");
      if (e.action !== "ignore" && e.action !== "route") throw new EffectRejected("action must be ignore or route");
      if (e.action === "route" && !/^[a-z][a-z0-9._-]{2,60}$/.test(String(e.workflow ?? ""))) throw new EffectRejected("route needs a workflow name");
      return { type: "routing_override", sender, action: e.action, ...(e.action === "route" ? { workflow: String(e.workflow) } : {}) };
    }
    case "procedure": {
      if (basis !== "inferred") throw new EffectRejected("procedures are inferred and need approval");
      // A learned procedure never carries a commitment: such a step becomes an explicit stop (it stays Julian's, approved
      // per step by the unchanged authority rules), and secrets / approval-skipping wording rejects the whole procedure.
      const steps = (e.steps ?? []).map((s) => String(s).slice(0, 200)).slice(0, 15)
        .map((s) => (COMMITMENT.test(stripNegations(s)) ? `STOP — "${s.split(":")[0]}" commits Julian externally: it stays his, approved per step` : s));
      for (const s of steps) if (SECURITY.test(s) || GOVERNANCE.test(s)) throw new EffectRejected(`step not allowed: ${s}`);
      return { type: "procedure", name: String(e.name).slice(0, 120), when: (e.when ?? []).map(String).slice(0, 8), steps };
    }
    case "policy_param": {
      if (basis !== "inferred") throw new EffectRejected("policy parameters are inferred and need approval");
      const b = POLICY_BOUNDS[e.param as PolicyParam];
      if (!b) throw new EffectRejected(`"${String(e.param)}" is not a learnable parameter`);
      if ("bool" in b) { if (typeof e.value !== "boolean") throw new EffectRejected("boolean expected"); }
      else if (typeof e.value !== "number" || !Number.isInteger(e.value) || e.value < b.min || e.value > b.max) throw new EffectRejected(`${e.param} must be an integer in [${b.min}, ${b.max}]`);
      return { type: "policy_param", area: String(e.area), param: e.param, value: e.value };
    }
    default: throw new EffectRejected(`unknown effect type ${(e as { type?: string }).type}`);
  }
}

/** Machine-readable trailer carried in an approved proposal's text (the human-readable part is what Julian approves). */
export const EFFECT_TAG = "[finagai-effect]";
export const encodeEffect = (e: Effect) => `${EFFECT_TAG} ${JSON.stringify(e)}`;
export function decodeEffect(text: string): Effect | null {
  const i = text.lastIndexOf(EFFECT_TAG);
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i + EFFECT_TAG.length).trim()) as Effect; } catch { return null; }
}
