/** JSON HTTP for provider APIs: retries transient failures; errors carry status and a redacted message. */
import { redact } from "./secret.js";

export class ProviderError extends Error {
  constructor(readonly provider: string, readonly status: number, message: string) {
    super(`${provider}: ${redact(message)}`);
  }
}

export interface Call { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; ok?: number[] }

export async function api<T = any>(provider: string, url: string, c: Call = {}): Promise<{ status: number; json: T }> {
  const ok = c.ok ?? [200, 201, 202, 204];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: c.method ?? (c.body || c.form ? "POST" : "GET"),
        headers: { accept: "application/json", ...(c.body ? { "content-type": "application/json" } : {}),
          ...(c.form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...c.headers },
        ...(c.body ? { body: JSON.stringify(c.body) } : c.form ? { body: new URLSearchParams(c.form).toString() } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt < 3) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
      throw new ProviderError(provider, 0, `request failed: ${err instanceof Error ? err.message : "network error"}`);
    }
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; } })() : {};
    if (ok.includes(res.status)) return { status: res.status, json: json as T };
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    throw new ProviderError(provider, res.status, `HTTP ${res.status} on ${new URL(url).pathname}: ${JSON.stringify(json).slice(0, 300)}`);
  }
}
