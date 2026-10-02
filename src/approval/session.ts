/**
 * Approval-page browser session (ADR-019, ADR-030). Deliberately separate from MCP auth:
 *   - carried only in an HttpOnly, Secure, SameSite=Strict cookie, never in an Authorization header
 *   - signed with SESSION_SECRET (HMAC-SHA256); bearer tokens are never accepted here
 *   - records authTime, so approvals can require a recent sign-in in addition to WebAuthn
 * The sign-in itself (OIDC code exchange with the identity provider) is implemented in M5.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "finagai_approval";
export const SESSION_MAX_AGE_SECONDS = 15 * 60;

export interface ApprovalSession {
  sub: string;
  authTime: number; // epoch seconds of the identity-provider sign-in
  exp: number;      // epoch seconds
}

const b64 = (b: Buffer) => b.toString("base64url");

export function signSession(s: ApprovalSession, secret: string): string {
  const body = b64(Buffer.from(JSON.stringify(s)));
  const mac = b64(createHmac("sha256", secret).update(`v1.${body}`).digest());
  return `v1.${body}.${mac}`;
}

export function verifySession(value: string | undefined, secret: string, principalSubject: string, nowSec: number): ApprovalSession | null {
  if (!value) return null;
  const [v, body, mac] = value.split(".");
  if (v !== "v1" || !body || !mac) return null;
  const expected = createHmac("sha256", secret).update(`v1.${body}`).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let s: ApprovalSession;
  try {
    s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ApprovalSession;
  } catch {
    return null;
  }
  if (s.sub !== principalSubject || !(s.exp > nowSec)) return null;
  return s;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/approve; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}
