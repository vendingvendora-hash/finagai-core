/**
 * Phase 2 live fix (ADR-075): Julian's real data spans several Google accounts — Vendora mail lives in
 * vending.vendora@gmail.com, the job search (e.g. every Altarum thread) in his university account. A single
 * refresh token made Finagai blind to one of them while reporting "healthy". This client fans every search
 * out to all authorized accounts, labels each result with its account, and isolates failures per account
 * (one revoked token never hides the others' data).
 */
import type { FileExcerpt } from "../pipelines/j5/concierge.js";
import { GoogleClient, type GoogleConfig } from "./client.js";

type Fetch = typeof fetch;
interface Member { client: GoogleClient; label: string | null }

export class MultiGoogleClient {
  private members: Member[];
  constructor(clients: GoogleClient[]) { this.members = clients.map((client) => ({ client, label: null })); }

  static fromConfig(cfg: { clientId: string; clientSecret: string; refreshTokens: string[] }, fetchFn: Fetch = fetch): MultiGoogleClient {
    const tokens = [...new Set(cfg.refreshTokens.map((t) => t.trim()).filter((t) => t.length >= 10))];
    return new MultiGoogleClient(tokens.map((refreshToken) =>
      new GoogleClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken } satisfies GoogleConfig, fetchFn)));
  }

  get size(): number { return this.members.length; }

  private async label(m: Member): Promise<string> {
    if (m.label) return m.label;
    try { m.label = await m.client.account(); } catch { return "unverified account"; }
    return m.label;
  }

  /** Every connected account; a failing token is reported, not hidden (registry shows it). */
  async account(): Promise<string> {
    const r = await Promise.allSettled(this.members.map((m) => m.client.account()));
    r.forEach((x, i) => { if (x.status === "fulfilled") this.members[i]!.label = x.value; });
    const ok = r.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
    const bad = r.length - ok.length;
    if (!ok.length) {
      const first = r.find((x): x is PromiseRejectedResult => x.status === "rejected");
      throw new Error(first ? String(first.reason?.message ?? first.reason) : "no Google accounts configured");
    }
    return ok.join(", ") + (bad ? ` (${bad} account(s) failing)` : "");
  }

  private async fan(kind: "gmail" | "calendar" | "drive", terms: string[]): Promise<FileExcerpt[]> {
    const parts = await Promise.allSettled(this.members.map(async (m) => {
      const rows = await m.client[kind](terms);
      if (this.members.length < 2) return rows;
      const acct = await this.label(m);
      return rows.map((x) => ({ ...x, name: `${x.name} [${acct}]` }));
    }));
    const ok = parts.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
    if (!ok.length && parts.every((p) => p.status === "rejected")) throw (parts[0] as PromiseRejectedResult).reason;
    return ok;
  }

  gmail(terms: string[]): Promise<FileExcerpt[]> { return this.fan("gmail", terms); }
  calendar(terms: string[]): Promise<FileExcerpt[]> { return this.fan("calendar", terms); }
  drive(terms: string[]): Promise<FileExcerpt[]> { return this.fan("drive", terms); }

  async search(terms: string[]): Promise<FileExcerpt[]> {
    const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 1))].slice(0, 3);
    if (!clean.length) return [];
    const parts = await Promise.all([this.drive(clean), this.gmail(clean), this.calendar(clean)].map((p) => p.catch(() => [] as FileExcerpt[])));
    return parts.flat();
  }
}
