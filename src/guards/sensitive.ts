/**
 * G09 layer 1: deterministic sensitive-content detector, run on every capture BEFORE storage and
 * before any model call in Core (implementation plan section 7, ADR-020).
 *   Prohibited: credentials and secrets (never stored, at any authorization level)
 *   Highly Sensitive: payment card, bank account, government ID numbers (rejected in v1)
 * Pattern detection cannot catch sensitive prose (for example a described medical condition);
 * that is the model-label layer's job, backed by the database constraints.
 */
export type SensitiveTier = "prohibited" | "highly_sensitive";

export interface Finding {
  kind: string;
  tier: SensitiveTier;
  start: number;
  end: number;
}

interface Rule {
  kind: string;
  tier: SensitiveTier;
  re: RegExp;
  valid?: (match: string) => boolean;
  group?: number; // redact only this capture group, keeping the label visible
}

const digits = (s: string) => s.replace(/\D/g, "");

export function luhnValid(num: string): boolean {
  const d = digits(num);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + Number(c)) % 97;
  }
  return rem === 1;
}

const ssnValid = (m: string) => {
  const [a, b, c] = m.split("-");
  return a !== "000" && a !== "666" && !a!.startsWith("9") && b !== "00" && c !== "0000";
};

const RULES: Rule[] = [
  // Prohibited: secrets and credentials
  { kind: "private_key", tier: "prohibited", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "jwt", tier: "prohibited", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer_token", tier: "prohibited", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/gi, group: 1 },
  { kind: "api_key", tier: "prohibited",
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|re_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g },
  { kind: "connection_string_credentials", tier: "prohibited", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi, group: 1 },
  { kind: "password", tier: "prohibited",
    re: /\b(?:password|passwd|pwd|passcode|pass|contrase(?:ñ|n)a|clave|pin)\s*(?:is|es|:|=)\s*([^\s,;]{4,})/gi, group: 1 },
  // Highly Sensitive: financial and government identifiers
  { kind: "payment_card", tier: "highly_sensitive", re: /\b(?:\d[ -]?){12,18}\d\b/g, valid: luhnValid },
  { kind: "iban", tier: "highly_sensitive", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, valid: ibanValid },
  { kind: "us_ssn", tier: "highly_sensitive", re: /\b\d{3}-\d{2}-\d{4}\b/g, valid: ssnValid },
  { kind: "bank_account", tier: "highly_sensitive",
    re: /\b(?:account|acct|routing|aba|cuenta|n[uú]mero de cuenta)\s*(?:number|no\.?|#|n[uú]mero)?\s*[:#]?\s*(\d[\d -]{5,20}\d)/gi, group: 1 },
];

export function detectSensitive(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (m.index === undefined) continue;
      const whole = m[0];
      if (rule.valid && !rule.valid(whole)) continue;
      const g = rule.group !== undefined ? m[rule.group] : undefined;
      const start = g !== undefined ? m.index + whole.lastIndexOf(g) : m.index;
      const end = g !== undefined ? start + g.length : m.index + whole.length;
      findings.push({ kind: rule.kind, tier: rule.tier, start, end });
    }
  }
  // Merge overlaps, keeping the most severe tier.
  findings.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Finding[] = [];
  for (const f of findings) {
    const last = merged[merged.length - 1];
    if (last && f.start < last.end) {
      last.end = Math.max(last.end, f.end);
      if (f.tier === "prohibited") { last.tier = "prohibited"; last.kind = f.kind; }
    } else {
      merged.push({ ...f });
    }
  }
  return merged;
}

/** Replace every finding with a marker that names the kind but never repeats the content. */
export function redactSensitive(text: string): { text: string; findings: Finding[] } {
  const findings = detectSensitive(text);
  let out = "";
  let pos = 0;
  for (const f of findings) {
    out += text.slice(pos, f.start) + `[REDACTED:${f.kind}]`;
    pos = f.end;
  }
  return { text: out + text.slice(pos), findings };
}
