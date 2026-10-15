/**
 * Server-side sessions. The browser holds only an opaque random id (HttpOnly cookie); Core's access and refresh tokens
 * live here, in process memory, and are never serialized into any response, URL, log line or cookie. A restart of the
 * BFF (a deploy) ends every session: Julian signs in again — the safe failure.
 */
import { randomBytes } from "node:crypto";
import type { Oidc, Tokens } from "./oidc.js";

interface Session { tokens: Tokens; createdAt: number; lastSeen: number; refreshing?: Promise<Tokens> | undefined }

export class Sessions {
  private readonly map = new Map<string, Session>();
  constructor(private readonly oidc: Oidc, private readonly idleMs: number, private readonly now = () => Date.now(),
    private readonly log: (msg: string, fields: Record<string, unknown>) => void = () => {}) {}

  create(tokens: Tokens): string {
    const id = randomBytes(32).toString("base64url");
    this.map.set(id, { tokens, createdAt: this.now(), lastSeen: this.now() });
    return id;
  }

  has(id: string | undefined): boolean { return !!id && this.live(id) !== null; }

  destroy(id: string | undefined) { if (id) this.map.delete(id); }

  /** A Core access token valid for at least 60 s, refreshed if needed; null = the session is gone (sign in again). */
  async accessToken(id: string | undefined, force = false): Promise<string | null> {
    const s = id ? this.live(id) : null;
    if (!s) return null;
    if (!force && s.tokens.accessExp - this.now() > 60_000) return s.tokens.access;
    if (!s.tokens.refresh) { this.map.delete(id!); return null; }
    const before = s.tokens;
    try {
      const first = !s.refreshing;
      s.refreshing ??= this.oidc.refresh(s.tokens.refresh).finally(() => { s.refreshing = undefined; });
      s.tokens = await s.refreshing;
      // operational evidence only: timings and whether the refresh token rotated — never a token
      if (first) this.log("access renewed", { forced: force, secondsLeftBefore: Math.round((before.accessExp - this.now()) / 1000),
        validForSeconds: Math.round((s.tokens.accessExp - this.now()) / 1000), refreshRotated: s.tokens.refresh !== before.refresh, sessionAgeMinutes: Math.round((this.now() - s.createdAt) / 60_000) });
      return s.tokens.access;
    } catch (e) {
      this.log("renewal failed; session ended", { reason: String((e as Error)?.message ?? e).slice(0, 160) });
      this.map.delete(id!); return null;
    }
  }

  private live(id: string): Session | null {
    const s = this.map.get(id);
    if (!s) return null;
    if (this.now() - s.lastSeen > this.idleMs) { this.map.delete(id); return null; }
    s.lastSeen = this.now();
    return s;
  }

  get size() { return this.map.size; }
}
