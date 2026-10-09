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

  /**
   * ADR-080: an account label must be VERIFIED before its evidence is used — record identity is (account, id), so
   * a transient profile failure must never relabel a mailbox ("unverified account") and silently change every key.
   */
  private async strictLabel(m: Member): Promise<string> {
    if (m.label) return m.label;
    m.label = await m.client.account();
    return m.label;
  }

  /**
   * The Career sheet across accounts, with explicit precedence: the pinned file id (previous snapshot) if any account
   * still has it, else the newest by modifiedTime (ties by id). Every account's outcome is reported.
   */
  async sheetCsv(title: string, preferId?: string): Promise<{ id: string; name: string; csv: string; modified: string; account: string; candidates: Array<{ id: string; name: string; modified: string; account: string }>; errors: string[] } | null> {
    const found = await Promise.all(this.members.map(async (m) => {
      try { const account = await this.strictLabel(m); const s = await m.client.sheetCsv(title, preferId); return { account, s, error: null as string | null }; }
      catch (e) { return { account: m.label ?? "unverified account", s: null, error: String((e as Error)?.message ?? e).slice(0, 200) }; }
    }));
    const errors = found.filter((f) => f.error).map((f) => `${f.account}: ${f.error}`);
    const hits = found.flatMap((f) => (f.s ? [{ ...f.s, account: f.account }] : []));
    const candidates = hits.flatMap((h) => h.candidates.map((c) => ({ ...c, account: h.account }))).sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id));
    const pinned = hits.find((h) => h.id === preferId);
    const pick = pinned ?? [...hits].sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id))[0];
    if (!pick) { if (errors.length) throw new Error(`sheet lookup failed: ${errors.join("; ")}`); return null; }
    return { id: pick.id, name: pick.name, csv: pick.csv, modified: pick.modified, account: pick.account, candidates, errors };
  }

  /** Per-account enumeration with per-account outcome (success OR recorded error) — nothing is dropped silently. */
  async gmailEnumerate(q: string, opts: { maxMessages?: number } = {}) {
    return Promise.all(this.members.map(async (m) => {
      let account = m.label ?? "unverified account";
      try { account = await this.strictLabel(m); return { account, ok: true as const, ...(await m.client.gmailEnumerate(q, opts)) }; }
      catch (e) { return { account, ok: false as const, error: String((e as Error)?.message ?? e).slice(0, 200), records: [], pages: 0, truncated: false, ids: 0, vanished: [] as string[] }; }
    }));
  }
  /** Re-verify specific message ids in one named account (carry-forward of previously seen evidence). */
  async gmailMetadata(account: string, ids: string[]) {
    for (const m of this.members) {
      let label: string;
      try { label = await this.strictLabel(m); } catch { continue; }
      if (label === account) return m.client.gmailMetadata(ids);
    }
    throw new Error(`account ${account} is not connected (or its identity could not be verified)`);
  }
  async calendarEnumerate(q: string, timeMin: string, timeMax: string) {
    return Promise.all(this.members.map(async (m) => {
      let account = m.label ?? "unverified account";
      try { account = await this.strictLabel(m); return { account, ok: true as const, ...(await m.client.calendarEnumerate(q, timeMin, timeMax)) }; }
      catch (e) { return { account, ok: false as const, error: String((e as Error)?.message ?? e).slice(0, 200), records: [], pages: 0 }; }
    }));
  }

  async search(terms: string[]): Promise<FileExcerpt[]> {
    const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 1))].slice(0, 3);
    if (!clean.length) return [];
    const parts = await Promise.all([this.drive(clean), this.gmail(clean), this.calendar(clean)].map((p) => p.catch(() => [] as FileExcerpt[])));
    return parts.flat();
  }
}
