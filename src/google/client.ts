/**
 * Read-only Google access for J5 (ADR-049): Drive (all files, Docs/Sheets/Slides exported as text),
 * Gmail and Calendar. Uses Julian's own OAuth refresh token (GOOGLE_REFRESH_TOKEN) obtained once with
 * helper/google-auth.mjs. Scopes are read-only; Finagai cannot change or send anything in Google.
 */
import type { FileExcerpt } from "../pipelines/j5/concierge.js";

export interface GoogleConfig { clientId: string; clientSecret: string; refreshToken: string }
type Fetch = typeof fetch;

const TEXT_EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const MAX_TEXT = 3000;

export class GoogleClient {
  private token: { value: string; expires: number } | null = null;
  private refreshing: Promise<string> | null = null;
  constructor(private cfg: GoogleConfig, private fetchFn: Fetch = fetch) {}

  /** One refresh at a time; parallel searches share it. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires - 60_000) return this.token.value;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const r = await this.fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken, grant_type: "refresh_token" }),
    });
    if (!r.ok) throw new Error(`google token refresh failed: HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async get(url: string): Promise<Response> {
    return this.fetchFn(url, { headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(20_000) });
  }

  private async json<T>(url: string): Promise<T> {
    const r = await this.get(url);
    if (!r.ok) throw new Error(`google ${new URL(url).hostname} HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  /** Drive full-text and name search; Google files exported as text, others listed with a link. */
  async drive(terms: string[]): Promise<FileExcerpt[]> {
    const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `(${terms.map((t) => `fullText contains '${esc(t)}' or name contains '${esc(t)}'`).join(" or ")}) and trashed = false`;
    const list = await this.json<{ files?: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }> }>(
      `https://www.googleapis.com/drive/v3/files?pageSize=6&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${encodeURIComponent(q)}`);
    const out: FileExcerpt[] = [];
    for (const f of list.files ?? []) {
      let text = "";
      const exportAs = TEXT_EXPORT[f.mimeType];
      try {
        if (exportAs) {
          const r = await this.get(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=${encodeURIComponent(exportAs)}`);
          if (r.ok) text = (await r.text()).slice(0, 200_000);
        } else if (/^text\/|json|csv/.test(f.mimeType)) {
          const r = await this.get(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
          if (r.ok) text = (await r.text()).slice(0, 200_000);
        }
      } catch { /* keep the listing */ }
      out.push({ name: `Google Drive: ${f.name}`, path: f.webViewLink ?? `drive:${f.id}`, modified: f.modifiedTime,
        text: `${passageOf(text, terms) || "(no text preview for this file type)"}\nLink: ${f.webViewLink ?? ""}` });
    }
    return out;
  }

  /** Gmail search; subject, sender, date and the start of the plain-text body. */
  async gmail(terms: string[]): Promise<FileExcerpt[]> {
    const q = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    const list = await this.json<{ messages?: Array<{ id: string }> }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(q)}`);
    const out: FileExcerpt[] = [];
    for (const m of list.messages ?? []) {
      const msg = await this.json<GmailMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`);
      const h = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
      out.push({ name: `Gmail: ${h("subject")}`, path: `gmail:${m.id}`, modified: new Date(Number(msg.internalDate)).toISOString(),
        text: `From: ${h("from")}\nDate: ${h("date")}\n${passageOf(plainBody(msg.payload) || msg.snippet || "", terms)}` });
    }
    return out;
  }

  /** Calendar events (all calendars on the primary list) matching the terms, 1 year back to 1 year ahead. */
  async calendar(terms: string[]): Promise<FileExcerpt[]> {
    const from = new Date(Date.now() - 365 * 864e5).toISOString();
    const to = new Date(Date.now() + 365 * 864e5).toISOString();
    const lines: string[] = [];
    for (const t of terms) {
      const r = await this.json<{ items?: Array<{ summary?: string; location?: string; start?: { dateTime?: string; date?: string }; description?: string }> }>(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=10&timeMin=${from}&timeMax=${to}&q=${encodeURIComponent(t)}`);
      for (const e of r.items ?? []) lines.push(`${e.start?.dateTime ?? e.start?.date ?? "?"} | ${e.summary ?? ""} | ${e.location ?? ""}${e.description ? ` | ${e.description.slice(0, 200)}` : ""}`);
    }
    return lines.length ? [{ name: "Google Calendar", path: "google-calendar", text: [...new Set(lines)].slice(0, 20).join("\n") }] : [];
  }

  /** Everything at once; one failing service never blocks the others. */
  async search(terms: string[]): Promise<FileExcerpt[]> {
    const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 1))].slice(0, 3);
    if (!clean.length) return [];
    const parts = await Promise.all([this.drive(clean), this.gmail(clean), this.calendar(clean)].map((p) => p.catch(() => [] as FileExcerpt[])));
    return parts.flat();
  }
}

interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: Array<{ name: string; value: string }> }
interface GmailMessage { internalDate: string; snippet?: string; payload?: GmailPart }

export function plainBody(p: GmailPart | undefined): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const c of p.parts ?? []) { const t = plainBody(c); if (t) return t; }
  if (p.mimeType === "text/html" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return "";
}

export function passageOf(text: string, terms: string[]): string {
  if (text.length <= MAX_TEXT) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of terms.flatMap((t) => t.toLowerCase().split(/\s+/)).filter((w) => w.length > 2)) { at = lower.indexOf(w); if (at >= 0) break; }
  const start = Math.max(0, at - 1000);
  return text.slice(start, start + MAX_TEXT);
}
